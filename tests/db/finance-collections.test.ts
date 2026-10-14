/**
 * Phase 23D: fin_collections_inputs() over the Unite collection report rows. Parity with the shared synthetic fixture
 * (the sums, counts and signals the pure rules read), branch scoping (the page's filter, a member's allowed branches,
 * the unknown-branch rule, the mapping read when the report is read), months, only current rows, the late-invoice
 * setting and its check, service-role only, and no PIN or patient ref in the output. Synthetic data only. Needs
 * TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCollections, parseCollectionsInputs } from "@/lib/finance/collections";

import fixture from "../unit/finance/fixtures/phase23-collections.synthetic.json";
import {
  referenceCollections,
  type CollectionsFixtureRow,
} from "../unit/finance/collections-reference";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const rows = fixture.rows as CollectionsFixtureRow[];
const clinics = Object.fromEntries(fixture.branches.map((b) => [b.clinic, b.code]));
const SHA = (i: number) => i.toString(16).padStart(64, "0");
const AMOUNTS = [
  "cash",
  "card",
  "bank_transfer",
  "payment_gateway",
  "other_payment",
  "patient_share",
  "insurance_claim",
  "net",
  "advance_consumed",
  "credit_note_consumed",
  "outstanding_credit",
  "write_off",
  "refund",
] as const;

type Out = Record<string, unknown> & {
  total: { rows: number; net: number };
  quality: Record<string, { rows: number; net: number }>;
  settings: { late_invoice_days: number };
};

/** The parts of the output the fixture's reference covers (everything except month, branch, coverage, settings). */
const body = (j: Out) => ({
  days: j.days,
  branches: j.branches,
  doctors: j.doctors,
  invoice_types: j.invoice_types,
  total: j.total,
  quality: j.quality,
});

