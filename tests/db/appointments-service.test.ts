/**
 * Appointment service paths (booking, slots, status, reminders, button replies) through a real
 * PostgREST in front of the test database. Runs only when TEST_POSTGREST_URL and TEST_SERVICE_JWT
 * are set (see supabase/test/README.md). Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { slotsForDay } from "@/lib/appointments/availability";
import { applyReminderReply } from "@/lib/appointments/replies";
import {
  cancelAppointmentReminders,
  changeAppointmentStatus,
  createAppointment,
  createTimeBlock,
  rescheduleAppointment,
  syncAppointmentReminders,
} from "@/lib/appointments/service";
import { localDate, localMinutesToInstant } from "@/lib/appointments/slots";
import { processReminder, reportReminderFailure } from "@/lib/jobs/handlers/appointments";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

const log = { info: () => {}, warn: () => {}, error: () => {} };

/** The first Monday at least 10 days out, as a local Dubai date. */
function futureMonday(): string {
  const d = new Date(Date.now() + 10 * 86_400_000);
  while (localDate(d, "Asia/Dubai") && new Date(d).getUTCDay() !== 1)
    d.setUTCDate(d.getUTCDate() + 1);
  return localDate(d, "Asia/Dubai");
}

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "appointments service through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let user: string;
    const id: Record<string, string> = {};
    const monday = futureMonday();
    const at = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return localMinutesToInstant(monday, h * 60 + m, "Asia/Dubai");
    };

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";

      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "admin@example.test");
      org = await createOrg(c, "Org S", "org-s", user);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;

      const q = async (sql: string, p: unknown[]) =>
        (await c.query(sql + " returning id", p)).rows[0].id as string;
      await c.query("set role service_role");
      id.loc = await q("insert into public.locations (org_id, name) values ($1, 'Test Clinic')", [
        org,
      ]);
      id.dept = await q("insert into public.departments (org_id, name) values ($1, 'General')", [
        org,
      ]);
      id.svc = await q(
        "insert into public.services (org_id, department_id, name, duration_min) values ($1, $2, 'Consultation', 30)",
        [org, id.dept],
      );
      id.spec = await q(
        "insert into public.specialists (org_id, name, department_id) values ($1, 'Dr Example', $2)",
        [org, id.dept],
      );
      for (let wd = 1; wd <= 7; wd++)
        await c.query(
          "insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1,$2,$3,$4,540,720)",
          [org, id.spec, id.loc, wd],
        );
      id.contact = await q(
        "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Sara', 'Example', '+971500000001')",
        [org],
      );
      id.channel = await q(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'waba-1', 'pn-1')",
        [org],
      );
      id.tpl = await q(
        `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
         values ($1, $2, 'waba-1', 'appointment_reminder', 'en', 'UTILITY', 'APPROVED',
                 '[{"type":"BODY","text":"Hi {{1}}, your visit is {{2}} with {{3}}."}]')`,
        [org, id.channel],
      );
      await c.query("update public.orgs set settings = $2::jsonb where id = $1", [
        org,
        JSON.stringify({
          appointments: {
            templates: {
              reminder: id.tpl,
              confirmed: id.tpl,
              cancelled: null,
              rescheduled: id.tpl,
            },
            lead_time_minutes: 0,
          },
        }),
      ]);
      await c.query("reset role");
    });

    afterAll(async () => {
      await c?.end();
    });

    let apptId: string;

    it("lists slots from working hours and books one, blocking it afterwards", async () => {
      const q = {
        orgId: org,
        specialistId: id.spec,
        locationId: id.loc,
        date: monday,
        durationMin: 30,
        now: new Date(),
      };
      const before = await slotsForDay(admin, q);
      expect(before.map((s) => s.label)).toEqual([
        "09:00",
        "09:15",
        "09:30",
        "09:45",
        "10:00",
        "10:15",
        "10:30",
        "10:45",
        "11:00",
        "11:15",
        "11:30",
      ]);

      const res = await createAppointment(admin, {
        orgId: org,
        actorId: user,
        contactId: id.contact,
        locationId: id.loc,
        specialistId: id.spec,
        serviceId: id.svc,
        startsAt: at("09:30"),
        notify: true,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      apptId = res.appointment.id;
      expect(res.appointment).toMatchObject({ status: "awaiting", source: "portal", number: 1 });
      expect(res.notification?.ok).toBe(true);

      const after = await slotsForDay(admin, q);
      expect(after.map((s) => s.label)).not.toContain("09:30");
      expect(after.map((s) => s.label)).not.toContain("09:15"); // would overlap the 09:30 booking
      expect(after.map((s) => s.label)).toContain("10:00");
    });

    it("rejects an overlapping booking unless overridden", async () => {
      const input = {
        orgId: org,
        actorId: user,
        contactId: id.contact,
        locationId: id.loc,
        specialistId: id.spec,
        serviceId: id.svc,
        startsAt: at("09:45"),
      };
      const denied = await createAppointment(admin, input);
      expect(denied).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
      const forced = await createAppointment(admin, { ...input, override: true });
      expect(forced.ok).toBe(true);
    });

    it("treats time blocks as busy", async () => {
      const blk = await createTimeBlock(admin, {
        orgId: org,
        actorId: user,
        specialistId: id.spec,
        startsAt: at("11:00"),
        endsAt: at("12:00"),
        reason: "Meeting",
      });
      expect(blk.ok).toBe(true);
      const slots = await slotsForDay(admin, {
        orgId: org,
        specialistId: id.spec,
        locationId: id.loc,
        date: monday,
        durationMin: 30,
      });
      expect(slots.map((s) => s.label)).not.toContain("11:00");
      expect(slots.map((s) => s.label)).toContain("10:30"); // 10:30–11:00 touches the block
      expect(slots.map((s) => s.label)).not.toContain("10:45"); // would run into it
    });

    it("schedules exactly one reminder from the default booking rules (24h) and is idempotent", async () => {
      const { data: rows } = await admin
        .from("appointment_reminders")
        .select("idx, status, due_at")
        .eq("appointment_id", apptId);
      expect(rows).toHaveLength(1);
      // Rule 2 of 3 is the enabled 24h reminder.
      expect(rows?.[0]).toMatchObject({ idx: 2, status: "scheduled" });
      expect(new Date(rows![0].due_at).getTime()).toBe(at("09:30").getTime() - 24 * 3600_000);

      const { data: appt } = await admin.from("appointments").select("*").eq("id", apptId).single();
      const again = await syncAppointmentReminders(admin, appt!);
      expect(again).toEqual({ scheduled: 0, cancelled: 0 });
      const jobs = await c.query(
        "select 1 from public.scheduled_jobs where dedupe_key = $1 and done_at is null",
        [`reminder:${apptId}:2`],
      );
      expect(jobs.rowCount).toBe(1);
    });

    it("sends a due reminder through the outbound queue and records the message", async () => {
      // 23h to go → the 24h reminder was due an hour ago.
      const start = new Date(Date.now() + 23 * 3600_000);
      await admin
        .from("appointments")
        .update({
          starts_at: start.toISOString(),
          ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        })
        .eq("id", apptId);
      const { data: r } = await admin
        .from("appointment_reminders")
        .select("id")
        .eq("appointment_id", apptId)
        .single();
      await admin
        .from("appointment_reminders")
        .update({ due_at: new Date(Date.now() - 3600_000).toISOString() })
        .eq("id", r!.id);

      expect(await processReminder(admin, org, r!.id, log)).toBe("sent");
      expect(await processReminder(admin, org, r!.id, log)).toBe("skipped_not_scheduled"); // idempotent

      const { data: row } = await admin
        .from("appointment_reminders")
        .select("status, message_id")
        .eq("id", r!.id)
        .single();
      expect(row?.status).toBe("sent");
      const { data: msg } = await admin
        .from("messages")
        .select("kind, body, status")
        .eq("id", row!.message_id!)
        .single();
      expect(msg).toMatchObject({ kind: "template", status: "queued" });
      expect(msg?.body).toContain("Hi Sara");
      expect(msg?.body).toContain("with Dr Example");
    });

    it("applies Confirm / Cancel button replies to the reminded appointment", async () => {
      const { data: row } = await admin
        .from("appointment_reminders")
        .select("message_id")
        .eq("appointment_id", apptId)
        .single();
      await admin
        .from("messages")
        .update({ wa_message_id: "wamid.REMINDER_1" })
        .eq("id", row!.message_id!);

      const reply = (button: string, to = "wamid.REMINDER_1") =>
        applyReminderReply(admin, {
          orgId: org,
          contactId: id.contact,
          replyToWaMessageId: to,
          interactive: { type: "template_button", id: button, title: button },
        });

      expect(await reply("RESCHEDULE")).toBe("reception_notified");
      expect(await reply("CONFIRM", "wamid.OTHER")).toBe("no_reminder");
      expect(await reply("CONFIRM")).toBe("confirmed");
      const { data: a1 } = await admin
        .from("appointments")
        .select("status")
        .eq("id", apptId)
        .single();
      expect(a1?.status).toBe("confirmed");
      expect(await reply("CANCEL")).toBe("cancelled");
      const { data: a2 } = await admin
        .from("appointments")
        .select("status")
        .eq("id", apptId)
        .single();
      expect(a2?.status).toBe("cancelled");

      const { data: rem } = await admin
        .from("appointment_reminders")
        .select("status")
        .eq("appointment_id", apptId);
      expect(rem?.every((x) => x.status === "sent" || x.status === "cancelled")).toBe(true);
      const { data: tl } = await admin
        .from("timeline_events")
        .select("type")
        .eq("contact_id", id.contact);
      expect(tl?.map((t) => t.type)).toEqual(
        expect.arrayContaining([
          "appointment.created",
          "appointment.status_changed",
          "appointment.reply",
        ]),
      );
    });

    it("moves reminders when an appointment is rescheduled and cancels them when closed", async () => {
      const res = await createAppointment(admin, {
        orgId: org,
        actorId: user,
        contactId: id.contact,
        locationId: id.loc,
        specialistId: id.spec,
        serviceId: id.svc,
        startsAt: at("10:15"),
      });
      if (!res.ok) throw new Error(res.error);
      const a = res.appointment.id;

      const moved = await rescheduleAppointment(admin, {
        orgId: org,
        appointmentId: a,
        actorId: user,
        startsAt: at("10:30"),
      });
      expect(moved.ok).toBe(true);
      const { data: r } = await admin
        .from("appointment_reminders")
        .select("due_at, status")
        .eq("appointment_id", a)
        .single();
      expect(new Date(r!.due_at).getTime()).toBe(at("10:30").getTime() - 24 * 3600_000);
      expect(r?.status).toBe("scheduled");

      const noShow = await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: a,
        to: "no_show",
        actorId: user,
      });
      expect(noShow.ok).toBe(true);
      const { data: r2 } = await admin
        .from("appointment_reminders")
        .select("status")
        .eq("appointment_id", a)
        .single();
      expect(r2?.status).toBe("cancelled");
      const pending = await c.query(
        "select 1 from public.scheduled_jobs where dedupe_key = $1 and done_at is null",
        [`reminder:${a}:2`],
      );
      expect(pending.rowCount).toBe(0);

      // Closed → open again is allowed; the reminder comes back only if still in the future.
      const reopened = await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: a,
        to: "confirmed",
        actorId: user,
      });
      expect(reopened.ok).toBe(true);
      expect(await cancelAppointmentReminders(admin, org, a)).toBe(1);
    });

    it("refuses invalid transitions and cross-org references", async () => {
      const bad = await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: apptId,
        to: "completed",
        actorId: user,
      });
      expect(bad).toMatchObject({ ok: false });
      const foreign = await createAppointment(admin, {
        orgId: "00000000-0000-0000-0000-000000000000",
        actorId: user,
        contactId: id.contact,
        locationId: id.loc,
        specialistId: id.spec,
        serviceId: id.svc,
        startsAt: at("11:30"),
      });
      expect(foreign.ok).toBe(false);
    });

    it("excludes placeholder patients and test-mode recipients without sending", async () => {
      const make = async () => {
        const r = await createAppointment(admin, {
          orgId: org,
          actorId: user,
          contactId: id.contact,
          locationId: id.loc,
          specialistId: id.spec,
          serviceId: id.svc,
          startsAt: at("11:15"),
          override: true,
        });
        if (!r.ok) throw new Error(r.error);
        const { data } = await admin
          .from("appointment_reminders")
          .select("id")
          .eq("appointment_id", r.appointment.id)
          .single();
        await admin
          .from("appointment_reminders")
          .update({ due_at: new Date(Date.now() - 1000).toISOString() })
          .eq("id", data!.id);
        return data!.id;
      };

      // test mode: phone not on the allow-list → excluded
      await c.query(
        `update public.orgs set settings = jsonb_set(settings, '{appointments,reminder_test_mode}', 'true') where id = $1`,
        [org],
      );
      const r1 = await make();
      expect(await processReminder(admin, org, r1, log)).toBe("excluded");
      const { data: x1 } = await admin
        .from("appointment_reminders")
        .select("exclusion_reason")
        .eq("id", r1)
        .single();
      expect(x1?.exclusion_reason).toBe("test_mode");

      // allow-listed → sent
      await c.query(
        `update public.orgs set settings = jsonb_set(settings, '{appointments,reminder_test_numbers}', '["+971500000001"]') where id = $1`,
        [org],
      );
      const r2 = await make();
      expect(await processReminder(admin, org, r2, log)).toBe("sent");

      // exclusion list
      await c.query(
        `update public.orgs set settings = jsonb_set(settings, '{appointments,reminder_test_mode}', 'false') where id = $1`,
        [org],
      );
      await c.query(
        "insert into public.reminder_exclusions (org_id, kind, match_type, value) values ($1, 'placeholder_name', 'contains', 'sara')",
        [org],
      );
      const r3 = await make();
      expect(await processReminder(admin, org, r3, log)).toBe("excluded");
      const { data: x3 } = await admin
        .from("appointment_reminders")
        .select("exclusion_reason")
        .eq("id", r3)
        .single();
      expect(x3?.exclusion_reason).toBe("exclusion_list");
    });

    it("a reminder that cannot be sent leaves one 'call patient' task, however often it is reported", async () => {
      await c.query("delete from public.reminder_exclusions where org_id = $1", [org]);
      await c.query(
        `update public.orgs set settings = jsonb_set(settings, '{appointments,templates,reminder}', 'null'::jsonb) where id = $1`,
        [org],
      );
      const r = await createAppointment(admin, {
        orgId: org,
        actorId: user,
        contactId: id.contact,
        locationId: id.loc,
        specialistId: id.spec,
        serviceId: id.svc,
        startsAt: at("11:45"),
        override: true,
      });
      if (!r.ok) throw new Error(r.error);
      const appt = r.appointment;
      const { data: rem } = await admin
        .from("appointment_reminders")
        .select("id")
        .eq("appointment_id", appt.id)
        .single();
      await admin
        .from("appointment_reminders")
        .update({ due_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", rem!.id);

      // No tasks exist for a reminder that went out fine (the earlier appointment's was sent).
      const none = await admin.from("tasks").select("id").eq("appointment_id", apptId);
      expect(none.data).toHaveLength(0);

      expect(await processReminder(admin, org, rem!.id, log)).toBe("failed");
      const tasks = async () =>
        (await admin.from("tasks").select("*").eq("appointment_id", appt.id)).data ?? [];
      let rows = await tasks();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "call",
        done: false,
        contact_id: id.contact,
        assignee_id: user,
        enquiry_id: null,
      });
      // Appointment number only: no patient or doctor names in the subject.
      expect(rows[0].subject).toContain(`#${appt.number}`);
      expect(rows[0].subject).not.toMatch(/Sara|Example/);
      const due = new Date(rows[0].due_at).getTime() - Date.now();
      expect(due).toBeGreaterThan(25 * 60_000);
      expect(due).toBeLessThan(31 * 60_000);

      // Reported again (a replayed job, or the delivery-failed hook after the send): still one.
      await reportReminderFailure(admin, org, appt.id, appt.number, "delivery failed");
      expect(await tasks()).toHaveLength(1);

      // Once the call is made, a later failure may raise a new one.
      await admin.from("tasks").update({ done: true, done_at: new Date().toISOString() }).eq("id", rows[0].id);
      await reportReminderFailure(admin, org, appt.id, appt.number, "delivery failed");
      rows = await tasks();
      expect(rows).toHaveLength(2);
      expect(rows.filter((t) => !t.done)).toHaveLength(1);
    });
  },
);
