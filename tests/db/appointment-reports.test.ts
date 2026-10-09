/**
 * Appointment report functions (20261009001400). Fixtures are synthetic: one org in Asia/Dubai (UTC+4)
 * so day bucketing is checked, a second org to prove isolation, and no patient data (contact_id is
 * null for Unite rows, which the schema allows).
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, asUser, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("appointment reports", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;

  async function appt(
    org: string,
    startsAt: string,
    status: string,
    opts: { contact?: string | null; location?: string | null; specialist?: string | null; source?: string; externalId?: string; externalStatus?: string } = {},
  ) {
    await c.query(
      `insert into public.appointments (org_id, starts_at, ends_at, status, source, contact_id, location_id, specialist_id, external_id, external_status)
       values ($1, $2::timestamptz, $2::timestamptz + interval '30 minutes', $3, $4, $5, $6, $7, $8, $9)`,
      [org, startsAt, status, opts.source ?? "unite", opts.contact ?? null, opts.location ?? null, opts.specialist ?? null, opts.externalId ?? null, opts.externalStatus ?? null],
    );
  }
  const q = async <T,>(sql: string, params: unknown[]) => (await c.query(sql, params)).rows as T[];

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const loc = (await c.query("insert into public.locations (org_id, name) values ($1, 'Main') returning id", [orgA])).rows[0].id;
      const dr = (await c.query("insert into public.specialists (org_id, name) values ($1, 'Dr Test') returning id", [orgA])).rows[0].id;
      const pat = (await c.query("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Test', '+971500000009') returning id", [orgA])).rows[0].id;
      await c.query(
        "insert into public.unite_appointment_status_map (org_id, code, status) values ($1, 'NSW', 'no_show'), ($1, 'AAC', null)",
        [orgA],
      );
      // 2026-03-10 20:30 UTC is 2026-03-11 00:30 in Dubai: it must land on the 11th.
      await appt(orgA, "2026-03-10T20:30:00Z", "completed", { location: loc, specialist: dr, externalId: "u1", externalStatus: "ACF" });
      await appt(orgA, "2026-03-11T06:00:00Z", "no_show", { location: loc, specialist: dr, externalId: "u2", externalStatus: "nsw" });
      await appt(orgA, "2026-03-11T07:00:00Z", "cancelled", { contact: pat, location: loc, specialist: dr, source: "portal" });
      await appt(orgA, "2026-03-12T07:00:00Z", "awaiting", { externalId: "u3", externalStatus: "AAC" });
      await appt(orgA, "2026-03-12T08:00:00Z", "confirmed", { contact: pat, source: "portal" });
      await appt(orgB, "2026-03-11T06:00:00Z", "no_show", { externalId: "b1", externalStatus: "NSW" });
    });
  });

  afterAll(async () => {
    await c.end();
  });

  it("counts by status for one org only, bucketed in the org timezone", async () => {
    await asServiceRole(c, async () => {
      const [s] = await q<Record<string, number>>("select * from public.report_appointments_summary($1, '2026-03-01', '2026-03-31')", [orgA]);
      expect(s).toEqual({ total: 5, awaiting: 1, confirmed: 1, cancelled: 1, completed: 1, no_show: 1 });

      const days = await q<{ day: Date; completed: number; no_show: number }>("select * from public.report_appointments_by_day($1, '2026-03-10', '2026-03-12')", [orgA]);
      expect(days).toHaveLength(3); // gap days are filled
      expect(days[0].completed).toBe(0); // 10 March has nothing: the 20:30 UTC one is the 11th in Dubai
      expect(days[1].completed).toBe(1);
      expect(days[1].no_show).toBe(1);
    });
  });

  it("breaks down by location and specialist, with a bucket for unassigned", async () => {
    await asServiceRole(c, async () => {
      const locs = await q<{ location_name: string; total: number; no_show: number }>("select * from public.report_appointments_by_location($1, '2026-03-01', '2026-03-31')", [orgA]);
      expect(locs.map((l) => [l.location_name, l.total])).toEqual([["Main", 3], ["No location", 2]]);
      const docs = await q<{ specialist_name: string; total: number; completed: number; no_show: number }>("select * from public.report_appointments_by_specialist($1, '2026-03-01', '2026-03-31')", [orgA]);
      expect(docs[0]).toMatchObject({ specialist_name: "Dr Test", total: 3, completed: 1, no_show: 1 });
      expect(docs[1].specialist_name).toBe("No specialist");
    });
  });

  it("reports Unite rows and which status codes are still unmapped (OQ-23)", async () => {
    await asServiceRole(c, async () => {
      const days = await q<{ appointments: number; unmapped: number }>("select * from public.report_unite_appointments_by_day($1, '2026-03-11', '2026-03-12')", [orgA]);
      // 11th: u1 (ACF, no map row -> unmapped) + u2 (nsw -> mapped, case-insensitive); 12th: u3 (AAC, map row but status null)
      expect(days.map((d) => [d.appointments, d.unmapped])).toEqual([[2, 1], [1, 1]]);
      const codes = await q<{ code: string; mapped_status: string | null }>("select * from public.report_unite_status_codes($1, '2026-03-01', '2026-03-31')", [orgA]);
      expect(Object.fromEntries(codes.map((r) => [r.code, r.mapped_status]))).toEqual({ ACF: null, AAC: null, nsw: "no_show" });
    });
  });

  it("is invisible to signed-in users: the view and functions are service-role only", async () => {
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.v_appointment_facts")).rejects.toThrow(/permission denied/);
    });
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.report_appointments_summary($1, '2026-03-01', '2026-03-31')", [orgA])).rejects.toThrow(/permission denied/);
    });
  });
});