describe.skipIf(!TEST_DATABASE_URL)("Finance collections and data quality (Phase 23D)", () => {
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
      const { rows: r } = await q("select public.fin_collections_inputs($1, $2, $3, $4) as j", [
        org,
        month,
        branch,
        branches,
      ]);
      return r[0].j as Out;
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-coll@example.test");
    const bob = await createAuthUser(c, "bob-coll@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      for (const b of fixture.branches)
        await q(
          `insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name) values ($1, $2, $3, $4)`,
          [orgA, b.code, b.name, b.clinic],
        );
      const uploadIds: Record<string, string> = {};
      let i = 0;
      for (const u of fixture.uploads) {
        const { rows: r } = await q(
          `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
           values ($1, $2, $3, $4, 'committed', true, now()) returning id`,
          [orgA, u.from_date, u.to_date, SHA(++i)],
        );
        uploadIds[u.key] = r[0].id;
      }
      let rowNo = 0;
      for (const r of rows) {
        const { rows: ins } = await q(
          `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, visit_at, invoice_date,
             clinic_name, branch_code, doctor_name, doctor_key, patient_pin, visit_status, invoice_type,
             selfpay_invoice_no, insurance_invoice_no, categories, is_cancelled, is_current,
             ${AMOUNTS.join(", ")})
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             ${AMOUNTS.map((_, k) => `$${19 + k}`).join(", ")})
           returning id`,
          [
            orgA,
            uploadIds[r.upload],
            ++rowNo,
            r.report_date,
            r.visit_at,
            r.invoice_date,
            r.clinic_name,
            r.branch_code,
            r.doctor_name,
            r.doctor_key,
            r.patient_pin,
            r.visit_status,
            r.invoice_type,
            r.selfpay_invoice_no,
            r.insurance_invoice_no,
            JSON.stringify(r.categories),
            r.is_cancelled,
            r.is_current,
            ...AMOUNTS.map((k) => r[k]),
          ],
        );
        // The keyed hash is normally set by the trigger from the Vault key; the fixture fixes it.
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
        `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, clinic_name, doctor_name,
           doctor_key, patient_pin, net, cash, is_current)
         values ($1, $2, 1, '2026-09-10', 'Synthetic Clinic Palm', 'Dr Demo-99', 'dr demo 99', '900000099', 5555, 5555,
           true)`,
        [orgB, ub[0].id],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("the fixture's expected aggregates follow the definitions (independent reference)", () => {
    expect(
      referenceCollections(rows, fixture.month, { clinics, lateDays: fixture.late_invoice_days }),
    ).toEqual(fixture.expected);
  });

  it("returns exactly the fixture's expected sums, counts and signals (parity)", async () => {
    const j = await inputs(orgA, fixture.month);
    expect(body(j)).toEqual(fixture.expected);
    expect(j).toMatchObject({
      month: "2026-09-01",
      branch: null,
      settings: { late_invoice_days: 3 },
      coverage: [{ from: "2026-09-01", to: "2026-09-30" }],
    });
    // any date in the month gives the same month
    expect(await inputs(orgA, "2026-09-30")).toEqual(j);
  });

  it("feeds the pure rules: total collected, buckets and the reconciliation line", async () => {
    const r = buildCollections(parseCollectionsInputs(await inputs(orgA, fixture.month)));
    expect(r.total.collected).toBe(1940.555); // 670 + 790.555 + 300 + 120 + 60
    expect(r.reconciliation).toEqual({
      net: 3700.555,
      accountedFor: 3990.555, // 1940.555 + 1800 + 200 + 35 + 10 + 5
      difference: -290,
    });
    expect(r.buckets.map((b) => [b.bucket, b.rows])).toEqual([
      ["self_pay", 8],
      ["insurance", 2],
      ["both", 1],
      ["blank", 2],
      ["other", 1],
    ]);
    expect(r.coverageInfo.full).toBe(true);
  });

  it("filters by one branch and keeps to a member's allowed branches (unknown branch only when unrestricted)", async () => {
    for (const opts of [
      { branch: "GM", branches: null },
      { branch: "PJ", branches: null },
      { branch: null, branches: ["GM"] },
      { branch: null, branches: [] as string[] },
      { branch: "GM", branches: ["GM", "PJ"] },
      { branch: "PJ", branches: ["GM"] },
    ]) {
      const j = await inputs(orgA, fixture.month, opts.branch, opts.branches);
      const ref = referenceCollections(rows, fixture.month, {
        clinics,
        lateDays: 3,
        ...opts,
      });
      expect(body(j), JSON.stringify(opts)).toEqual(ref);
      expect(j.branch).toBe(opts.branch);
      expect(j.quality.unknown_branch.rows, JSON.stringify(opts)).toBe(0);
    }
    // GM: the two Mile rows, the stored-GM row with no clinic, and the stored-PJ row whose clinic now maps to GM
    const gm = await inputs(orgA, fixture.month, null, ["GM"]);
    expect(gm.total).toMatchObject({ rows: 4, net: 1000.555 });
    expect((gm.quality as unknown as { unknown_clinics: unknown[] }).unknown_clinics).toEqual([]);
    // unrestricted: the unmapped clinic is named, the blank one shows as null
    const all = await inputs(orgA, fixture.month);
    expect(
      (all.branches as Array<{ branch_code: string | null }>).map((b) => b.branch_code),
    ).toEqual(["GM", "PJ", null]);
  });

  it("works out the branch when read: mapping a clinic later moves its rows out of unknown", async () => {
    await svc(() =>
      q(
        `insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name)
         values ($1, 'ZZ', 'Synthetic branch Z', 'Synthetic Clinic Unmapped')`,
        [orgA],
      ),
    );
    try {
      const j = await inputs(orgA, fixture.month);
      expect(j.quality.unknown_branch).toEqual({ rows: 1, net: 40 });
      expect((await inputs(orgA, fixture.month, null, ["ZZ"])).total).toMatchObject({
        rows: 1,
        net: 250,
      });
    } finally {
      await svc(() =>
        q("delete from public.fin_ref_branches where org_id = $1 and code = 'ZZ'", [orgA]),
      );
    }
  });

  it("counts only current rows of the chosen month, and only the org's own", async () => {
    const oct = await inputs(orgA, "2026-10-01");
    expect(oct.total).toMatchObject({ rows: 1, net: 321, card: 321 });
    const aug = await inputs(orgA, "2026-08-01");
    expect(aug.total).toMatchObject({ rows: 1, net: 777 }); // the superseded 99,999 row is dated September
    const empty = await inputs(orgA, "2025-01-10");
    expect(empty).toMatchObject({
      month: "2025-01-01",
      coverage: [],
      days: [],
      branches: [],
      doctors: [],
      invoice_types: [],
      total: { rows: 0, net: 0, cash: 0 },
      quality: { late_invoice: { rows: 0, net: 0 }, unknown_clinics: [] },
    });
    expect((await inputs(orgB, fixture.month)).total).toMatchObject({ rows: 1, net: 5555 });
  });

  it("reads the late-invoice days from the settings and refuses values outside 0 to 60", async () => {
    const late = async () => (await inputs(orgA, fixture.month)).quality.late_invoice;
    const set = (d: number) =>
      svc(() =>
        q(
          `insert into public.fin_ref_finance_settings (org_id, dq_late_invoice_days) values ($1, $2)
           on conflict (org_id) do update set dq_late_invoice_days = excluded.dq_late_invoice_days`,
          [orgA, d],
        ),
      );
    await set(4); // the 4-day invoice is no longer late; the 12-day one is
    expect(await late()).toEqual({ rows: 1, net: 80 });
    expect((await inputs(orgA, fixture.month)).settings).toEqual({ late_invoice_days: 4 });
    await set(0);
    expect(await late()).toEqual({ rows: 4, net: 900 }); // every invoice raised after the visit day
    for (const bad of [-1, 61])
      await expect(set(bad), String(bad)).rejects.toThrow(/dq_late_invoice_days_check/);
    await svc(() => q("delete from public.fin_ref_finance_settings where org_id = $1", [orgA]));
    expect((await inputs(orgA, fixture.month)).settings).toEqual({ late_invoice_days: 3 });
  });

  it("never returns a PIN or a patient ref", async () => {
    const text = JSON.stringify(await inputs(orgA, fixture.month));
    expect(text).not.toMatch(/9000000\d\d/);
    expect(text).not.toContain("P-syn");
    expect(text).not.toMatch(/pin|patient_ref|S-\d\d|I-\d\d/i);
  });

  it("signed-in users cannot run the function", async () => {
    await expect(
      asUser(c, alice, () => q("select public.fin_collections_inputs($1, '2026-09-01')", [orgA])),
    ).rejects.toThrow(/permission denied/);
    const { rows: priv } = await q(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fin_collections_inputs'`,
    );
    expect(priv).toEqual([
      { anon: false, auth: false, svc: true, definer: true, config: 'search_path=""' },
    ]);
  });
});
