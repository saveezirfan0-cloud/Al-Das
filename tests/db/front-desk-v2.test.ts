/**
 * Phase E (docs/34): front desk and appointments v2 against the database.
 *
 *  - contacts.whatsapp_declined_at: the column, its RLS (it rides on contacts), and that appointment messages,
 *    reminders and desk messages are never queued to a walk-in who did not agree to WhatsApp (through PostgREST).
 *  - The arrival check loader fails closed and reads expiry / status only.
 *  - The slip and payment record loaders.
 *
 * Synthetic names and reserved test numbers only. The PostgREST part runs only when TEST_POSTGREST_URL and
 * TEST_SERVICE_JWT are set (supabase/test/README.md).
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppointment, sendAppointmentTemplate } from "@/lib/appointments/service";
import { localDate, localMinutesToInstant } from "@/lib/appointments/slots";
import { loadArrivalChecks } from "@/lib/front-desk/arrival-check-server";
import { sendDeskMessage } from "@/lib/front-desk/desk-send";
import { loadPatientCard } from "@/lib/front-desk/server";
import { loadPaymentRecord, loadSlip } from "@/lib/front-desk/slip-server";
import {
  WHATSAPP_DECLINED_ERROR,
  WHATSAPP_DECLINED_REASON,
} from "@/lib/front-desk/whatsapp-consent";
import { processReminder } from "@/lib/jobs/handlers/appointments";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const TZ = "Asia/Dubai";
const log = { info: () => {}, warn: () => {}, error: () => {} };

function at(days: number, hhmm: string): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  const [h, m] = hhmm.split(":").map(Number);
  return localMinutesToInstant(localDate(d, TZ), h * 60 + m, TZ);
}

describe.skipIf(!TEST_DATABASE_URL)("Phase E: contacts.whatsapp_declined_at (SQL)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let contactA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    userA = await createAuthUser(c, "desk-a@example.test");
    userB = await createAuthUser(c, "desk-b@example.test");
    orgA = await createOrg(c, "Org EA", "org-ea", userA);
    orgB = await createOrg(c, "Org EB", "org-eb", userB);
    contactA = await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "insert into public.contacts (org_id, first_name, phone_e164, whatsapp_declined_at) values ($1, 'Layla', '+447700900501', now()) returning id",
        [orgA],
      );
      return rows[0].id as string;
    });
  });
  afterAll(async () => {
    await c?.end();
  });

  it("is a nullable timestamp, empty for every existing patient", async () => {
    const { rows } = await c.query(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'contacts' and column_name = 'whatsapp_declined_at'",
    );
    expect(rows).toEqual([
      { data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    ]);
    const plain = await asServiceRole(c, async () => {
      const { rows: r } = await c.query(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Omar', '+447700900502') returning whatsapp_declined_at",
        [orgA],
      );
      return r[0].whatsapp_declined_at;
    });
    expect(plain).toBeNull();
  });

  it("follows the contacts RLS: the org's own member reads it, another org sees nothing", async () => {
    const own = await asUser(c, userA, () =>
      count(c, "select 1 from public.contacts where id = $1 and whatsapp_declined_at is not null", [
        contactA,
      ]),
    );
    expect(own).toBe(1);
    const other = await asUser(c, userB, () =>
      count(c, "select 1 from public.contacts where id = $1", [contactA]),
    );
    expect(other).toBe(0);
    expect(orgB).not.toBe(orgA);
  });
});

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "Phase E services through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let user: string;
    const id: Record<string, string> = {};

    const q = async (sql: string, p: unknown[]) =>
      (await c.query(sql + " returning id", p)).rows[0].id as string;
    const settings = (over: Record<string, unknown> = {}) =>
      asServiceRole(c, () =>
        c.query("update public.orgs set settings = $2::jsonb where id = $1", [
          org,
          JSON.stringify({
            appointments: {
              templates: {
                reminder: id.reminderTpl,
                confirmed: id.reminderTpl,
                cancelled: null,
                rescheduled: null,
              },
              lead_time_minutes: 0,
              reminder_test_mode: false,
              reminder_test_numbers: [],
            },
            ...over,
          }),
        ]),
      );
    const book = async (contactId: string, startsAt: Date) => {
      const r = await createAppointment(admin, {
        orgId: org,
        actorId: user,
        contactId,
        locationId: id.loc,
        specialistId: id.dr,
        serviceId: id.svc,
        startsAt,
        override: true,
      });
      if (!r.ok) throw new Error(r.error);
      return r.appointment;
    };
    const member = (permissions: string[], orgSettings: Record<string, unknown> = {}) => ({
      userId: user,
      orgId: org,
      roleId: "r",
      status: "active" as const,
      permissions,
      org: { settings: orgSettings },
    });

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";

      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "desk-e@example.test");
      org = await createOrg(c, "Org E", "org-e", user);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;

      await asServiceRole(c, async () => {
        id.loc = await q(
          "insert into public.locations (org_id, name, address, timezone, latitude, longitude) values ($1, 'Test Branch', 'Example Street 9', 'Asia/Dubai', 25.2, 55.3)",
          [org],
        );
        id.dept = await q("insert into public.departments (org_id, name) values ($1, 'General')", [
          org,
        ]);
        id.svc = await q(
          "insert into public.services (org_id, department_id, name, duration_min) values ($1, $2, 'Consultation', 30)",
          [org, id.dept],
        );
        id.dr = await q(
          "insert into public.specialists (org_id, name, department_id) values ($1, 'Dr Example', $2)",
          [org, id.dept],
        );
        await c.query(
          "insert into public.specialist_locations (org_id, specialist_id, location_id) values ($1,$2,$3)",
          [org, id.dr, id.loc],
        );
        id.channel = await q(
          "insert into public.channels (org_id, name, waba_id, phone_number_id, display_phone) values ($1, 'Main', 'waba-e', 'pn-e', '+971 4 000 0000')",
          [org],
        );
        id.reminderTpl = await q(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
           values ($1, $2, 'waba-e', 'appointment_reminder', 'en', 'UTILITY', 'APPROVED',
                   '[{"type":"BODY","text":"Hi {{1}}, your visit is {{2}} with {{3}}."}]')`,
          [org, id.channel],
        );
        // A walk-in registered with a number but without the WhatsApp tick.
        id.declined = await q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, source, whatsapp_declined_at) values ($1, 'Layla', 'Demo-01', '+447700900511', 'walk_in', now())",
          [org],
        );
        id.agreed = await q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Sara', 'Demo-02', '+447700900512')",
          [org],
        );
        // A dependant whose guardian declined: the message would reach the guardian, so nothing goes.
        id.child = await q(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Omar', 'Demo-03')",
          [org],
        );
        await c.query(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1,$2,$3)",
          [org, id.declined, id.child],
        );
      });
      await settings();
    });

    afterAll(async () => {
      await c?.end();
    });

    it("never queues an appointment message to a patient who did not agree, nor to their dependant's guardian", async () => {
      for (const who of [id.declined, id.child]) {
        const appt = await book(who, at(5, who === id.child ? "11:00" : "10:00"));
        const res = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: appt.id,
          key: "reminder",
          sentByUserId: user,
        });
        expect(res).toEqual({ ok: false, error: WHATSAPP_DECLINED_ERROR });
      }
      expect(
        await count(c, "select 1 from public.conversations where contact_id = $1", [id.declined]),
      ).toBe(0);
      expect(
        await count(
          c,
          "select 1 from public.messages m join public.conversations v on v.id = m.conversation_id where v.contact_id = $1",
          [id.declined],
        ),
      ).toBe(0);
    });

    it("still sends to a patient with no refusal on record (nothing changes for them)", async () => {
      const appt = await book(id.agreed, at(5, "12:00"));
      const res = await sendAppointmentTemplate(admin, {
        orgId: org,
        appointmentId: appt.id,
        key: "reminder",
        sentByUserId: user,
      });
      expect(res.ok).toBe(true);
    });

    it("excludes the reminder (no failure, no call task, no SMS) with the reason", async () => {
      const appt = await book(id.declined, at(6, "10:00"));
      const reminder = await asServiceRole(c, async () => {
        await c.query("delete from public.appointment_reminders where appointment_id = $1", [
          appt.id,
        ]);
        return q(
          "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, status, dedupe_key) values ($1, $2, 1, now() - interval '1 minute', 'scheduled', $3)",
          [org, appt.id, `phase-e-test-${appt.id}`],
        );
      });
      const outcome = await processReminder(admin, org, reminder, log);
      expect(outcome).toBe("excluded");
      const { rows } = await c.query(
        "select status, exclusion_reason from public.appointment_reminders where id = $1",
        [reminder],
      );
      expect(rows[0]).toEqual({ status: "excluded", exclusion_reason: WHATSAPP_DECLINED_REASON });
      expect(
        await count(c, "select 1 from public.tasks where org_id = $1 and type = 'call'", [org]),
      ).toBe(0);
    });

    it("refuses the desk's location and running-late messages", async () => {
      const res = await sendDeskMessage(admin, {
        orgId: org,
        userId: user,
        contactId: id.declined,
        kind: "location",
        locationId: id.loc,
      });
      expect(res).toEqual({ ok: false, error: WHATSAPP_DECLINED_ERROR });
    });

    it("shows the refusal on the patient card, and clearing it lets messages go again", async () => {
      const card = await loadPatientCard(admin, org, id.declined);
      expect(card?.contact.whatsapp_declined).toBe(true);
      expect(card?.flags.map((f) => f.key)).toContain("whatsapp_declined");
      await asServiceRole(c, () =>
        c.query("update public.contacts set whatsapp_declined_at = null where id = $1", [
          id.declined,
        ]),
      );
      const appt = await book(id.declined, at(7, "10:00"));
      const res = await sendAppointmentTemplate(admin, {
        orgId: org,
        appointmentId: appt.id,
        key: "reminder",
        sentByUserId: user,
      });
      expect(res.ok).toBe(true);
      await asServiceRole(c, () =>
        c.query("update public.contacts set whatsapp_declined_at = now() where id = $1", [
          id.declined,
        ]),
      );
    });

    it("arrival checks fail closed: off, not allowed, then real expiry and cover from the data", async () => {
      const appt = await book(id.agreed, at(0, "23:00"));
      const today = localDate(new Date(), TZ);
      // Documents off and no finance key: nothing is read, everything says Not checked.
      const off = await loadArrivalChecks(admin, member(["appointments.view"]), [appt], today);
      expect(off[appt.id].map((l) => l.tone)).toEqual(["unknown", "unknown", "unknown"]);
      expect(off[appt.id][0].label).toBe("Not checked (patient documents off)");

      await asServiceRole(c, async () => {
        await c.query(
          `insert into public.patient_documents (org_id, contact_id, category, title, storage_path, mime_type, size_bytes, status, scan_status, expires_on)
           values ($1, $2, 'insurance_card', 'Card title never read', $3, 'image/png', 10, 'ready', 'unscanned', current_date - 3)`,
          [org, id.agreed, `${org}/${id.agreed}/00000000-0000-4000-8000-00000000e001`],
        );
        await c.query(
          "insert into public.fin_eligibility_checks (org_id, contact_id, payer_id, status, valid_to, checked_on) values ($1, $2, 'PAYER-1', 'verified', current_date + 30, current_date)",
          [org, id.agreed],
        );
      });
      const on = await loadArrivalChecks(
        admin,
        member(["appointments.view", "documents.view", "finance.eligibility.manage"], {
          documents: { enabled: true },
        }),
        [appt],
        today,
      );
      const [insurance, eligibility, consent] = on[appt.id];
      expect(insurance).toMatchObject({ tone: "alert", label: "Insurance card expired" });
      expect(JSON.stringify(on)).not.toContain("Card title never read");
      expect(eligibility.tone).toBe("ok");
      // E-signature is not switched on in this workspace.
      expect(consent.label).toBe("Not checked (e-signature off)");
      // The finance window or a missing key turns eligibility back to Not checked.
      const restricted = await loadArrivalChecks(
        admin,
        {
          ...member(["appointments.view", "finance.eligibility.manage"]),
          restrictedAreas: ["finance"],
        },
        [appt],
        today,
      );
      expect(restricted[appt.id][1].tone).toBe("unknown");
    });

    it("slip: first name only and the branch address; payment record from the finance mirror", async () => {
      const appt = await asServiceRole(c, () =>
        q(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, department_id, starts_at, ends_at, status, source, external_id) values ($1, $2, $3, $4, $5, $6, now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed', 'unite', 'U-PHASE-E-1')",
          [org, id.agreed, id.loc, id.dr, id.svc, id.dept],
        ),
      );
      const slip = await loadSlip(admin, org, appt, TZ);
      expect(slip).toMatchObject({
        first_name: "Sara",
        doctor: "Dr Example",
        branch: { name: "Test Branch", address: "Example Street 9" },
      });
      expect(JSON.stringify(slip)).not.toContain("Demo-02");
      expect(await loadSlip(admin, "00000000-0000-4000-8000-000000000000", appt, TZ)).toBeNull();

      expect(await loadPaymentRecord(admin, org, slip!)).toEqual({
        invoices: 0,
        lines: [],
        total: 0,
      });
      await asServiceRole(c, async () => {
        const inv = await q(
          "insert into public.fin_invoices (org_id, inv_display_number, appointment_id, total, record_hash) values ($1, 'INV-E-1', 'U-PHASE-E-1', 300, 'h')",
          [org],
        );
        await c.query(
          "insert into public.fin_payments (org_id, invoice_id, payment_key, paid, paid_date, payment_mode, receipt_number) values ($1, $2, 'INV-E-1|1|R-1', 120, current_date, 'Card', 'R-1')",
          [org, inv],
        );
      });
      const record = await loadPaymentRecord(admin, org, slip!);
      expect(record).toMatchObject({ invoices: 1, total: 120 });
      expect(record?.lines).toEqual([
        { date: expect.any(String), mode: "Card", amount: 120, reference: "R-1" },
      ]);
    });
  },
);
