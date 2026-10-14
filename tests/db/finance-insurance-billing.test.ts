/**
 * Phase 23D-2: fin_insurance_billing_recon_inputs() — Unite report (billed) against Diligence (submitted). Each
 * bucket through the pure rules, tolerance and grace days from the settings, branch scoping, only current and not
 * cancelled report rows, other orgs never mix in, the SQL invoice-number rule equals the TypeScript one, no PIN in the
 * output, service role only. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildInsuranceBilling, parseReconInputs } from "@/lib/finance/insurance-billing";
import { normalizeInvoiceNumber } from "@/lib/finance/keys";

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
const AS_OF = "2026-09-20";

type Row = {
  date: string;
  inv: string | null;
  claim: number;
  branch: string | null;
  doctor: string;
  clinic?: string;
  cancelled?: boolean;
  current?: boolean;
};
type Act = {
  inv: string | null;
  net: number | null;
  initial?: number | null;
  date: string;
  payer?: string;
};

// org A, September (plus one August row): see each comment for the bucket it proves
const ROWS_A: Row[] = [
  { date: "2026-09-02", inv: "INS-SYN-001", claim: 300, branch: "PJ", doctor: "Dr Demo-01" }, // matched, equal
  { date: "2026-09-03", inv: "INS-SYN-002", claim: 150, branch: "GM", doctor: "Dr Demo-02" }, // matched, 10.50 apart
  { date: "2026-09-03", inv: " ins-syn-002 ", claim: 50.5, branch: "GM", doctor: "Dr Demo-02" },
  {
    date: "2026-09-01",
    inv: "INS-SYN-003",
    claim: 400,
    branch: null,
    doctor: "Dr Demo-03",
    clinic: "Synthetic Clinic X",
  }, // at risk, branch unknown
  { date: "2026-09-18", inv: "INS-SYN-004", claim: 250, branch: "PJ", doctor: "Dr Demo-01" }, // inside the grace days
  { date: "2026-09-05", inv: "INS-SYN-005", claim: 200, branch: "PJ", doctor: "Dr Demo-01" }, // ambiguous
  { date: "2026-09-05", inv: "INS-SYN-005", claim: 200, branch: "GM", doctor: "Dr Demo-02" },
  {
    date: "2026-09-07",
    inv: "INS-SYN-006",
    claim: 75,
    branch: "PJ",
    doctor: "Dr Demo-01",
    cancelled: true,
  }, // left out
  { date: "2026-09-06", inv: null, claim: 50, branch: "PJ", doctor: "Dr Demo-01" }, // no invoice number
  {
    date: "2026-09-08",
    inv: "INS-SYN-008",
    claim: 999,
    branch: "PJ",
    doctor: "Dr Demo-01",
    current: false,
  }, // superseded
  { date: "2026-09-04", inv: "INS-SYN-007", claim: 7, branch: "GM", doctor: "Dr Demo-02" }, // matched on initial net
  { date: "2026-09-09", inv: "INS-SYN-010", claim: 0, branch: "PJ", doctor: "Dr Demo-01" }, // nothing to claim
  { date: "2026-08-20", inv: "INS-SYN-101", claim: 80, branch: "PJ", doctor: "Dr Demo-01" }, // August
];
const ACTS_A: Act[] = [
  { inv: " ins-syn-001\t", net: 200, date: "2026-09-02", payer: "SYN-P1" },
  { inv: "INS-SYN-001", net: 100, date: "2026-09-02", payer: "SYN-P2" },
  { inv: "INS-SYN-002", net: 190, date: "2026-09-03" },
  { inv: "INS-SYN-005", net: 400, date: "2026-09-05" },
  { inv: "INS-SYN-006", net: 75, date: "2026-09-07" }, // cancelled in the report
  { inv: "INS-SYN-007", net: null, initial: 7, date: "2026-09-04" },
  { inv: "INS-SYN-008", net: 999, date: "2026-09-08" }, // only on a superseded row: not in any report
  { inv: "INS-SYN-101", net: 80, date: "2026-09-09" }, // in the August report
  { inv: null, net: 30, date: "2026-09-12" }, // no invoice number
  { inv: "INS-SYN-009", net: 55, date: "2026-10-02" }, // another month
];

describe.skipIf(!TEST_DATABASE_URL)("Finance insurance billed vs claimed (Phase 23D-2)", () => {
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
      const { rows } = await q(
        "select public.fin_insurance_billing_recon_inputs($1, $2, $3, $4) as j",
        [org, month, branch, branches],
      );
      return rows[0].j as Record<string, unknown>;
    });
  const report = async (branch: string | null = null, branches: string[] | null = null) =>
    buildInsuranceBilling(
      parseReconInputs(await inputs(orgA, "2026-09-01", branch, branches)),
      AS_OF,
    );
  const nos = (list: { invoiceNo: string }[]) => list.map((x) => x.invoiceNo);

  let sha = 0;
  const seed = async (org: string, rows: Row[], acts: Act[]) => {
    const uploads: Record<string, string> = {};
    for (const [from, to] of [
      ["2026-08-01", "2026-08-31"],
      ["2026-09-01", "2026-09-30"],
    ]) {
      const { rows: u } = await q(
        `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
         values ($1, $2, $3, $4, 'committed', true, now()) returning id`,
        [org, from, to, SHA(++sha)],
      );
      uploads[from.slice(0, 7)] = u[0].id;
    }
    let rowNo = 0;
    for (const r of rows)
      await q(
        `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name, doctor_key,
           clinic_name, branch_code, patient_pin, insurance_invoice_no, insurance_claim, is_cancelled, is_current)
         values ($1, $2, $3, $4, 'General Medicine', $5, lower($5), $6, $7, $8, $9, $10, $11, $12)`,
        [
          org,
          uploads[r.date.slice(0, 7)],
          ++rowNo,
          r.date,
          r.doctor,
          r.clinic ?? null,
          r.branch,
          `9000000${String(rowNo).padStart(2, "0")}`,
          r.inv,
          r.claim,
          r.cancelled ?? false,
          r.current ?? true,
        ],
      );
    let n = 0;
    for (const a of acts)
      await q(
        `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, activity_start_date,
           transaction_date, net, initial_net, payer_id)
         values ($1, $2, $3, $4, $4, $5, $6, $7)`,
        [org, `SYN-ACT-${++n}`, a.inv, a.date, a.net, a.initial ?? a.net, a.payer ?? null],
      );
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-insbill@example.test");
    const bob = await createAuthUser(c, "bob-insbill@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      await seed(orgA, ROWS_A, ACTS_A);
      // org B has the same numbers: never mixed into org A
      await seed(
        orgB,
        [{ date: "2026-09-02", inv: "INS-SYN-003", claim: 1, branch: "PJ", doctor: "Dr Demo-99" }],
        [
          { inv: "INS-SYN-003", net: 400, date: "2026-09-01" },
          { inv: "INS-SYN-001", net: 5, date: "2026-09-02" },
          { inv: "INS-SYN-777", net: 5, date: "2026-09-02" },
        ],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("the SQL invoice-number rule is the TypeScript rule", async () => {
    const samples = [
      "INS-SYN-001",
      "ins-syn-001",
      " ins syn\t001 \n",
      "Ins\r\nSyn 002",
      "",
      "   ",
      "a b  c",
      "\u000bx\fy",
    ];
    const { rows } = await q("select x, app.fin_invoice_key(x) as k from unnest($1::text[]) as x", [
      samples,
    ]);
    for (const r of rows) expect(r.k, JSON.stringify(r.x)).toBe(normalizeInvoiceNumber(r.x));
    const { rows: nul } = await q("select app.fin_invoice_key(null) as k");
    expect(nul[0].k).toBe(normalizeInvoiceNumber(null));
  });

  it("puts every invoice number in its bucket (no restriction)", async () => {
    const r = await report();
    expect(
      r.matched.map((m) => [m.invoiceNo, m.billed, m.submitted, m.difference, m.flagged]),
    ).toEqual([
      ["INS-SYN-002", 200.5, 190, 10.5, true],
      ["INS-SYN-001", 300, 300, 0, false],
      ["INS-SYN-007", 7, 7, 0, false],
    ]);
    expect(r.matched.find((m) => m.invoiceNo === "INS-SYN-001")).toMatchObject({
      activities: 2,
      payers: ["SYN-P1", "SYN-P2"],
      rows: 1,
    });
    expect(r.matched.find((m) => m.invoiceNo === "INS-SYN-002")!.rows).toBe(2);
    expect(
      r.billedNotSubmitted.map((x) => [x.invoiceNo, x.billed, x.ageDays, x.visiblePairs]),
    ).toEqual([["INS-SYN-003", 400, 19, [{ branch: null, doctor: "Dr Demo-03" }]]]);
    expect(nos(r.awaiting)).toEqual(["INS-SYN-004"]);
    expect(
      r.ambiguous.map((x) => [x.invoiceNo, x.pairs, x.billed, x.submitted, x.visiblePairs]),
    ).toEqual([
      [
        "INS-SYN-005",
        2,
        400,
        400,
        [
          { branch: "GM", doctor: "Dr Demo-02" },
          { branch: "PJ", doctor: "Dr Demo-01" },
        ],
      ],
    ]);
    expect(r.unreported.map((x) => [x.invoiceNo, x.note, x.reportMonth, x.submitted])).toEqual([
      ["INS-SYN-008", "not_in_report", null, 999],
      ["INS-SYN-101", "other_month", "2026-08-01", 80],
      ["INS-SYN-006", "cancelled", null, 75],
    ]);
    expect(r.summary).toMatchObject({
      billed: 300 + 200.5 + 400 + 250 + 400 + 50 + 7,
      submitted: 300 + 190 + 7 + 400,
      atRisk: 400,
      atRiskCount: 1,
      awaitingAmount: 250,
      flaggedCount: 1,
      ambiguousCount: 1,
      noInvoiceNoRows: 1,
      noInvoiceNoAmount: 50,
      cancelledRows: 1,
      cancelledAmount: 75,
      submittedNoInvoiceNoActivities: 1,
      submittedNoInvoiceNoAmount: 30,
      unreportedCount: 3,
    });
    expect(r.summary.matchedPct).toBeCloseTo((300 + 200.5 + 7) / 1607.5, 12);
    // INS-SYN-010 billed nothing and has no claim: in no list
    const all = [...r.matched, ...r.billedNotSubmitted, ...r.awaiting, ...r.ambiguous];
    expect(nos(all)).not.toContain("INS-SYN-010");
    expect(r.coverage.full).toBe(true);
  });

  it("reads the tolerance and grace days from the settings, and refuses values out of range", async () => {
    await svc(() =>
      q(
        `insert into public.fin_ref_finance_settings (org_id, ins_recon_tolerance, ins_recon_grace_days) values ($1, 10.5, 19)
         on conflict (org_id) do update set ins_recon_tolerance = 10.5, ins_recon_grace_days = 19`,
        [orgA],
      ),
    );
    let r = await report();
    expect(r.settings).toEqual({ tolerance: 10.5, graceDays: 19 });
    expect(r.matched.filter((m) => m.flagged)).toEqual([]); // 10.50 is not MORE than 10.50
    expect(nos(r.billedNotSubmitted)).toEqual([]); // 19 days is not MORE than 19
    expect(nos(r.awaiting)).toEqual(["INS-SYN-003", "INS-SYN-004"]);
    await svc(() =>
      q(
        "update public.fin_ref_finance_settings set ins_recon_tolerance = 10.49, ins_recon_grace_days = 18 where org_id = $1",
        [orgA],
      ),
    );
    r = await report();
    expect(nos(r.matched.filter((m) => m.flagged))).toEqual(["INS-SYN-002"]);
    expect(nos(r.billedNotSubmitted)).toEqual(["INS-SYN-003"]);
    for (const [t, g] of [
      [-0.01, 7],
      [1, -1],
      [1, 366],
      [100000.01, 7],
    ])
      await expect(
        svc(() =>
          q(
            "update public.fin_ref_finance_settings set ins_recon_tolerance = $2, ins_recon_grace_days = $3 where org_id = $1",
            [orgA, t, g],
          ),
        ),
        `${t}/${g}`,
      ).rejects.toThrow(/ins_recon_check/);
    await svc(() => q("delete from public.fin_ref_finance_settings where org_id = $1", [orgA]));
    expect((await inputs(orgA, "2026-09-01")).settings).toEqual({ tolerance: 1, grace_days: 7 });
  });

  it("keeps to a member's branches; an unknown branch and the Diligence-only list need an unrestricted view", async () => {
    const pj = await report(null, ["PJ"]);
    expect(nos(pj.matched)).toEqual(["INS-SYN-001"]);
    expect(nos(pj.billedNotSubmitted)).toEqual([]); // INS-SYN-003's branch is unknown
    expect(nos(pj.awaiting)).toEqual(["INS-SYN-004"]);
    // ambiguous over every branch, but only the member's own pair is shown
    expect(pj.ambiguous.map((x) => [x.invoiceNo, x.pairs, x.billed, x.visiblePairs])).toEqual([
      ["INS-SYN-005", 2, 200, [{ branch: "PJ", doctor: "Dr Demo-01" }]],
    ]);
    expect(pj.unreportedShown).toBe(false);
    expect(pj.unreported).toEqual([]);
    expect(pj.summary).toMatchObject({
      billed: 300 + 250 + 200 + 50,
      noInvoiceNoRows: 1,
      cancelledRows: 1,
      submittedNoInvoiceNoActivities: 0,
    });
    expect(JSON.stringify(pj)).not.toContain("Dr Demo-02");

    const gm = await report("GM");
    expect(nos(gm.matched)).toEqual(["INS-SYN-002", "INS-SYN-007"]);
    expect(gm.ambiguous[0].visiblePairs).toEqual([{ branch: "GM", doctor: "Dr Demo-02" }]);
    expect(gm.unreportedShown).toBe(false);
    expect(gm.summary.billed).toBe(200.5 + 200 + 7);

    const none = await report(null, []);
    expect(none.hasData).toBe(false);
    expect(none.summary.billed).toBe(0);

    // mapping the unknown clinic later puts its rows in that branch when read
    await svc(() =>
      q(
        `insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name) values ($1, 'ZZ', 'Synthetic', 'Synthetic Clinic X')`,
        [orgA],
      ),
    );
    expect(nos((await report(null, ["ZZ"])).billedNotSubmitted)).toEqual(["INS-SYN-003"]);
    expect(nos((await report("ZZ")).billedNotSubmitted)).toEqual(["INS-SYN-003"]);
    await svc(() =>
      q("delete from public.fin_ref_branches where org_id = $1 and code = 'ZZ'", [orgA]),
    );
  });

  it("never mixes another org in, and an empty month is empty", async () => {
    const b = buildInsuranceBilling(parseReconInputs(await inputs(orgB, "2026-09-01")), AS_OF);
    expect(b.matched.map((m) => [m.invoiceNo, m.billed, m.submitted])).toEqual([
      ["INS-SYN-003", 1, 400],
    ]);
    expect(nos(b.unreported)).toEqual(["INS-SYN-001", "INS-SYN-777"]);
    const empty = await inputs(orgA, "2025-01-15");
    expect(empty).toMatchObject({
      month: "2025-01-01",
      invoices: [],
      unreported: [],
      coverage: [],
    });
  });

  it("never returns a PIN, a patient ref or a patient field", async () => {
    for (const [branch, branches] of [
      [null, null],
      ["GM", null],
      [null, ["PJ"]],
    ] as const) {
      const text = JSON.stringify(
        await inputs(orgA, "2026-09-01", branch, branches as string[] | null),
      );
      expect(text).not.toMatch(/9000000\d\d/);
      expect(text).not.toMatch(/pin|patient|emirates|member_id|card/i);
    }
  });

  it("signed-in users cannot run the function; it is SECURITY DEFINER with a pinned search_path", async () => {
    await expect(
      asUser(c, alice, () =>
        q("select public.fin_insurance_billing_recon_inputs($1, '2026-09-01')", [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await q(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fin_insurance_billing_recon_inputs'`,
    );
    expect(rows).toEqual([
      { anon: false, auth: false, svc: true, definer: true, config: 'search_path=""' },
    ]);
  });
});
