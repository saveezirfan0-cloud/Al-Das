/**
 * Phase 20C: bank and settlement reconciliation in the database. Who reads (Finance, the CEO; nobody in another org,
 * not Billing), that nobody writes directly, that the functions are service-role only, the collections aggregate against
 * the synthetic fixture, the atomic import (duplicate file and overlapping dates refused), the starter rules, match
 * bookkeeping, the review / sign-off rules (frozen figures with their sha256, two different people, signed is final) and
 * the locked-month refusal. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

import fx from "../unit/finance/fixtures/bank.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bankRows = (from: number, days: number) =>
  Array.from({ length: days }, (_, i) => ({
    value_date: `2026-10-${String(from + i).padStart(2, "0")}`,
    amount: i % 2 === 0 ? 100 + i : -(50 + i),
    reference: `R${i}`,
    description: "SYNTHETIC",
  }));

describe.skipIf(!TEST_DATABASE_URL)("Finance bank reconciliation (Phase 20C)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let accA: string;
  let accB: string;
  let importId: string;
  let recOct: string;
  let lineIds: string[] = [];
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const importRows = (org: string, acc: string, rows: unknown[], hash: string) =>
    q(
      "select public.fin_bank_import($1, 'bank_statement', $2, null, null, 'statement.csv', $3, $4::jsonb, $5) as id",
      [org, acc, hash, JSON.stringify(rows), users.fin],
    );
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "fin2", "ceo", "billing"])
      users[n] = await createAuthUser(c, `${n}-bank@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fin", "Finance");
      await member("fin2", "Finance");
      await member("ceo", "CEO");
      await member("billing", "Billing");

      for (const org of [orgA, orgB]) await q("select public.fin_seed_settlement_rules($1)", [org]);
      accA = (
        await q(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', '4321') returning id",
          [orgA],
        )
      ).rows[0].id;
      accB = (
        await q(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', '9999') returning id",
          [orgB],
        )
      ).rows[0].id;
      importId = (await importRows(orgA, accA, bankRows(1, 10), sha("a-oct-1"))).rows[0].id;
      await importRows(orgB, accB, bankRows(1, 3), sha("b-oct-1"));
      lineIds = (
        await q(
          "select id from public.fin_bank_lines where import_id = $1 and amount > 0 order by row_no",
          [importId],
        )
      ).rows.map((r) => r.id);
      recOct = (
        await q(
          "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end, created_by) values ($1, $2, '2026-10-01', '2026-10-01', '2026-10-30', $3) returning id",
          [orgA, accA, users.fin],
        )
      ).rows[0].id;

      // Unite collections from the fixture (two branches, a refund-only row, modes that are not reconciled)
      let n = 0;
      for (const p of fx.payments) {
        n++;
        const inv = (
          await q(
            "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, net, total, patient_pin, record_hash) values ($1, $2, $3, $4, $5, $5, $6, 'h') returning id",
            [orgA, `SYN/${n}`, p.date, p.branch, p.paid || p.refund, `PIN-${n}`],
          )
        ).rows[0].id;
        await q(
          "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date, refund, refund_date) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            orgA,
            inv,
            `SYN/${n}|1|R${n}`,
            p.mode,
            p.paid || null,
            p.paid ? p.date : null,
            p.refund || null,
            p.refund ? p.date : null,
          ],
        );
      }
      // noise: a deleted invoice's payment, another month, another org
      const del = (
        await q(
          "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, net, total, patient_pin, record_hash, is_deleted) values ($1, 'SYN/DEL', '2026-10-01', 9, 9, 'PIN-D', 'h', true) returning id",
          [orgA],
        )
      ).rows[0].id;
      await q(
        "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date) values ($1, $2, 'SYN/DEL|1', 'Card', 999, '2026-10-01')",
        [orgA, del],
      );
      const nov = (
        await q(
          "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, net, total, patient_pin, record_hash) values ($1, 'SYN/NOV', '2026-11-02', 9, 9, 'PIN-N', 'h') returning id",
          [orgA],
        )
      ).rows[0].id;
      await q(
        "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date) values ($1, $2, 'SYN/NOV|1', 'Card', 777, '2026-11-02')",
        [orgA, nov],
      );
      const b = (
        await q(
          "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, net, total, patient_pin, record_hash) values ($1, 'SYN/B', '2026-10-01', 9, 9, 'PIN-B', 'h') returning id",
          [orgB],
        )
      ).rows[0].id;
      await q(
        "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date) values ($1, $2, 'SYN/B|1', 'Card', 555, '2026-10-01')",
        [orgB, b],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("access", () => {
    const visible = (who: string) =>
      asRole(who, async () => {
        const n = async (t: string) =>
          Number((await q(`select count(*)::int as n from public.${t}`)).rows[0].n);
        return {
          accounts: await n("fin_bank_accounts"),
          lines: await n("fin_bank_lines"),
          recs: await n("fin_bank_recs"),
          rules: await n("fin_ref_settlement_rules"),
        };
      });

    it("Finance and the CEO read their own org's rows only", async () => {
      for (const who of ["fin", "ceo"])
        expect(await visible(who), who).toEqual({ accounts: 1, lines: 10, recs: 1, rules: 7 });
    });

    it("Billing sees nothing, and org B's admin sees only org B", async () => {
      expect(await visible("billing")).toEqual({ accounts: 0, lines: 0, recs: 0, rules: 0 });
      expect(await visible("bob")).toEqual({ accounts: 1, lines: 3, recs: 0, rules: 7 });
    });

    it("nobody writes directly, not even Finance", async () => {
      for (const sql of [
        [
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'X', 'X', '0000')",
          [orgA],
        ],
        [
          "insert into public.fin_bank_rec_notes (org_id, rec_id, item_key, reason_code) values ($1, $2, 'k', 'in_transit')",
          [orgA, recOct],
        ],
        [
          "insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status) values ($1, $2, $3, 'k', 'collection', '2026-10-01', 1, 1, 90, 'matched')",
          [orgA, recOct, lineIds[0]],
        ],
      ] as Array<[string, unknown[]]>)
        expect(await err(asRole("fin", () => q(sql[0], sql[1]))), sql[0]).toMatchObject({
          code: "42501",
        });
      const upd = await asRole("fin", () =>
        q("update public.fin_bank_recs set status = 'reviewed' where org_id = $1", [orgA]),
      );
      expect(upd.rowCount).toBe(0);
      const del = await asRole("fin", () =>
        q("delete from public.fin_bank_lines where org_id = $1", [orgA]),
      );
      expect(del.rowCount).toBe(0);
    });

    it("the functions run for the service role only", async () => {
      for (const sql of [
        ["select public.fin_bank_collections($1, '2026-10-01', '2026-10-30')", [orgA]],
        ["select public.fin_seed_settlement_rules($1)", [orgA]],
        [
          "select public.fin_bank_import($1, 'bank_statement', $2, null, null, 'x', $3, '[]'::jsonb, null)",
          [orgA, accA, sha("x")],
        ],
      ] as Array<[string, unknown[]]>)
        expect(await err(asRole("fin", () => q(sql[0], sql[1]))), sql[0]).toMatchObject({
          code: "42501",
        });
    });
  });

  describe("collections and rules", () => {
    it("aggregates Unite collections per mode and day across branches, refunds by refund date (fixture parity)", async () => {
      const { rows } = await svc(() =>
        q("select public.fin_bank_collections($1, '2026-10-01', '2026-10-30') as j", [orgA]),
      );
      const got = (rows[0].j as Array<Record<string, unknown>>).map((x) => ({
        mode: x.mode,
        date: x.date,
        paid: Number(x.paid),
        refunds: Number(x.refunds),
        payments: Number(x.payments),
      }));
      const key = (x: { mode: unknown; date: unknown }) => `${x.mode}|${x.date}`;
      expect([...got].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
        [...fx.collections].sort((a, b) => key(a).localeCompare(key(b))),
      );
    });

    it("seeds the starter rules once, without overwriting Finance's edits", async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_settlement_rules set lag_days = 3 where org_id = $1 and payment_mode = 'Card'",
          [orgA],
        );
        await q("select public.fin_seed_settlement_rules($1)", [orgA]);
      });
      const { rows } = await svc(() =>
        q(
          "select payment_mode, lag_days, fee_pct, settles_to_bank from public.fin_ref_settlement_rules where org_id = $1 order by payment_mode",
          [orgA],
        ),
      );
      expect(
        rows.map((r) => [
          r.payment_mode,
          r.lag_days,
          r.fee_pct === null ? null : Number(r.fee_pct),
          r.settles_to_bank,
        ]),
      ).toEqual([
        ["Card", 3, null, true],
        ["Cash", 1, 0, true],
        ["EPG", 2, null, true],
        ["Insurance credit", null, null, false],
        ["MX", null, null, true],
        ["Tabby", 6, null, true],
        ["rePG", null, null, true],
      ]);
      // one rule per mode, whatever the case
      expect(
        await err(
          svc(() =>
            q(
              "insert into public.fin_ref_settlement_rules (org_id, payment_mode) values ($1, ' card')",
              [orgA],
            ),
          ),
        ),
      ).toMatchObject({ code: "23505" });
    });
  });

  describe("imports", () => {
    it("stores a statement atomically with its totals and the sha256 only", async () => {
      const { rows } = await svc(() =>
        q(
          "select row_count, sum_credits, sum_debits, first_date::text, last_date::text from public.fin_bank_imports where id = $1",
          [importId],
        ),
      );
      expect(rows[0]).toMatchObject({
        row_count: 10,
        first_date: "2026-10-01",
        last_date: "2026-10-10",
      });
      expect(Number(rows[0].sum_credits)).toBe(100 + 102 + 104 + 106 + 108);
      expect(Number(rows[0].sum_debits)).toBe(51 + 53 + 55 + 57 + 59);
    });

    it("refuses the same file twice and dates that overlap an earlier statement of the account", async () => {
      expect(
        await err(svc(() => importRows(orgA, accA, bankRows(20, 2), sha("a-oct-1")))),
      ).toMatchObject({ code: "23505" });
      expect(
        await err(svc(() => importRows(orgA, accA, bankRows(10, 2), sha("a-overlap")))),
      ).toMatchObject({ code: "23514" });
      // the next days are fine, and another org's statement never counts as an overlap
      await svc(() => importRows(orgA, accA, bankRows(11, 2), sha("a-oct-11")));
    });

    it("refuses an account of another org and stores settlement reports per mode", async () => {
      expect(
        await err(svc(() => importRows(orgA, accB, bankRows(20, 1), sha("a-wrong-account")))),
      ).toMatchObject({
        code: "22023",
      });
      const rows = fx.settlements.map((s) => ({
        txn_date: s.txnDate,
        settlement_date: s.settlementDate,
        gross: s.gross,
        fee: s.fee,
        net: s.net,
        reference: s.reference,
      }));
      await svc(() =>
        q(
          "select public.fin_bank_import($1, 'settlement', null, 'Tabby', null, 'tabby.csv', $2, $3::jsonb, null)",
          [orgA, sha("tabby-oct"), JSON.stringify(rows)],
        ),
      );
      const again = err(
        svc(() =>
          q(
            "select public.fin_bank_import($1, 'settlement', null, 'tabby', null, 'tabby2.csv', $2, $3::jsonb, null)",
            [orgA, sha("tabby-oct-2"), JSON.stringify(rows)],
          ),
        ),
      );
      expect(await again).toMatchObject({ code: "23514" });
      const { rows: stored } = await svc(() =>
        q(
          "select sum(net)::numeric as net, sum(fee)::numeric as fee from public.fin_settlement_lines where org_id = $1",
          [orgA],
        ),
      );
      expect([Number(stored[0].net), Number(stored[0].fee)]).toEqual([902.5, 47.5]);
    });
  });

  describe("matches", () => {
    const match = (lineId: string, key: string, status = "matched", rec = recOct) =>
      q(
        "insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status, auto) values ($1, $2, $3, $4, 'collection', '2026-10-05', 100, 100, 90, $5, false) returning id",
        [orgA, rec, lineId, key, status],
      );
    const statusOf = async (id: string) =>
      (await svc(() => q("select match_status from public.fin_bank_lines where id = $1", [id])))
        .rows[0].match_status;

    it("keeps the line's match status, uses each line and each expected item once, and protects matched lines", async () => {
      await svc(() => match(lineIds[0], "col|Card|2026-10-01"));
      expect(await statusOf(lineIds[0])).toBe("matched");
      expect(await err(svc(() => match(lineIds[0], "col|Card|2026-10-02")))).toMatchObject({
        code: "23505",
      });
      expect(await err(svc(() => match(lineIds[1], "col|Card|2026-10-01")))).toMatchObject({
        code: "23505",
      });
      // a rejected pair does not count as a use
      await svc(() => match(lineIds[1], "col|Card|2026-10-01", "rejected"));
      expect(await statusOf(lineIds[1])).toBe("unmatched");
      // the import of a matched line cannot be removed
      expect(
        await err(svc(() => q("delete from public.fin_bank_imports where id = $1", [importId]))),
      ).toMatchObject({
        code: "42501",
      });
      await svc(() =>
        q("delete from public.fin_bank_matches where bank_line_id = $1 and status = 'matched'", [
          lineIds[0],
        ]),
      );
      expect(await statusOf(lineIds[0])).toBe("unmatched");
      await svc(() => match(lineIds[0], "col|Card|2026-10-01"));
    });
  });

  describe("review and sign-off", () => {
    const set = (sql: string, p: unknown[] = []) => err(svc(() => q(sql, p)));

    it("refuses a review with open problems, freezes the figures with their sha256, and needs a second person to sign", async () => {
      expect(
        await set(
          "update public.fin_bank_recs set status = 'reviewed', figures = '{\"problems\": [\"x\"]}'::jsonb, prepared_by = $2 where id = $1",
          [recOct, users.fin],
        ),
      ).toMatchObject({ code: "23514" });
      await svc(() =>
        q(
          'update public.fin_bank_recs set status = \'reviewed\', figures = \'{"problems": [], "summary": {"matchedCount": 1}}\'::jsonb, prepared_by = $2 where id = $1',
          [recOct, users.fin],
        ),
      );
      const { rows } = await svc(() =>
        q(
          "select figures::text as f, figures_sha256, prepared_at from public.fin_bank_recs where id = $1",
          [recOct],
        ),
      );
      expect(rows[0].figures_sha256).toBe(sha(rows[0].f));
      expect(rows[0].prepared_at).not.toBeNull();

      // decisions are frozen while reviewed
      expect(
        await set(
          "insert into public.fin_bank_rec_notes (org_id, rec_id, item_key, reason_code) values ($1, $2, 'k', 'in_transit')",
          [orgA, recOct],
        ),
      ).toMatchObject({ code: "23514" });
      // the figures cannot be edited without a transition
      expect(
        await set("update public.fin_bank_recs set figures = '{}'::jsonb where id = $1", [recOct]),
      ).toMatchObject({
        code: "23514",
      });
      // the preparer cannot sign
      expect(
        await set(
          "update public.fin_bank_recs set status = 'signed', signed_by = $2 where id = $1",
          [recOct, users.fin],
        ),
      ).toMatchObject({
        code: "23514",
      });
      await svc(() =>
        q("update public.fin_bank_recs set status = 'signed', signed_by = $2 where id = $1", [
          recOct,
          users.fin2,
        ]),
      );
      const signed = (
        await svc(() =>
          q("select status, signed_at, figures_sha256 from public.fin_bank_recs where id = $1", [
            recOct,
          ]),
        )
      ).rows[0];
      expect(signed.status).toBe("signed");
      expect(signed.figures_sha256).toBe(rows[0].figures_sha256);
    });

    it("signed is final: no reopening, no new decisions, no deletion", async () => {
      expect(
        await set("update public.fin_bank_recs set status = 'open' where id = $1", [recOct]),
      ).toMatchObject({ code: "42501" });
      expect(await set("delete from public.fin_bank_recs where id = $1", [recOct])).toMatchObject({
        code: "42501",
      });
      expect(
        await set("delete from public.fin_bank_matches where rec_id = $1", [recOct]),
      ).toMatchObject({ code: "23514" });
    });

    it("a run starts open and its account and period never change", async () => {
      expect(
        await set(
          "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end, status) values ($1, $2, '2026-12-01', '2026-12-01', '2026-12-30', 'signed')",
          [orgA, accA],
        ),
      ).toMatchObject({ code: "23514" });
      const id = (
        await svc(() =>
          q(
            "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end) values ($1, $2, '2026-11-01', '2026-10-31', '2026-11-30') returning id",
            [orgA, accA],
          ),
        )
      ).rows[0].id;
      expect(
        await set("update public.fin_bank_recs set period_end = '2026-11-29' where id = $1", [id]),
      ).toMatchObject({
        code: "23514",
      });
      expect(
        await set(
          "update public.fin_bank_recs set status = 'signed', signed_by = $2 where id = $1",
          [id, users.fin2],
        ),
      ).toMatchObject({
        code: "23514",
      });
    });
  });

  describe("a locked month", () => {
    it("refuses every reconciliation change", async () => {
      const sep = (
        await svc(() =>
          q(
            "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end) values ($1, $2, '2026-09-01', '2026-09-01', '2026-09-30') returning id",
            [orgA, accA],
          ),
        )
      ).rows[0].id;
      await svc(() =>
        q(
          `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
           values ($1, '2026-09-01', 'locked', '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'), now(), now(), now(), now())`,
          [orgA],
        ),
      );
      const set = (sql: string, p: unknown[]) => err(svc(() => q(sql, p)));
      expect(
        await set(
          "update public.fin_bank_recs set status = 'reviewed', figures = '{}'::jsonb, prepared_by = $2 where id = $1",
          [sep, users.fin],
        ),
      ).toMatchObject({
        code: "42501",
      });
      expect(
        await set(
          "insert into public.fin_bank_rec_notes (org_id, rec_id, item_key, reason_code) values ($1, $2, 'k', 'in_transit')",
          [orgA, sep],
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await set(
          "insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status) values ($1, $2, $3, 'k', 'collection', '2026-09-30', 1, 1, 90, 'matched')",
          [orgA, sep, lineIds[2]],
        ),
      ).toMatchObject({ code: "42501" });
      // and a new run for the locked month cannot be opened (another account)
      const acc2 = (
        await svc(() =>
          q(
            "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Second', 'Synthetic Bank', '1111') returning id",
            [orgA],
          ),
        )
      ).rows[0].id;
      expect(
        await set(
          "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end) values ($1, $2, '2026-09-01', '2026-09-01', '2026-09-30')",
          [orgA, acc2],
        ),
      ).toMatchObject({ code: "42501" });
    });
  });
});
