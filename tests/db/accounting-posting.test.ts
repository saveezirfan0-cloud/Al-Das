/**
 * Phase 22D: the posting engine, database side. The ledger start (refused before it, Tally imports and opening journals
 * allowed, reversals of those too, the date cannot be cleared, moved earlier or moved past a posted Pulse journal), the
 * default rules (22A chart, the old maps), every builder through the real runner posting balanced journals, an amended
 * invoice reversed and posted again, a withdrawn item reversed, missing rules and VAT codes waiting with their reason
 * and posting after the rule is added, a closed period waiting, preview before the ledger start (totals stored, nothing
 * posted) and the comparison with the ledger, idempotent re-runs, buildJournalForSource, RLS and cross-org.
 *
 * Sub-ledger end states (signed reconciliations, paid vouchers, approved revenue-share runs, posted lab statements) are
 * seeded with triggers off (session_replication_role = replica, superuser only) because the real paths need documents,
 * hashes and several people; the CHECK constraints still apply. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildJournalForSource,
  runAccountingPosting,
  type PostingPort,
  type RunOptions,
} from "@/lib/accounting/posting/runner";
import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";
import type { JobLogger } from "@/lib/jobs/types";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const NOW = new Date("2027-08-15T08:00:00Z");
const HASH = "a".repeat(64);
const silent: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** The runner's port over a plain Postgres connection (service role), like adminPort over PostgREST. */
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

