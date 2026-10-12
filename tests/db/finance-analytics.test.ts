/**
 * The Phase 18 analytics functions on synthetic data: payer scorecards, denial reasons, forecast inputs, revenue breakdown,
 * self-pay balances, the accounting-journal source and the cash-up expectation. Each one is scoped to the organisation it is
 * given, and none can be called by a signed-in user. Amounts are small enough to check by hand.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildForecast, parseHistory, parseOutstanding } from "@/lib/finance/forecast";
import {
  buildJournal,
  parseJournalSource,
  type AccountMapRow,
} from "@/lib/finance/accounting-export";
import { parseRevenue } from "@/lib/finance/revenue";
import { parseScorecardRows } from "@/lib/finance/scorecard";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 18: analytics functions", () => {
  let c: Client;
  let alice: string;
  let orgA: string;
  let orgB: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const fn = async (sql: string, params: unknown[]) =>
    (await q(`select ${sql} as r`, params)).rows[0].r;

  async function claim(
    org: string,
    no: string,
    o: {
      payer: string;
      tx: string;
      net: number;
      remitted?: number;
      rejected?: number;
      first?: string | null;
      doctor?: string;
      initialRejected?: number;
      code?: string | null;
      writeOff?: number;
      wos?: string;
    },
    invoiceId?: string,
  ) {
    await q(
      "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, net, remitted, rejected, initial_rejected, first_remittance_date, clinician_id, last_denial_code, write_off, write_off_status, matched_invoice_id) values ($1, $2, 'INV', '99213', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
      [
        org,
        no,
        o.payer,
        o.tx,
        o.net,
        o.remitted ?? 0,
        o.rejected ?? 0,
        o.initialRejected ?? 0,
        o.first ?? null,
        o.doctor ?? "DHA-1",
        o.code ?? null,
        o.writeOff ?? 0,
        o.wos ?? null,
        invoiceId ?? null,
      ],
    );
  }
  async function invoice(
    org: string,
    no: string,
    o: {
      date: string;
      branch: string;
      type: string;
      doctor: string;
      dept: string;
      total: number;
      net: number;
      vat?: number;
      writeOff?: number;
      creditNote?: number;
      pin?: string;
      deleted?: boolean;
    },
  ) {
    const id = (
      await q(
        "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, doctor_dha_id, doctor_name, department, inv_type, gross, net, vat, total, write_off, credit_note, is_deleted, record_hash) values ($1, $2, $3, $4, $5, $6, 'Dr Fake', $7, $8, $9, $9, $10, $11, $12, $13, $14, 'h') returning id",
        [
          org,
          no,
          o.date,
          o.pin ?? "PIN-AN",
          o.branch,
          o.doctor,
          o.dept,
          o.type,
          o.net,
          o.vat ?? 0,
          o.total,
          o.writeOff ?? 0,
          o.creditNote ?? 0,
          o.deleted ?? false,
        ],
      )
    ).rows[0].id as string;
    await q(
      "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, qty, line_gross, line_discount, line_net, vat) values ($1, $2, $3, 1, $4, 1, $5, 0, $5, $6)",
      [org, id, `${no}|I|1`, o.dept === "Lab" ? "T-LAB" : "T-CONS", o.net, o.vat ?? 0],
    );
    return id;
  }
  async function payment(
    org: string,
    invId: string,
    key: string,
    o: {
      mode: string;
      paid: number;
      date: string;
      refund?: number;
      refundDate?: string;
      current?: boolean;
    },
  ) {
    await q(
      "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date, refund, refund_date, is_current) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        org,
        invId,
        key,
        o.mode,
        o.paid,
        o.date,
        o.refund ?? 0,
        o.refundDate ?? null,
        o.current ?? true,
      ],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      await q(
        "insert into public.fin_ref_services (org_id, item_code, service_category, description) values ($1, 'T-CONS', 'Consultation', 'Consultation'), ($1, 'T-LAB', 'Laboratory', 'Lab panel') on conflict (org_id, item_code) do update set service_category = excluded.service_category, description = excluded.description",
        [orgA],
      );
      await q(
        "insert into public.fin_ref_doctors (org_id, dha_id, name, department) values ($1, 'DHA-1', 'Dr Alpha', 'Dermatology'), ($1, 'DHA-2', 'Dr Beta', 'Lab')",
        [orgA],
      );

      // insurance invoices
      const i1 = await invoice(orgA, "A-1", {
        date: "2026-09-02",
        branch: "P",
        type: "INSURANCE",
        doctor: "DHA-1",
        dept: "Dermatology",
        total: 105,
        net: 100,
        vat: 5,
        writeOff: 5,
      });
      const i2 = await invoice(orgA, "A-2", {
        date: "2026-09-03",
        branch: "M",
        type: "INSURANCE",
        doctor: "DHA-2",
        dept: "Lab",
        total: 210,
        net: 200,
        vat: 10,
      });
      const i3 = await invoice(orgA, "A-3", {
        date: "2026-09-04",
        branch: "P",
        type: "SELF PAID",
        doctor: "DHA-1",
        dept: "Dermatology",
        total: 262.51,
        net: 250,
        vat: 12.5,
        creditNote: 10,
        pin: "PIN-SP1",
      });
      await invoice(orgA, "A-DEL", {
        date: "2026-09-04",
        branch: "P",
        type: "SELF PAID",
        doctor: "DHA-1",
        dept: "Dermatology",
        total: 999,
        net: 999,
        deleted: true,
      });

      // claims: PAYER-A has 4, one denied, paid in 10/20/30 days; PAYER-B has 2, both denied, paid late
      await claim(
        orgA,
        "C1",
        {
          payer: "PAYER-A",
          tx: "2026-09-02",
          net: 100,
          remitted: 100,
          first: "2026-09-12",
          doctor: "DHA-1",
        },
        i1,
      );
      await claim(
        orgA,
        "C2",
        {
          payer: "PAYER-A",
          tx: "2026-09-02",
          net: 100,
          remitted: 60,
          rejected: 40,
          initialRejected: 40,
          first: "2026-09-22",
          doctor: "DHA-1",
          code: "AUTH-001",
        },
        i1,
      );
      await claim(
        orgA,
        "C3",
        {
          payer: "PAYER-A",
          tx: "2026-09-03",
          net: 200,
          remitted: 200,
          first: "2026-10-03",
          doctor: "DHA-2",
        },
        i2,
      );
      await claim(
        orgA,
        "C4",
        { payer: "PAYER-A", tx: "2026-09-03", net: 50, remitted: 0, doctor: "DHA-2" },
        i2,
      ); // unpaid, outstanding 50
      await claim(
        orgA,
        "C5",
        {
          payer: "PAYER-B",
          tx: "2026-09-05",
          net: 100,
          remitted: 0,
          rejected: 100,
          initialRejected: 100,
          code: "AUTH-002",
          doctor: "DHA-1",
          writeOff: 30,
          wos: "approved",
        },
        i1,
      );
      await claim(orgA, "C6", {
        payer: "PAYER-B",
        tx: "2026-09-06",
        net: 80,
        remitted: 40,
        rejected: 40,
        initialRejected: 0,
        first: "2026-11-05",
        code: "ZZZ-9",
        doctor: "DHA-1",
      });
      await claim(orgA, "C-OUT", { payer: "PAYER-A", tx: "2026-07-01", net: 500, remitted: 0 }); // outside the period

      await payment(orgA, i3, "P1", { mode: "CASH", paid: 100, date: "2026-09-04" });
      await payment(orgA, i3, "P2", {
        mode: "CARD",
        paid: 162.51,
        date: "2026-09-04",
        refund: 20,
        refundDate: "2026-09-05",
      });
      await payment(orgA, i1, "P3", { mode: "CARD", paid: 50, date: "2026-09-02" });
      await payment(orgA, i1, "P4", {
        mode: "CARD",
        paid: 777,
        date: "2026-09-02",
        current: false,
      }); // superseded
      // another organisation with its own data: must never leak into org A's numbers
      const ib = await invoice(orgB, "A-1", {
        date: "2026-09-02",
        branch: "P",
        type: "INSURANCE",
        doctor: "DHA-1",
        dept: "Dermatology",
        total: 9999,
        net: 9999,
      });
      await claim(
        orgB,
        "C1",
        {
          payer: "PAYER-A",
          tx: "2026-09-02",
          net: 9999,
          remitted: 0,
          rejected: 9999,
          initialRejected: 9999,
        },
        ib,
      );
      await payment(orgB, ib, "PB", { mode: "CASH", paid: 5000, date: "2026-09-02" });
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("scorecard by payer: counts, denial, amounts and days to pay, scoped to the org and period", async () => {
    await asServiceRole(c, async () => {
      const rows = parseScorecardRows(
        await fn("public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'payer')", [orgA]),
      );
      const a = rows.find((r) => r.group_key === "PAYER-A")!;
      const b = rows.find((r) => r.group_key === "PAYER-B")!;
      expect(a).toMatchObject({
        claims: 4,
        denied_claims: 1,
        net: 450,
        remitted: 360,
        rejected: 40,
        paid_claims: 3,
      });
      expect(a.avg_days_to_pay).toBe(20); // 10, 20, 30
      expect(b).toMatchObject({
        claims: 2,
        denied_claims: 2,
        net: 180,
        rejected: 140,
        paid_claims: 1,
      });
      expect(b.avg_days_to_pay).toBe(60); // 2026-09-06 -> 2026-11-05
      expect(rows.map((r) => r.group_key)).not.toContain("(no payer)");
    });
  });

  it("scorecard by doctor, department and branch, and filtered to one payer", async () => {
    await asServiceRole(c, async () => {
      const doc = parseScorecardRows(
        await fn("public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'doctor')", [orgA]),
      );
      expect(doc.find((r) => r.group_key === "DHA-1")).toMatchObject({
        claims: 4,
        group_label: "Dr Alpha",
      });
      const dept = parseScorecardRows(
        await fn("public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'department')", [
          orgA,
        ]),
      );
      expect(dept.map((r) => r.group_key).sort()).toEqual(["Dermatology", "Lab"]);
      const branch = parseScorecardRows(
        await fn("public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'branch')", [orgA]),
      );
      expect(branch.map((r) => r.group_key).sort()).toEqual(["(no branch)", "M", "P"]);
      const onlyB = parseScorecardRows(
        await fn(
          "public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'doctor', 'PAYER-B')",
          [orgA],
        ),
      );
      expect(onlyB.reduce((a, r) => a + r.claims, 0)).toBe(2);
      await expect(
        q("select public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'patient')", [orgA]),
      ).rejects.toThrow(/unknown scorecard grouping/);
    });
  });

  it("denial reasons: grouped by code, with the taxonomy description where known", async () => {
    await asServiceRole(c, async () => {
      const rows = (await fn("public.fin_denial_reasons($1, '2026-09-01', '2026-09-30')", [
        orgA,
      ])) as Array<{
        reason_code: string;
        description: string | null;
        claims: number;
        amount: number;
      }>;
      expect(rows.find((r) => r.reason_code === "AUTH-001")).toMatchObject({
        claims: 1,
        amount: 40,
      });
      expect(rows.find((r) => r.reason_code === "AUTH-001")?.description).toMatch(/authorisation/i); // the seeded AUTH family
      expect(rows.find((r) => r.reason_code === "AUTH-002")).toMatchObject({
        claims: 1,
        category: "authorization",
      }); // family match
      expect(rows.find((r) => r.reason_code === "ZZZ-9")).toMatchObject({
        claims: 1,
        description: null,
      });
    });
  });

  it("forecast inputs: outstanding by payer and week (net of approved write-offs), and payer history", async () => {
    await asServiceRole(c, async () => {
      const out = parseOutstanding(await fn("public.fin_forecast_outstanding($1)", [orgA]));
      const total = (p: string) =>
        out.filter((r) => r.payer_id === p).reduce((a, r) => a + r.outstanding, 0);
      expect(total("PAYER-A")).toBe(40 + 50 + 500); // C2 (net - remitted), C4, C-OUT
      expect(total("PAYER-B")).toBe(70 + 40); // C5 (less the approved write-off of 30), C6
      expect(out.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.week_start))).toBe(true);
      // weeks start on a Monday
      for (const r of out) expect(new Date(`${r.week_start}T00:00:00Z`).getUTCDay()).toBe(1);

      const hist = parseHistory(await fn("public.fin_forecast_history($1, 1)", [orgA]));
      const a = hist.find((h) => h.payer_id === "PAYER-A")!;
      expect(a).toMatchObject({ paid_claims: 3, p25: 15, p50: 20, p75: 25, p90: 28 });
      expect(a.collection_rate).toBe(0.3789); // 360 collected of 950 billed
      const b = hist.find((h) => h.payer_id === "PAYER-B")!;
      expect(b.paid_claims).toBe(1);
      // the pure forecaster accepts exactly what the database returns
      const f = buildForecast(out, hist, "2026-10-12", {
        horizonWeeks: 13,
        defaultLagDays: 60,
        defaultCollectionRate: 0.9,
        minHistory: 3,
        tailWeeks: 4,
      });
      expect(f.totalOutstanding).toBe(700);
      expect(f.expectedTotal).toBeGreaterThan(0);
      expect(f.expectedTotal).toBeLessThan(700);
    });
  });

  it("revenue breakdown by every dimension: current lines of non-deleted invoices only, in range, one org", async () => {
    await asServiceRole(c, async () => {
      const by = async (dim: string, branch: string | null = null) =>
        parseRevenue(
          await fn("public.fin_revenue_breakdown($1, '2026-09-01', '2026-09-30', $2, $3)", [
            orgA,
            dim,
            branch,
          ]),
        );
      expect((await by("category")).map((r) => [r.key, r.net])).toEqual([
        ["Consultation", 350],
        ["Laboratory", 200],
      ]);
      expect((await by("doctor")).map((r) => [r.key, r.label, r.net])).toEqual([
        ["DHA-1", "Dr Alpha", 350],
        ["DHA-2", "Dr Beta", 200],
      ]);
      expect((await by("department")).map((r) => [r.key, r.net])).toEqual([
        ["Dermatology", 350],
        ["Lab", 200],
      ]);
      expect((await by("branch")).map((r) => [r.key, r.net])).toEqual([
        ["P", 350],
        ["M", 200],
      ]);
      expect((await by("service")).map((r) => [r.key, r.label, r.net])).toEqual([
        ["T-CONS", "Consultation", 350],
        ["T-LAB", "Lab panel", 200],
      ]);
      expect((await by("month")).map((r) => [r.key, r.net])).toEqual([["2026-09", 550]]);
      expect((await by("category", "M")).map((r) => [r.key, r.net])).toEqual([["Laboratory", 200]]);
      expect((await by("doctor"))[0].invoices).toBe(2);
      await expect(
        q("select public.fin_revenue_breakdown($1, '2026-09-01', '2026-09-30', 'patient')", [orgA]),
      ).rejects.toThrow(/unknown revenue dimension/);
      const none = parseRevenue(
        await fn("public.fin_revenue_breakdown($1, '2030-01-01', '2030-01-31', 'category')", [
          orgA,
        ]),
      );
      expect(none).toEqual([]);
    });
  });

  it("self-pay balances: total - paid + refunds - write-off - credit notes, floored at zero, self-pay only", async () => {
    await asServiceRole(c, async () => {
      const rows = (await fn("public.fin_selfpay_balances($1, 0, 0, 100)", [orgA])) as Array<{
        inv_display_number: string;
        balance: number;
        settled: number;
        patient_pin: string;
      }>;
      expect(rows.map((r) => r.inv_display_number)).toEqual(["A-3"]);
      expect(rows[0]).toMatchObject({ balance: 10, settled: 242.51, patient_pin: "PIN-SP1" });
      expect(await fn("public.fin_selfpay_balances($1, 50, 0, 100)", [orgA])).toEqual([]);
      expect(await fn("public.fin_selfpay_balances($1, 0, 100000, 100)", [orgA])).toEqual([]);
    });
  });

  it("journal source and a real balanced journal built from it", async () => {
    await asServiceRole(c, async () => {
      const src = parseJournalSource(
        await fn("public.fin_journal_source($1, '2026-09-01', '2026-09-30')", [orgA]),
      );
      expect(src.sales.map((s) => [s.date, s.branch, s.type, s.category, s.net, s.vat])).toEqual([
        ["2026-09-02", "P", "insurance", "Consultation", 100, 5],
        ["2026-09-03", "M", "insurance", "Laboratory", 200, 10],
        ["2026-09-04", "P", "self_pay", "Consultation", 250, 12.5],
      ]);
      expect(src.totals.find((t) => t.type === "self_pay")).toMatchObject({
        total: 262.51,
        credit_note: 10,
        write_off: 0,
      });
      expect(src.totals.find((t) => t.branch === "P" && t.type === "insurance")).toMatchObject({
        write_off: 5,
      });
      expect(src.receipts.map((r) => [r.date, r.type, r.mode, r.paid])).toEqual([
        ["2026-09-02", "insurance", "CARD", 50],
        ["2026-09-04", "self_pay", "CARD", 162.51],
        ["2026-09-04", "self_pay", "CASH", 100],
      ]);
      expect(src.refunds).toEqual([
        { date: "2026-09-05", branch: "P", type: "self_pay", mode: "CARD", refund: 20 },
      ]);
      const accounts: AccountMapRow[] = [
        ["revenue", "Consultation", "4000"],
        ["revenue", "Laboratory", "4100"],
        ["payment_mode", "CARD", "1020"],
        ["payment_mode", "CASH", "1010"],
        ["receivable", "insurance", "1200"],
        ["receivable", "self_pay", "1210"],
        ["vat_output", "*", "2200"],
        ["writeoff", "*", "5900"],
        ["credit_note", "*", "5910"],
        ["rounding", "*", "5990"],
      ].map(([kind, key, code]) => ({ kind, key, account_code: code, account_name: null }));
      const j = buildJournal(src, accounts, { status: "final" });
      expect(j.ok).toBe(true);
      if (j.ok) expect(j.debitTotal).toBe(j.creditTotal);
    });
  });

  it("cash-up expectation: payments of the day at the branch by mode, refunds on their own day", async () => {
    await asServiceRole(c, async () => {
      const day = (await fn("public.fin_cashup_expected($1, 'P', '2026-09-04')", [orgA])) as Array<{
        mode: string;
        expected: number;
        payments: number;
      }>;
      expect(day).toEqual([
        { mode: "CARD", expected: 162.51, payments: 1 },
        { mode: "CASH", expected: 100, payments: 1 },
      ]);
      const refundDay = (await fn("public.fin_cashup_expected($1, 'P', '2026-09-05')", [
        orgA,
      ])) as Array<{ mode: string; expected: number }>;
      expect(refundDay).toEqual([expect.objectContaining({ mode: "CARD", expected: -20 })]);
      expect(await fn("public.fin_cashup_expected($1, 'M', '2026-09-04')", [orgA])).toEqual([]);
      // org B's 5,000 cash on another day at branch P never shows up for org A
      const other = (await fn("public.fin_cashup_expected($1, 'P', '2026-09-02')", [
        orgA,
      ])) as Array<{ mode: string; expected: number }>;
      expect(other).toEqual([{ mode: "CARD", expected: 50, payments: 1 }]);
    });
  });

  it("returns org B's own numbers for org B (isolation both ways)", async () => {
    await asServiceRole(c, async () => {
      const rows = parseScorecardRows(
        await fn("public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'payer')", [orgB]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ group_key: "PAYER-A", claims: 1, net: 9999, rejected: 9999 });
      expect(
        parseRevenue(
          await fn("public.fin_revenue_breakdown($1, '2026-09-01', '2026-09-30', 'category')", [
            orgB,
          ]),
        )[0].net,
      ).toBe(9999);
    });
  });

  it("cannot be called by a signed-in user, even an admin", async () => {
    await asUser(c, alice, async () => {
      for (const sql of [
        "select public.fin_payer_scorecard($1, '2026-09-01', '2026-09-30', 'payer')",
        "select public.fin_forecast_outstanding($1)",
        "select public.fin_revenue_breakdown($1, '2026-09-01', '2026-09-30', 'doctor')",
        "select public.fin_journal_source($1, '2026-09-01', '2026-09-30')",
        "select public.fin_selfpay_balances($1)",
        "select public.fin_close_month_figures($1, '2026-09-01')",
      ])
        await expect(q(sql, [orgA]), sql).rejects.toThrow(/permission denied/);
    });
  });
});
