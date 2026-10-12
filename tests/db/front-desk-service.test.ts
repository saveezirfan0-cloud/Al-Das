/**
 * Phase 14 service paths through a real PostgREST in front of the test database: household reminder
 * addressing, the waiting list from cancellation to first YES, training mode, shared phones in matching, the
 * one-tap desk messages, and the board / card / end-of-day queries. Runs only when TEST_POSTGREST_URL and
 * TEST_SERVICE_JWT are set (see supabase/test/README.md). Synthetic names and reserved test numbers only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { applyReminderReply } from "@/lib/appointments/replies";
import {
  changeAppointmentStatus,
  createAppointment,
  rescheduleAppointment,
  sendAppointmentTemplate,
  syncAppointmentReminders,
} from "@/lib/appointments/service";
import { localDate, localMinutesToInstant } from "@/lib/appointments/slots";
import { matchContact } from "@/lib/contacts/import-writer";
import { logDeskCall, sendDeskMessage } from "@/lib/front-desk/desk-send";
import { loadEndOfDay } from "@/lib/front-desk/end-of-day-server";
import { expireOffer, handleOfferReply, offerFreedSlot } from "@/lib/front-desk/offers";
import { loadBoardRows, loadNextFreeSlots, loadPatientCard } from "@/lib/front-desk/server";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import { processReminder } from "@/lib/jobs/handlers/appointments";
import { TrainingModeError } from "@/lib/training/mode";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { resolveSyncReview } from "@/lib/unite/review";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const log = { info: () => {}, warn: () => {}, error: () => {} };
const TZ = "Asia/Dubai";

/** A local Dubai time `days` from now, e.g. at(5, "10:00"). */
function at(days: number, hhmm: string): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  const [h, m] = hhmm.split(":").map(Number);
  return localMinutesToInstant(localDate(d, TZ), h * 60 + m, TZ);
}

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "front desk services through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let user: string;
    const id: Record<string, string> = {};

    const q = async (sql: string, p: unknown[]) =>
      (await c.query(sql + " returning id", p)).rows[0].id as string;
    const asService = async <T>(fn: () => Promise<T>) => {
      await c.query("set role service_role");
      try {
        return await fn();
      } finally {
        await c.query("reset role");
      }
    };
    const setSettings = (settings: Record<string, unknown>) =>
      asService(() =>
        c.query("update public.orgs set settings = $2::jsonb where id = $1", [
          org,
          JSON.stringify(settings),
        ]),
      );
    const frontDesk = (over: Record<string, unknown> = {}) => ({
      front_desk: {
        offers_enabled: true,
        offer_template_id: id.offerTpl,
        offer_ttl_minutes: 15,
        offer_batch_size: 1,
        offer_min_lead_minutes: 60,
        location_template_id: null,
        running_late_template_id: null,
        ...over,
      },
      appointments: {
        templates: {
          reminder: id.reminderTpl,
          confirmed: null,
          cancelled: null,
          rescheduled: null,
        },
        lead_time_minutes: 0,
        reminder_test_mode: false,
        reminder_test_numbers: [],
      },
    });
    const sentMessages = async (conversationId: string) =>
      (
        await c.query(
          "select id, kind, body, status, payload from public.messages where conversation_id = $1 and direction = 'out' order by created_at",
          [conversationId],
        )
      ).rows;
    const conversationOf = async (contactId: string) =>
      (
        await c.query(
          "select id, last_inbound_at from public.conversations where contact_id = $1 order by created_at desc limit 1",
          [contactId],
        )
      ).rows[0] as { id: string; last_inbound_at: string | null } | undefined;
    const newContact = async (first: string, phone: string | null) =>
      asService(() =>
        q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, language) values ($1, $2, 'Waiter', $3, 'en')",
          [org, first, phone],
        ),
      );
    const book = async (contactId: string, startsAt: Date, specialist = id.drA) => {
      const r = await createAppointment(admin, {
        orgId: org,
        actorId: user,
        contactId,
        locationId: id.loc,
        specialistId: specialist,
        serviceId: id.svc,
        startsAt,
        override: true,
      });
      if (!r.ok) throw new Error(r.error);
      return r.appointment;
    };

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";

      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "admin@example.test");
      org = await createOrg(c, "Org F", "org-f", user);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;

      await asService(async () => {
        id.loc = await q(
          "insert into public.locations (org_id, name, address, latitude, longitude, maps_url) values ($1, 'Test Clinic', 'Example Street 1', 25.2, 55.3, 'https://maps.example.test/clinic')",
          [org],
        );
        id.dept = await q("insert into public.departments (org_id, name) values ($1, 'General')", [
          org,
        ]);
        id.svc = await q(
          "insert into public.services (org_id, department_id, name, duration_min) values ($1, $2, 'Consultation', 30)",
          [org, id.dept],
        );
        id.svcLong = await q(
          "insert into public.services (org_id, department_id, name, duration_min) values ($1, $2, 'Long consult', 60)",
          [org, id.dept],
        );
        id.drA = await q(
          "insert into public.specialists (org_id, name, department_id) values ($1, 'Dr Alpha', $2)",
          [org, id.dept],
        );
        id.drB = await q(
          "insert into public.specialists (org_id, name, department_id) values ($1, 'Dr Beta', $2)",
          [org, id.dept],
        );
        for (const dr of [id.drA, id.drB]) {
          await c.query(
            "insert into public.specialist_locations (org_id, specialist_id, location_id) values ($1,$2,$3)",
            [org, dr, id.loc],
          );
          await c.query(
            "insert into public.specialist_services (org_id, specialist_id, service_id) values ($1,$2,$3), ($1,$2,$4)",
            [org, dr, id.svc, id.svcLong],
          );
          for (let wd = 1; wd <= 7; wd++)
            await c.query(
              "insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1,$2,$3,$4,540,1020)",
              [org, dr, id.loc, wd],
            );
        }
        id.channel = await q(
          "insert into public.channels (org_id, name, waba_id, phone_number_id, display_phone) values ($1, 'Main', 'waba-1', 'pn-1', '+971 4 000 0000')",
          [org],
        );
        id.reminderTpl = await q(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
           values ($1, $2, 'waba-1', 'appointment_reminder', 'en', 'UTILITY', 'APPROVED',
                   '[{"type":"BODY","text":"Hi {{1}}, your visit is {{2}} with {{3}}."}]')`,
          [org, id.channel],
        );
        id.offerTpl = await q(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components, variable_map)
           values ($1, $2, 'waba-1', 'slot_offer', 'en', 'UTILITY', 'APPROVED',
                   '[{"type":"BODY","text":"A place opened with {{1}} on {{2}}."},{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"Yes, book it"},{"type":"QUICK_REPLY","text":"No thanks"}]}]',
                   '{"body.1":"appointment.specialist","body.2":"appointment.datetime"}'::jsonb)`,
          [org, id.channel],
        );
        id.guardian = await q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, language) values ($1, 'Layla', 'Example', '+971500000201', 'en')",
          [org],
        );
        id.child = await q(
          "insert into public.contacts (org_id, first_name, last_name, dob) values ($1, 'Omar', 'Example', '2019-06-11')",
          [org],
        );
        id.adult = await q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, language) values ($1, 'Sam', 'Example', '+971500000202', 'en')",
          [org],
        );
        await c.query(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1,$2,$3)",
          [org, id.guardian, id.child],
        );
      });
      await setSettings(frontDesk());
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await c?.end();
    });
    afterEach(() => vi.restoreAllMocks());

    // -------------------------------------------------------------------------------------------
    describe("household reminder addressing", () => {
      it("sends a child's reminder to the guardian's conversation and names the child", async () => {
        const appt = await book(id.child, at(6, "10:00"));
        const res = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: appt.id,
          key: "reminder",
          sentByUserId: null,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;

        const { rows } = await c.query(
          "select m.body, m.payload, c.contact_id from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = $1",
          [res.messageId],
        );
        expect(rows[0].contact_id).toBe(id.guardian); // the guardian's number, not a number the child does not have
        const send = rows[0].payload.send as { type: string; values: Record<string, string> };
        expect(send.type).toBe("template");
        expect(send.values["body.1"]).toBe("Layla (for Omar)");
        expect(rows[0].body).toContain("Omar");
        // and nothing was opened for the child
        const childConvs = await c.query(
          "select 1 from public.conversations where contact_id = $1",
          [id.child],
        );
        expect(childConvs.rowCount).toBe(0);
      });

      it("leaves an ordinary patient's reminder exactly as before", async () => {
        const appt = await book(id.adult, at(6, "11:00"));
        const res = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: appt.id,
          key: "reminder",
          sentByUserId: null,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const { rows } = await c.query(
          "select m.payload, c.contact_id from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = $1",
          [res.messageId],
        );
        expect(rows[0].contact_id).toBe(id.adult);
        expect((rows[0].payload.send as { values: Record<string, string> }).values["body.1"]).toBe(
          "Sam",
        );
      });

      it("counts the guardian's Confirm tap as the child's answer, and nobody else's", async () => {
        const appt = await book(id.child, at(7, "10:00"));
        const res = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: appt.id,
          key: "reminder",
          sentByUserId: null,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        await asService(async () => {
          await c.query(
            "update public.messages set wa_message_id = 'wamid.household-1' where id = $1",
            [res.messageId],
          );
          await syncAppointmentReminders(admin, appt);
          await c.query(
            "update public.appointment_reminders set message_id = $1, status = 'sent' where appointment_id = $2",
            [res.messageId, appt.id],
          );
        });
        const button = { type: "button_reply", id: "confirm", title: "Confirm" };

        const stranger = await applyReminderReply(admin, {
          orgId: org,
          contactId: id.adult,
          replyToWaMessageId: "wamid.household-1",
          interactive: button,
        });
        expect(stranger).toBe("no_reminder");
        const mine = await applyReminderReply(admin, {
          orgId: org,
          contactId: id.guardian,
          replyToWaMessageId: "wamid.household-1",
          interactive: button,
        });
        expect(mine).toBe("confirmed");
        const { rows } = await c.query("select status from public.appointments where id = $1", [
          appt.id,
        ]);
        expect(rows[0].status).toBe("confirmed");
      });

      it("checks the guardian's number against the reminder test list, not the child's (who has none)", async () => {
        const appt = await book(id.child, at(8, "10:00"));
        const prepare = async (numbers: string[]) => {
          await setSettings({
            ...frontDesk(),
            appointments: {
              ...frontDesk().appointments,
              reminder_test_mode: true,
              reminder_test_numbers: numbers,
            },
          });
          await asService(async () => {
            await c.query("delete from public.appointment_reminders where appointment_id = $1", [
              appt.id,
            ]);
            await c.query(
              "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, status) values ($1, $2, 2, now() - interval '1 minute', 'scheduled')",
              [org, appt.id],
            );
          });
          const { rows } = await c.query(
            "select id from public.appointment_reminders where appointment_id = $1",
            [appt.id],
          );
          return rows[0].id as string;
        };
        const excluded = await processReminder(admin, org, await prepare(["+971500000999"]), log);
        expect(excluded).toBe("excluded");
        const sent = await processReminder(admin, org, await prepare(["+971500000201"]), log);
        expect(sent).toBe("sent");
        await setSettings(frontDesk());
      });
    });

    // -------------------------------------------------------------------------------------------
    describe("shared phones in contact matching", () => {
      it("does not treat a child arriving on the parent's number as the parent", async () => {
        await asService(async () => {
          await c.query(
            "update public.contacts set external_id = 'PIN-MUM' , dob = '1988-03-02' where id = $1",
            [id.guardian],
          );
          await c.query("update public.contacts set external_id = 'PIN-OMAR' where id = $1", [
            id.child,
          ]);
        });
        // The child, already linked as a dependant, is found through the parent's number.
        const known = await matchContact(admin, org, {
          phone: "+971500000201",
          fullName: "Omar Example",
          dob: "2019-06-11",
        });
        expect(known).toMatchObject({ kind: "match", id: id.child, on: "household_phone" }); // the child, found through her number
        const byName = await matchContact(admin, org, {
          phone: "+971500000201",
          fullName: "Omar Example",
          dob: "2019-06-11",
          externalId: "PIN-UNSEEN",
        });
        expect(byName.kind).toBe("ambiguous");

        // A second child not yet in Pulse is a shared phone for a person to resolve, not "Layla".
        const sibling = await matchContact(admin, org, {
          phone: "+971500000201",
          fullName: "Noor Example",
          dob: "2021-01-05",
          externalId: "PIN-NOOR",
        });
        expect(sibling).toMatchObject({ kind: "ambiguous" });
        if (sibling.kind === "ambiguous") {
          expect(sibling.candidates.every((x) => x.matched_on === "shared_phone")).toBe(true);
          expect(sibling.candidates.map((x) => x.contact_id).sort()).toEqual(
            [id.guardian, id.child].sort(),
          );
        }
        // The parent herself still matches by phone, and a bare phone behaves as it always did.
        expect(
          await matchContact(admin, org, {
            phone: "+971500000201",
            fullName: "Layla Example",
            dob: "1988-03-02",
          }),
        ).toMatchObject({ kind: "match", id: id.guardian });
        expect(await matchContact(admin, org, { phone: "+971500000201" })).toMatchObject({
          kind: "match",
          id: id.guardian,
          on: "phone",
        });
      });

      it("lets a reviewer create the new sibling as a dependant of the parent (no phone, linked)", async () => {
        const reviewId = await asService(() =>
          q(
            `insert into public.sync_reviews (org_id, source, entity, external_id, reason, candidates, incoming)
             values ($1, 'unite', 'patient', 'PIN-NOOR', 'shared_phone', '[]'::jsonb,
                     '{"pin":"PIN-NOOR","name":"Noor Example","phone_e164":"+971500000201","dob":"2021-01-05"}'::jsonb)`,
            [org],
          ),
        );
        const res = await resolveSyncReview(admin, {
          orgId: org,
          reviewId,
          userId: user,
          action: { kind: "create_dependant", guardianId: id.guardian },
        });
        expect(res.ok).toBe(true);
        if (!res.ok || !res.contactId) return;
        const { rows } = await c.query(
          "select c.phone_e164, c.external_id, c.dob::text as dob, h.guardian_contact_id from public.contacts c join public.household_links h on h.dependant_contact_id = c.id where c.id = $1",
          [res.contactId],
        );
        expect(rows[0]).toMatchObject({
          phone_e164: null,
          external_id: "PIN-NOOR",
          guardian_contact_id: id.guardian,
        });
        // Next time Noor arrives, the PIN finds her.
        expect(
          await matchContact(admin, org, { externalId: "PIN-NOOR", phone: "+971500000201" }),
        ).toMatchObject({ kind: "match", id: res.contactId });
      });
    });

    // -------------------------------------------------------------------------------------------
    describe("waiting list: from cancellation to first YES", () => {
      let w1: string;
      let w2: string;
      let w3: string;
      let waiter1: string;
      let waiter2: string;
      let waiter3: string;

      beforeAll(async () => {
        waiter1 = await newContact("Wanda", "+971500000211");
        waiter2 = await newContact("Walt", "+971500000212");
        waiter3 = await newContact("Wren", "+971500000213");
        await asService(async () => {
          // Order in the queue is the order they were added.
          w1 = await q(
            "insert into public.waitlist_entries (org_id, contact_id, specialist_id, created_at) values ($1,$2,$3, now() - interval '3 hours')",
            [org, waiter1, id.drA],
          );
          w2 = await q(
            "insert into public.waitlist_entries (org_id, contact_id, specialist_id, service_id, created_at) values ($1,$2,$3,$4, now() - interval '2 hours')",
            [org, waiter2, id.drA, id.svc],
          );
          w3 = await q(
            "insert into public.waitlist_entries (org_id, contact_id, specialist_id, created_at) values ($1,$2,$3, now() - interval '1 hour')",
            [org, waiter3, id.drB],
          );
        });
      });

      // pg hands back Date objects; the job payload carries ISO strings, which is what the code under test sees.
      const slotOf = (a: {
        specialist_id: string | null;
        location_id: string | null;
        service_id: string | null;
        starts_at: string | Date;
        ends_at: string | Date;
        id: string;
      }) => ({
        source_appointment_id: a.id,
        specialist_id: a.specialist_id!,
        location_id: a.location_id!,
        service_id: a.service_id,
        starts_at: new Date(a.starts_at).toISOString(),
        ends_at: new Date(a.ends_at).toISOString(),
      });
      const offersOf = async (start: string) =>
        (
          await c.query(
            "select o.id, o.status, o.sent_as, o.failure_reason, o.waitlist_entry_id, o.message_id, o.expires_at from public.slot_offers o where o.starts_at = $1 order by o.created_at",
            [start],
          )
        ).rows as Array<{
          id: string;
          status: string;
          sent_as: string | null;
          failure_reason: string | null;
          waitlist_entry_id: string;
          message_id: string | null;
          expires_at: string;
        }>;

      it("schedules a durable job when an appointment is cancelled", async () => {
        const appt = await book(id.adult, at(9, "10:00"));
        const res = await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        expect(res.ok).toBe(true);
        const { rows } = await c.query(
          "select kind, payload, run_at, dedupe_key from public.scheduled_jobs where kind = 'waitlist.freed' and payload->>'source_appointment_id' = $1",
          [appt.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toMatchObject({
          specialist_id: id.drA,
          starts_at: new Date(appt.starts_at).toISOString().replace(".000Z", "+00:00"),
        });
      });

      it("schedules one when an appointment is moved away from its slot", async () => {
        const appt = await book(id.adult, at(9, "14:00"));
        const res = await rescheduleAppointment(admin, {
          orgId: org,
          appointmentId: appt.id,
          actorId: user,
          startsAt: at(9, "15:00"),
          override: true,
        });
        expect(res.ok).toBe(true);
        const { rows } = await c.query(
          "select payload from public.scheduled_jobs where kind = 'waitlist.freed' and payload->>'source_appointment_id' = $1",
          [appt.id],
        );
        expect(rows).toHaveLength(1);
        expect(new Date(rows[0].payload.starts_at).getTime()).toBe(at(9, "14:00").getTime()); // the OLD time is what is free
      });

      it("offers the slot to the first matching person only (batch of one), by template when the window is closed", async () => {
        const appt = await book(id.adult, at(10, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows: cancelled } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        const slot = slotOf(cancelled[0]);

        const res = await offerFreedSlot(admin, { orgId: org, slot });
        expect(res).toMatchObject({ offered: 1, failed: 0 });
        const offers = await offersOf(slot.starts_at);
        expect(offers).toHaveLength(1);
        expect(offers[0]).toMatchObject({
          waitlist_entry_id: w1,
          status: "pending",
          sent_as: "template",
        });
        // Dr Beta's patient (w3) is never asked about Dr Alpha's slot.
        expect(offers.some((o) => o.waitlist_entry_id === w3)).toBe(false);
        // The expiry rides scheduled_jobs, not a timer.
        const jobs = await c.query(
          "select run_at from public.scheduled_jobs where kind = 'waitlist.expire' and payload->>'offer_id' = $1",
          [offers[0].id],
        );
        expect(jobs.rowCount).toBe(1);
        // The message went through the outbound queue as a template
        const conv = await conversationOf(waiter1);
        const msgs = await sentMessages(conv!.id);
        expect(msgs.at(-1)).toMatchObject({ kind: "template", status: "queued" });

        // Replaying the job asks nobody twice.
        const again = await offerFreedSlot(admin, { orgId: org, slot });
        expect(again.offered).toBe(0);
        expect((await offersOf(slot.starts_at)).length).toBe(1);
      });

      it("passes an expired offer on to the next person in order, and a refusal too", async () => {
        const appt = await book(id.adult, at(11, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows: cancelled } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        const slot = slotOf(cancelled[0]);
        await offerFreedSlot(admin, { orgId: org, slot });
        let offers = await offersOf(slot.starts_at);
        expect(offers.map((o) => o.waitlist_entry_id)).toEqual([w1]);

        // Not due yet: nothing changes.
        expect(await expireOffer(admin, org, offers[0].id, new Date())).toBe("not_due");
        // Past the expiry: w1 expires and w2 is asked.
        const later = new Date(new Date(offers[0].expires_at).getTime() + 1000);
        expect(await expireOffer(admin, org, offers[0].id, later)).toBe("expired");
        offers = await offersOf(slot.starts_at);
        expect(offers.map((o) => [o.waitlist_entry_id, o.status])).toEqual([
          [w1, "expired"],
          [w2, "pending"],
        ]);
        // w2 says NO: declined, and nobody else matches, so the slot just stays free.
        const conv2 = await conversationOf(waiter2);
        const declined = await handleOfferReply(admin, {
          orgId: org,
          contactId: waiter2,
          conversationId: conv2!.id,
          intent: "no",
        });
        expect(declined).toBe("declined");
        offers = await offersOf(slot.starts_at);
        expect(offers.map((o) => o.status)).toEqual(["expired", "declined"]);
        // Expiring twice is harmless.
        expect(await expireOffer(admin, org, offers[0].id, later)).toBe("gone");
      });

      it("uses plain text inside the 24-hour window and the template outside it, and skips someone it cannot reach", async () => {
        const appt = await book(id.adult, at(12, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows: cancelled } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        const slot = slotOf(cancelled[0]);
        // w1 wrote to us an hour ago: free text is allowed.
        const conv1 = await conversationOf(waiter1);
        await asService(() =>
          c.query(
            "update public.conversations set last_inbound_at = now() - interval '1 hour' where id = $1",
            [conv1!.id],
          ),
        );
        await offerFreedSlot(admin, { orgId: org, slot });
        expect((await offersOf(slot.starts_at))[0]).toMatchObject({
          waitlist_entry_id: w1,
          sent_as: "text",
        });
        const msgs = await sentMessages(conv1!.id);
        expect(msgs.at(-1).kind).toBe("text");
        expect(msgs.at(-1).body).toBe("Waiting list offer");
        expect((msgs.at(-1).payload.send as { body: string }).body).toMatch(
          /Reply YES within 15 minutes/,
        );
      });

      it("never sends outside the window without an approved template, and moves on to the next person", async () => {
        await setSettings(frontDesk({ offer_template_id: null }));
        const appt = await book(id.adult, at(13, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows: cancelled } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        const slot = slotOf(cancelled[0]);
        // w1: window closed (no inbound for 3 days) and no template; w2: wrote an hour ago.
        const conv1 = await conversationOf(waiter1);
        const conv2 = await conversationOf(waiter2);
        await asService(async () => {
          await c.query(
            "update public.conversations set last_inbound_at = now() - interval '3 days' where id = $1",
            [conv1!.id],
          );
          await c.query(
            "update public.conversations set last_inbound_at = now() - interval '5 minutes' where id = $1",
            [conv2!.id],
          );
        });
        const before = (await sentMessages(conv1!.id)).length;
        const res = await offerFreedSlot(admin, { orgId: org, slot });
        expect(res).toMatchObject({ offered: 1, failed: 1 });
        const offers = await offersOf(slot.starts_at);
        expect(offers.map((o) => [o.waitlist_entry_id, o.status, o.failure_reason])).toEqual([
          [w1, "failed", "window_closed_no_template"],
          [w2, "pending", null],
        ]);
        expect((await sentMessages(conv1!.id)).length).toBe(before); // nothing went to the closed window
        await setSettings(frontDesk());
      });

      it("does nothing at all while offers are switched off", async () => {
        await setSettings(frontDesk({ offers_enabled: false }));
        const appt = await book(id.adult, at(14, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        const res = await offerFreedSlot(admin, { orgId: org, slot: slotOf(rows[0]) });
        expect(res).toMatchObject({ offered: 0, skipped: "disabled" });
        expect((await offersOf(rows[0].starts_at)).length).toBe(0);
        await setSettings(frontDesk());
      });

      it("does not offer a slot that is too close, or that someone has already taken", async () => {
        const soon = new Date(Date.now() + 20 * 60_000);
        const near = await offerFreedSlot(admin, {
          orgId: org,
          slot: {
            source_appointment_id: null,
            specialist_id: id.drA,
            location_id: id.loc,
            service_id: id.svc,
            starts_at: soon.toISOString(),
            ends_at: new Date(soon.getTime() + 30 * 60_000).toISOString(),
          },
        });
        expect(near).toMatchObject({ skipped: "too_soon" });

        const taken = await book(id.adult, at(15, "10:00"));
        const busy = await offerFreedSlot(admin, { orgId: org, slot: slotOf(taken) });
        expect(busy).toMatchObject({ skipped: "slot_busy" });
      });

      it("books exactly one of two patients who both say YES at the same moment, and tells the other it has gone", async () => {
        await setSettings(frontDesk({ offer_batch_size: 2 }));
        const appt = await book(id.adult, at(16, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows: cancelled } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        const slot = slotOf(cancelled[0]);
        // Both are inside the 24h window so they can simply type YES.
        const conv1 = await conversationOf(waiter1);
        const conv2 = await conversationOf(waiter2);
        await asService(() =>
          c.query(
            "update public.conversations set last_inbound_at = now() - interval '2 minutes' where id = any($1)",
            [[conv1!.id, conv2!.id]],
          ),
        );
        const res = await offerFreedSlot(admin, { orgId: org, slot });
        expect(res.offered).toBe(2);

        const [a, b] = await Promise.all([
          handleOfferReply(admin, {
            orgId: org,
            contactId: waiter1,
            conversationId: conv1!.id,
            intent: "yes",
          }),
          handleOfferReply(admin, {
            orgId: org,
            contactId: waiter2,
            conversationId: conv2!.id,
            intent: "yes",
          }),
        ]);
        expect([a, b].sort()).toEqual(["booked", "taken"]);

        const { rows: appts } = await c.query(
          "select contact_id, status from public.appointments where specialist_id = $1 and starts_at = $2 and status <> 'cancelled'",
          [id.drA, slot.starts_at],
        );
        expect(appts).toHaveLength(1);
        expect(appts[0].status).toBe("confirmed");
        const winner = a === "booked" ? waiter1 : waiter2;
        expect(appts[0].contact_id).toBe(winner);
        const offers = await offersOf(slot.starts_at);
        expect(offers.map((o) => o.status).sort()).toEqual(["accepted", "taken"]);
        // Each got an honest answer in their own chat.
        const bodies = async (conv: string) =>
          (await sentMessages(conv))
            .filter((m) => m.status === "queued" && m.body === "Waiting list answer")
            .map((m) => (m.payload.send as { body: string }).body);
        const [b1, b2] = [await bodies(conv1!.id), await bodies(conv2!.id)];
        expect([b1.at(-1), b2.at(-1)].some((t) => /booked/.test(t ?? ""))).toBe(true);
        expect([b1.at(-1), b2.at(-1)].some((t) => /just been taken/.test(t ?? ""))).toBe(true);
        // The winner leaves the list; the other stays on it.
        const { rows: entries } = await c.query(
          "select id, status from public.waitlist_entries where id = any($1)",
          [[w1, w2]],
        );
        const st = new Map(entries.map((e) => [e.id, e.status]));
        expect(st.get(winner === waiter1 ? w1 : w2)).toBe("booked");
        expect(st.get(winner === waiter1 ? w2 : w1)).toBe("waiting");
        await setSettings(frontDesk());
      });

      it("ignores a reminder's Confirm button and a stray 'yes' from someone with no open offer", async () => {
        const appt = await book(id.adult, at(17, "10:00"));
        await changeAppointmentStatus(admin, {
          orgId: org,
          appointmentId: appt.id,
          to: "cancelled",
          actorId: user,
        });
        const { rows } = await c.query(
          "select id, specialist_id, location_id, service_id, starts_at, ends_at from public.appointments where id = $1",
          [appt.id],
        );
        // w1 is asked.
        const slot = slotOf(rows[0]);
        const waiting = await c.query(
          "select id from public.waitlist_entries where status = 'waiting' order by created_at limit 1",
        );
        expect(waiting.rowCount).toBe(1);
        await offerFreedSlot(admin, { orgId: org, slot });
        const offers = await offersOf(slot.starts_at);
        expect(offers).toHaveLength(1);
        const owner = (
          await c.query("select contact_id from public.waitlist_entries where id = $1", [
            offers[0].waitlist_entry_id,
          ])
        ).rows[0].contact_id as string;
        const conv = await conversationOf(owner);

        // A button tap that does not quote the offer message is not an answer (a "Confirm" on a reminder).
        const button = await handleOfferReply(admin, {
          orgId: org,
          contactId: owner,
          conversationId: conv!.id,
          intent: "yes",
          viaButton: true,
          replyToWaMessageId: "wamid.some-reminder",
        });
        expect(button).toBe("ignored");
        // Someone with no offer saying YES changes nothing.
        const nobody = await handleOfferReply(admin, {
          orgId: org,
          contactId: id.adult,
          conversationId: conv!.id,
          intent: "yes",
        });
        expect(nobody).toBe("no_offer");
        expect((await offersOf(slot.starts_at))[0].status).toBe("pending");
        // Unknown text is not an answer either.
        const maybe = await handleOfferReply(admin, {
          orgId: org,
          contactId: owner,
          conversationId: conv!.id,
          intent: "unknown",
        });
        expect(maybe).toBe("ignored");
      });

      it("keeps w3 (Dr Beta) and the entry statuses untouched by Dr Alpha's slots", async () => {
        const { rows } = await c.query("select status from public.waitlist_entries where id = $1", [
          w3,
        ]);
        expect(rows[0].status).toBe("waiting");
        const offered = await c.query(
          "select 1 from public.slot_offers where waitlist_entry_id = $1",
          [w3],
        );
        expect(offered.rowCount).toBe(0);
      });
    });

    // -------------------------------------------------------------------------------------------
    describe("training mode", () => {
      it("marks a queued message sent on screen and never calls Meta", async () => {
        await asService(() =>
          c.query("update public.orgs set is_training = true where id = $1", [org]),
        );
        try {
          // PostgREST traffic passes through; any request to Meta would fail the test.
          const realFetch = globalThis.fetch;
          const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (/facebook\.com/.test(url))
              throw new Error("Meta must not be called from a training workspace");
            return realFetch(input, init);
          });
          const conv = await conversationOf(id.adult);
          const { queueOutbound } = await import("@/lib/inbox/send");
          const msg = await queueOutbound(admin, {
            orgId: org,
            conversationId: conv!.id,
            spec: { type: "text", body: "Practice message" },
            body: "Practice message",
            sentByUserId: user,
          });
          await deliverOutbound(admin, msg.id, {
            queue: "outbound_priority",
            msgId: 1,
            readCt: 1,
            enqueuedAt: new Date(),
            admin,
            log,
          });
          const { rows } = await c.query(
            "select status, wa_message_id, payload from public.messages where id = $1",
            [msg.id],
          );
          expect(rows[0].status).toBe("sent");
          expect(rows[0].wa_message_id).toBe(`training:${msg.id}`);
          expect(rows[0].payload.training).toBe(true);
          const meta = fetchSpy.mock.calls.filter(([u]) => /graph\.facebook\.com/.test(String(u)));
          expect(meta).toHaveLength(0);

          // The Meta client itself refuses to be built for a training workspace.
          await expect(
            clientForChannel(admin, { id: id.channel, phone_number_id: "pn-1", waba_id: "waba-1" }),
          ).rejects.toBeInstanceOf(TrainingModeError);
        } finally {
          await asService(() =>
            c.query("update public.orgs set is_training = false where id = $1", [org]),
          );
        }
      });
    });

    // -------------------------------------------------------------------------------------------
    describe("one-tap desk messages", () => {
      it("sends a location pin inside the window, and refuses outside it without a template", async () => {
        const conv = await conversationOf(id.adult);
        await asService(() =>
          c.query(
            "update public.conversations set last_inbound_at = now() - interval '10 minutes' where id = $1",
            [conv!.id],
          ),
        );
        const ok = await sendDeskMessage(admin, {
          orgId: org,
          userId: user,
          contactId: id.adult,
          kind: "location",
        });
        expect(ok).toMatchObject({ ok: true, sentAs: "location" });
        const last = (await sentMessages(conv!.id)).at(-1);
        expect(last.kind).toBe("location");
        expect(last.payload.send).toMatchObject({
          type: "location",
          latitude: 25.2,
          longitude: 55.3,
          name: "Test Clinic",
        });

        await asService(() =>
          c.query(
            "update public.conversations set last_inbound_at = now() - interval '2 days' where id = $1",
            [conv!.id],
          ),
        );
        const closed = await sendDeskMessage(admin, {
          orgId: org,
          userId: user,
          contactId: id.adult,
          kind: "location",
        });
        expect(closed.ok).toBe(false);
        expect(!closed.ok && closed.error).toMatch(/24-hour/);
        const late = await sendDeskMessage(admin, {
          orgId: org,
          userId: user,
          contactId: id.adult,
          kind: "running_late",
          minutes: 15,
        });
        expect(late.ok).toBe(false);
      });

      it("sends 'running late' by the mapped template when the window is closed", async () => {
        const conv = await conversationOf(id.adult);
        await asService(async () => {
          id.lateTpl = await q(
            `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components, variable_map)
             values ($1, $2, 'waba-1', 'running_late', 'en', 'UTILITY', 'APPROVED',
                     '[{"type":"BODY","text":"{{1}}, we are running about {{2}} minutes late."}]',
                     '{"body.1":"contact.first_name","body.2":"delay.minutes"}'::jsonb)`,
            [org, id.channel],
          );
          await c.query(
            "update public.conversations set last_inbound_at = now() - interval '2 days' where id = $1",
            [conv!.id],
          );
        });
        await setSettings(frontDesk({ running_late_template_id: id.lateTpl }));
        const res = await sendDeskMessage(admin, {
          orgId: org,
          userId: user,
          contactId: id.adult,
          kind: "running_late",
          minutes: 30,
        });
        expect(res).toMatchObject({ ok: true, sentAs: "template" });
        const last = (await sentMessages(conv!.id)).at(-1);
        expect((last.payload.send as { values: Record<string, string> }).values).toEqual({
          "body.1": "Sam",
          "body.2": "30",
        });
        await setSettings(frontDesk());
      });

      it("logs a call as an open call task for the caller, once per few minutes", async () => {
        const first = await logDeskCall(admin, { orgId: org, userId: user, contactId: id.adult });
        const second = await logDeskCall(admin, { orgId: org, userId: user, contactId: id.adult });
        expect(first.reused).toBe(false);
        expect(second).toMatchObject({ reused: true, id: first.id });
        const { rows } = await c.query(
          "select type, done, assignee_id, contact_id from public.tasks where id = $1",
          [first.id],
        );
        expect(rows[0]).toEqual({
          type: "call",
          done: false,
          assignee_id: user,
          contact_id: id.adult,
        });
      });
    });

    // -------------------------------------------------------------------------------------------
    describe("board, patient card and end of day queries", () => {
      it("loads today's board with names, check-in fields and reminder state", async () => {
        const today = localDate(new Date(), TZ);
        const a = await book(id.guardian, localMinutesToInstant(today, 20 * 60, TZ));
        await asService(() =>
          c.query(
            "update public.appointments set checkin_status = 'arrived', arrived_at = now(), is_walk_in = true where id = $1",
            [a.id],
          ),
        );
        const rows = await loadBoardRows(admin, org, TZ, today);
        const mine = rows.find((r) => r.id === a.id);
        expect(mine).toMatchObject({
          patient_name: "Layla Example",
          specialist_name: "Dr Alpha",
          checkin_status: "arrived",
          is_walk_in: true,
          location_name: "Test Clinic",
        });
      });

      it("builds the patient card for a guardian with her child's next appointment and the household flags", async () => {
        const card = await loadPatientCard(admin, org, id.guardian);
        expect(card).not.toBeNull();
        expect(card!.household.dependants.map((d) => d.name)).toContain("Omar Example");
        expect(
          card!.household.dependants.find((d) => d.name === "Omar Example")?.next_starts_at,
        ).toBeTruthy();
        expect(card!.flags.map((f) => f.key)).toContain("guardian");
        expect(card!.next_appointment).not.toBeNull();
        const kid = await loadPatientCard(admin, org, id.child);
        expect(kid!.household.guardian).toMatchObject({
          id: id.guardian,
          name: "Layla Example",
          phone: "+971500000201",
        });
        expect(kid!.flags.map((f) => f.key)).toContain("dependant");
        expect(kid!.flags.map((f) => f.key)).not.toContain("no_whatsapp"); // reachable through the guardian
        expect(
          await loadPatientCard(admin, org, "00000000-0000-0000-0000-000000000000"),
        ).toBeNull();
      });

      it("lists the next free slots per doctor", async () => {
        const today = localDate(new Date(), TZ);
        const slots = await loadNextFreeSlots(admin, org, { today, durationMin: 30 });
        expect(slots.map((s) => s.specialist_name)).toEqual(["Dr Alpha", "Dr Beta"]);
        for (const s of slots) expect(s.slots.length).toBeGreaterThan(0);
      });

      it("builds the end-of-day sheet from tomorrow's bookings, open calls and failed sends", async () => {
        const today = localDate(new Date(), TZ);
        const tomorrow = localDate(new Date(Date.now() + 86_400_000), TZ);
        const t = await book(id.adult, localMinutesToInstant(tomorrow, 9 * 60 + 30, TZ), id.drB);
        const conv = await conversationOf(id.adult);
        await asService(async () => {
          await c.query(
            "update public.conversations set last_message_direction = 'in', status = 'open' where id = $1",
            [conv!.id],
          );
          await c.query(
            "insert into public.messages (org_id, conversation_id, direction, kind, body, status, error_code, error_message, at) values ($1,$2,'out','text','x','failed',131047,'Re-engagement message', now())",
            [org, conv!.id],
          );
        });
        const eod = await loadEndOfDay(admin, org, TZ, today);
        expect(eod.unconfirmed.map((u) => u.id)).toContain(t.id);
        expect(eod.unanswered.map((u) => u.id)).toContain(conv!.id);
        expect(eod.openCalls.some((x) => x.subject.startsWith("Call patient"))).toBe(true);
        expect(
          eod.failed.some((f) => f.error_code === 131047 && f.contact_name === "Sam Example"),
        ).toBe(true);
        // no message text anywhere on the sheet
        expect(JSON.stringify(eod)).not.toContain('"body":"x"');
      });
    });
  },
);
