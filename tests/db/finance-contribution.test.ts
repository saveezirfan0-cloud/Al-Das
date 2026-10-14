/**
 * M2A: fin_contribution_inputs() and the doctor mapping table. Parity with the hand-worked synthetic fixture (the SQL
 * output equals the fixture's inputs exactly and, run through the pure rules, gives the fixture's levels), branch
 * scoping (a member's allowed branches, the page's filter, an unknown branch only for unrestricted members, and the
 * doctor's and pools' shares kept over every branch), zero costs left out, only current rows of the month, no PIN,
 * service role only, and the mapping table's org-bound DHA id. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildContribution, parseContributionInputs } from "@/lib/finance/contribution";

import fixture from "../unit/finance/fixtures/m2a-contribution.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type Inputs = typeof fixture.expected;
const SHA = (i: number) => i.toString(16).padStart(64, "0");

describe.skipIf(!TEST_DATABASE_URL)("Finance contribution (M2A)", () => {
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
      const { rows } = await q("select public.fin_contribution_inputs($1, $2, $3, $4) as j", [
        org,
        month,
        branch,
        branches,
      ]);
      return rows[0].j as Inputs;
    });

  async function seedUploads(org: string, from: string, to: string, n: number) {
    const { rows } = await q(
      `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
       values ($1, $2, $3, $4, 'committed', true, now()) returning id`,
      [org, from, to, SHA(n)],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-contrib@example.test");
    const bob = await createAuthUser(c, "bob-contrib@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      const sep = await seedUploads(orgA, "2026-09-01", "2026-09-30", 1);
      const oct = await seedUploads(orgA, "2026-10-01", "2026-10-31", 2);
      for (const d of fixture.doctors)
        await q("insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, $2, $3)", [
          orgA,
          d.dha_id,
          d.name,
        ]);
      for (const m of fixture.map)
        await q(
          "insert into public.fin_report_doctor_map (org_id, doctor_key, dha_id) values ($1, $2, $3)",
          [orgA, m.doctor_key, m.dha_id],
        );
      let rowNo = 0;
      for (const r of fixture.rows)
        await q(
          `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name,
             doctor_key, branch_code, patient_pin, net, is_current)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            orgA,
            r.report_date.startsWith("2026-10") ? oct : sep,
            ++rowNo,
            r.report_date,
            r.department,
            r.doctor_name,
            r.doctor_key,
            r.branch_code,
            r.patient_pin,
            r.net,
            r.is_current,
          ],
        );
      for (const x of fixture.comp)
        await q(
          "insert into public.fin_cost_doctor_comp (org_id, month, doctor_dha_id, amount) values ($1, $2, $3, $4)",
          [orgA, fixture.month, x.doctor_dha_id, x.amount],
        );
      // October pay must never reach September
      await q(
        "insert into public.fin_cost_doctor_comp (org_id, month, doctor_dha_id, amount) values ($1, '2026-10-01', 'D0002', 999)",
        [orgA],
      );
      for (const x of fixture.charges)
        await q(
          "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, $3, $4, $5)",
          [orgA, fixture.month, x.doctor_dha_id, x.kind, x.amount],
        );
      for (const o of fixture.overheads)
        await q(
          "insert into public.fin_cost_overheads (org_id, month, branch_code, pool, amount, basis) values ($1, $2, $3, $4, $5, $6)",
          [orgA, fixture.month, o.branch_code, o.pool, o.amount, o.basis],
        );

      // Org B: the same doctor key and DHA id with its own figures; must never show in org A.
      const ub = await seedUploads(orgB, "2026-09-01", "2026-09-30", 3);
      await q(
        "insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, 'D0001', 'Dr Demo-91')",
        [orgB],
      );
      await q(
        "insert into public.fin_report_doctor_map (org_id, doctor_key, dha_id) values ($1, 'demo-01', 'D0001')",
        [orgB],
      );
      await q(
        `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name, doctor_key,
           branch_code, patient_pin, net, is_current)
         values ($1, $2, 1, '2026-09-10', 'General Medicine', 'Dr Demo-01', 'demo-01', 'P', '900000099', 5555, true)`,
        [orgB, ub],
      );
      await q(
        "insert into public.fin_cost_doctor_comp (org_id, month, doctor_dha_id, amount) values ($1, '2026-09-01', 'D0001', 7777)",
        [orgB],
      );
      await q(
        "insert into public.fin_cost_overheads (org_id, month, branch_code, pool, amount, basis) values ($1, '2026-09-01', null, 'Rent', 3333, 'revenue')",
        [orgB],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("returns exactly the fixture's inputs (parity), whatever day of the month is asked", async () => {
    const j = await inputs(orgA, fixture.month);
    expect(j).toEqual(fixture.expected);
    expect(await inputs(orgA, "2026-09-23")).toEqual(j);
  });

  it("feeds the pure rules to the fixture's hand-worked levels", async () => {
    const r = buildContribution(parseContributionInputs(await inputs(orgA, fixture.month)), {
      canSeePay: true,
    });
    const pick = (o: object) =>
      Object.fromEntries(
        Object.keys(fixture.result.total).map((k) => [k, (o as Record<string, unknown>)[k]]),
      );
    expect(pick(r.total)).toEqual(fixture.result.total);
    for (const cl of r.clinics)
      expect(pick(cl), cl.key).toEqual(
        fixture.result.clinics[cl.key as keyof typeof fixture.result.clinics],
      );
  });

  it("keeps to a member's branches; the doctor's pay share and the shared pools still use every branch", async () => {
    const p = await inputs(orgA, fixture.month, null, ["P"]);
    expect(new Set(p.rows.map((r) => r.branch_code))).toEqual(new Set(["P"]));
    expect(p.branch_overheads).toEqual([{ branch_code: "P", amount: 1000 }]);
    // D0001 also works in M: the weight is over all branches, so P gets 2/3 of the pay, not all of it
    expect(p.doctor_weights.find((w) => w.dha_id === "D0001")).toEqual({
      dha_id: "D0001",
      revenue: 9000,
      groups: 3,
    });
    expect(p.branch_weights).toEqual(fixture.expected.branch_weights);
    // only the doctors in view: no D0005 / D0006 pay
    expect(p.comp.map((x) => x.dha_id)).toEqual(["D0001", "D0002"]);
    const r = buildContribution(parseContributionInputs(p), { canSeePay: true });
    expect(r.total.pay).toBe(7000);
    expect(r.total.allocated).toBe(6950);

    // the page's filter
    const m = await inputs(orgA, fixture.month, "M");
    expect(new Set(m.rows.map((r) => r.branch_code))).toEqual(new Set(["M"]));
    expect(m.branch).toBe("M");
    expect(m.branch_overheads).toEqual([{ branch_code: "M", amount: 500 }]);

    // an empty allowed list sees nothing; the unknown branch only without a restriction
    expect((await inputs(orgA, fixture.month, null, [])).rows).toEqual([]);
    const restricted = await inputs(orgA, fixture.month, null, ["P", "M"]);
    expect(restricted.rows.some((r) => r.branch_code === null)).toBe(false);
    expect((await inputs(orgA, fixture.month)).rows.some((r) => r.branch_code === null)).toBe(true);
  });

  it("leaves out zero costs, other months, other orgs and superseded rows", async () => {
    const j = await inputs(orgA, fixture.month);
    expect(j.comp.find((x) => x.dha_id === "D0005")).toBeUndefined(); // 0 = unavailable
    expect(j.shared_overheads.find((o) => o.pool === "IT")).toBeUndefined();
    expect(j.comp.find((x) => x.dha_id === "D0002")!.amount).toBe(3000); // not October's 999
    expect(JSON.stringify(j)).not.toContain("7777");
    expect(JSON.stringify(j)).not.toContain("9999");
    expect(JSON.stringify(j)).not.toContain("5555");
    const oct = await inputs(orgA, "2026-10-01");
    expect(oct.rows.map((r) => r.revenue)).toEqual([7777]);
    expect(oct.comp).toEqual([{ dha_id: "D0002", amount: 999 }]);
    const b = await inputs(orgB, fixture.month);
    expect(b.comp).toEqual([{ dha_id: "D0001", amount: 7777 }]);
    expect(b.rows).toHaveLength(1);
  });

  it("reports the month's approval", async () => {
    await svc(() =>
      q(
        "insert into public.fin_cost_periods (org_id, month, status, approved_by, approved_at) values ($1, $2, 'approved', $3, now())",
        [orgA, fixture.month, alice],
      ),
    );
    expect((await inputs(orgA, fixture.month)).period_approved).toBe(true);
    expect((await inputs(orgA, "2026-10-01")).period_approved).toBe(false);
    await svc(() =>
      q("delete from public.fin_cost_periods where org_id = $1 and month = $2", [
        orgA,
        fixture.month,
      ]),
    );
  });

  it("never returns a PIN or a patient ref", async () => {
    const text = JSON.stringify(await inputs(orgA, fixture.month));
    expect(text).not.toMatch(/9000000\d\d/);
    expect(text).not.toMatch(/pin|patient/i);
  });

  it("links only to the org's own reference doctors, once per report doctor", async () => {
    await expect(
      svc(() =>
        q(
          "insert into public.fin_report_doctor_map (org_id, doctor_key, dha_id) values ($1, 'demo-04', 'D9999')",
          [orgA],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      svc(() =>
        q(
          "insert into public.fin_report_doctor_map (org_id, doctor_key, dha_id) values ($1, 'demo-01', 'D0002')",
          [orgA],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // removing a reference doctor removes the link: the doctor then shows "pay not linked", never zero pay
    await svc(async () => {
      await q(
        "insert into public.fin_report_doctor_map (org_id, doctor_key, dha_id) values ($1, 'demo-04', 'D0007')",
        [orgA],
      );
      await q("delete from public.fin_ref_doctors where org_id = $1 and dha_id = 'D0007'", [orgA]);
      const { rows } = await q(
        "select count(*)::int as n from public.fin_report_doctor_map where org_id = $1 and doctor_key = 'demo-04'",
        [orgA],
      );
      expect(rows[0].n).toBe(0);
      await q(
        "insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, 'D0007', 'Dr Demo-07')",
        [orgA],
      );
    });
  });

  it("is service role only: signed-in users cannot read or write the map or run the function", async () => {
    await expect(
      asUser(c, alice, () => q("select public.fin_contribution_inputs($1, '2026-09-01')", [orgA])),
    ).rejects.toThrow(/permission denied/);
    const seen = await asUser(c, alice, () =>
      q("select count(*)::int as n from public.fin_report_doctor_map"),
    );
    expect(seen.rows[0].n).toBe(0);
    await expect(
      asUser(c, alice, () =>
        q(
          "insert into public.fin_report_doctor_map (org_id, doctor_key, dha_id) values ($1, 'demo-04', 'D0004')",
          [orgA],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const { rows: priv } = await q(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fin_contribution_inputs'`,
    );
    expect(priv).toEqual([
      { anon: false, auth: false, svc: true, definer: true, config: 'search_path=""' },
    ]);
    const { rows: pol } = await q(
      "select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'fin_report_doctor_map'",
    );
    expect(pol[0].n).toBe(0);
  });
});
