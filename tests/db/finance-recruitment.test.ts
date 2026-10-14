/**
 * M4 recruitment calculator: fin_recruitment_benchmarks() (full months only, doctor-months above 0, current rows,
 * branch scope, department and clinic percentiles, settings), the seeded calendar, and RLS on the calendar and the
 * saved scenarios (cross-org, the two-key rule, no browser writes), plus service-role-only functions. Synthetic data
 * only ("dr demo nn", made-up PINs). Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { parseBenchmarks, pickBenchmark } from "@/lib/finance/recruitment";

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

describe.skipIf(!TEST_DATABASE_URL)("Finance recruitment calculator (M4)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const bench = (org: string, branches: string[] | null = null) =>
    svc(async () => {
      const { rows } = await q("select public.fin_recruitment_benchmarks($1, $2) as j", [
        org,
        branches,
      ]);
      return rows[0].j as Record<string, unknown>;
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "ceo", "payroll"])
      users[n] = await createAuthUser(c, `${n}-recruit@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);

    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fin", "Finance"); // profit.view + costs.compensation
      await member("ceo", "CEO"); // profit.view only
      await member("payroll", "Cost / Payroll"); // costs.compensation only

      const upload = async (org: string, from: string, to: string, n: number) => {
        const { rows } = await q(
          `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
           values ($1, $2, $3, $4, 'committed', true, now()) returning id`,
          [org, from, to, SHA(n)],
        );
        return rows[0].id as string;
      };
      const aug = await upload(orgA, "2026-08-01", "2026-08-31", 1);
      // September is covered by two uploads that meet: still a full month
      const sep1 = await upload(orgA, "2026-09-01", "2026-09-15", 2);
      const sep2 = await upload(orgA, "2026-09-16", "2026-09-30", 3);
      const oct = await upload(orgA, "2026-10-01", "2026-10-10", 4); // part month: left out
      let rowNo = 0;
      const visit = (
        org: string,
        up: string,
        date: string,
        dept: string,
        doctor: string,
        net: number,
        branch = "S1",
        current = true,
      ) =>
        q(
          `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name, doctor_key,
             branch_code, patient_pin, net, is_current)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            org,
            up,
            ++rowNo,
            date,
            dept,
            `Dr Demo-${doctor}`,
            `dr demo ${doctor}`,
            branch,
            `9000000${(rowNo % 90) + 10}`,
            net,
            current,
          ],
        );
      // Dermatology, branch S1: doctors 01..03, Aug 10k/20k/30k (01 in two rows), Sep 40k/50k/60k
      await visit(orgA, aug, "2026-08-03", "Dermatology", "01", 4_000);
      await visit(orgA, aug, "2026-08-20", "Dermatology", "01", 6_000);
      await visit(orgA, aug, "2026-08-05", "Dermatology", "02", 20_000);
      await visit(orgA, aug, "2026-08-06", "Dermatology", "03", 30_000);
      await visit(orgA, sep1, "2026-09-02", "Dermatology", "01", 40_000);
      await visit(orgA, sep2, "2026-09-20", "Dermatology", "02", 50_000);
      await visit(orgA, sep2, "2026-09-21", "Dermatology", "03", 60_000);
      // a doctor-month of 0 (nothing billed) and a superseded row: both left out
      await visit(orgA, aug, "2026-08-07", "Dermatology", "05", 0);
      await visit(orgA, aug, "2026-08-08", "Dermatology", "01", 999_999, "S1", false);
      // October is only partly covered: left out
      await visit(orgA, oct, "2026-10-02", "Dermatology", "01", 777_777);
      // Dental: doctor 04 both months; doctor 01 also works in Dental in September (5k)
      await visit(orgA, aug, "2026-08-09", "Dental", "04", 90_000);
      await visit(orgA, sep1, "2026-09-09", "Dental", "04", 95_000);
      await visit(orgA, sep2, "2026-09-25", "Dental ", "01", 5_000); // trailing space: same department
      // another branch: doctor 06 in Dermatology, September, branch S2
      await visit(orgA, sep2, "2026-09-26", "Dermatology", "06", 70_000, "S2");

      // org B: never in org A's figures
      const b = await upload(orgB, "2026-09-01", "2026-09-30", 99);
      await visit(orgB, b, "2026-09-10", "Dermatology", "99", 123_456);
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("uses only full months, sums a doctor's rows, leaves out 0 doctor-months and superseded rows", async () => {
    const j = await bench(orgA);
    expect(j.months).toEqual(["2026-08-01", "2026-09-01"]);
    const derm = (j.departments as Record<string, unknown>[]).find(
      (d) => d.department === "Dermatology",
    )!;
    // [10, 20, 30, 40, 50, 60, 70] k: median 40,000; p75 at position 4.5 = 55,000
    expect(derm).toEqual({
      department: "Dermatology",
      doctor_months: 7,
      doctors: 4,
      median: 40000,
      p75: 55000,
    });
  });

  it("counts a doctor in two departments under each department, and once per month clinic-wide", async () => {
    const j = await bench(orgA);
    const dental = (j.departments as Record<string, unknown>[]).find(
      (d) => d.department === "Dental",
    )!;
    // [5, 90, 95] k: median 90,000; p75 at position 1.5 = 92,500
    expect(dental).toEqual({
      department: "Dental",
      doctor_months: 3,
      doctors: 2,
      median: 90000,
      p75: 92500,
    });
    // clinic: Aug 10/20/30/90, Sep 45 (40 + 5)/50/60/70/95 k -> 9 doctor-months; median 50,000; p75 at 6 = 70,000
    expect(j.clinic).toEqual({
      department: null,
      doctor_months: 9,
      doctors: 5,
      median: 50000,
      p75: 70000,
    });
  });

  it("keeps to the member's branches", async () => {
    const j = await bench(orgA, ["S1"]);
    const derm = (j.departments as Record<string, unknown>[]).find(
      (d) => d.department === "Dermatology",
    )!;
    // [10, 20, 30, 40, 50, 60] k: median 35,000; p75 at 3.75 = 47,500
    expect(derm).toMatchObject({ doctor_months: 6, doctors: 3, median: 35000, p75: 47500 });
    // [10, 20, 30, 45, 50, 60, 90, 95] k: median 47,500; p75 at 5.25 = 67,500
    expect(j.clinic).toMatchObject({ doctor_months: 8, doctors: 4, median: 47500, p75: 67500 });
    const none = await bench(orgA, ["S9"]);
    expect(none.months).toEqual([]);
    expect(none.departments).toEqual([]);
    expect(none.clinic).toMatchObject({ doctor_months: 0, doctors: 0, median: null, p75: null });
  });

  it("feeds the pure rules: a thin department falls back to the clinic", async () => {
    const b = parseBenchmarks(await bench(orgA));
    expect(b.settings).toEqual({
      conservativePct: 70,
      consumablesPct: 12,
      gatewayPct: 1.5,
      minPeerMonths: 6,
    });
    expect(pickBenchmark(b, "Dermatology").source).toBe("department");
    const dental = pickBenchmark(b, "Dental");
    expect(dental.source).toBe("clinic");
    expect(dental.reason).toMatch(/3 doctor-months, fewer than the 6/);
  });

  it("returns org B's own figures only", async () => {
    const j = await bench(orgB);
    expect(j.clinic).toMatchObject({ doctor_months: 1, doctors: 1, median: 123456 });
  });

  it("reads the defaults from the settings, which the database checks", async () => {
    await svc(() =>
      q(
        "update public.fin_ref_finance_settings set recruit_conservative_pct = 65, recruit_consumables_pct = 10, recruit_gateway_pct = 2, recruit_min_peer_months = 3 where org_id = $1",
        [orgA],
      ),
    );
    expect((await bench(orgA)).settings).toEqual({
      conservative_pct: 65,
      consumables_pct: 10,
      gateway_pct: 2,
      min_peer_months: 3,
    });
    for (const [col, v] of [
      ["recruit_conservative_pct", 0],
      ["recruit_conservative_pct", 101],
      ["recruit_consumables_pct", 98],
      ["recruit_gateway_pct", -1],
      ["recruit_min_peer_months", 0],
    ] as const)
      await expect(
        svc(() =>
          q(`update public.fin_ref_finance_settings set ${col} = $2 where org_id = $1`, [orgA, v]),
        ),
        `${col} = ${v}`,
      ).rejects.toThrow(/recruit_check/);
    await svc(() => q("delete from public.fin_ref_finance_settings where org_id = $1", [orgA]));
    expect((await bench(orgA)).settings).toEqual({
      conservative_pct: 70,
      consumables_pct: 12,
      gateway_pct: 1.5,
      min_peer_months: 6,
    });
  });

  it("seeds Ramadan and Eid for 2026 and 2027 in every new org, approximate, idempotently", async () => {
    const { rows } = await svc(() =>
      q(
        "select kind, starts_on::text as s, ends_on::text as e, approximate from public.fin_ref_calendar_events where org_id = $1 order by starts_on",
        [orgA],
      ),
    );
    expect(rows.map((r) => `${r.kind} ${r.s}..${r.e}`)).toEqual([
      "ramadan 2026-02-18..2026-03-19",
      "eid 2026-03-20..2026-03-22",
      "eid 2026-05-26..2026-05-29",
      "ramadan 2027-02-08..2027-03-09",
      "eid 2027-03-10..2027-03-12",
      "eid 2027-05-15..2027-05-18",
    ]);
    expect(rows.every((r) => r.approximate)).toBe(true);
    const again = await svc(() => q("select public.fin_seed_calendar_events($1) as n", [orgA]));
    expect(again.rows[0].n).toBe(0);
    await expect(
      svc(() =>
        q(
          "insert into public.fin_ref_calendar_events (org_id, starts_on, ends_on, kind, label) values ($1, '2027-01-02', '2027-01-01', 'other', 'x')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/dates_check/);
  });

  it("calendar: read with finance.profit.view in one's own org only; no browser writes", async () => {
    const n = async (u: string) =>
      asUser(c, users[u], async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.fin_ref_calendar_events where org_id = $1",
          [orgA],
        );
        return rows[0].n as number;
      });
    expect(await n("fin")).toBe(6);
    expect(await n("ceo")).toBe(6);
    expect(await n("payroll")).toBe(0);
    expect(await n("bob")).toBe(0);
    await expect(
      asUser(c, users.fin, () =>
        q(
          "insert into public.fin_ref_calendar_events (org_id, starts_on, ends_on, kind, label) values ($1, '2027-07-01', '2027-08-31', 'summer', 'Summer')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await asUser(c, users.fin, () =>
      q("update public.fin_ref_calendar_events set label = 'x' where org_id = $1", [orgA]),
    );
    expect(upd.rowCount).toBe(0);
  });

  it("scenarios: read only with BOTH compensation and profit; never across orgs; no browser writes", async () => {
    await svc(() =>
      q(
        `insert into public.fin_recruitment_scenarios (org_id, title, inputs, result, created_by)
         values ($1, 'Dermatologist, synthetic branch', '{"contractType":"fixed_salary"}', '{"engine":"recruitment-v1"}', $2),
                ($3, 'Dentist, org B', '{}', '{}', $4)`,
        [orgA, users.fin, orgB, users.bob],
      ),
    );
    const n = async (u: string, org: string) =>
      asUser(c, users[u], async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.fin_recruitment_scenarios where org_id = $1",
          [org],
        );
        return rows[0].n as number;
      });
    expect(await n("fin", orgA)).toBe(1);
    expect(await n("alice", orgA)).toBe(1); // admin
    expect(await n("ceo", orgA)).toBe(0); // profit without compensation
    expect(await n("payroll", orgA)).toBe(0); // compensation without profit (F8: no revenue for payroll)
    expect(await n("bob", orgA)).toBe(0);
    expect(await n("fin", orgB)).toBe(0);
    await expect(
      asUser(c, users.fin, () =>
        q(
          "insert into public.fin_recruitment_scenarios (org_id, title, inputs, result) values ($1, 'x', '{}', '{}')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const del = await asUser(c, users.fin, () =>
      q("delete from public.fin_recruitment_scenarios where org_id = $1", [orgA]),
    );
    expect(del.rowCount).toBe(0);
    await expect(
      svc(() =>
        q(
          "insert into public.fin_recruitment_scenarios (org_id, title, inputs, result) values ($1, '  ', '{}', '{}')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/title_check/);
  });

  it("the functions are service role only, SECURITY DEFINER with a pinned search_path", async () => {
    await expect(
      asUser(c, users.fin, () => q("select public.fin_recruitment_benchmarks($1)", [orgA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(c, users.fin, () => q("select public.fin_seed_calendar_events($1)", [orgA])),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await q(
      `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('fin_recruitment_benchmarks', 'fin_seed_calendar_events')
       order by 1`,
    );
    const expected = {
      anon: false,
      auth: false,
      svc: true,
      definer: true,
      config: 'search_path=""',
    };
    expect(rows).toEqual([
      { name: "fin_recruitment_benchmarks", ...expected },
      { name: "fin_seed_calendar_events", ...expected },
    ]);
  });
});
