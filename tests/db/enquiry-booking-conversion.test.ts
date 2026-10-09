/**
 * report_enquiry_booking_conversion and tasks.appointment_id (20261010001100). Synthetic data only:
 * the contact has a placeholder phone, appointments are Unite-style rows without names.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, asUser, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("enquiry → booking conversion and call tasks", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let pipeline: string;
  let stage: string;
  let patient: string;
  let otherPatient: string;
  const q = async <T,>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as T[];

  async function enquiry(title: string, contact: string | null, createdAt: string) {
    const { rows } = await c.query<{ id: string }>(
      "insert into public.enquiries (org_id, pipeline_id, stage_id, title, contact_id, created_at) values ($1, $2, $3, $4, $5, $6) returning id",
      [orgA, pipeline, stage, title, contact, createdAt],
    );
    return rows[0].id;
  }
  async function appointment(org: string, contact: string | null, startsAt: string, status: string) {
    const { rows } = await c.query<{ id: string }>(
      `insert into public.appointments (org_id, contact_id, starts_at, ends_at, status, source)
       values ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes', $4, 'portal') returning id`,
      [org, contact, startsAt, status],
    );
    return rows[0].id;
  }
  const conversion = (org: string) =>
    q<{ created: number; booked: number }>("select * from public.report_enquiry_booking_conversion($1, '2026-03-01', '2026-03-31')", [org]);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      pipeline = (await q<{ id: string }>("insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true) returning id", [orgA]))[0].id;
      stage = (await q<{ id: string }>("insert into public.stages (org_id, pipeline_id, name) values ($1, $2, 'New') returning id", [orgA, pipeline]))[0].id;
      patient = (await q<{ id: string }>("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Test', '+971500000401') returning id", [orgA]))[0].id;
      otherPatient = (await q<{ id: string }>("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Test', '+971500000402') returning id", [orgA]))[0].id;
    });
  });

  afterAll(async () => {
    await c.end();
  });

  it("counts an enquiry as booked only when its contact has a live appointment after it was created", async () => {
    await asServiceRole(c, async () => {
      await enquiry("booked", patient, "2026-03-05T06:00:00Z");
      await enquiry("not booked", otherPatient, "2026-03-05T06:00:00Z");
      await enquiry("no contact", null, "2026-03-05T06:00:00Z");
      const deleted = await enquiry("deleted", patient, "2026-03-05T06:00:00Z");
      await c.query("update public.enquiries set deleted_at = now() where id = $1", [deleted]);
      await enquiry("outside the period", patient, "2026-04-05T06:00:00Z");
      await appointment(orgA, patient, "2026-03-10T06:00:00Z", "confirmed");
      // never counts: before the enquiry, or cancelled
      await appointment(orgA, otherPatient, "2026-03-01T06:00:00Z", "completed");
      await appointment(orgA, otherPatient, "2026-03-12T06:00:00Z", "cancelled");

      expect(await conversion(orgA)).toEqual([{ created: 3, booked: 1 }]);

      await appointment(orgA, otherPatient, "2026-03-20T06:00:00Z", "no_show");
      expect(await conversion(orgA)).toEqual([{ created: 3, booked: 2 }]); // a no-show is still a booking
    });
  });

  it("is per organisation and closed to signed-in users", async () => {
    await asServiceRole(c, async () => {
      expect(await conversion(orgB)).toEqual([{ created: 0, booked: 0 }]);
    });
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.report_enquiry_booking_conversion($1, '2026-03-01', '2026-03-31')", [orgA])).rejects.toThrow(/permission denied/);
    });
  });

  describe("tasks.appointment_id", () => {
    let appt: string;
    beforeAll(async () => {
      await asServiceRole(c, async () => {
        appt = await appointment(orgA, patient, "2026-03-25T06:00:00Z", "confirmed");
      });
    });
    const task = (org: string, appointmentId: string, type = "call") =>
      c.query("insert into public.tasks (org_id, type, subject, due_at, appointment_id) values ($1, $2, 'Call', now(), $3)", [org, type, appointmentId]);

    it("allows one open call task per appointment, then another once it is done", async () => {
      await asServiceRole(c, async () => {
        await task(orgA, appt);
        await expect(task(orgA, appt)).rejects.toThrow(/tasks_open_call_per_appointment_uidx|duplicate key/);
        await task(orgA, appt, "follow_up"); // other task types are not limited
        await c.query("update public.tasks set done = true, done_at = now() where appointment_id = $1 and type = 'call'", [appt]);
        await task(orgA, appt);
      });
    });

    it("refuses another organisation's appointment", async () => {
      await asServiceRole(c, async () => {
        await expect(task(orgB, appt)).rejects.toThrow(/does not belong to org/);
      });
    });

    it("keeps the task when the appointment goes away", async () => {
      await asServiceRole(c, async () => {
        await c.query("delete from public.appointments where id = $1", [appt]);
        const rows = await q<{ n: string }>("select count(*) as n from public.tasks where org_id = $1 and appointment_id is null and subject = 'Call'", [orgA]);
        expect(Number(rows[0].n)).toBeGreaterThan(0);
      });
    });
  });
});
