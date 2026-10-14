/**
 * Phase 23B: fin_doctor_performance_inputs() over the Unite collection report rows. Parity with the shared synthetic
 * fixture (the same aggregates the pure rules read), branch scoping (the page's filter and a member's allowed branches),
 * months without data, only current rows, the settings check, service-role only, and no PIN or patient ref in the
 * output. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildDoctorPerformance,
  parseDoctorPerformanceInputs,
} from "@/lib/finance/doctor-performance";

import fixture from "../unit/finance/fixtures/phase23-doctor-performance.synthetic.json";
import { referenceInputs, type FixtureRow } from "../unit/finance/doctor-performance-reference";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const rows = fixture.rows as FixtureRow[];
const SHA = (i: number) => i.toString(16).padStart(64, "0");

describe.skipIf(!TEST_DATABASE_URL)("Finance doctor performance (Phase 23B)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const inputs = async (
    org: string,
    month: string,
    branch: string | null = null,
    branches: string[] | null = null,
  ) =>
    svc(async () => {
      const { rows: r } = await q(
        "select public.fin_doctor_performance_inputs($1, $2, $3, $4) as j",
        [org, month, branch, branches],
      );
      return r[0].j as Record<string, unknown>;
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-perf@example.test");
    const bob = await createAuthUser(c, "bob-perf@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      const uploadIds: Record<string, string> = {};
      let i = 0;
      for (const u of fixture.uploads) {
        const committed = u.status === "committed";
        const { rows: r } = await q(
          `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            orgA,
            u.from_date,
            u.to_date,
            SHA(++i),
            u.status,
            committed,
            committed ? new Date().toISOString() : null,
          ],
        );
        uploadIds[u.key] = r[0].id;
      }
      let rowNo = 0;
      for (const r of rows) {
        const { rows: ins } = await q(
          `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name, doctor_key,
             branch_code, patient_pin, visit_status, net, is_cancelled, is_current)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
          [
            orgA,
            uploadIds[r.upload],
            ++rowNo,
            r.report_date,
            r.department,
            r.doctor_name,
            r.doctor_key,
            r.branch_code,
            r.patient_pin,
            r.visit_status,
            r.net,
            r.is_cancelled,
            r.is_current,
          ],
        );
        // The keyed hash is normally set by the trigger from the Vault key; the fixture fixes it (or leaves it null).
        await q("update public.fin_report_visits set patient_ref = $2 where id = $1", [
          ins[0].id,
          r.patient_ref,
        ]);
      }
      // Another org's September: must never show in org A.
      const { rows: ub } = await q(
        `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
         values ($1, '2026-09-01', '2026-09-30', $2, 'committed', true, now()) returning id`,
        [orgB, SHA(99)],
      );
      await q(
        `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name, doctor_key,
           branch_code, patient_pin, net, is_current)
         values ($1, $2, 1, '2026-09-10', 'Dermatology', 'Dr Demo-99', 'dr demo 99', 'PJ', '900000099', 5555, true)`,
        [orgB, ub[0].id],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("the fixture's expected aggregates follow the definitions (independent reference)", () => {
    const ref = referenceInputs(rows, fixture.month);
    expect(ref.current).toEqual(fixture.expected.current);
    expect(ref.previous).toEqual(fixture.expected.previous);
  });

  it("returns exactly the fixture's expected aggregates (parity with the pure rules' input)", async () => {
    const j = await inputs(orgA, fixture.month);
    expect(j).toEqual(fixture.expected);
    // any date in the month gives the same month
    expect(await inputs(orgA, "2026-09-30")).toEqual(j);
  });

  it("feeds the pure rules: departments add up to the total exactly", async () => {
    const report = buildDoctorPerformance(
      parseDoctorPerformanceInputs(await inputs(orgA, "2026-09-01")),
    );
    expect(report.reconciliation).toEqual({
      departmentsSum: 6499.985,
      total: 6499.985,
      matches: true,
    });
    expect(report.coverage.full).toBe(true);
  });

  it("filters by one branch, and keeps to a member's allowed branches (rows with no branch stay visible)", async () => {
    for (const opts of [
      { branch: "GM", branches: null },
      { branch: "PJ", branches: null },
      { branch: null, branches: ["GM"] },
      { branch: null, branches: [] as string[] },
      { branch: "GM", branches: ["GM", "PJ"] },
    ]) {
      const j = await inputs(orgA, fixture.month, opts.branch, opts.branches);
      const ref = referenceInputs(rows, fixture.month, opts);
      expect(j.current, JSON.stringify(opts)).toEqual(ref.current);
      expect(j.previous, JSON.stringify(opts)).toEqual(ref.previous);
      expect(j.branch).toBe(opts.branch);
    }
    // limited to GM: the PJ doctors are gone, the no-branch Dermatology row stays
    const gm = (await inputs(orgA, fixture.month, null, ["GM"])) as {
      current: { total: { revenue: number }; departments: Array<{ department: string | null }> };
    };
    expect(gm.current.total.revenue).toBe(2599.985);
    expect(gm.current.departments.map((d) => d.department)).toEqual([
      "Dermatology",
      "General Medicine",
      "Pediatrics",
    ]);
  });

  it("counts only current rows and only the chosen months", async () => {
    const j = (await inputs(orgA, "2026-09-01")) as { current: { total: { revenue: number } } };
    expect(j.current.total.revenue).not.toBeGreaterThan(10_000); // the superseded 99,999 row is not counted
    const oct = (await inputs(orgA, "2026-10-01")) as {
      coverage: unknown;
      current: { total: { revenue: number; visits: number } };
      previous: { total: { revenue: number } };
    };
    expect(oct.current.total).toMatchObject({ revenue: 321, visits: 1 });
    expect(oct.previous.total.revenue).toBe(6499.985);
    expect(oct.coverage).toEqual([{ from: "2026-10-01", to: "2026-10-01" }]); // partly covered
  });

  it("returns zeros and no coverage for a month without data", async () => {
    const j = await inputs(orgA, "2025-01-20");
    expect(j).toMatchObject({
      month: "2025-01-01",
      previous_month: "2024-12-01",
      coverage: [],
      previous_coverage: [],
      current: { doctors: [], departments: [], total: { revenue: 0, visits: 0, patients: 0 } },
      previous: { doctors: [], departments: [], total: { revenue: 0, visits: 0, patients: 0 } },
    });
    const b = (await inputs(orgB, "2026-09-01")) as { current: { total: { revenue: number } } };
    expect(b.current.total.revenue).toBe(5555);
  });

  it("names the latest month with current rows", async () => {
    const latest = async (org: string, branches: string[] | null = null) =>
      svc(async () => {
        const { rows: r } = await q("select public.fin_report_latest_month($1, $2)::text as m", [
          org,
          branches,
        ]);
        return r[0].m as string | null;
      });
    expect(await latest(orgA)).toBe("2026-10-01");
    expect(await latest(orgA, ["GM"])).toBe("2026-09-01");
  });

  it("never returns a PIN or a patient ref", async () => {
    const text = JSON.stringify(await inputs(orgA, fixture.month));
    expect(text).not.toMatch(/9000000\d\d/);
    expect(text).not.toContain("P-syn");
    expect(text).not.toMatch(/pin|patient_ref/i);
  });

  it("reads the thresholds from the settings and refuses bands out of order", async () => {
    await svc(async () => {
      await q(
        `insert into public.fin_ref_finance_settings (org_id, perf_arpp_target, perf_band_near, perf_band_moderate)
         values ($1, 800, 600, 500)
         on conflict (org_id) do update set perf_arpp_target = 800, perf_band_near = 600, perf_band_moderate = 500`,
        [orgA],
      );
    });
    expect((await inputs(orgA, fixture.month)).settings).toEqual({
      target: 800,
      near: 600,
      moderate: 500,
    });
    for (const [t, n, m] of [
      [750, 750, 650],
      [750, 700, 700],
      [700, 750, 650],
      [750, 700, 0],
      [750, 700, -1],
    ]) {
      await expect(
        svc(() =>
          q(
            "update public.fin_ref_finance_settings set perf_arpp_target = $2, perf_band_near = $3, perf_band_moderate = $4 where org_id = $1",
            [orgA, t, n, m],
          ),
        ),
        `${t}/${n}/${m}`,
      ).rejects.toThrow(/perf_bands_check/);
    }
    await svc(() => q("delete from public.fin_ref_finance_settings where org_id = $1", [orgA]));
    expect((await inputs(orgA, fixture.month)).settings).toEqual({
      target: 750,
      near: 700,
      moderate: 650,
    });
  });

  it("signed-in users cannot run the functions or read the rows directly", async () => {
    await expect(
      asUser(c, alice, () =>
        q("select public.fin_doctor_performance_inputs($1, '2026-09-01')", [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(c, alice, () => q("select public.fin_report_latest_month($1)", [orgA])),
    ).rejects.toThrow(/permission denied/);
    const { rows: priv } = await q(
      `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('fin_doctor_performance_inputs', 'fin_report_latest_month')
       order by 1`,
    );
    expect(priv).toEqual([
      {
        name: "fin_doctor_performance_inputs",
        anon: false,
        auth: false,
        svc: true,
        definer: true,
        config: 'search_path=""',
      },
      {
        name: "fin_report_latest_month",
        anon: false,
        auth: false,
        svc: true,
        definer: true,
        config: 'search_path=""',
      },
    ]);
  });
});