describe.skipIf(!TEST_DATABASE_URL)("Accounting posting engine (Phase 22D)", () => {
  let c: Client;
  let port: PostingPort;
  let orgA: string;
  let orgB: string;
  let orgL: string;
  const users: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const run = (opts: RunOptions = {}) =>
    runAccountingPosting(port, silent, {
      orgIds: [orgA],
      now: NOW,
      settleSeconds: 0,
      retryAfterMinutes: 0,
      ...opts,
    });
  const status = async (kind: string, id: string, org = orgA) =>
    one<{
      state: string;
      reason: string | null;
      detail: string | null;
      version: number;
      journal_id: string | null;
    }>(
      "select state, reason, detail, version, journal_id from public.acc_posting_status where org_id = $1 and source_kind = $2 and source_id = $3",
      [org, kind, id],
    );
  /** The live journal of a source item as [account, debit, credit] rows (line order). */
  const journalOf = async (kind: string, id: string, org = orgA) => {
    const j = await one<
      { id: string; number: string; journal_date: string; source_version: number } | undefined
    >(
      "select id, number, journal_date::text, source_version from public.acc_journals where org_id = $1 and source_kind = $2 and source_id = $3 and status = 'posted'",
      [org, kind, id],
    );
    if (!j) return null;
    const { rows } = await svc(() =>
      q(
        `select a.code, l.debit::float as d, l.credit::float as c, l.branch_code, l.doctor_id, l.payer_id, t.code as tax
         from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id
         left join public.acc_tax_codes t on t.id = l.tax_code_id
         where l.journal_id = $1 order by l.line_no`,
        [j.id],
      ),
    );
    return { ...j, lines: rows.map((r) => [r.code, r.d, r.c]), rows };
  };
  const raw = async (fn: () => Promise<unknown>) => {
    await q("set session_replication_role = replica");
    try {
      await fn();
    } finally {
      await q("set session_replication_role = default");
    }
  };
  const ins = async (sql: string, p: unknown[]) =>
    (await q(sql + " returning id::text as id", p)).rows[0].id as string;
  const rule = (
    org: string,
    kind: string,
    key: string,
    qualifier: string,
    account: string | null,
    tax: string | null,
  ) =>
    svc(() =>
      q(
        `insert into public.acc_posting_rules (org_id, kind, key, qualifier, account_id, tax_code_id)
         values ($1, $2, $3, $4, (select id from public.acc_accounts where org_id = $1 and code = $5),
                 (select id from public.acc_tax_codes where org_id = $1 and code = $6))
         on conflict (org_id, kind, key, qualifier) do update set account_id = excluded.account_id, tax_code_id = excluded.tax_code_id`,
        [org, kind, key, qualifier, account, tax],
      ),
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    port = pgPort(c);
    for (const n of ["alice", "bob", "lena", "acct", "chief", "fm"])
      users[n] = await createAuthUser(c, `${n}-post@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    orgL = await createOrg(c, "Org L", "org-l", users.lena);
    await svc(async () => {
      for (const org of [orgA, orgL]) {
        for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
            [org, r.name, r.description, JSON.stringify(r.permissions)],
          );
        for (const [u, role] of [
          ["acct", "Accountant"],
          ["chief", "Chief Accountant"],
          ["fm", "Finance Manager"],
        ])
          await q(
            "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
            [org, users[u], role],
          );
      }
      await q("update public.orgs set timezone = 'Asia/Dubai' where id in ($1, $2, $3)", [
        orgA,
        orgB,
        orgL,
      ]);
      for (const org of [orgA, orgB]) {
        await q(
          "insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, 'DHA-SYN-1', 'Dr Synthetic')",
          [org],
        );
        await q(
          "insert into public.fin_ref_payers (org_id, payer_id, payer_name) values ($1, 'PAYER-SYN-1', 'Payer One'), ($1, 'PAYER-SYN-2', 'Payer Two')",
          [org],
        );
        await q(
          `insert into public.fin_ref_services (org_id, item_code, service_category)
           values ($1, 'CONS', 'Consultation'), ($1, 'COSM', 'Cosmetic'), ($1, 'LAB1', 'Laboratory')`,
          [org],
        );
      }
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("ledger start", () => {
    const post = (kind: string, id: string, date: string, org = orgL) =>
      one<{ r: { id: string; number: string } }>(
        "select public.acc_post_from_source($1, null, $2, $3, 1, $4, 'journal', 'Synthetic', $5::jsonb) as r",
        [
          org,
          kind,
          id,
          date,
          JSON.stringify([
            { account_code: "6200", debit: 10 },
            { account_code: "9000", credit: 10 },
          ]),
        ],
      ).then((x) => x.r);
    const setStart = (user: string, date: string | null) =>
      one<{ r: { ledger_start_date: string } }>(
        "select public.acc_set_ledger_start($1, (select id from public.acc_entities where org_id = $1 and is_default), $2, $3) as r",
        [orgL, users[user], date],
      );
    const manual = async (date: string) => {
      const d = await one<{ r: { id: string } }>(
        "select public.acc_journal_save($1, $2, null, $3::jsonb, $4::jsonb) as r",
        [
          orgL,
          users.acct,
          JSON.stringify({
            voucher_type: "journal",
            journal_date: date,
            narration: "Synthetic manual",
          }),
          JSON.stringify([
            { account_code: "6200", debit: 5 },
            { account_code: "9000", credit: 5 },
          ]),
        ],
      );
      const s = await one<{ r: { hash: string } }>(
        "select public.acc_journal_act($1, $2, $3, 'submit', '') as r",
        [orgL, d.r.id, users.acct],
      );
      return one("select public.acc_post_journal($1, $2, $3, $4) as r", [
        orgL,
        d.r.id,
        users.fm,
        s.r.hash,
      ]);
    };

    it("refuses every posting while no ledger start is set, except Tally imports and opening journals (and their reversals)", async () => {
      expect(hint(await fails(post("voucher", "L-1", "2027-07-05")))).toBe("before_ledger_start");
      expect(hint(await fails(manual("2027-07-05")))).toBe("before_ledger_start");
      const tally = await post("tally_import", "GUID-L-1", "2027-06-05");
      await post("opening", "OPEN-L-1", "2027-06-30");
      const rev = await one<{ r: { reversal_of: string } }>(
        "select public.acc_reverse_journal($1, $2, $3, '2027-06-06', 'Synthetic reversal') as r",
        [orgL, tally.id, users.fm],
      );
      expect(rev.r.reversal_of).toBe(tally.id);
    });

    it("is set by accounting.settings.manage only; postings before it are refused, on and after it allowed", async () => {
      expect(hint(await fails(setStart("acct", "2027-07-01")))).toBe("not_permitted");
      expect((await setStart("chief", "2027-07-01")).r.ledger_start_date).toBe("2027-07-01");
      expect(hint(await fails(post("voucher", "L-2", "2027-06-30")))).toBe("before_ledger_start");
      expect(hint(await fails(manual("2027-06-30")))).toBe("before_ledger_start");
      await post("tally_import", "GUID-L-2", "2027-06-30");
      // before any Pulse journal the date may still move
      await setStart("chief", "2027-07-03");
      await setStart("chief", "2027-07-02");
      expect((await post("voucher", "L-3", "2027-07-02")).number).toMatch(/^JV\//);
      await manual("2027-07-10");
    });

    it("cannot be cleared, moved earlier or moved past the first Pulse journal once Pulse has posted (every role)", async () => {
      expect(hint(await fails(setStart("chief", null)))).toBe("ledger_start_in_use");
      expect(hint(await fails(setStart("chief", "2027-06-01")))).toBe("ledger_start_in_use");
      expect(hint(await fails(setStart("chief", "2027-07-03")))).toBe("ledger_start_in_use");
      expect(
        hint(
          await fails(
            q("update public.acc_entities set ledger_start_date = '2027-06-01' where org_id = $1", [
              orgL,
            ]),
          ),
        ),
      ).toBe("ledger_start_in_use");
      // the same date again is fine
      await setStart("chief", "2027-07-02");
    });
  });

  describe("default rules", () => {
    it("seeds the 22A chart's rules for a new org, the extra ledgers, cash per branch, and never a VAT code", async () => {
      const { rows } = await svc(() =>
        q(
          `select r.kind, r.key, r.qualifier, a.code, r.origin from public.acc_posting_rules r
           left join public.acc_accounts a on a.id = r.account_id where r.org_id = $1 order by 1, 2, 3`,
          [orgB],
        ),
      );
      const m = new Map(rows.map((r) => [`${r.kind}|${r.key}|${r.qualifier}`, r.code]));
      expect(m.get("receivable|insurance|*")).toBe("1200");
      expect(m.get("receivable|self_pay|*")).toBe("1210");
      expect(m.get("receivable|corporate|*")).toBe("1220");
      expect(m.get("payment_mode|CASH|P")).toBe("1100-P");
      expect(m.get("payment_mode|TABBY|*")).toBe("1310");
      expect(m.get("payable|*|*")).toBe("2100");
      expect(m.get("provider_cost_offset|*|*")).toBe("5100");
      expect(m.get("denial_writeoff|*|*")).toBe("6620");
      expect(rows.some((r) => r.kind === "service_tax")).toBe(false);
      expect(rows.every((r) => r.origin === "seed")).toBe(true);
    });

    it("takes values from the old account map and Tally ledger map first, guesses revenue accounts, and is idempotent", async () => {
      await svc(async () => {
        await q(
          "insert into public.fin_ref_account_map (org_id, kind, key, account_code) values ($1, 'payment_mode', 'Pos Terminal', '1300'), ($1, 'revenue', 'Cosmetic', '4130')",
          [orgB],
        );
        await q(
          "insert into public.fin_ref_tally_ledgers (org_id, kind, key, ledger_name) values ($1, 'category', 'Office rent', 'Rent')",
          [orgB],
        );
      });
      const r1 = await one<{ r: { rules_added: number } }>(
        "select public.acc_seed_posting_rules($1) as r",
        [orgB],
      );
      expect(r1.r.rules_added).toBeGreaterThan(0);
      const { rows } = await svc(() =>
        q(
          `select r.kind, r.key, a.code, r.origin from public.acc_posting_rules r join public.acc_accounts a on a.id = r.account_id
           where r.org_id = $1 and r.kind in ('payment_mode', 'expense', 'revenue') and r.origin <> 'seed' or (r.org_id = $1 and r.kind = 'revenue')
           order by 1, 2`,
          [orgB],
        ),
      );
      expect(rows.map((r) => [r.kind, r.key, r.code, r.origin])).toEqual([
        ["expense", "Office rent", "6200", "migrated"],
        ["payment_mode", "POS TERMINAL", "1300", "migrated"],
        ["revenue", "Consultation", "4100", "seed"],
        ["revenue", "Cosmetic", "4130", "migrated"],
        ["revenue", "Laboratory", "4120", "seed"],
      ]);
      expect(
        (
          await one<{ r: { rules_added: number } }>(
            "select public.acc_seed_posting_rules($1) as r",
            [orgB],
          )
        ).r.rules_added,
      ).toBe(0);
    });

    it("keeps rules on ledgers of the org and service VAT rules on a tax code", async () => {
      expect(
        hint(
          await fails(
            svc(() =>
              q(
                "insert into public.acc_posting_rules (org_id, kind, key, account_id) select $1, 'discount', 'X', id from public.acc_accounts where org_id = $1 and code = 'G-CA'",
                [orgB],
              ),
            ),
          ),
        ),
      ).toBe("account_not_found");
      expect(
        (await fails(
          svc(() =>
            q(
              "insert into public.acc_posting_rules (org_id, kind, key) values ($1, 'service_tax', 'X')",
              [orgB],
            ),
          ),
        )) as {
          code?: string;
        },
      ).toMatchObject({ code: "23514" });
      expect(
        hint(
          await fails(
            svc(() =>
              q(
                "insert into public.acc_posting_rules (org_id, kind, key, account_id) select $1, 'receivable', 'friends', id from public.acc_accounts where org_id = $1 and code = '1210'",
                [orgB],
              ),
            ),
          ),
        ),
      ).toBe("invalid");
    });
  });

  describe("the runner, end to end", () => {
    beforeAll(async () => {
      await svc(() =>
        q("update public.acc_entities set ledger_start_date = '2027-07-01' where org_id = $1", [
          orgA,
        ]),
      );
      await rule(orgA, "service_tax", "Consultation", "*", null, "ZR");
      await rule(orgA, "service_tax", "Cosmetic", "*", null, "VAT5");
      await raw(async () => {
        const invoice = async (
          no: string,
          date: string,
          branch: string,
          type: string,
          total: number,
          lines: Array<[string, number, number, number]>,
        ) => {
          const id = await ins(
            `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, department, doctor_dha_id, inv_type, total, write_off, credit_note, record_hash)
             values ($1, $2, $3, $4, 'General Practice', 'DHA-SYN-1', $5, $6, 0, 0, 'h')`,
            [orgA, no, date, branch, type, total],
          );
          let pos = 0;
          for (const [item, net, discount, vat] of lines)
            await q(
              "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, line_net, line_discount, vat, is_current) values ($1, $2, $3, $4, $5, $6, $7, $8, true)",
              [orgA, id, `${no}|${item}|${pos}`, pos++, item, net, discount, vat],
            );
          return id;
        };
        ids.inv1 = await invoice("SYN-A1", "2027-07-05", "P", "SELF PAID", 252.5, [
          ["CONS", 200, 20, 0],
          ["COSM", 50, 0, 2.5],
        ]);
        ids.inv2 = await invoice("SYN-A2", "2027-07-06", "G", "INSURANCE", 500, [
          ["CONS", 500, 0, 0],
        ]);
        ids.inv3 = await invoice("SYN-A3", "2027-07-07", "P", "SELF PAID", 80, [
          ["LAB1", 80, 0, 0],
        ]);
        ids.invJ = await invoice("SYN-J1", "2027-06-20", "P", "SELF PAID", 100, [
          ["CONS", 100, 0, 0],
        ]);
        ids.claim1 = await ins(
          "insert into public.ins_claim_activities (org_id, claim_activity_number, matched_invoice_id, match_status, payer_id, initial_net) values ($1, 'CL-1', $2, 'matched', 'PAYER-SYN-1', 300)",
          [orgA, ids.inv2],
        );
        await q(
          "insert into public.ins_claim_activities (org_id, claim_activity_number, matched_invoice_id, match_status, payer_id, initial_net) values ($1, 'CL-2', $2, 'matched', 'PAYER-SYN-2', 150)",
          [orgA, ids.inv2],
        );
        const pay = (inv: string, key: string, mode: string, paid: number, date: string) =>
          ins(
            "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date, is_current) values ($1, $2, $3, $4, $5, $6, true)",
            [orgA, inv, key, mode, paid, date],
          );
        ids.pay1 = await pay(ids.inv1, "SYN-A1|1|R1", "Cash", 252.5, "2027-07-05");
        ids.pay2 = await pay(ids.inv1, "SYN-A1|2|R2", "CHEQUE", 10, "2027-07-06");
        ids.payJ = await pay(ids.invJ, "SYN-J1|1|R1", "CASH", 100, "2027-06-20");
        ids.rem = await ins(
          "insert into public.ins_remittance_batches (org_id, payer_id, paid_on, sum_paid) values ($1, 'PAYER-SYN-1', '2027-08-01', 430)",
          [orgA],
        );
        await q(
          `insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, payer_id, paid_amount, match_status)
           values ($1, $2, 1, 'R1', 'PAYER-SYN-1', 280, 'matched'), ($1, $2, 2, 'R2', 'PAYER-SYN-2', 150, 'unmatched')`,
          [orgA, ids.rem],
        );
        ids.denial = await ins(
          `insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, payer_id, rejected_amount, status, denied_on, deadline_on, resolved_at)
           values ($1, $2, 'CL-1', 'PAYER-SYN-1', 20, 'written_off', '2027-07-20', '2027-08-20', '2027-08-10T06:00:00Z')`,
          [orgA, ids.claim1],
        );
        ids.supplier = await ins(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Synthetic Landlord')",
          [orgA],
        );
        ids.bill = await ins(
          "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat, branch_code) values ($1, $2, 'SUP-77', '2027-07-03', 'Rent', 1000, 50, 'M')",
          [orgA, ids.supplier],
        );
        ids.voucher = await ins(
          `insert into public.fin_payment_vouchers (org_id, voucher_no, voucher_date, payee_name, supplier_id, amount, category, narration, status,
                                                    route, content_sha256, submitted_at, approved_at, payment_date, payment_reference, paid_at)
           values ($1, 'PV-2027-0001', '2027-07-19', 'Synthetic Landlord', $2, 600, 'Rent', 'Synthetic', 'paid', 'pulse', $3,
                   '2027-07-19T08:00:00Z', '2027-07-19T09:00:00Z', '2027-07-20', 'BANK-REF', '2027-07-20T08:00:00Z')`,
          [orgA, ids.supplier, HASH],
        );
        ids.run = await ins(
          `insert into public.fin_revshare_runs (org_id, month, status, snapshot, snapshot_hash, verified_at, approved_at)
           values ($1, '2027-07-01', 'approved', '{}'::jsonb, $2, '2027-08-08T06:00:00Z', '2027-08-09T06:00:00Z')`,
          [orgA, HASH],
        );
        await q(
          `insert into public.fin_revshare_lines (org_id, run_id, doctor_dha_id, scheme_id, scheme_version, payout) values ($1, $2, 'DHA-SYN-1', gen_random_uuid(), 1, 1200.4)`,
          [orgA, ids.run],
        );
        ids.payoutLine = await ins(
          `insert into public.fin_revshare_lines (org_id, run_id, doctor_dha_id, scheme_id, scheme_version, payout, paid_on, payment_ref, paid_recorded_at)
           values ($1, $2, 'DHA-SYN-2', gen_random_uuid(), 1, 800, '2027-08-05', 'PAY-1', now() - interval '1 hour')`,
          [orgA, ids.run],
        );
        const provider = await ins(
          "insert into public.fin_providers (org_id, name, kind) values ($1, 'Synthetic Lab', 'send_out_lab')",
          [orgA],
        );
        ids.lab = await ins(
          `insert into public.fin_provider_statements (org_id, provider_id, month, status, figures, figures_sha256, prepared_at, posted_at)
           values ($1, $2, '2027-07-01', 'posted', $3::jsonb, $4, '2027-08-07T06:00:00Z', '2027-08-08T06:00:00Z')`,
          [
            orgA,
            provider,
            JSON.stringify({
              allocation: [
                { doctor: "DHA-SYN-1", branch: "P", tests: 3, cost: 300 },
                { doctor: null, branch: null, tests: 1, cost: 20 },
              ],
            }),
            HASH,
          ],
        );
        ids.cashup = await ins(
          "insert into public.fin_cashups (org_id, branch_code, business_date, status, submitted_at) values ($1, 'P', '2027-07-05', 'submitted', '2027-07-05T18:00:00Z')",
          [orgA],
        );
        await q(
          "insert into public.fin_cashup_lines (org_id, cashup_id, payment_mode, expected_amount, counted_amount) values ($1, $2, 'CASH', 252.5, 240), ($1, $2, 'CARD', 0, 0)",
          [orgA, ids.cashup],
        );
        const account = await ins(
          "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Main', 'Synthetic Bank', '1234')",
          [orgA],
        );
        const stmt = await ins(
          "insert into public.fin_bank_imports (org_id, kind, account_id, file_sha256) values ($1, 'bank_statement', $2, $3)",
          [orgA, account, "1".repeat(64)],
        );
        const line = await ins(
          "insert into public.fin_bank_lines (org_id, account_id, import_id, row_no, value_date, amount, match_status) values ($1, $2, $3, 1, '2027-07-12', 1879, 'matched')",
          [orgA, account, stmt],
        );
        const settle = await ins(
          "insert into public.fin_bank_imports (org_id, kind, payment_mode, file_sha256) values ($1, 'settlement', 'Tabby', $2)",
          [orgA, "2".repeat(64)],
        );
        await q(
          `insert into public.fin_settlement_lines (org_id, import_id, row_no, payment_mode, txn_date, settlement_date, gross, fee, net, reference)
           values ($1, $2, 1, 'Tabby', '2027-07-08', '2027-07-12', 2000, 121, 1879, 'REF1')`,
          [orgA, settle],
        );
        const rec = await ins(
          `insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end, status, figures, figures_sha256, prepared_at, signed_at)
           values ($1, $2, '2027-07-01', '2027-07-01', '2027-07-31', 'signed', '{}'::jsonb, $3, '2027-08-03T06:00:00Z', '2027-08-04T06:00:00Z')`,
          [orgA, account, HASH],
        );
        ids.match = await ins(
          `insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status)
           values ($1, $2, $3, 'pay|Tabby|2027-07-12/REF1', 'payout', '2027-07-12', 1879, 1879, 95, 'matched')`,
          [orgA, rec, line],
        );
      });
      // the categories, modes and expense categories now in use get their default rules
      await one("select public.acc_seed_posting_rules($1)", [orgA]);
    });

    it("posts every source from the ledger start, previews what is before it, and waits with a reason", async () => {
      const totals = await run();
      expect(totals).toMatchObject({ orgs: 1, posted: 12, preview: 2, waiting: 2, errors: 0 });
      // every journal balances
      const unbalanced = await svc(() =>
        q(
          `select j.id from public.acc_journals j join public.acc_journal_lines l on l.journal_id = j.id
           where j.org_id = $1 group by j.id having sum(l.debit) <> sum(l.credit)`,
          [orgA],
        ),
      );
      expect(unbalanced.rows).toEqual([]);

      const inv1 = await journalOf("unite_invoice", "SYN-A1");
      expect(inv1!.lines).toEqual([
        ["4100", 0, 220],
        ["6600", 20, 0],
        ["4190", 0, 50],
        ["2200", 0, 2.5],
        ["1210", 252.5, 0],
      ]);
      expect(inv1!.number).toMatch(/^SAL\/2027-28\//);
      expect(inv1!.rows[0]).toMatchObject({ branch_code: "P", doctor_id: "DHA-SYN-1", tax: "ZR" });
      expect((await journalOf("unite_invoice", "SYN-A2"))!.lines).toEqual([
        ["4100", 0, 500],
        ["1200", 300, 0],
        ["1200", 150, 0],
        ["1210", 50, 0],
      ]);
      expect((await journalOf("unite_payment", ids.pay1))!.lines).toEqual([
        ["1100-P", 252.5, 0],
        ["1210", 0, 252.5],
      ]);
      expect((await journalOf("remittance", ids.rem))!.lines).toEqual([
        ["1150", 430, 0],
        ["1200", 0, 280],
        ["1200", 0, 150],
      ]);
      expect((await journalOf("denial", ids.denial))!.lines).toEqual([
        ["6620", 20, 0],
        ["1200", 0, 20],
      ]);
      expect((await journalOf("supplier_invoice", ids.bill))!.lines).toEqual([
        ["6200", 1000, 0],
        ["2210", 50, 0],
        ["2100", 0, 1050],
      ]);
      expect((await journalOf("voucher", ids.voucher))!.lines).toEqual([
        ["2100", 600, 0],
        ["1150", 0, 600],
      ]);
      const accrual = await journalOf("revshare_run", ids.run);
      expect(accrual!.journal_date).toBe("2027-07-31");
      expect(accrual!.lines).toEqual([
        ["5110", 1200.4, 0],
        ["2110", 0, 1200.4],
        ["5110", 800, 0],
        ["2110", 0, 800],
      ]);
      expect((await journalOf("revshare_run", `payout:${ids.payoutLine}`))!.lines).toEqual([
        ["2110", 800, 0],
        ["1150", 0, 800],
      ]);
      expect((await journalOf("lab_charge", ids.lab))!.lines).toEqual([
        ["5100", 300, 0],
        ["5100", 0, 300],
      ]);
      expect((await journalOf("cashup", ids.cashup))!.lines).toEqual([
        ["1100-P", 0, 12.5],
        ["6920", 12.5, 0],
      ]);
      expect((await journalOf("settlement", ids.match))!.lines).toEqual([
        ["1150", 1879, 0],
        ["1310", 0, 2000],
        ["6500", 121, 0],
      ]);

      expect(await status("unite_invoice", "SYN-A3")).toMatchObject({
        state: "waiting",
        reason: "no_tax_code",
        detail: "VAT code for Laboratory",
      });
      expect(await status("unite_payment", ids.pay2)).toMatchObject({
        state: "waiting",
        reason: "no_rule",
        detail: "Payment mode: CHEQUE (P)",
      });
      expect(await status("unite_invoice", "SYN-J1")).toMatchObject({
        state: "preview",
        journal_id: null,
      });
      expect(await journalOf("unite_invoice", "SYN-J1")).toBeNull();
      // no patient identity in journals
      const narr = await svc(() =>
        q("select string_agg(narration, ' | ') as n from public.acc_journals where org_id = $1", [
          orgA,
        ]),
      );
      expect(narr.rows[0].n).not.toMatch(/pin|patient/i);
    });

    it("is idempotent: a second run finds nothing, a full re-scan leaves every journal as it is", async () => {
      const count = async () =>
        Number(
          (
            await one<{ n: string }>(
              "select count(*)::text as n from public.acc_journals where org_id = $1",
              [orgA],
            )
          ).n,
        );
      const before = await count();
      expect((await run()).posted).toBe(0);
      await svc(() => q("delete from public.acc_posting_cursors where org_id = $1", [orgA]));
      const again = await run();
      expect(again).toMatchObject({ posted: 0, unchanged: 12, preview: 2 });
      expect(await count()).toBe(before);
    });

    it("reverses and re-posts an amended Unite invoice as its next version", async () => {
      const v1 = await journalOf("unite_invoice", "SYN-A1");
      await q(
        "update public.fin_invoice_lines set line_net = 300 where invoice_id = $1 and item_code = 'CONS'",
        [ids.inv1],
      );
      await q("update public.fin_invoices set total = 352.5, version = 2 where id = $1", [
        ids.inv1,
      ]);
      expect((await run()).posted).toBe(1);
      const v2 = await journalOf("unite_invoice", "SYN-A1");
      expect(v2!.source_version).toBe(2);
      expect(v2!.lines[0]).toEqual(["4100", 0, 320]);
      const old = await one<{ status: string; reversed_by: string }>(
        "select status, reversed_by from public.acc_journals where id = $1",
        [v1!.id],
      );
      expect(old.status).toBe("reversed");
      expect((await status("unite_invoice", "SYN-A1")).version).toBe(2);
    });

    it("reverses the journal of a withdrawn item (a deleted invoice)", async () => {
      const live = await journalOf("unite_invoice", "SYN-A2");
      await q("update public.fin_invoices set is_deleted = true where id = $1", [ids.inv2]);
      expect((await run()).withdrawn).toBe(1);
      expect(await journalOf("unite_invoice", "SYN-A2")).toBeNull();
      expect(
        (
          await one<{ status: string }>("select status from public.acc_journals where id = $1", [
            live!.id,
          ])
        ).status,
      ).toBe("reversed");
      expect((await status("unite_invoice", "SYN-A2")).state).toBe("withdrawn");
    });

    it("posts a waiting item once its VAT code and rule exist (the retry)", async () => {
      await rule(orgA, "service_tax", "Laboratory", "*", null, "ZR");
      await rule(orgA, "payment_mode", "CHEQUE", "*", "1150", null);
      const r = await run();
      expect(r.retried).toBe(2);
      expect((await status("unite_invoice", "SYN-A3")).state).toBe("posted");
      expect((await status("unite_payment", ids.pay2)).state).toBe("posted");
    });

    it("waits for a closed period and posts when it reopens", async () => {
      const period = await one<{ id: string }>(
        "select id from public.acc_periods where org_id = $1 and year = 2027 and month = 8",
        [orgA],
      );
      await one("select public.acc_set_period_status($1, $2, $3, 'closed')", [
        orgA,
        period.id,
        users.chief,
      ]);
      const caseId = await svc(() =>
        ins(
          `insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, payer_id, rejected_amount, status, denied_on, deadline_on, resolved_at)
           values ($1, $2, 'CL-1', 'PAYER-SYN-1', 5, 'lost', '2027-07-21', '2027-08-21', '2027-08-12T06:00:00Z')`,
          [orgA, ids.claim1],
        ),
      );
      await run();
      expect(await status("denial", caseId)).toMatchObject({
        state: "waiting",
        reason: "period_closed",
      });
      await one("select public.acc_set_period_status($1, $2, $3, 'open')", [
        orgA,
        period.id,
        users.chief,
      ]);
      await run();
      expect((await status("denial", caseId)).state).toBe("posted");
    });

    it("stores the preview before the ledger start and compares it with the ledger (the Tally mirror); posts nothing", async () => {
      const prev = await svc(() =>
        q(
          `select p.source_kind, a.code, p.debit::float as d, p.credit::float as c, p.month::text as m from public.acc_posting_preview p
           join public.acc_accounts a on a.id = p.account_id where p.org_id = $1 order by 1, 2`,
          [orgA],
        ),
      );
      expect(prev.rows).toEqual([
        { source_kind: "unite_invoice", code: "1210", d: 100, c: 0, m: "2027-06-01" },
        { source_kind: "unite_invoice", code: "4100", d: 0, c: 100, m: "2027-06-01" },
        { source_kind: "unite_payment", code: "1100-P", d: 100, c: 0, m: "2027-06-01" },
        { source_kind: "unite_payment", code: "1210", d: 0, c: 100, m: "2027-06-01" },
      ]);
      // Tally's June, mirrored by the import (22I)
      await one(
        "select public.acc_post_from_source($1, null, 'tally_import', 'GUID-A-1', 1, '2027-06-20', 'sales', 'Tally', $2::jsonb)",
        [
          orgA,
          JSON.stringify([
            { account_code: "1210", debit: 100 },
            { account_code: "4100", credit: 100 },
          ]),
        ],
      );
      const report = await one<{
        r: Array<{
          code: string;
          month: string;
          preview: number;
          ledger: number;
          difference: number;
        }>;
      }>("select public.acc_posting_preview_report($1, null, '2027-06-01', '2027-06-30') as r", [
        orgA,
      ]);
      expect(
        report.r.map((x) => [
          x.code,
          x.month,
          Number(x.preview),
          Number(x.ledger),
          Number(x.difference),
        ]),
      ).toEqual([
        ["1100-P", "2027-06-01", 100, 0, 100],
        ["1210", "2027-06-01", 0, 100, -100],
        ["4100", "2027-06-01", -100, -100, 0],
      ]);
      expect(
        Number(
          (
            await one<{ n: string }>(
              "select count(*)::text as n from public.acc_journals where org_id = $1 and source_id in ('SYN-J1', $2)",
              [orgA, ids.payJ],
            )
          ).n,
        ),
      ).toBe(0);
      // the ledger start cannot move back over Tally's June now that Pulse has posted
      expect(
        hint(
          await fails(
            one(
              "select public.acc_set_ledger_start($1, (select id from public.acc_entities where org_id = $1 and is_default), $2, '2027-06-01')",
              [orgA, users.chief],
            ),
          ),
        ),
      ).toBe("ledger_start_in_use");
    });

    it("builds one item's journal without posting it (for the Tally bridge)", async () => {
      const r = await buildJournalForSource(port, orgA, "unite_invoice", "SYN-J1");
      expect(r.action).toBe("post");
      if (r.action === "post")
        expect(r.journal.lines.map((l) => [l.account_code, l.debit, l.credit])).toEqual([
          ["4100", 0, 100],
          ["1210", 100, 0],
        ]);
      expect(await buildJournalForSource(port, orgA, "unite_invoice", "NO-SUCH")).toEqual({
        action: "withdraw",
      });
    });

    it("lists the keys in use for the missing-mappings view", async () => {
      const r = await one<{
        r: { service_categories: string[]; payment_modes: string[]; expense_categories: string[] };
      }>("select public.acc_posting_needed_keys($1) as r", [orgA]);
      expect(r.r.service_categories).toEqual(["Consultation", "Cosmetic", "Laboratory"]);
      // Unite's modes, the cash-up's and the settlement rules' (seeded for every org by 20C)
      expect(r.r.payment_modes).toEqual(
        expect.arrayContaining(["CARD", "CASH", "CHEQUE", "TABBY"]),
      );
      expect(r.r.payment_modes).toEqual([...r.r.payment_modes].sort());
      expect(r.r.expense_categories).toEqual(["Rent"]);
    });
  });

  describe("access", () => {
    it("staff with an accounting key read their org's rules, status and preview; another org sees nothing; nobody writes", async () => {
      await asUser(c, users.acct, async () => {
        for (const t of ["acc_posting_rules", "acc_posting_status", "acc_posting_preview"])
          expect(
            Number(
              (await q(`select count(*)::text as n from public.${t} where org_id = $1`, [orgA]))
                .rows[0].n,
            ),
            t,
          ).toBeGreaterThan(0);
        expect(
          Number((await q("select count(*)::text as n from public.acc_posting_cursors")).rows[0].n),
        ).toBe(0);
        const err = await fails(
          q(
            "insert into public.acc_posting_rules (org_id, kind, key) values ($1, 'discount', 'Y')",
            [orgA],
          ),
        );
        expect((err as { code?: string }).code).toBe("42501");
      });
      await asUser(c, users.bob, async () => {
        for (const t of [
          "acc_posting_rules",
          "acc_posting_status",
          "acc_posting_preview",
          "acc_posting_settings",
        ])
          expect(
            Number(
              (await q(`select count(*)::text as n from public.${t} where org_id = $1`, [orgA]))
                .rows[0].n,
            ),
            t,
          ).toBe(0);
      });
    });

    it("the runner works per organisation: org B's items never touch org A", async () => {
      const r = await runAccountingPosting(port, silent, {
        orgIds: [orgB],
        now: NOW,
        settleSeconds: 0,
      });
      expect(r.posted).toBe(0);
      expect(
        Number(
          (
            await one<{ n: string }>(
              "select count(*)::text as n from public.acc_posting_status where org_id = $1",
              [orgB],
            )
          ).n,
        ),
      ).toBe(0);
    });
  });
});
