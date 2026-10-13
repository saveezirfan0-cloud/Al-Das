/**
 * Phase 22F: banking and cash, database side. The ledger link of a 20C bank account (and a new ledger under Bank
 * Accounts or Bank OD A/c), transfers (Contra) and their cancellation, bank entries with VAT and from a statement line
 * (the line counts as matched), petty cash (float, top-up, expense with a receipt, the monthly count signed by a second
 * person, bound to its fingerprint), the cheque register (posting now or on the cheque's date, presented / cleared /
 * bounced with a reversal, a flag and a charge, cancelled, stale, cheque books, patients by PIN only), the bank
 * position, items waiting for the ledger start (hint before_ledger_start) and the sweep that posts them, immutability,
 * record history, who reads what and that nobody writes directly. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bookToBank } from "@/lib/accounting/banking";
import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";

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

describe.skipIf(!TEST_DATABASE_URL)("Accounting banking and cash (Phase 22F)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const as = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Row>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const accountId = async (code: string, org = orgA) =>
    (
      await one<{ id: string }>(
        "select id from public.acc_accounts where org_id = $1 and code = $2",
        [org, code],
      )
    ).id;
  const rpc = async <T = Row>(fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await one<{ r: T }>(`select public.${fn}(${ph}) as r`, args)).r;
  };
  const lines = async (journalId: string) =>
    (
      await svc(() =>
        q(
          `select a.code, l.debit::float as debit, l.credit::float as credit
           from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id
           where l.journal_id = $1 order by l.line_no`,
          [journalId],
        ),
      )
    ).rows as Array<{ code: string; debit: number; credit: number }>;
  const journal = (id: string) =>
    one<{
      voucher_type: string;
      journal_date: string;
      status: string;
      source_kind: string;
      total: string;
      reversed_by: string | null;
    }>(
      "select voucher_type, journal_date::text, status, source_kind, total::text, reversed_by from public.acc_journals where id = $1",
      [id],
    );
  const balanced = async (journalId: string) => {
    const ls = await lines(journalId);
    const d = ls.reduce((s, l) => s + l.debit, 0);
    const cr = ls.reduce((s, l) => s + l.credit, 0);
    return Math.round(d * 100) === Math.round(cr * 100) && d > 0;
  };

  let bankA: string; // fin_bank_accounts, linked to ledger 1150
  let bankB: string; // a second account (overdraft)
  let gl1150: string;
  let cashP: string;
  let bankBOther: string; // org B's bank account

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "acct", "acct2", "chief", "ceo", "auditor", "fin"])
      users[n] = await createAuthUser(c, `${n}-bank@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-bank", users.alice);
    orgB = await createOrg(c, "Org B", "org-b-bank", users.bob);
    await svc(async () => {
      for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("acct", "Accountant");
      await member("acct2", "Accountant");
      await member("chief", "Chief Accountant");
      await member("ceo", "CEO");
      await member("auditor", "Auditor");
      await member("fin", "Finance");
      bankA = (
        await q(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', '4321') returning id",
          [orgA],
        )
      ).rows[0].id;
      bankB = (
        await q(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Overdraft', 'Synthetic Bank', '8765') returning id",
          [orgA],
        )
      ).rows[0].id;
      bankBOther = (
        await q(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', '1111') returning id",
          [orgB],
        )
      ).rows[0].id;
    });
    gl1150 = await accountId("1150");
    cashP = await accountId("1100-P");
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("bank accounts and their ledgers", () => {
    it("links a bank account to a bank ledger and refuses anything else", async () => {
      expect(
        await fails(rpc("acc_bank_link_gl", [orgA, users.acct, bankA, await accountId("6500")])),
      ).toSatisfy((e: unknown) => hint(e) === "not_money_account");
      expect(await fails(rpc("acc_bank_link_gl", [orgA, users.acct, bankA, cashP]))).toSatisfy(
        (e: unknown) => hint(e) === "not_bank_ledger",
      );
      // the auditor reads but does not manage banking
      expect(hint(await fails(rpc("acc_bank_link_gl", [orgA, users.auditor, bankA, gl1150])))).toBe(
        "not_permitted",
      );
      await rpc("acc_bank_link_gl", [orgA, users.acct, bankA, gl1150]);
      expect(
        (
          await one<{ g: string }>(
            "select gl_account_id as g from public.fin_bank_accounts where id = $1",
            [bankA],
          )
        ).g,
      ).toBe(gl1150);
      // one ledger, one bank account
      expect(hint(await fails(rpc("acc_bank_link_gl", [orgA, users.acct, bankB, gl1150])))).toBe(
        "ledger_in_use",
      );
      // the trigger repeats the rule for every role
      const e = await fails(
        svc(() =>
          q("update public.fin_bank_accounts set gl_account_id = $1 where id = $2", [cashP, bankB]),
        ),
      );
      expect(hint(e)).toBe("not_bank_ledger");
    });

    it("creates a new ledger under Bank OD A/c (a liability with the bank control) and links it", async () => {
      const r = await rpc<{ gl_account_id: string }>("acc_bank_create_ledger", [
        orgA,
        users.acct,
        bankB,
        "od",
        "2050",
        "Bank - Overdraft",
      ]);
      const a = await one<Row>(
        "select a.code, a.nature, a.control, p.code as parent from public.acc_accounts a join public.acc_accounts p on p.id = a.parent_id where a.id = $1",
        [r.gl_account_id],
      );
      expect(a).toEqual({ code: "2050", nature: "liability", control: "bank", parent: "G-BOD" });
      expect(
        hint(
          await fails(
            rpc("acc_bank_create_ledger", [orgA, users.acct, bankB, "bank", "1151", "X"]),
          ),
        ),
      ).toBe("already_linked");
    });

    it("never links another org's account", async () => {
      expect(
        hint(await fails(rpc("acc_bank_link_gl", [orgA, users.acct, bankBOther, gl1150]))),
      ).toBe("ledger_in_use");
      expect(
        hint(await fails(rpc("acc_bank_link_gl", [orgB, users.bob, bankBOther, gl1150]))),
      ).toBe("not_money_account");
    });
  });

  describe("transfers (Contra)", () => {
    let transferId: string;
    it("posts a balanced Contra journal: Dr to, Cr from", async () => {
      const r = await rpc<{ id: string; status: string; journal_id: string }>(
        "acc_bank_transfer_create",
        [
          orgA,
          users.acct,
          JSON.stringify({
            kind: "cash_deposit",
            transfer_date: "2026-07-03",
            from_account_id: cashP,
            to_account_id: gl1150,
            amount: "2500.00",
            narration: "Takings deposited",
            branch_code: "P",
          }),
        ],
      );
      transferId = r.id;
      expect(r.status).toBe("posted");
      const j = await journal(r.journal_id);
      expect(j).toMatchObject({
        voucher_type: "contra",
        journal_date: "2026-07-03",
        status: "posted",
        source_kind: "bank_transfer",
      });
      expect(await lines(r.journal_id)).toEqual([
        { code: "1150", debit: 2500, credit: 0 },
        { code: "1100-P", debit: 0, credit: 2500 },
      ]);
    });

    it("refuses the wrong direction, the same account and non-money ledgers", async () => {
      const base = { transfer_date: "2026-07-03", amount: 10, narration: "x" };
      const t = (p: Row) =>
        fails(
          rpc("acc_bank_transfer_create", [orgA, users.acct, JSON.stringify({ ...base, ...p })]),
        );
      expect(
        hint(await t({ kind: "cash_deposit", from_account_id: gl1150, to_account_id: cashP })),
      ).toBe("transfer_direction");
      expect(
        hint(await t({ kind: "transfer", from_account_id: gl1150, to_account_id: gl1150 })),
      ).toBe("same_account");
      expect(
        hint(
          await t({
            kind: "transfer",
            from_account_id: gl1150,
            to_account_id: await accountId("6500"),
          }),
        ),
      ).toBe("not_money_account");
      expect(
        hint(
          await t({
            kind: "transfer",
            from_account_id: gl1150,
            to_account_id: cashP,
            amount: "1.005",
          }),
        ),
      ).toBe("bad_amount");
    });

    it("never changes or deletes a transfer; cancelling reverses its journal", async () => {
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_bank_transfers set amount = 1 where id = $1", [transferId]),
            ),
          ),
        ),
      ).toBe("banking_immutable");
      expect(
        hint(
          await fails(
            svc(() => q("delete from public.acc_bank_transfers where id = $1", [transferId])),
          ),
        ),
      ).toBe("banking_immutable");
      expect(
        hint(
          await fails(
            rpc("acc_banking_cancel", [orgA, users.acct, "transfer", transferId, "2026-07-04", ""]),
          ),
        ),
      ).toBe("remarks_required");
      const r = await rpc<{ reversed: boolean }>("acc_banking_cancel", [
        orgA,
        users.acct,
        "transfer",
        transferId,
        "2026-07-04",
        "deposited twice",
      ]);
      expect(r.reversed).toBe(true);
      const t = await one<{ status: string; journal_id: string }>(
        "select status, journal_id from public.acc_bank_transfers where id = $1",
        [transferId],
      );
      expect(t.status).toBe("cancelled");
      const j = await journal(t.journal_id);
      expect(j.status).toBe("reversed");
      expect((await journal(j.reversed_by!)).journal_date).toBe("2026-07-04");
      // a cancelled transfer is final
      expect(
        hint(
          await fails(
            rpc("acc_banking_cancel", [
              orgA,
              users.acct,
              "transfer",
              transferId,
              "2026-07-04",
              "again",
            ]),
          ),
        ),
      ).toBe("wrong_status");
      // the record history names the change
      const h = await one<{ n: string }>(
        "select count(*)::text as n from public.record_history where table_name = 'acc_bank_transfers' and record_id = $1",
        [transferId],
      );
      expect(Number(h.n)).toBeGreaterThanOrEqual(2);
    });
  });

  describe("bank entries", () => {
    let lineCharge: string;
    let lineInterest: string;
    beforeAll(async () => {
      await svc(async () => {
        const imp = (
          await q(
            "insert into public.fin_bank_imports (org_id, kind, account_id, file_sha256, row_count) values ($1, 'bank_statement', $2, $3, 2) returning id",
            [orgA, bankA, "a".repeat(64)],
          )
        ).rows[0].id;
        const ins = (row: number, date: string, amount: number) =>
          q(
            "insert into public.fin_bank_lines (org_id, account_id, import_id, row_no, value_date, amount, reference) values ($1, $2, $3, $4, $5, $6, 'SYN') returning id",
            [orgA, bankA, imp, row, date, amount],
          ).then((r) => r.rows[0].id as string);
        lineCharge = await ins(1, "2026-07-10", -26.25);
        lineInterest = await ins(2, "2026-07-11", 40);
      });
    });

    it("splits VAT on a bank charge: Dr charges net, Dr VAT input, Cr bank", async () => {
      const vat = (
        await one<{ id: string }>(
          "select id from public.acc_tax_codes where org_id = $1 and code = 'VAT5'",
          [orgA],
        )
      ).id;
      const r = await rpc<{ id: string; journal_id: string; status: string }>(
        "acc_bank_entry_create",
        [
          orgA,
          users.acct,
          JSON.stringify({
            bank_account_id: bankA,
            entry_date: "2026-07-10",
            kind: "bank_charge",
            amount: 26.25,
            account_id: await accountId("6500"),
            tax_code_id: vat,
            narration: "Monthly fee",
            bank_line_id: lineCharge,
          }),
        ],
      );
      expect(r.status).toBe("posted");
      expect((await journal(r.journal_id)).voucher_type).toBe("payment");
      expect(await lines(r.journal_id)).toEqual([
        { code: "6500", debit: 25, credit: 0 },
        { code: "2210", debit: 1.25, credit: 0 },
        { code: "1150", debit: 0, credit: 26.25 },
      ]);
      // the statement line now counts as matched for the 20C reconciliation
      expect(
        (
          await one<{ s: string }>(
            "select match_status as s from public.fin_bank_lines where id = $1",
            [lineCharge],
          )
        ).s,
      ).toBe("matched");
      // ... and cannot be used twice
      expect(
        hint(
          await fails(
            rpc("acc_bank_entry_create", [
              orgA,
              users.acct,
              JSON.stringify({
                bank_account_id: bankA,
                entry_date: "2026-07-10",
                kind: "bank_charge",
                amount: 26.25,
                account_id: await accountId("6500"),
                narration: "again",
                bank_line_id: lineCharge,
              }),
            ]),
          ),
        ),
      ).toBe("line_matched");
      // cancelling the entry frees the line again
      await rpc("acc_banking_cancel", [
        orgA,
        users.acct,
        "entry",
        r.id,
        "2026-07-12",
        "entered on the wrong account",
      ]);
      expect(
        (
          await one<{ s: string }>(
            "select match_status as s from public.fin_bank_lines where id = $1",
            [lineCharge],
          )
        ).s,
      ).toBe("unmatched");
    });

    it("needs the statement line's date, amount and direction; posts interest received as Dr bank, Cr income", async () => {
      const base = {
        bank_account_id: bankA,
        entry_date: "2026-07-11",
        account_id: await accountId("4900"),
        narration: "Interest",
        bank_line_id: lineInterest,
      };
      const make = (p: Row) =>
        fails(rpc("acc_bank_entry_create", [orgA, users.acct, JSON.stringify({ ...base, ...p })]));
      expect(hint(await make({ kind: "bank_charge", amount: 40 }))).toBe("line_mismatch");
      expect(hint(await make({ kind: "interest_received", amount: 41 }))).toBe("line_mismatch");
      expect(
        hint(await make({ kind: "interest_received", amount: 40, entry_date: "2026-07-12" })),
      ).toBe("line_mismatch");
      // control accounts are not the other side of a bank entry
      expect(
        hint(
          await make({
            kind: "interest_received",
            amount: 40,
            account_id: await accountId("1200"),
          }),
        ),
      ).toBe("counter_not_allowed");
      const r = await rpc<{ journal_id: string }>("acc_bank_entry_create", [
        orgA,
        users.acct,
        JSON.stringify({ ...base, kind: "interest_received", amount: 40 }),
      ]);
      expect((await journal(r.journal_id)).voucher_type).toBe("receipt");
      expect(await lines(r.journal_id)).toEqual([
        { code: "1150", debit: 40, credit: 0 },
        { code: "4900", debit: 0, credit: 40 },
      ]);
    });

    it("refuses an entry on a bank account without its ledger", async () => {
      await svc(() =>
        q(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Unlinked', 'S', '0001')",
          [orgA],
        ),
      );
      const unlinked = (
        await one<{ id: string }>(
          "select id from public.fin_bank_accounts where org_id = $1 and name = 'Unlinked'",
          [orgA],
        )
      ).id;
      expect(
        hint(
          await fails(
            rpc("acc_bank_entry_create", [
              orgA,
              users.acct,
              JSON.stringify({
                bank_account_id: unlinked,
                entry_date: "2026-07-11",
                kind: "bank_charge",
                amount: 5,
                account_id: await accountId("6500"),
                narration: "fee",
              }),
            ]),
          ),
        ),
      ).toBe("bank_not_linked");
    });
  });

  describe("petty cash", () => {
    let floatId: string;
    let floatAccount: string;
    let countId: string;
    it("creates a float with its own cash ledger under Cash-in-Hand, tops it up and posts an expense with its receipt", async () => {
      const f = await rpc<{ id: string; account_id: string }>("acc_petty_cash_float_save", [
        orgA,
        users.acct,
        JSON.stringify({
          name: "Palm front desk",
          branch_code: "P",
          imprest_amount: 1000,
          code: "PC-P",
        }),
      ]);
      floatId = f.id;
      floatAccount = f.account_id;
      expect(
        await one<Row>(
          "select a.code, a.control, p.code as parent from public.acc_accounts a join public.acc_accounts p on p.id = a.parent_id where a.id = $1",
          [floatAccount],
        ),
      ).toEqual({ code: "PC-P", control: "cash", parent: "G-CASH" });
      const top = await rpc<{ journal_id: string }>("acc_bank_transfer_create", [
        orgA,
        users.acct,
        JSON.stringify({
          kind: "petty_cash_topup",
          transfer_date: "2026-07-01",
          from_account_id: gl1150,
          float_id: floatId,
          amount: 1000,
          narration: "Float",
        }),
      ]);
      expect(await lines(top.journal_id)).toEqual([
        { code: "PC-P", debit: 1000, credit: 0 },
        { code: "1150", debit: 0, credit: 1000 },
      ]);
      const doc = (
        await one<{ id: string }>(
          "insert into public.fin_documents (org_id, kind, storage_path, mime_type, size_bytes, sha256, status) values ($1::uuid, 'voucher_backup', $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 1000, $2, 'ready') returning id",
          [orgA, "b".repeat(64)],
        )
      ).id;
      const x = await rpc<{ journal_id: string; status: string }>("acc_petty_cash_expense_create", [
        orgA,
        users.acct,
        JSON.stringify({
          float_id: floatId,
          expense_date: "2026-07-05",
          amount: 52.5,
          account_id: await accountId("5120"),
          tax_code_id: (
            await one<{ id: string }>(
              "select id from public.acc_tax_codes where org_id = $1 and code = 'VAT5'",
              [orgA],
            )
          ).id,
          narration: "Gloves",
          document_id: doc,
        }),
      ]);
      expect(x.status).toBe("posted");
      expect(await lines(x.journal_id)).toEqual([
        { code: "5120", debit: 50, credit: 0 },
        { code: "2210", debit: 2.5, credit: 0 },
        { code: "PC-P", debit: 0, credit: 52.5 },
      ]);
      expect(await balanced(x.journal_id)).toBe(true);
      // a receipt of another org is refused
      expect(
        hint(
          await fails(
            rpc("acc_petty_cash_expense_create", [
              orgA,
              users.acct,
              JSON.stringify({
                float_id: floatId,
                expense_date: "2026-07-05",
                amount: 1,
                account_id: await accountId("5120"),
                narration: "x",
                document_id: "00000000-0000-0000-0000-000000000001",
              }),
            ]),
          ),
        ),
      ).toBe("document_unknown");
    });

    it("counts against the book: a difference needs an explanation", async () => {
      expect(
        hint(
          await fails(
            rpc("acc_petty_cash_count_prepare", [orgA, users.acct, floatId, "2026-07-31", 940, ""]),
          ),
        ),
      ).toBe("explanation_required");
      const r = await rpc<{ id: string; book_balance: number; difference: number; sha256: string }>(
        "acc_petty_cash_count_prepare",
        [orgA, users.acct, floatId, "2026-07-31", 940, "Taxi receipt missing"],
      );
      countId = r.id;
      expect(Number(r.book_balance)).toBe(947.5);
      expect(Number(r.difference)).toBe(-7.5);
    });

    it("is signed by a different person, bound to the fingerprint, and is then final", async () => {
      const { sha256 } = await one<{ sha256: string }>(
        "select sha256 from public.acc_petty_cash_counts where id = $1",
        [countId],
      );
      expect(
        hint(await fails(rpc("acc_petty_cash_count_sign", [orgA, users.acct, countId, sha256]))),
      ).toBe("same_person");
      expect(
        hint(
          await fails(
            rpc("acc_petty_cash_count_sign", [orgA, users.acct2, countId, "0".repeat(64)]),
          ),
        ),
      ).toBe("hash_mismatch");
      expect(
        hint(await fails(rpc("acc_petty_cash_count_sign", [orgA, users.auditor, countId, sha256]))),
      ).toBe("not_permitted");
      await rpc("acc_petty_cash_count_sign", [orgA, users.acct2, countId, sha256]);
      expect(
        await one<Row>("select status, signed_by from public.acc_petty_cash_counts where id = $1", [
          countId,
        ]),
      ).toEqual({ status: "signed", signed_by: users.acct2 });
      expect(
        hint(
          await fails(
            rpc("acc_petty_cash_count_prepare", [
              orgA,
              users.acct,
              floatId,
              "2026-07-31",
              947.5,
              "",
            ]),
          ),
        ),
      ).toBe("count_signed");
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_petty_cash_counts set counted_amount = 1 where id = $1", [
                countId,
              ]),
            ),
          ),
        ),
      ).toBe("count_signed");
      // the table repeats the two-person rule
      const e = await fails(
        svc(() =>
          q("update public.acc_petty_cash_counts set prepared_by = signed_by where id = $1", [
            countId,
          ]),
        ),
      );
      expect((e as { code?: string }).code).toBe("23514");
    });

    it("refuses to sign a count whose book balance moved since it was prepared", async () => {
      const r = await rpc<{ id: string; sha256: string }>("acc_petty_cash_count_prepare", [
        orgA,
        users.acct,
        floatId,
        "2026-08-31",
        947.5,
        "",
      ]);
      await rpc("acc_petty_cash_expense_create", [
        orgA,
        users.acct,
        JSON.stringify({
          float_id: floatId,
          expense_date: "2026-08-20",
          amount: 10,
          account_id: await accountId("5120"),
          narration: "Late receipt",
        }),
      ]);
      expect(
        hint(await fails(rpc("acc_petty_cash_count_sign", [orgA, users.acct2, r.id, r.sha256]))),
      ).toBe("count_stale");
    });
  });

  describe("cheques", () => {
    const supplier = async () =>
      (
        await one<{ id: string }>(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Synthetic Supplies') on conflict do nothing returning id",
          [orgA],
        ).catch(() => null)
      )?.id ??
      (
        await one<{ id: string }>(
          "select id from public.fin_suppliers where org_id = $1 and name = 'Synthetic Supplies'",
          [orgA],
        )
      ).id;
    const register = (p: Row, today = "2026-07-15", user = "acct") =>
      rpc<{ id: string; cheque_no: string; posting: string; party_flagged: boolean }>(
        "acc_cheque_register",
        [orgA, users[user], JSON.stringify(p), today],
      );
    const cheque = (id: string) =>
      one<{
        status: string;
        posting: string;
        journal_id: string | null;
        post_dated: boolean;
        charge_entry_id: string | null;
      }>(
        "select status, posting, journal_id, post_dated, charge_entry_id from public.acc_cheques where id = $1",
        [id],
      );

    it("takes the next leaf of a cheque book and posts a current cheque at once, dated the cheque", async () => {
      const book = await rpc<{ id: string }>("acc_cheque_book_save", [
        orgA,
        users.acct,
        JSON.stringify({
          bank_account_id: bankA,
          first_number: "000101",
          last_number: "000150",
          width: 6,
        }),
      ]);
      expect(
        hint(
          await fails(
            rpc("acc_cheque_book_save", [
              orgA,
              users.acct,
              JSON.stringify({ bank_account_id: bankA, first_number: "120", last_number: "130" }),
            ]),
          ),
        ),
      ).toBe("book_overlap");
      const s = await supplier();
      const r = await register({
        direction: "issued",
        bank_account_id: bankA,
        cheque_book_id: book.id,
        cheque_date: "2026-07-14",
        recorded_on: "2026-07-14",
        amount: 3000,
        party_kind: "supplier",
        party_ref: s,
        party_name: "Synthetic Supplies",
        counter_account_id: await accountId("2100"),
      });
      expect(r.cheque_no).toBe("000101");
      expect(r.posting).toBe("posted");
      const ch = await cheque(r.id);
      const j = await journal(ch.journal_id!);
      expect(j).toMatchObject({
        voucher_type: "payment",
        journal_date: "2026-07-14",
        source_kind: "cheque",
      });
      expect(await lines(ch.journal_id!)).toEqual([
        { code: "2100", debit: 3000, credit: 0 },
        { code: "1150", debit: 0, credit: 3000 },
      ]);
      // the supplier dimension rides on the payable line
      expect(
        (
          await one<{ s: string }>(
            "select supplier_id::text as s from public.acc_journal_lines where journal_id = $1 and line_no = 1",
            [ch.journal_id],
          )
        ).s,
      ).toBe(s);
      // the leaf is used once
      expect(
        hint(
          await fails(
            register({
              direction: "issued",
              bank_account_id: bankA,
              cheque_no: "000101",
              cheque_date: "2026-07-14",
              recorded_on: "2026-07-14",
              amount: 1,
              party_kind: "other",
              party_name: "Someone",
              counter_account_id: await accountId("6200"),
            }),
          ),
        ),
      ).toBe("cheque_duplicate");
      expect(
        (
          await one<{ n: string }>(
            "select next_number::text as n from public.acc_cheque_books where id = $1",
            [book.id],
          )
        ).n,
      ).toBe("102");
    });

    it("posts a post-dated cheque only on its date (the sweep), dated the cheque", async () => {
      const r = await register({
        direction: "received",
        bank_account_id: bankA,
        cheque_no: "778899",
        cheque_date: "2026-08-20",
        recorded_on: "2026-07-15",
        amount: 1200,
        party_kind: "patient",
        party_ref: "PIN-0001",
        counter_account_id: await accountId("1210"),
      });
      expect(r.posting).toBe("not_due");
      expect((await cheque(r.id)).post_dated).toBe(true);
      // not before its date
      expect(
        hint(
          await fails(
            rpc("acc_cheque_act", [
              orgA,
              users.acct,
              r.id,
              "present",
              "2026-07-20",
              "",
              null,
              "2026-07-20",
            ]),
          ),
        ),
      ).toBe("cheque_not_due");
      await rpc("acc_banking_sweep", [orgA, "2026-08-19"]);
      expect((await cheque(r.id)).posting).toBe("not_due");
      const sw = await rpc<{ posted: number }>("acc_banking_sweep", [orgA, "2026-08-21"]);
      expect(sw.posted).toBeGreaterThanOrEqual(1);
      const ch = await cheque(r.id);
      expect(ch.posting).toBe("posted");
      expect((await journal(ch.journal_id!)).journal_date).toBe("2026-08-20");
      expect(await lines(ch.journal_id!)).toEqual([
        { code: "1150", debit: 1200, credit: 0 },
        { code: "1210", debit: 0, credit: 1200 },
      ]);
      // no patient identity in the ledger
      const n = await one<{ narration: string }>(
        "select narration from public.acc_journals where id = $1",
        [ch.journal_id],
      );
      expect(n.narration).not.toContain("PIN-0001");
      // idempotent: a second sweep posts nothing new for it
      await rpc("acc_banking_sweep", [orgA, "2026-08-22"]);
      expect(
        (
          await one<{ n: string }>(
            "select count(*)::text as n from public.acc_journals where source_kind = 'cheque' and source_id = $1",
            [r.id],
          )
        ).n,
      ).toBe("1");
    });

    it("bounces a cheque: reverses the posting, flags the party and books the bank's charge", async () => {
      const r = await register({
        direction: "received",
        bank_account_id: bankA,
        cheque_no: "445566",
        cheque_date: "2026-07-10",
        recorded_on: "2026-07-10",
        amount: 800,
        party_kind: "other",
        party_name: "Synthetic Corporate",
        counter_account_id: await accountId("1210"),
      });
      await rpc("acc_cheque_act", [
        orgA,
        users.acct,
        r.id,
        "present",
        "2026-07-11",
        "",
        null,
        "2026-07-15",
      ]);
      expect(
        hint(
          await fails(
            rpc("acc_cheque_act", [
              orgA,
              users.acct,
              r.id,
              "bounce",
              "2026-07-13",
              "",
              null,
              "2026-07-15",
            ]),
          ),
        ),
      ).toBe("remarks_required");
      await rpc("acc_cheque_act", [
        orgA,
        users.acct,
        r.id,
        "bounce",
        "2026-07-13",
        "insufficient funds",
        JSON.stringify({ amount: 52.5 }),
        "2026-07-15",
      ]);
      const ch = await cheque(r.id);
      expect(ch).toMatchObject({ status: "bounced", posting: "reversed" });
      const j = await journal(ch.journal_id!);
      expect(j.status).toBe("reversed");
      const rev = await journal(j.reversed_by!);
      expect(rev.journal_date).toBe("2026-07-13");
      expect(
        await one<Row>(
          "select reason, party_kind, party_name from public.acc_party_flags where cheque_id = $1",
          [r.id],
        ),
      ).toEqual({
        reason: "bounced_cheque_received",
        party_kind: "other",
        party_name: "Synthetic Corporate",
      });
      const charge = await one<{ kind: string; amount: string; journal_id: string }>(
        "select kind, amount::text, journal_id from public.acc_bank_entries where id = $1",
        [ch.charge_entry_id],
      );
      expect(charge).toMatchObject({ kind: "bank_charge", amount: "52.50" });
      expect(await lines(charge.journal_id)).toEqual([
        { code: "6500", debit: 52.5, credit: 0 },
        { code: "1150", debit: 0, credit: 52.5 },
      ]);
      // bounced is final
      expect(
        hint(
          await fails(
            rpc("acc_cheque_act", [
              orgA,
              users.acct,
              r.id,
              "clear",
              "2026-07-14",
              "",
              null,
              "2026-07-15",
            ]),
          ),
        ),
      ).toBe("cheque_transition");
      expect(
        hint(
          await fails(
            svc(() => q("update public.acc_cheques set narration = 'x' where id = $1", [r.id])),
          ),
        ),
      ).toBe("banking_immutable");
      // the next cheque from the same party is registered with a warning
      const again = await register({
        direction: "received",
        bank_account_id: bankA,
        cheque_no: "445567",
        cheque_date: "2026-07-15",
        recorded_on: "2026-07-15",
        amount: 800,
        party_kind: "other",
        party_name: "synthetic corporate",
        counter_account_id: await accountId("1210"),
      });
      expect(again.party_flagged).toBe(true);
      const flag = (
        await one<{ id: string }>("select id from public.acc_party_flags where cheque_id = $1", [
          r.id,
        ])
      ).id;
      await rpc("acc_party_flag_clear", [orgA, users.acct, flag, "paid by transfer"]);
      expect(
        (
          await one<{ c: boolean }>(
            "select cleared_at is not null as c from public.acc_party_flags where id = $1",
            [flag],
          )
        ).c,
      ).toBe(true);
    });

    it("cancels a post-dated cheque without ever posting it, and marks old cheques stale with a reversal", async () => {
      const pdc = await register({
        direction: "issued",
        bank_account_id: bankA,
        cheque_no: "900001",
        cheque_date: "2026-09-30",
        recorded_on: "2026-07-15",
        amount: 5000,
        party_kind: "other",
        party_name: "Synthetic Landlord",
        counter_account_id: await accountId("6200"),
      });
      await rpc("acc_cheque_act", [
        orgA,
        users.acct,
        pdc.id,
        "cancel",
        "2026-07-16",
        "lease renegotiated",
        null,
        "2026-07-16",
      ]);
      expect(await cheque(pdc.id)).toMatchObject({
        status: "cancelled",
        posting: "not_posted",
        journal_id: null,
      });

      const old = await register({
        direction: "issued",
        bank_account_id: bankA,
        cheque_no: "900002",
        cheque_date: "2026-07-15",
        recorded_on: "2026-07-15",
        amount: 75,
        party_kind: "other",
        party_name: "Synthetic Vendor",
        counter_account_id: await accountId("6300"),
      });
      expect(
        hint(
          await fails(
            rpc("acc_cheque_act", [
              orgA,
              users.acct,
              old.id,
              "stale",
              "2027-01-15",
              "",
              null,
              "2027-01-15",
            ]),
          ),
        ),
      ).toBe("cheque_not_stale");
      const sw = await rpc<{ stale: number }>("acc_banking_sweep", [orgA, "2027-01-16"]);
      expect(sw.stale).toBeGreaterThanOrEqual(1);
      const ch = await cheque(old.id);
      expect(ch).toMatchObject({ status: "stale", posting: "reversed" });
      expect((await journal(ch.journal_id!)).status).toBe("reversed");
      // a cheque already older than six months cannot be registered
      expect(
        hint(
          await fails(
            register({
              direction: "received",
              bank_account_id: bankA,
              cheque_no: "1",
              cheque_date: "2026-01-01",
              recorded_on: "2026-07-15",
              amount: 5,
              party_kind: "other",
              party_name: "X",
              counter_account_id: await accountId("1210"),
            }),
          ),
        ),
      ).toBe("cheque_stale");
    });

    it("records a patient by PIN only and refuses a voucher that is not an approved cheque payment", async () => {
      const base = {
        direction: "received",
        bank_account_id: bankA,
        cheque_no: "5",
        cheque_date: "2026-07-15",
        recorded_on: "2026-07-15",
        amount: 5,
        counter_account_id: await accountId("1210"),
      };
      expect(
        hint(
          await fails(
            register({
              ...base,
              party_kind: "patient",
              party_ref: "PIN-1",
              party_name: "Layla Demo-01",
            }),
          ),
        ),
      ).toBe("party_patient");
      expect(
        hint(await fails(register({ ...base, party_kind: "patient", party_ref: "Layla Demo" }))),
      ).toBe("party_patient");
      expect(
        hint(
          await fails(
            register({
              ...base,
              direction: "issued",
              party_kind: "other",
              party_name: "X",
              voucher_id: "00000000-0000-0000-0000-000000000009",
            }),
          ),
        ),
      ).toBe("voucher_mismatch");
      // the table repeats the PIN-only rule for every role
      const e = await fails(
        svc(() =>
          q(
            "update public.acc_cheques set party_name = 'A Name' where org_id = $1 and party_kind = 'patient'",
            [orgA],
          ),
        ),
      );
      expect(e).not.toBeNull();
    });
  });

  describe("bank position", () => {
    it("reconciles book to bank at the statement date with the uncleared cheques", async () => {
      await rpc("acc_bank_statement_balance_save", [orgA, users.acct, bankA, "2026-07-15", 0]);
      const rows = await rpc<Array<Row>>("acc_bank_position", [orgA, "2026-07-15"]);
      const p = rows.find((r) => r.bank_account_id === bankA)!;
      expect(p.gl_account_id).toBe(gl1150);
      const gl = Number(p.gl_at_statement);
      const issued = p.uncleared_issued as { amount: number; count: number };
      const received = p.uncleared_received as { amount: number; count: number };
      // issued 000101 (3,000) is posted and not cleared; the received 445567 (800) is posted and not cleared
      expect(Number(issued.amount)).toBe(3075);
      expect(Number(received.amount)).toBe(800);
      // make the statement agree with what the bank should show, then the difference is zero
      const expected = bookToBank({
        glAtStatement: gl,
        statementBalance: 0,
        unclearedIssued: Number(issued.amount),
        unclearedReceived: Number(received.amount),
      }).expectedBank;
      await rpc("acc_bank_statement_balance_save", [
        orgA,
        users.acct,
        bankA,
        "2026-07-15",
        expected,
      ]);
      const again = (await rpc<Array<Row>>("acc_bank_position", [orgA, "2026-07-15"])).find(
        (r) => r.bank_account_id === bankA,
      )!;
      expect(
        bookToBank({
          glAtStatement: Number(again.gl_at_statement),
          statementBalance: Number(again.statement_balance),
          unclearedIssued: Number((again.uncleared_issued as { amount: number }).amount),
          unclearedReceived: Number((again.uncleared_received as { amount: number }).amount),
        }).reconciled,
      ).toBe(true);
      // only org A's accounts
      expect(rows.some((r) => r.bank_account_id === bankBOther)).toBe(false);
    });

    it("keeps every banking journal balanced", async () => {
      const { rows } = await svc(() =>
        q(
          `select j.id from public.acc_journals j where j.org_id = $1 and j.source_kind in ('bank_transfer', 'bank_entry', 'petty_cash', 'cheque', 'reversal')`,
          [orgA],
        ),
      );
      expect(rows.length).toBeGreaterThan(5);
      for (const r of rows) expect(await balanced(r.id), r.id).toBe(true);
    });
  });

  describe("waiting for the ledger start", () => {
    it("keeps an item dated before the ledger start waiting (the action succeeds) and the sweep posts it once allowed", async () => {
      await q("begin");
      try {
        const original = (
          await q(
            "select pg_get_functiondef('public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb)'::regprocedure) as d",
          )
        ).rows[0].d as string;
        // the central rule (added by another slice) refuses dates before the ledger start with this hint
        await q(`create or replace function public.acc_post_from_source(
            p_org_id uuid, p_entity_id uuid, p_source_kind text, p_source_id text, p_source_version integer, p_date date,
            p_voucher_type text, p_narration text, p_lines jsonb)
          returns jsonb language plpgsql security definer set search_path = '' as $f$
          begin
            if p_date < date '2026-01-01' then
              raise exception 'before the ledger start' using errcode = 'check_violation', hint = 'before_ledger_start';
            end if;
            raise exception 'stub' using errcode = 'check_violation', hint = 'invalid';
          end $f$`);
        const t = await rpc<{ id: string; status: string; journal_id: string | null }>(
          "acc_bank_transfer_create",
          [
            orgA,
            users.acct,
            JSON.stringify({
              kind: "transfer",
              transfer_date: "2025-12-30",
              from_account_id: gl1150,
              to_account_id: cashP,
              amount: 10,
              narration: "Old",
            }),
          ],
        );
        expect(t).toMatchObject({ status: "waiting_ledger_start", journal_id: null });
        const ch = await rpc<{ id: string; posting: string }>("acc_cheque_register", [
          orgA,
          users.acct,
          JSON.stringify({
            direction: "received",
            bank_account_id: bankA,
            cheque_no: "123",
            cheque_date: "2025-12-31",
            recorded_on: "2025-12-31",
            amount: 20,
            party_kind: "other",
            party_name: "Old customer",
            counter_account_id: await accountId("1210"),
          }),
          "2026-01-05",
        ]);
        expect(ch.posting).toBe("waiting_ledger_start");
        // any other refusal still fails the action (inside a savepoint: the error aborts it)
        await q("savepoint other_refusal");
        const refused = await fails(
          q("set role service_role").then(() =>
            q("select public.acc_bank_transfer_create($1, $2, $3)", [
              orgA,
              users.acct,
              JSON.stringify({
                kind: "transfer",
                transfer_date: "2026-02-01",
                from_account_id: gl1150,
                to_account_id: cashP,
                amount: 10,
                narration: "New",
              }),
            ]),
          ),
        );
        await q("rollback to savepoint other_refusal");
        expect(hint(refused)).toBe("invalid");
        // still waiting while the date is before the start
        const w = await rpc<{ waiting: number }>("acc_banking_sweep", [orgA, "2026-01-05"]);
        expect(w.waiting).toBeGreaterThanOrEqual(2);
        // the ledger start moves back (here: the real function again); the sweep posts both
        await q(original);
        await rpc("acc_banking_sweep", [orgA, "2026-01-05"]);
        expect(
          (
            await one<{ status: string }>(
              "select status from public.acc_bank_transfers where id = $1",
              [t.id],
            )
          ).status,
        ).toBe("posted");
        const posted = await one<{ posting: string; journal_id: string }>(
          "select posting, journal_id from public.acc_cheques where id = $1",
          [ch.id],
        );
        expect(posted.posting).toBe("posted");
        expect((await journal(posted.journal_id)).journal_date).toBe("2025-12-31");
      } finally {
        await q("rollback");
      }
    });
  });

  describe("who reads and who writes", () => {
    const tables = [
      "acc_bank_transfers",
      "acc_bank_entries",
      "acc_petty_cash_floats",
      "acc_petty_cash_expenses",
      "acc_petty_cash_counts",
      "acc_cheque_books",
      "acc_cheques",
      "acc_party_flags",
      "acc_bank_statement_balances",
    ];
    const seen = (u: string, t: string) =>
      as(u, () => q(`select count(*)::int as n from public.${t} where org_id = $1`, [orgA])).then(
        (r) => r.rows[0].n as number,
      );

    it("shows the registers to accountants and ledger readers, not to the CEO, Finance or another org", async () => {
      for (const t of tables) {
        expect(await seen("acct", t), `acct ${t}`).toBeGreaterThan(0);
        expect(await seen("auditor", t), `auditor ${t}`).toBeGreaterThan(0);
        expect(await seen("ceo", t), `ceo ${t}`).toBe(0);
        expect(await seen("fin", t), `fin ${t}`).toBe(0);
        expect(await seen("bob", t), `bob ${t}`).toBe(0);
      }
    });

    it("lets nobody write directly, and keeps the functions for the service role", async () => {
      for (const t of tables) {
        const e = await fails(
          as("acct", () => q(`insert into public.${t} (org_id) values ($1)`, [orgA])),
        );
        expect((e as { code?: string }).code, t).toBe("42501");
      }
      const e = await fails(
        as("acct", () => q("select public.acc_banking_sweep($1, '2026-07-01')", [orgA])),
      );
      expect((e as { code?: string }).code).toBe("42501");
    });

    it("lets banking readers see the history of transfers, entries and cheques", async () => {
      const r = await as("acct", () =>
        q(
          "select app.can_view_record_history($1, 'acc_cheques') as a, app.can_view_record_history($1, 'acc_bank_entries') as b",
          [orgA],
        ),
      );
      expect(r.rows[0]).toEqual({ a: true, b: true });
      const ceo = await as("ceo", () =>
        q("select app.can_view_record_history($1, 'acc_cheques') as a", [orgA]),
      );
      expect(ceo.rows[0].a).toBe(false);
    });
  });
});
