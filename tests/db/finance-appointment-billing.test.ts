/**
 * W2: fin_appt_import() and the two appointment tables. One transaction per file, the same file twice is a no-op, a new
 * file supersedes only the same dates and clinics (nothing is deleted), rows outside the file's own range are refused,
 * the tables are service-role only and the function is not callable by signed-in users. Synthetic data only. Needs
 * TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const SHA = (i: number) => i.toString(16).padStart(64, "0");
const row = (
  n: number,
  date: string,
  clinic: string | null,
  over: Record<string, unknown> = {},
) => ({
  row_no: n,
  appointment_id: `A${n}`,
  appt_date: date,
  start_min: 540,
  duration_min: 30,
  status: "honoured",
  patient_pin: "9000001",
  doctor_name: "Dr. Omar Testdoc",
  doctor_key: "omar testdoc",
  clinic_name: clinic,
  room: "Room 1",
  ...over,
});

describe.skipIf(!TEST_DATABASE_URL)("Finance appointment import (W2)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const imp = (org: string, sha: number, from: string, to: string, rows: unknown[]) =>
    svc(async () => {
      const { rows: r } = await q("select public.fin_appt_import($1, $2, $3, $4) as j", [
        org,
        alice,
        JSON.stringify({ file_sha256: SHA(sha), from_date: from, to_date: to }),
        JSON.stringify(rows),
      ]);
      return r[0].j as { upload_id: string; existing: boolean; rows: number; superseded: number };
    });
  const current = (org: string) =>
    svc(async () => {
      const { rows } = await q(
        "select appointment_id from public.fin_appt_rows where org_id = $1 and is_current order by appointment_id",
        [org],
      );
      return rows.map((r) => r.appointment_id as string);
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-appt@example.test");
    const bob = await createAuthUser(c, "bob-appt@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
  });
  afterAll(async () => {
    await c.end();
  });

  it("stores the rows and makes them current", async () => {
    const r = await imp(orgA, 1, "2026-09-01", "2026-09-30", [
      row(1, "2026-09-01", "Clinic One"),
      row(2, "2026-09-15", "Clinic One"),
      row(3, "2026-09-15", "Clinic Two", {
        status: "awaiting",
        duration_min: null,
        start_min: null,
        room: null,
      }),
    ]);
    expect(r).toMatchObject({ existing: false, rows: 3, superseded: 0 });
    expect(await current(orgA)).toEqual(["A1", "A2", "A3"]);
  });

  it("the same file again is a no-op", async () => {
    const r = await imp(orgA, 1, "2026-09-01", "2026-09-30", [row(9, "2026-09-02", "Clinic One")]);
    expect(r).toMatchObject({ existing: true, rows: 3, superseded: 0 });
    expect(await current(orgA)).toEqual(["A1", "A2", "A3"]);
  });

  it("a new file supersedes only the same dates and clinics, and nothing is deleted", async () => {
    const r = await imp(orgA, 2, "2026-09-10", "2026-09-20", [
      row(1, "2026-09-15", "Clinic One", { appointment_id: "B1" }),
    ]);
    expect(r).toMatchObject({ existing: false, rows: 1, superseded: 1 });
    // A1 (1 Sep) is outside the range; A3 is another clinic; A2 (15 Sep, Clinic One) was replaced
    expect(await current(orgA)).toEqual(["A1", "A3", "B1"]);
    const { rows } = await svc(() =>
      q("select count(*)::int as n from public.fin_appt_rows where org_id = $1", [orgA]),
    );
    expect(rows[0].n).toBe(4);
  });

  it("refuses a row outside the file's own range, a bad status and bad input", async () => {
    await expect(
      imp(orgA, 3, "2026-09-01", "2026-09-05", [row(1, "2026-09-09", null)]),
    ).rejects.toThrow(/appt_rows_out_of_range/);
    await expect(
      imp(orgA, 4, "2026-09-01", "2026-09-05", [row(1, "2026-09-02", null, { status: "done" })]),
    ).rejects.toThrow(/fin_appt_rows_status_check/);
    await expect(
      imp(orgA, 5, "2026-09-05", "2026-09-01", [row(1, "2026-09-02", null)]),
    ).rejects.toThrow(/appt_bad_input/);
    await expect(imp(orgA, 6, "2026-09-01", "2026-09-05", [])).rejects.toThrow(/appt_bad_input/);
    // a failed import leaves nothing behind
    const { rows } = await svc(() =>
      q(
        "select count(*)::int as n from public.fin_appt_uploads where org_id = $1 and file_sha256 = any($2)",
        [orgA, [SHA(3), SHA(4), SHA(5), SHA(6)]],
      ),
    );
    expect(rows[0].n).toBe(0);
  });

  it("keeps organisations apart", async () => {
    await imp(orgB, 7, "2026-09-01", "2026-09-30", [row(1, "2026-09-15", "Clinic One")]);
    expect(await current(orgB)).toEqual(["A1"]);
    expect(await current(orgA)).toEqual(["A1", "A3", "B1"]);
    // the same sha in another org is its own upload
    const r = await imp(orgB, 1, "2026-09-01", "2026-09-30", [row(2, "2026-09-16", "Clinic One")]);
    expect(r.existing).toBe(false);
  });

  it("signed-in users can neither read the tables nor run the function", async () => {
    for (const t of ["fin_appt_rows", "fin_appt_uploads"])
      await expect(
        asUser(c, alice, () => q(`select * from public.${t}`)),
        t,
      ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(c, alice, () => q("select public.fin_appt_import($1, $2, '{}', '[]')", [orgA, alice])),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await q(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fin_appt_import'`,
    );
    expect(rows).toEqual([
      { anon: false, auth: false, svc: true, definer: true, config: 'search_path=""' },
    ]);
  });

  it("RLS is on with no policies", async () => {
    const { rows } = await q(
      `select c.relname, c.relrowsecurity as rls,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c where c.relname in ('fin_appt_rows', 'fin_appt_uploads') order by 1`,
    );
    expect(rows).toEqual([
      { relname: "fin_appt_rows", rls: true, policies: 0 },
      { relname: "fin_appt_uploads", rls: true, policies: 0 },
    ]);
  });
});
