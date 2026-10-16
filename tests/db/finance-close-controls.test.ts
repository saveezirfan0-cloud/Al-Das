/**
 * Phase 20G part 2: fin_close_controls, the Board pack control summary. Synthetic rows in every source table (bank,
 * payables, revenue share, invoice changes, claims, the close timetable, exceptions) give hand-worked figures; another
 * org's rows never count; an org with nothing reports "not set up" (null), not zero; the function is service-role only;
 * and the summary frozen into the close snapshot is covered by its sha256. End states (signed reconciliation, approved
 * and paid vouchers, approved revenue-share runs, done or blocked steps) are seeded with triggers off
 * (session_replication_role = replica, superuser only) because the real paths need documents, hashes and several people;
 * the CHECK constraints still apply. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveMatters, readControls, type CloseControls } from "@/lib/finance/close-controls";
import { dueOn } from "@/lib/finance/close-timetable";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const SEPT = "2026-09-01";
const TODAY = "2026-10-14";
const HASH = "a".repeat(64);

describe.skipIf(!TEST_DATABASE_URL)("Finance close controls (Phase 20G part 2)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let orgC: string;
  const u: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p)).rows[0];
  const controls = async (org: string, today: string | null = TODAY) =>
    (await svc(() => q("select public.fin_close_controls($1, $2, $3) as r", [org, SEPT, today])))
      .rows[0].r as CloseControls;

  /** Rows for one org; `k` scales org B's amounts so a leak would show. */
  async function seed(org: string, k: number) {
    // --- bank: Main has a signed September reconciliation, Second none, Old is inactive
    const acct = async (name: string, last4: string, active = true) =>
      (
        await one(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4, active) values ($1, $2, 'Synthetic Bank', $3, $4) returning id",
          [org, name, last4, active],
        )
      ).id as string;
    const main = await acct("Main", "1234");
    await acct("Second", "5678");
    await acct("Old", "0000", false);
    const rec = (
      await one(
        `insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end, status, figures, figures_sha256,
                                           prepared_by, prepared_at, signed_by, signed_at)
         values ($1, $2, $3, '2026-09-01', '2026-09-30', 'signed', $4::jsonb, $5, $6, '2026-10-05', $7, '2026-10-06') returning id`,
        [
          org,
          main,
          SEPT,
          JSON.stringify({
            summary: {
              unmatched: {
                waiting: { count: 1, amount: 100 * k },
                "0-7": { count: 0, amount: 0 },
                "8-30": { count: 2, amount: 250.5 * k },
                "31-60": { count: 0, amount: 0 },
                "60+": { count: 0, amount: 0 },
              },
            },
            problems: [],
          }),
          HASH,
          u.prep,
          u.signer,
        ],
      )
    ).id as string;
    const imp = (
      await one(
        "insert into public.fin_bank_imports (org_id, kind, account_id, file_sha256) values ($1, 'bank_statement', $2, $3) returning id",
        [org, main, (k === 1 ? "1" : "2").repeat(64)],
      )
    ).id as string;
    const line = async (row: number, date: string, amount: number, status = "unmatched") =>
      (
        await one(
          "insert into public.fin_bank_lines (org_id, account_id, import_id, row_no, value_date, amount, match_status) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, main, imp, row, date, amount, status],
        )
      ).id as string;
    await line(1, "2026-07-20", 500 * k); // unexplained, 86 days at TODAY
    await line(2, "2026-09-10", 200 * k); // unexplained, 34 days
    const explained = await line(3, "2026-09-12", 300 * k); // has a reason
    await line(4, "2026-09-15", 400 * k, "matched");
    await line(5, "2026-09-20", -50 * k); // a debit
    await line(6, "2026-10-02", 70 * k); // after the month end
    await q(
      "insert into public.fin_bank_rec_notes (org_id, rec_id, item_key, reason_code) values ($1, $2, $3, 'other_income')",
      [org, rec, `bank|${explained}`],
    );

    // --- payables
    const supplier = (
      await one(
        "insert into public.fin_suppliers (org_id, name) values ($1, 'Synthetic Supplies') returning id",
        [org],
      )
    ).id as string;
    const invoice = async (no: string, date: string, net: number, status = "open") =>
      (
        await one(
          "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, status) values ($1, $2, $3, $4, 'supplies', $5, $6) returning id",
          [org, supplier, no, date, net * k, status],
        )
      ).id as string;
    await invoice("I1", "2026-09-25", 1000); // 0-30
    await invoice("I2", "2026-08-10", 2000); // 31-60
    await invoice("I3", "2026-06-01", 3000, "on_voucher"); // 90+
    const paidEarly = await invoice("I4", "2026-07-15", 500, "paid"); // paid before the month end
    const paidLate = await invoice("I5", "2026-07-20", 700, "paid"); // paid after it: 61-90
    await invoice("I6", "2026-09-05", 900, "void");
    await invoice("I7", "2026-10-03", 800); // after the month end
    let n = 0;
    const voucher = async (status: string, amount: number, extra: Record<string, string> = {}) => {
      n++;
      const submitted = status !== "draft";
      return (
        await one(
          `insert into public.fin_payment_vouchers (org_id, voucher_no, voucher_date, payee_name, amount, category, narration, status,
                                                    route, content_sha256, submitted_at, approved_at, payment_date, payment_reference, paid_at)
           values ($1, $2, '2026-09-20', 'Synthetic payee', $3, 'supplies', 'Synthetic', $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [
            org,
            `PV-2026-${String(n).padStart(4, "0")}`,
            amount * k,
            status,
            submitted ? (status === "for_tally" ? "tally" : "pulse") : null,
            submitted ? HASH : null,
            submitted ? "2026-09-20T08:00:00Z" : null,
            extra.approved_at ?? null,
            extra.payment_date ?? null,
            extra.payment_date ? "BANK-REF" : null,
            extra.payment_date ? `${extra.payment_date}T08:00:00Z` : null,
          ],
        )
      ).id as string;
    };
    await voucher("approved", 1500, { approved_at: "2026-09-20T08:00:00Z" }); // 24 days at TODAY
    await voucher("approved", 250, { approved_at: "2026-10-10T10:00:00Z" }); // 4 days
    await voucher("submitted", 100);
    await voucher("checked", 200);
    await voucher("dept_approved", 300);
    await voucher("for_tally", 400);
    await voucher("draft", 999);
    const early = await voucher("paid", 500, {
      approved_at: "2026-09-19T08:00:00Z",
      payment_date: "2026-09-20",
    });
    const late = await voucher("paid", 700, {
      approved_at: "2026-09-19T08:00:00Z",
      payment_date: "2026-10-05",
    });
    await q(
      "insert into public.fin_voucher_invoices (org_id, voucher_id, supplier_invoice_id) values ($1, $2, $3), ($1, $4, $5)",
      [org, early, paidEarly, late, paidLate],
    );

    // --- revenue share: September approved on 13 Oct (after WD7), August posted, October excluded (after the month)
    const run = async (month: string, status: string, approvedAt: string) =>
      (
        await one(
          `insert into public.fin_revshare_runs (org_id, month, status, snapshot, snapshot_hash, built_by, verified_by, verified_at,
                                                 approved_by, approved_at, posted_ref, posted_at)
           values ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7, $8, $7, $9, $10) returning id`,
          [
            org,
            month,
            status,
            HASH,
            u.prep,
            u.signer,
            approvedAt,
            u.ceo,
            status === "posted" ? "JV-1" : null,
            status === "posted" ? approvedAt : null,
          ],
        )
      ).id as string;
    const rLine = (runId: string, doctor: string, payout: number, paid = false) =>
      q(
        `insert into public.fin_revshare_lines (org_id, run_id, doctor_dha_id, scheme_id, scheme_version, payout, paid_on, payment_ref, paid_recorded_at)
         values ($1, $2, $3, gen_random_uuid(), 1, $4, $5, $6, $7)`,
        [
          org,
          runId,
          doctor,
          payout * k,
          paid ? "2026-10-14" : null,
          paid ? "PAY-1" : null,
          paid ? "2026-10-14T08:00:00Z" : null,
        ],
      );
    const sept = await run(SEPT, "approved", "2026-10-13T06:00:00Z");
    await rLine(sept, "DHA-SYN-1", 1000);
    await rLine(sept, "DHA-SYN-2", 500, true);
    await rLine(sept, "DHA-SYN-3", 0);
    await rLine(await run("2026-08-01", "posted", "2026-09-10T06:00:00Z"), "DHA-SYN-1", 800);
    await rLine(await run("2026-10-01", "approved", "2026-11-10T06:00:00Z"), "DHA-SYN-1", 999);

    // --- invoice changes: refunds (start date 10 Sep)
    const inv = (
      await one(
        `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, inv_type, net, total, record_hash)
         values ($1, 'INV-SYN-1', '2026-09-01', 'SELF PAID', 0, 0, 'h') returning id`,
        [org],
      )
    ).id as string;
    for (const [key, refund, date] of [
      ["P1", 100, "2026-09-05"],
      ["P2", 200, "2026-09-15"],
      ["P3", 300, "2026-09-20"],
      ["P4", 400, "2026-09-25"],
      ["P5", 50, "2026-10-02"],
    ] as const)
      await q(
        "insert into public.fin_payments (org_id, invoice_id, payment_key, paid, paid_date, refund, refund_date, is_current) values ($1, $2, $3, 0, '2026-09-01', $4, $5, true)",
        [org, inv, key, refund * k, date],
      );
    await q(
      "update public.fin_ref_finance_settings set change_review_start_date = '2026-09-10', change_review_min_amount = 0 where org_id = $1",
      [org],
    );
    const events = (
      await one("select public.fin_invoice_changes($1, '2026-09-01', '2026-09-30') as r", [org])
    ).r.events as Array<{ change_key: string; amount: number; change_date: string }>;
    const review = async (date: string, decision: string) => {
      const e = events.find((x) => x.change_date === date)!;
      await q(
        `insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason)
         values ($1, $2, $3, 'refund', $4, $5, $6, 'Synthetic reason')`,
        [org, e.change_key, inv, e.amount, date, decision],
      );
    };
    await review("2026-09-20", "approved");
    await review("2026-09-25", "rejected");

    // --- insurance claims
    for (const [no, date, net, remitted, writeOff] of [
      ["C1", "2026-09-01", 1000, 0, null], // 43 days
      ["C2", "2026-06-01", 3000, 1000, null], // 135 days, 2,000 open
      ["C3", "2026-05-01", 500, 500, null], // paid
      ["C4", "2026-07-01", 800, 0, 800], // written off (approved)
    ] as const)
      await q(
        `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, transaction_date, net, remitted, write_off, write_off_status)
         values ($1, $2, 'INV', $3, $4, $5, $6, $7)`,
        [
          org,
          no,
          date,
          net * k,
          remitted * k,
          writeOff ? writeOff * k : null,
          writeOff ? "Approved" : null,
        ],
      );

    // --- exceptions
    await q(
      `insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, owner_role, status, opened_at, closed_at, closure_note)
       values ($1, 'E06', 'claim', 'X/1', 'billing', 'open', '2026-08-01T10:00:00Z', null, null),
              ($1, 'E06', 'claim', 'X/2', 'billing', 'in_progress', '2026-10-01T10:00:00Z', null, null),
              ($1, 'E06', 'claim', 'X/3', 'billing', 'closed', '2026-05-01T10:00:00Z', '2026-05-02T10:00:00Z', 'Synthetic')`,
      [org],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "carol", "prep", "signer", "ceo"])
      u[n] = await createAuthUser(c, `${n}-controls@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", u.alice);
    orgB = await createOrg(c, "Org B", "org-b", u.bob);
    orgC = await createOrg(c, "Org C", "org-c", u.carol);
    await q("update public.orgs set timezone = 'Asia/Dubai' where id in ($1, $2, $3)", [
      orgA,
      orgB,
      orgC,
    ]);
    await q("set session_replication_role = replica");
    try {
      await seed(orgA, 1);
      await seed(orgB, 10);
    } finally {
      await q("set session_replication_role = default");
    }
    // the close timetable (real paths): standard steps, September's tasks, then a few end states
    await svc(async () => {
      await q("select public.fin_close_seed_steps($1)", [orgA]);
      await q(
        "insert into public.fin_ref_holidays (org_id, holiday_on, name) values ($1, '2026-10-06', 'Synthetic holiday')",
        [orgA],
      );
      await q("select public.fin_close_generate_tasks($1, $2)", [orgA, SEPT]);
    });
    const wd5 = (
      await q(
        "select id from public.fin_close_tasks where org_id = $1 and month = $2 and due_wd = 5 order by step_code",
        [orgA, SEPT],
      )
    ).rows.map((r) => r.id as string);
    await q(
      "update public.fin_close_tasks set status = 'done', done_at = '2026-10-07T10:00:00Z' where id = $1",
      [wd5[0]],
    );
    await q(
      "update public.fin_close_tasks set status = 'done', done_at = '2026-10-09T10:00:00Z' where id = $1",
      [wd5[1]],
    );
    await q(
      "update public.fin_close_tasks set status = 'blocked', blocked_reason = 'Waiting for a synthetic file' where id = $1",
      [wd5[2]],
    );
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("works out every block for the month from synthetic rows", async () => {
    const r = await controls(orgA);
    expect(r).toMatchObject({
      version: 1,
      month: SEPT,
      month_end: "2026-09-30",
      as_of: TODAY,
      settings: {
        item_max_age_days: 60,
        voucher_unpaid_days: 14,
        receivables_over90_pct: 25,
        inputs_wd: 5,
        revshare_wd: 7,
      },
    });
    expect(r.bank!.accounts.map((a) => [a.name, a.status])).toEqual([
      ["Main", "signed"],
      ["Second", "none"],
    ]);
    expect(r.bank!.accounts[0]).toMatchObject({
      last4: "1234",
      period_end: "2026-09-30",
      expected_unmatched: { count: 3, amount: 350.5 },
      bank_unexplained: { count: 2, amount: 700, oldest_days: 86, over_limit: 1 },
    });
    expect(r.bank!.accounts[1]).toMatchObject({
      expected_unmatched: null,
      bank_unexplained: { count: 0, amount: 0, oldest_days: null, over_limit: 0 },
    });
    expect(r.payables).toEqual({
      invoices_unpaid: { count: 4, amount: 6700 },
      by_age: [
        { bucket: "0-30", count: 1, amount: 1000 },
        { bucket: "31-60", count: 1, amount: 2000 },
        { bucket: "61-90", count: 1, amount: 700 },
        { bucket: "90+", count: 1, amount: 3000 },
      ],
      vouchers_approved_unpaid: {
        count: 2,
        amount: 1750,
        oldest_days: 24,
        over_limit: { count: 1, amount: 1500 },
      },
      vouchers_waiting: {
        submitted: { count: 1, amount: 100 },
        checked: { count: 1, amount: 200 },
        dept_approved: { count: 1, amount: 300 },
        for_tally: { count: 1, amount: 400 },
      },
    });
    expect(r.revenue_share).toEqual({
      run_status: "approved",
      approved_on: "2026-10-13",
      due_on: "2026-10-12",
      liability: {
        total: 1800,
        runs: [
          { month: "2026-08-01", status: "posted", doctors: 1, unpaid: 800 },
          { month: SEPT, status: "approved", doctors: 1, unpaid: 1000 },
        ],
      },
    });
    expect(r.invoice_changes).toEqual({
      measured: true,
      from: "2026-09-10",
      unapproved: { count: 2, amount: 600 },
    });
    expect(r.receivables).toEqual({
      open_claims: 2,
      outstanding: 3000,
      over_90: { count: 1, amount: 2000 },
      over_90_pct: 66.7,
    });
    // 13 steps since the 16 Oct 2026 controls: the revenue and cost submissions (WD4) count as inputs
    expect(r.timetable).toMatchObject({
      tasks: 13,
      done: 2,
      blocked: 1,
      inputs_wd: 5,
      inputs_due_on: "2026-10-08",
      inputs: { total: 8, on_time: 1, late: 7, pending: 0 },
    });
    expect(r.exceptions).toEqual({ open: 2, oldest_days: 74, over_limit: 1 });
  });

  it("counts working days exactly as the timetable does (weekend and holiday)", async () => {
    const r = await controls(orgA);
    const cal = { weekend: [6, 7], holidays: ["2026-10-06"] };
    expect(r.timetable!.inputs_due_on).toBe(dueOn(SEPT, 5, cal));
    expect(r.revenue_share!.due_on).toBe(dueOn(SEPT, 7, cal));
  });

  it("judges inputs not yet due as pending on an earlier day", async () => {
    const r = await controls(orgA, "2026-10-08");
    // the two WD4 submissions were due on 7 October, so they are late on the 8th
    expect(r.timetable!.inputs).toEqual({ total: 8, on_time: 1, late: 3, pending: 4 });
  });

  it("reads the thresholds from the settings", async () => {
    await q(
      "update public.fin_ref_finance_settings set close_voucher_unpaid_days = 30, close_receivables_over90_pct = 70, close_item_max_age_days = 90, close_revshare_wd = 8 where org_id = $1",
      [orgA],
    );
    try {
      const r = await controls(orgA);
      expect(r.settings).toMatchObject({
        voucher_unpaid_days: 30,
        receivables_over90_pct: 70,
        item_max_age_days: 90,
        revshare_wd: 8,
      });
      expect(r.payables!.vouchers_approved_unpaid.over_limit.count).toBe(0);
      expect(r.bank!.accounts[0].bank_unexplained.over_limit).toBe(0);
      expect(r.exceptions.over_limit).toBe(0);
      expect(r.revenue_share!.due_on).toBe("2026-10-13");
      expect(deriveMatters(r).map((m) => m.key)).not.toContain("receivables_old");
    } finally {
      await q(
        "update public.fin_ref_finance_settings set close_voucher_unpaid_days = 14, close_receivables_over90_pct = 25, close_item_max_age_days = 60, close_revshare_wd = 7 where org_id = $1",
        [orgA],
      );
    }
  });

  it("derives the matters needing attention from the summary", async () => {
    const r = readControls(await controls(orgA))!;
    const second = r.bank!.accounts[1].account_id;
    const main = r.bank!.accounts[0].account_id;
    expect(deriveMatters(r).map((m) => m.key)).toEqual([
      `bank_old:${main}`,
      `bank_unsigned:${second}`,
      "vouchers_unpaid",
      "revshare_late",
      "invoice_changes",
      "receivables_old",
      "inputs_late",
      "steps_blocked",
      "exceptions_old",
    ]);
  });

  it("never counts another organisation's rows", async () => {
    const b = await controls(orgB);
    expect(b.payables!.invoices_unpaid).toEqual({ count: 4, amount: 67000 });
    expect(b.receivables!.outstanding).toBe(30000);
    expect(b.revenue_share!.liability.total).toBe(18000);
    expect(b.bank!.accounts[0].bank_unexplained.amount).toBe(7000);
    expect(b.invoice_changes).toMatchObject({ unapproved: { count: 2, amount: 6000 } });
    expect(b.timetable).toBeNull(); // only org A has a timetable
  });

  it("says 'not set up' for an organisation with no data, never zero", async () => {
    const r = await controls(orgC);
    expect(r).toMatchObject({
      bank: null,
      payables: null,
      revenue_share: null,
      invoice_changes: { measured: false },
      receivables: null,
      timetable: null,
      exceptions: { open: 0, oldest_days: null, over_limit: 0 },
    });
    expect(deriveMatters(readControls(r)!)).toEqual([]);
  });

  it("refuses an unknown organisation", async () => {
    await expect(
      svc(() => q("select public.fin_close_controls(gen_random_uuid(), $1, $2)", [SEPT, TODAY])),
    ).rejects.toThrow(/organisation not found/);
  });

  it("is service-role only", async () => {
    await expect(
      asUser(c, u.alice, () =>
        q("select public.fin_close_controls($1, $2, $3)", [orgA, SEPT, TODAY]),
      ),
    ).rejects.toThrow(/permission denied/);
    const r = await one(
      `select p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
       from pg_proc p where p.proname = 'fin_close_controls' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(r).toEqual({
      prosecdef: true,
      proconfig: ['search_path=""'],
      anon: false,
      auth: false,
      svc: true,
    });
  });

  it("is frozen into the close snapshot and covered by its sha256", async () => {
    const summary = await controls(orgA, null);
    const snapshot = { version: 1, month: SEPT, controls: summary };
    const store = (s: unknown) =>
      svc(() =>
        q("select public.fin_close_store_snapshot($1, $2, $3, $4::jsonb)", [
          orgA,
          SEPT,
          u.alice,
          JSON.stringify(s),
        ]),
      );
    await store(snapshot);
    const row = await one(
      `select snapshot -> 'controls' as controls, snapshot_hash,
              encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') as recomputed
       from public.fin_period_closes where org_id = $1 and month = $2`,
      [orgA, SEPT],
    );
    expect(row.controls).toEqual(summary);
    expect(row.snapshot_hash).toBe(row.recomputed);
    // the same pack with one control figure changed has a different fingerprint
    await store({
      ...snapshot,
      controls: { ...summary, exceptions: { ...summary.exceptions, open: 99 } },
    });
    const after = await one(
      "select snapshot_hash from public.fin_period_closes where org_id = $1 and month = $2",
      [orgA, SEPT],
    );
    expect(after.snapshot_hash).not.toBe(row.snapshot_hash);
  });
});
