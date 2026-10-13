/**
 * Phase 22K: the accounting slices agree (migration 20261109000900, docs/22_PHASE_22K_NOTES.md).
 *
 *   - every ledger code seeded by 22A, 22D, 22E, 22F, 22G, 22H and 22I carries one meaning, and every slice's
 *     reference (posting rules, the receivable ledger, asset classes, cash flow classes) points at the right account;
 *     workspaces seeded before the fix are repaired, never touching an account that has journal lines;
 *   - one journal per economic event: a voucher paid by cheque (cheque register vs posting engine), a customer receipt
 *     by cheque (receipt vs cheque register), a statement line (settlement match vs bank entry);
 *   - the year-end close posts before the ledger start, and the statements leave the closing journal out;
 *   - every HISTORY_TABLES table is readable through app.can_view_record_history by a holder of its permission.
 * All data synthetic.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAccountingPosting, type PostingPort } from "@/lib/accounting/posting/runner";
import type { JobLogger } from "@/lib/jobs/types";
import { HISTORY_PERMISSION, HISTORY_TABLES } from "@/lib/security/history";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type Row = Record<string, unknown>;
const HASH = "c".repeat(64);
const silent: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** The runner's port over a plain Postgres connection (service role), as in accounting-posting.test.ts. */
function pgPort(c: Client): PostingPort {
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  return {
    async rpc(fn, args) {
      const keys = Object.keys(args);
      const vals = keys.map((k) => {
        const v = args[k];
        const textArray = Array.isArray(v) && v.every((x) => typeof x === "string");
        return v !== null && typeof v === "object" && !textArray ? JSON.stringify(v) : v;
      });
      try {
        const { rows } = await svc(() =>
          c.query(
            `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
            vals,
          ),
        );
        return rows[0].r;
      } catch (e) {
        const err = e as { code?: string; hint?: string };
        throw new Error(`${fn}: ${err.code ?? "error"}${err.hint ? ` (${err.hint})` : ""}`);
      }
    },
    cursors: async (orgId) =>
      (
        await svc(() =>
          c.query(
            "select source_kind, cursor_at::text as cursor_at, cursor_id from public.acc_posting_cursors where org_id = $1",
            [orgId],
          ),
        )
      ).rows,
    waiting: async (orgId, before, limit) =>
      (
        await svc(() =>
          c.query(
            "select source_kind, source_id from public.acc_posting_status where org_id = $1 and state = 'waiting' and last_attempt_at <= $2 order by last_attempt_at limit $3",
            [orgId, before, limit],
          ),
        )
      ).rows,
    orgTimezone: async (orgId) =>
      (await c.query("select timezone from public.orgs where id = $1", [orgId])).rows[0]
        ?.timezone ?? null,
    orgsWithLedger: async () =>
      (
        await c.query(
          "select distinct org_id::text as o from public.acc_entities where is_default order by 1",
        )
      ).rows.map((r) => r.o),
  };
}

describe.skipIf(!TEST_DATABASE_URL)("Accounting integration (Phase 22K)", () => {
  let c: Client;
  let orgA: string;
  let orgFresh: string;
  let orgY: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Row>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const rpc = async <T = Row>(fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await one<{ r: T }>(`select public.${fn}(${ph}) as r`, args)).r;
  };
  const accountId = async (code: string, org = orgA) =>
    (
      await one<{ id: string }>(
        "select id from public.acc_accounts where org_id = $1 and code = $2",
        [org, code],
      )
    ).id;
  /** debit minus credit on one ledger over every posted or reversed journal (reversals are journals of their own) */
  const balance = async (code: string, org = orgA) =>
    Number(
      (
        await q(
          `select coalesce(sum(l.debit - l.credit), 0)::float as b from public.acc_journal_lines l
           join public.acc_journals j on j.id = l.journal_id join public.acc_accounts a on a.id = l.account_id
           where j.org_id = $1 and a.code = $2 and j.status in ('posted', 'reversed')`,
          [org, code],
        )
      ).rows[0].b,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "fresh", "yeu"])
      users[n] = await createAuthUser(c, `${n}-22k@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-22k", users.alice);
    orgFresh = await createOrg(c, "Org Fresh", "org-fresh-22k", users.fresh);
    orgY = await createOrg(c, "Org Y", "org-y-22k", users.yeu);
    await q("update public.acc_entities set ledger_start_date = '2000-01-01' where org_id = $1", [
      orgA,
    ]);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("ledger codes: one meaning per code", () => {
    const EXPECTED: Record<string, [string, string, string | null]> = {
      // 22A
      "1150": ["Bank - current account", "asset", "bank"],
      "1200": ["Insurance receivable", "asset", "receivable"],
      "1210": ["Patient receivable", "asset", "receivable"],
      "1500": ["Medical equipment", "asset", null],
      "1510": ["Furniture and fittings", "asset", null],
      "1590": ["Accumulated depreciation", "asset", null],
      "2100": ["Supplier payables", "liability", "payable"],
      "3100": ["Retained earnings", "equity", "retained_earnings"],
      "6400": ["Depreciation", "expense", null],
      "6500": ["Bank and card charges", "expense", null],
      "9100": ["Opening balance difference", "liability", null],
      // 22D
      "1220": ["Corporate receivable", "asset", "receivable"],
      "2330": ["Patient advances and deposits", "liability", null],
      "4990": ["Sales credit notes", "income", null],
      "6620": ["Insurance denials written off", "expense", null],
      "6920": ["Cash over and short", "expense", null],
      // 22E (receivable control moved from 1220 to 1230 by 22K)
      "1230": ["Customer receivables", "asset", "receivable"],
      "4910": ["Rental income", "income", null],
      // 22H (disposal gain / loss moved from 4910 to 4920 by 22K)
      "1520": ["IT equipment", "asset", null],
      "1530": ["Leasehold improvements", "asset", null],
      "1540": ["Motor vehicles", "asset", null],
      "1591": ["Accumulated depreciation - medical equipment", "asset", null],
      "1592": ["Accumulated depreciation - IT equipment", "asset", null],
      "1593": ["Accumulated depreciation - furniture and fittings", "asset", null],
      "1594": ["Accumulated depreciation - leasehold improvements", "asset", null],
      "1595": ["Accumulated depreciation - motor vehicles", "asset", null],
      "2310": ["Deferred revenue", "liability", null],
      "4920": ["Gain or loss on disposal of fixed assets", "income", null],
    };

    it("seeds a fresh org through every trigger with each code meaning what every slice expects", async () => {
      const { rows } = await svc(() =>
        q(
          "select code, name, nature, control, cash_flow_class from public.acc_accounts where org_id = $1 and code = any ($2)",
          [orgFresh, Object.keys(EXPECTED)],
        ),
      );
      const got = Object.fromEntries(rows.map((r) => [r.code, [r.name, r.nature, r.control]]));
      expect(got).toEqual(EXPECTED);
      // 22G: accumulated depreciation is non-cash, the generic ledger and each class's
      const cls = Object.fromEntries(rows.map((r) => [r.code, r.cash_flow_class]));
      for (const code of ["1590", "1591", "1592", "1593", "1594", "1595"])
        expect(cls[code], code).toBe("operating_noncash");
      // one retained earnings control (22I links Tally's P&L A/c to it)
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.acc_accounts where org_id = $1 and control = 'retained_earnings' and not is_group",
            [orgFresh],
          )
        ).n,
      ).toBe(1);
    });

    it("points every slice's references at the account of that meaning", async () => {
      // 22D posting rules
      const rules = (
        await svc(() =>
          q(
            `select r.kind || '|' || r.key as k, a.code from public.acc_posting_rules r join public.acc_accounts a on a.id = r.account_id
             where r.org_id = $1 and r.qualifier = '*'`,
            [orgFresh],
          ),
        )
      ).rows;
      const m = new Map(rules.map((r) => [r.k, r.code]));
      expect(m.get("receivable|corporate")).toBe("1220");
      expect(m.get("receivable|insurance")).toBe("1200");
      expect(m.get("receivable|self_pay")).toBe("1210");
      expect(m.get("patient_advance|*")).toBe("2330");
      expect(m.get("credit_note|*")).toBe("4990");
      expect(m.get("denial_writeoff|*")).toBe("6620");
      expect(m.get("cashup_over_short|*")).toBe("6920");
      expect(m.get("payable|*")).toBe("2100");
      expect(m.get("bank|*")).toBe("1150");
      // 22E: a customer without its own ledger books into 1230
      const cust = (
        await q(
          "insert into public.acc_customers (org_id, kind, name) values ($1, 'corporate', 'Synthetic Fresh Corp') returning id",
          [orgFresh],
        )
      ).rows[0].id;
      expect(
        (
          await q(
            "select a.code from public.acc_accounts a where a.id = app.acc_ar_receivable_account($1, $2)",
            [orgFresh, cust],
          )
        ).rows[0].code,
      ).toBe("1230");
      // 22H asset classes
      const classes = (
        await svc(() =>
          q(
            `select k.code, c.code as cost, a.code as accum, e.code as expense, d.code as gain
             from public.acc_asset_classes k join public.acc_accounts c on c.id = k.cost_account_id
             join public.acc_accounts a on a.id = k.accum_account_id join public.acc_accounts e on e.id = k.expense_account_id
             join public.acc_accounts d on d.id = k.disposal_account_id where k.org_id = $1 order by k.code`,
            [orgFresh],
          ),
        )
      ).rows;
      expect(classes).toEqual([
        { code: "FURN", cost: "1510", accum: "1593", expense: "6400", gain: "4920" },
        { code: "IT", cost: "1520", accum: "1592", expense: "6400", gain: "4920" },
        { code: "LHI", cost: "1530", accum: "1594", expense: "6400", gain: "4920" },
        { code: "MED", cost: "1500", accum: "1591", expense: "6400", gain: "4920" },
        { code: "VEH", cost: "1540", accum: "1595", expense: "6400", gain: "4920" },
      ]);
    });

    it("repairs a workspace seeded before the fix (unused accounts only)", async () => {
      const org = orgFresh;
      const code = async (cd: string) =>
        (
          await q("select id, name from public.acc_accounts where org_id = $1 and code = $2", [
            org,
            cd,
          ])
        ).rows[0] as { id: string; name: string } | undefined;
      const repair = async () =>
        (await q("select app.acc_integration_repair_codes($1) as r", [org])).rows[0].r as {
          done: string[];
        };
      const toOld = async () => {
        // the merged state before 22K: no 1230, the classes on 4910 (whatever its name), no 4920
        await q("update public.acc_customers set receivable_account_id = null where org_id = $1", [
          org,
        ]);
        await q("delete from public.acc_accounts where org_id = $1 and code = '1230'", [org]);
        await q(
          "update public.acc_asset_classes set disposal_account_id = (select id from public.acc_accounts where org_id = $1 and code = '4910') where org_id = $1",
          [org],
        );
        await q("delete from public.acc_accounts where org_id = $1 and code = '4920'", [org]);
      };
      const gains = async () =>
        (
          await q(
            "select distinct a.code from public.acc_asset_classes k join public.acc_accounts a on a.id = k.disposal_account_id where k.org_id = $1",
            [org],
          )
        ).rows.map((r) => r.code);

      // pastes in order (44 before 45, 45 before 48): 1220 and 4910 are right, 1230 and 4920 missing
      await toOld();
      let r = await repair();
      expect(r.done).toContain("asset classes now use 4920");
      expect((await code("1230"))?.name).toBe("Customer receivables");
      expect(await gains()).toEqual(["4920"]);
      expect((await repair()).done).toEqual([]); // idempotent

      // pastes out of order: 22E got 1220 and 22H got 4910
      await toOld();
      await q(
        "update public.acc_accounts set name = 'Customer receivables' where org_id = $1 and code = '1220'",
        [org],
      );
      await q(
        "update public.acc_accounts set name = 'Gain or loss on disposal of fixed assets' where org_id = $1 and code = '4910'",
        [org],
      );
      r = await repair();
      expect(r.done).toEqual(
        expect.arrayContaining([
          "1220 renamed Corporate receivable",
          "4910 renamed Rental income",
          "asset classes now use 4920",
        ]),
      );
      expect((await code("1220"))?.name).toBe("Corporate receivable");
      expect((await code("1230"))?.name).toBe("Customer receivables");
      expect((await code("4910"))?.name).toBe("Rental income");
      expect((await code("4920"))?.name).toBe("Gain or loss on disposal of fixed assets");
      expect(await gains()).toEqual(["4920"]);

      // an account with journal lines is never renamed; 22E's receivable then falls back to it by name
      await q("delete from public.acc_accounts where org_id = $1 and code = '1230'", [org]);
      await q(
        "update public.acc_accounts set name = 'Customer receivables' where org_id = $1 and code = '1220'",
        [org],
      );
      await rpc("acc_post_from_source", [
        org,
        null,
        "tally_import",
        "GUID-22K-1",
        1,
        "2026-07-10",
        "journal",
        "Synthetic import",
        JSON.stringify([
          { account_code: "1220", debit: 10 },
          { account_code: "4910", credit: 10 },
        ]),
      ]);
      r = await repair();
      expect(r.done).toContain("1220 left (has lines)");
      expect((await code("1220"))?.name).toBe("Customer receivables");
      expect(await code("1230")).toBeUndefined();
      const cust = (await q("select id from public.acc_customers where org_id = $1 limit 1", [org]))
        .rows[0].id;
      expect(
        (
          await q(
            "select a.code from public.acc_accounts a where a.id = app.acc_ar_receivable_account($1, $2)",
            [org, cust],
          )
        ).rows[0].code,
      ).toBe("1220");
    });
  });

  describe("one journal per economic event", () => {
    let bank: string;
    let gl1150: string;
    let supplier: string;
    let voucher: string;
    let customer: string;
    const NOW = new Date("2027-08-15T08:00:00Z");
    const run = () =>
      runAccountingPosting(pgPort(c), silent, {
        orgIds: [orgA],
        now: NOW,
        settleSeconds: 0,
        retryAfterMinutes: 0,
      });
    const status = (kind: string, id: string) =>
      one<{ state: string; reason: string | null; journal_id: string | null }>(
        "select state, reason, journal_id from public.acc_posting_status where org_id = $1 and source_kind = $2 and source_id = $3",
        [orgA, kind, id],
      );
    const voucherJournals = async () =>
      (
        await one<{ n: number }>(
          "select count(*)::int as n from public.acc_journals where org_id = $1 and source_kind = 'voucher' and status = 'posted'",
          [orgA],
        )
      ).n;

    beforeAll(async () => {
      gl1150 = await accountId("1150");
      await svc(async () => {
        bank = (
          await q(
            "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', '4321') returning id",
            [orgA],
          )
        ).rows[0].id;
        supplier = (
          await q(
            "insert into public.fin_suppliers (org_id, name) values ($1, 'Synthetic Lab Supplier') returning id",
            [orgA],
          )
        ).rows[0].id;
        voucher = (
          await q(
            `insert into public.fin_payment_vouchers (org_id, voucher_no, voucher_date, payee_name, supplier_id, amount, category, narration, status,
                                                      route, content_sha256, submitted_at, approved_at, payment_date, payment_reference, paid_at,
                                                      payment_method)
             values ($1, 'PV-2027-0901', '2027-07-19', 'Synthetic Lab Supplier', $2, 600, 'Rent', 'Synthetic', 'paid', 'pulse', $3,
                     '2027-07-19T08:00:00Z', '2027-07-19T09:00:00Z', '2027-07-20', 'CHQ', '2027-07-20T08:00:00Z', 'cheque')
             returning id`,
            [orgA, supplier, HASH],
          )
        ).rows[0].id;
        customer = (
          await q(
            "insert into public.acc_customers (org_id, kind, name) values ($1, 'corporate', 'Synthetic Corp') returning id",
            [orgA],
          )
        ).rows[0].id;
      });
      await rpc("acc_bank_link_gl", [orgA, users.alice, bank, gl1150]);
    });

    it("a voucher paid by cheque: the register posts the bank side, the engine waits until a cheque is registered", async () => {
      await run();
      expect(await status("voucher", voucher)).toMatchObject({
        state: "waiting",
        reason: "cheque_not_registered",
      });
      expect(await voucherJournals()).toBe(0);
      // nobody posts the voucher's payment directly either (every role)
      expect(
        hint(
          await fails(
            rpc("acc_post_from_source", [
              orgA,
              null,
              "voucher",
              voucher,
              9,
              "2027-07-20",
              "payment",
              "Synthetic",
              JSON.stringify([
                { account_code: "2100", debit: 600 },
                { account_code: "1150", credit: 600 },
              ]),
            ]),
          ),
        ),
      ).toBe("cheque_not_registered");

      const payable = await accountId("2100");
      const ch = await rpc<{ id: string; posting: string }>("acc_cheque_register", [
        orgA,
        users.alice,
        JSON.stringify({
          direction: "issued",
          bank_account_id: bank,
          cheque_no: "000123",
          cheque_date: "2027-07-20",
          recorded_on: "2027-07-20",
          amount: 600,
          party_kind: "supplier",
          party_ref: supplier,
          counter_account_id: payable,
          voucher_id: voucher,
        }),
        "2027-07-20",
      ]);
      expect(ch.posting).toBe("posted");
      await run();
      expect((await status("voucher", voucher)).state).toBe("nothing");
      expect(await voucherJournals()).toBe(0);
      // the bank is credited once
      expect(await balance("1150")).toBe(-600);
      expect(await balance("2100")).toBe(600);

      // the cheque bounces: the engine waits again, and a replacement cheque may name the same voucher
      await rpc("acc_cheque_act", [
        orgA,
        users.alice,
        ch.id,
        "bounce",
        "2027-07-25",
        "insufficient funds",
        null,
        "2027-07-25",
      ]);
      await run();
      expect(await status("voucher", voucher)).toMatchObject({
        state: "waiting",
        reason: "cheque_not_registered",
      });
      expect(await balance("1150")).toBe(0);
      const ch2 = await rpc<{ id: string; posting: string }>("acc_cheque_register", [
        orgA,
        users.alice,
        JSON.stringify({
          direction: "issued",
          bank_account_id: bank,
          cheque_no: "000124",
          cheque_date: "2027-07-26",
          recorded_on: "2027-07-26",
          amount: 600,
          party_kind: "supplier",
          party_ref: supplier,
          counter_account_id: payable,
          voucher_id: voucher,
        }),
        "2027-07-26",
      ]);
      expect(ch2.posting).toBe("posted");
      await run();
      expect((await status("voucher", voucher)).state).toBe("nothing");
      expect(await balance("1150")).toBe(-600);
      expect(await voucherJournals()).toBe(0);
    });

    it("a customer receipt by cheque: the receipt owns the posting, dated the cheque, and a bounce voids it", async () => {
      const recv = await accountId("1230");
      const before = await balance("1150");
      const received = (no: string, date: string, today: string, amount: number) =>
        rpc<{ id: string; posting: string }>("acc_cheque_register", [
          orgA,
          users.alice,
          JSON.stringify({
            direction: "received",
            bank_account_id: bank,
            cheque_no: no,
            cheque_date: date,
            recorded_on: today,
            amount,
            party_kind: "customer",
            party_ref: customer,
            counter_account_id: recv,
          }),
          today,
        ]);
      const save = (amount: number, chequeId: string | null, mode = "cheque") =>
        rpc<{ id: string; posting_status: string }>("acc_receipt_save", [
          orgA,
          users.alice,
          JSON.stringify({
            customer_id: customer,
            receipt_date: "2026-09-02",
            account_id: gl1150,
            amount,
            mode,
            cheque_id: chequeId,
          }),
          null,
        ]);

      // a receipt by cheque names a registered cheque of the same amount
      expect(hint(await fails(save(250, null)))).toBe("cheque_not_registered");
      const a = await received("700001", "2026-09-01", "2026-09-02", 250);
      expect(a.posting).toBe("posted"); // the register posted it before any receipt named it
      expect(hint(await fails(save(251, a.id)))).toBe("cheque_mismatch");
      expect(hint(await fails(save(250, a.id, "bank_transfer")))).toBe("invalid");

      const r = await save(250, a.id);
      expect(r.posting_status).toBe("posted");
      const rec = await one<{ journal_id: string; journal_date: string; source_kind: string }>(
        `select r.journal_id, j.journal_date::text, j.source_kind from public.acc_receipts r
         join public.acc_journals j on j.id = r.journal_id where r.id = $1`,
        [r.id],
      );
      expect(rec).toMatchObject({ journal_date: "2026-09-01", source_kind: "receipt" });
      const chA = await one<{ posting: string; journal_id: string }>(
        "select posting, journal_id from public.acc_cheques where id = $1",
        [a.id],
      );
      expect(chA).toEqual({ posting: "posted", journal_id: rec.journal_id });
      // the register's own journal was reversed when the receipt took over: the bank is debited once
      expect(
        (
          await one<{ status: string }>(
            "select status from public.acc_journals where org_id = $1 and source_kind = 'cheque' and source_id = $2",
            [orgA, a.id],
          )
        ).status,
      ).toBe("reversed");
      expect((await balance("1150")) - before).toBe(250);
      // the register never posts it again, and the receipt is voided only through the cheque
      expect(
        hint(
          await fails(
            rpc("acc_post_from_source", [
              orgA,
              null,
              "cheque",
              a.id,
              2,
              "2026-09-01",
              "receipt",
              "Synthetic",
              JSON.stringify([
                { account_code: "1150", debit: 250 },
                { account_code: "1230", credit: 250 },
              ]),
            ]),
          ),
        ),
      ).toBe("cheque_by_receipt");
      expect(
        hint(
          await fails(
            rpc("acc_receipt_void", [orgA, r.id, users.alice, "2026-09-03", "typed twice"]),
          ),
        ),
      ).toBe("receipt_has_cheque");

      await rpc("acc_cheque_act", [
        orgA,
        users.alice,
        a.id,
        "bounce",
        "2026-09-05",
        "returned unpaid",
        null,
        "2026-09-05",
      ]);
      expect(
        await one(
          "select status, amount_allocated::float as allocated from public.acc_receipts where id = $1",
          [r.id],
        ),
      ).toEqual({ status: "void", allocated: 0 });
      expect((await balance("1150")) - before).toBe(0);

      // a post-dated cheque: the receipt waits for the cheque's date and the register's sweep posts it then
      const b = await received("700002", "2099-01-10", "2026-09-02", 100);
      expect(b.posting).toBe("not_due");
      const rb = await save(100, b.id);
      expect(rb.posting_status).toBe("not_posted");
      await rpc("acc_banking_sweep", [orgA, "2099-01-10"]);
      const rbj = await one<{ posting_status: string; journal_date: string; journal_id: string }>(
        `select r.posting_status, j.journal_date::text, r.journal_id from public.acc_receipts r
         join public.acc_journals j on j.id = r.journal_id where r.id = $1`,
        [rb.id],
      );
      expect(rbj).toMatchObject({ posting_status: "posted", journal_date: "2099-01-10" });
      expect(
        await one("select posting, journal_id from public.acc_cheques where id = $1", [b.id]),
      ).toEqual({ posting: "posted", journal_id: rbj.journal_id });
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.acc_journals where org_id = $1 and source_kind = 'cheque' and source_id = $2",
            [orgA, b.id],
          )
        ).n,
      ).toBe(0);
    });

    it("a statement line is explained once: by a settlement match or by a bank entry, never both", async () => {
      const ids = await svc(async () => {
        const imp = (
          await q(
            "insert into public.fin_bank_imports (org_id, kind, account_id, file_sha256, row_count) values ($1, 'bank_statement', $2, $3, 2) returning id",
            [orgA, bank, "d".repeat(64)],
          )
        ).rows[0].id;
        const line = async (row: number, amount: number) =>
          (
            await q(
              "insert into public.fin_bank_lines (org_id, account_id, import_id, row_no, value_date, amount, reference) values ($1, $2, $3, $4, '2027-07-12', $5, 'SYN') returning id",
              [orgA, bank, imp, row, amount],
            )
          ).rows[0].id as string;
        const l1 = await line(1, 500);
        const l2 = await line(2, 40);
        const rec = (
          await q(
            "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end, status) values ($1, $2, '2027-07-01', '2027-07-01', '2027-07-31', 'open') returning id",
            [orgA, bank],
          )
        ).rows[0].id as string;
        await q(
          `insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status)
           values ($1, $2, $3, 'pay|Tabby|2027-07-12/R1', 'payout', '2027-07-12', 500, 500, 95, 'matched')`,
          [orgA, rec, l1],
        );
        return { l1, l2, rec };
      });
      const other = await accountId("4900");
      const mk = (line: string, amount: number) =>
        rpc<{ id: string; status: string }>("acc_bank_entry_create", [
          orgA,
          users.alice,
          JSON.stringify({
            bank_account_id: bank,
            entry_date: "2027-07-12",
            kind: "direct_credit",
            amount,
            account_id: other,
            narration: "Synthetic credit",
            bank_line_id: line,
          }),
        ]);
      // the settlement match (posted by 22D) explains line 1: no bank entry, even if the line's flag were stale
      expect(hint(await fails(mk(ids.l1, 500)))).toBe("line_matched");
      await q("update public.fin_bank_lines set match_status = 'unmatched' where id = $1", [
        ids.l1,
      ]);
      expect(hint(await fails(mk(ids.l1, 500)))).toBe("line_matched");
      // a bank entry explains line 2: the reconciliation cannot match it as well
      expect((await mk(ids.l2, 40)).status).toBe("posted");
      expect(
        hint(
          await fails(
            svc(() =>
              q(
                `insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status)
                 values ($1, $2, $3, 'col|Card|2027-07-12', 'collection', '2027-07-12', 40, 40, 90, 'matched')`,
                [orgA, ids.rec, ids.l2],
              ),
            ),
          ),
        ),
      ).toBe("line_has_bank_entry");
    });
  });

  describe("year-end close and the statements", () => {
    it("closes a year Tally kept before the ledger start, and the statements leave the closing journal out", async () => {
      const post = (id: string, date: string, lines: unknown[]) =>
        rpc("acc_post_from_source", [
          orgY,
          null,
          "tally_import",
          id,
          1,
          date,
          "journal",
          "Synthetic Tally voucher",
          JSON.stringify(lines),
        ]);
      await post("GUID-Y-1", "2025-08-10", [
        { account_code: "1150", debit: 500 },
        { account_code: "4100", credit: 500 },
      ]);
      await post("GUID-Y-2", "2025-09-10", [
        { account_code: "6200", debit: 200 },
        { account_code: "1150", credit: 200 },
      ]);
      const fy = (
        await one<{ id: string }>(
          "select id from public.acc_fiscal_years where org_id = $1 and start_date = '2025-07-01'",
          [orgY],
        )
      ).id;
      await rpc("acc_year_end_close_months", [orgY, fy, users.yeu]);
      const r = await rpc<{ journal_id: string; result: number }>("acc_year_end_close", [
        orgY,
        fy,
        users.yeu,
      ]);
      expect(r.journal_id).toBeTruthy();
      expect(
        (
          await one<{ s: string | null }>(
            "select ledger_start_date::text as s from public.acc_entities where org_id = $1",
            [orgY],
          )
        ).s,
      ).toBeNull();
      // the close does not count as "Pulse has posted": the ledger start still moves freely
      const entity = (
        await one<{ id: string }>("select id from public.acc_entities where org_id = $1", [orgY])
      ).id;
      expect(
        (await q("select app.acc_first_pulse_journal($1) as d", [entity])).rows[0].d,
      ).toBeNull();
      await rpc("acc_set_ledger_start", [orgY, entity, users.yeu, "2026-08-01"]);
      await rpc("acc_set_ledger_start", [orgY, entity, users.yeu, "2026-07-01"]);

      const pl = await rpc<{ totals: Array<{ net_profit: number }> }>("acc_profit_and_loss", [
        orgY,
        null,
        "2025-07-01",
        "2026-06-30",
        "none",
        true,
      ]);
      expect(Number(pl.totals[0].net_profit)).toBe(300);
      const cf = await rpc<{
        net_profit: number;
        totals: { difference: number; financing: number };
      }>("acc_cash_flow", [orgY, null, "2025-07-01", "2026-06-30", true]);
      expect(Number(cf.net_profit)).toBe(300);
      expect(Number(cf.totals.financing)).toBe(0);
      expect(Number(cf.totals.difference)).toBe(0);
      const ct = await rpc<{ accounting_profit: number }>("acc_ct_bridge", [
        orgY,
        null,
        "2025-07-01",
        "2026-06-30",
      ]);
      expect(Number(ct.accounting_profit)).toBe(300);
      // the balance sheet stays post-closing: the profit sits in retained earnings
      const bs = await rpc<{ totals: { difference: number }; current_year_pl: number }>(
        "acc_balance_sheet",
        [orgY, null, "2026-06-30", true],
      );
      expect(Number(bs.totals.difference)).toBe(0);

      // re-opening reverses the close: the statements are unchanged
      await rpc("acc_year_end_reopen", [orgY, fy, users.yeu, "auditor adjustment"]);
      const pl2 = await rpc<{ totals: Array<{ net_profit: number }> }>("acc_profit_and_loss", [
        orgY,
        null,
        "2025-07-01",
        "2026-06-30",
        "none",
        true,
      ]);
      expect(Number(pl2.totals[0].net_profit)).toBe(300);
    });
  });

  describe("shared definitions", () => {
    it("lets a holder of each HISTORY_TABLES permission read that table's history, and no one else", async () => {
      const entries = Object.entries(HISTORY_PERMISSION) as Array<[string, string]>;
      // every table with a fixed permission is covered (the rest are portal tables, read through portal_objects)
      for (const t of Object.keys(HISTORY_TABLES))
        if (!t.startsWith("ref_") && t !== "website_entry_points")
          expect(HISTORY_PERMISSION, t).toHaveProperty(t);
      let i = 0;
      for (const [table, perm] of entries) {
        i += 1;
        const holder = await createAuthUser(c, `hist-${i}-22k@example.test`);
        const role = (
          await one<{ id: string }>(
            "insert into public.roles (org_id, name, description, permissions) values ($1, $2, 'synthetic', $3::jsonb) returning id",
            [orgA, `History ${i}`, JSON.stringify([perm])],
          )
        ).id;
        await svc(() =>
          q("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
            orgA,
            holder,
            role,
          ]),
        );
        const r = await asUser(c, holder, () =>
          q("select app.can_view_record_history($1, $2) as ok", [orgA, table]),
        );
        expect(r.rows[0].ok, `${table} with ${perm}`).toBe(true);
      }
      const stranger = await createAuthUser(c, "hist-stranger-22k@example.test");
      for (const [table] of entries) {
        const r = await asUser(c, stranger, () =>
          q("select app.can_view_record_history($1, $2) as ok", [orgA, table]),
        );
        expect(r.rows[0].ok, table).toBe(false);
      }
    });

    it("keeps every slice's journal source kinds and access-log entities", async () => {
      const def = (
        await q(
          "select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'public.acc_journals'::regclass and conname = 'acc_journals_source_kind_check'",
        )
      ).rows[0].d as string;
      for (const k of [
        "unite_invoice",
        "voucher",
        "opening",
        "tally_import",
        "fixed_asset",
        "sales_invoice",
        "receipt",
        "reversal",
        "bank_transfer",
        "bank_entry",
        "petty_cash",
        "cheque",
        "year_end",
      ])
        expect(def, k).toContain(`'${k}'`);
      const fn = (
        await q(
          "select pg_get_functiondef('public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb)'::regprocedure) as d",
        )
      ).rows[0].d as string;
      for (const k of [
        "bank_transfer",
        "bank_entry",
        "petty_cash",
        "cheque",
        "sales_invoice",
        "fixed_asset",
      ])
        expect(fn, k).toContain(`'${k}'`);
      expect(fn).toContain("before_ledger_start");
      const log = (
        await q(
          "select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'public.record_access_log'::regclass and conname = 'record_access_log_entity_check'",
        )
      ).rows[0].d as string;
      for (const e of [
        "accounting_journal",
        "accounting_receivable",
        "finance_document",
        "contact",
      ])
        expect(log, e).toContain(`'${e}'`);
    });
  });
});
