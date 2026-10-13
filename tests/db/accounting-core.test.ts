/**
 * Phase 22A: the accounting ledger core, database side. Seeding (and its idempotence, the new-org and new-branch
 * triggers), who reads what (and that nobody writes directly), the journal rules (balance, one-sided lines, control
 * accounts, maker and checker, the hash the checker reviewed), posted journals and lines immutable for every role,
 * gap-free numbering per series and fiscal year (also under concurrent posts), the July and January fiscal years, closed
 * and locked periods and the CEO month lock, acc_post_from_source (idempotent, version replacement), reversals, automatic
 * reversals, the adjustment period, the trial balance against the ledger, the canonical-text parity with
 * lib/accounting/canonical.ts and the migration's role grants. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { journalCanonical } from "@/lib/accounting/canonical";
import { journalContentHash } from "@/lib/accounting/journal-hash";
import { fiscalYearOf, formatJournalNumber } from "@/lib/accounting/numbering";
import { TALLY_GROUPS } from "@/lib/accounting/tally-groups";
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

type Line = Record<string, unknown>;

describe.skipIf(!TEST_DATABASE_URL)("Accounting ledger core (Phase 22A)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const as = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const code = (e: unknown) => (e as { code?: string } | null)?.code ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const accountId = async (codeText: string, org = orgA) =>
    (
      await one<{ id: string }>(
        "select id from public.acc_accounts where org_id = $1 and code = $2",
        [org, codeText],
      )
    ).id;

  const postSource = (
    kind: string,
    id: string,
    version: number,
    date: string,
    lines: Line[],
    opts: { org?: string; type?: string; narration?: string } = {},
  ) =>
    one<{
      r: { id: string; number: string; created: boolean; replaced: string | null; status: string };
    }>("select public.acc_post_from_source($1, null, $2, $3, $4, $5, $6, $7, $8::jsonb) as r", [
      opts.org ?? orgA,
      kind,
      id,
      version,
      date,
      opts.type ?? "journal",
      opts.narration ?? "Synthetic posting",
      JSON.stringify(lines),
    ]).then((x) => x.r);

  const pair = (debitCode: string, creditCode: string, amount: number): Line[] => [
    { account_code: debitCode, debit: amount },
    { account_code: creditCode, credit: amount },
  ];

  /** A manual draft by `maker` (p_user_id), returned with its id. */
  const saveManual = (
    maker: string,
    date: string,
    lines: Line[],
    header: Record<string, unknown> = {},
    id: string | null = null,
  ) =>
    one<{ r: { id: string } }>(
      "select public.acc_journal_save($1, $2, $3, $4::jsonb, $5::jsonb) as r",
      [
        orgA,
        users[maker],
        id,
        JSON.stringify({
          voucher_type: "journal",
          journal_date: date,
          narration: "Synthetic manual journal",
          ...header,
        }),
        JSON.stringify(lines),
      ],
    ).then((x) => x.r.id);
  const act = (id: string, user: string, action: string, remarks = "") =>
    one<{ r: { hash?: string } }>("select public.acc_journal_act($1, $2, $3, $4, $5) as r", [
      orgA,
      id,
      users[user],
      action,
      remarks,
    ]).then((x) => x.r);
  const post = (id: string, user: string, hash: string | null) =>
    one<{ r: { number: string; status: string } }>(
      "select public.acc_post_journal($1, $2, $3, $4) as r",
      [orgA, id, users[user], hash],
    ).then((x) => x.r);
  const hashOf = (id: string) =>
    one<{ h: string }>("select public.acc_journal_compute_hash($1) as h", [id]).then((x) => x.h);
  /** maker prepares and submits, checker posts. */
  const manualPosted = async (
    date: string,
    lines: Line[],
    header: Record<string, unknown> = {},
    maker = "acct",
    checker = "fm",
  ) => {
    const id = await saveManual(maker, date, lines, header);
    const s = await act(id, maker, "submit");
    await post(id, checker, s.hash!);
    return id;
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of [
      "alice",
      "bob",
      "acct",
      "chief",
      "chief2",
      "fm",
      "ceo",
      "auditor",
      "fin",
      "nobody",
    ])
      users[n] = await createAuthUser(c, `${n}-acc@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
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
      await member("chief", "Chief Accountant");
      await member("chief2", "Chief Accountant");
      await member("fm", "Finance Manager");
      await member("ceo", "CEO");
      await member("auditor", "Auditor");
      await member("fin", "Finance");
      await q(
        "insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, 'DHA-SYN-1', 'Dr Synthetic')",
        [orgA],
      );
      await q(
        "insert into public.fin_ref_payers (org_id, payer_id, payer_name) values ($1, 'PAYER-SYN', 'Payer Synthetic')",
        [orgA],
      );
    });
    await postSource("unite_invoice", "SEED-1", 1, "2026-07-05", [
      { account_code: "1210", debit: 105, branch_code: "P" },
      { account_code: "4100", credit: 100, branch_code: "P", doctor_id: "DHA-SYN-1" },
      { account_code: "2200", credit: 5, tax_code: "VAT5" },
    ]);
    await postSource("unite_invoice", "SEED-B", 1, "2026-07-05", pair("1210", "4100", 10), {
      org: orgB,
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("seeding", () => {
    it("gives every org one default entity (July fiscal year) mapping all its branches to Dubai", async () => {
      const { rows } = await svc(() =>
        q(
          "select name, fiscal_year_start_month, is_default, base_currency from public.acc_entities where org_id = $1",
          [orgA],
        ),
      );
      expect(rows).toEqual([
        { name: "Org A", fiscal_year_start_month: 7, is_default: true, base_currency: "AED" },
      ]);
      const branches = await svc(() =>
        q(
          "select branch_code, emirate from public.acc_entity_branches where org_id = $1 order by 1",
          [orgA],
        ),
      );
      expect(branches.rows).toEqual([
        { branch_code: "G", emirate: "Dubai" },
        { branch_code: "M", emirate: "Dubai" },
        { branch_code: "P", emirate: "Dubai" },
      ]);
    });

    it("seeds Tally's 28 predefined groups exactly as the TypeScript catalogue, with the gross-profit flag", async () => {
      const { rows } = await svc(() =>
        q(
          `select a.code, a.name, p.code as parent, a.nature, a.affects_gross_profit as gp, a.tally_group
             from public.acc_accounts a left join public.acc_accounts p on p.id = a.parent_id
            where a.org_id = $1 and a.is_system order by a.code`,
          [orgA],
        ),
      );
      expect(rows).toEqual(
        [...TALLY_GROUPS]
          .sort((x, y) => (x.code < y.code ? -1 : 1))
          .map((g) => ({
            code: g.code,
            name: g.name,
            parent: g.parent,
            nature: g.nature,
            gp: g.grossProfit,
            tally_group: g.name,
          })),
      );
      // ledgers inherit nature, Tally group and the gross-profit flag from their group
      const rev = await one(
        "select nature, tally_group, affects_gross_profit, control from public.acc_accounts where org_id = $1 and code = '4100'",
        [orgA],
      );
      expect(rev).toEqual({
        nature: "income",
        tally_group: "Sales Accounts",
        affects_gross_profit: true,
        control: null,
      });
      const cash = await svc(() =>
        q(
          "select code, control from public.acc_accounts where org_id = $1 and code like '1100-%' order by code",
          [orgA],
        ),
      );
      expect(cash.rows).toEqual([
        { code: "1100-G", control: "cash" },
        { code: "1100-M", control: "cash" },
        { code: "1100-P", control: "cash" },
      ]);
    });

    it("seeds the UAE VAT codes: reverse charge on both VAT accounts, blocked VAT on none", async () => {
      const { rows } = await svc(() =>
        q(
          `select t.code, t.kind, t.rate::float8 as rate, o.code as out, i.code as inp
             from public.acc_tax_codes t
             left join public.acc_accounts o on o.id = t.output_account_id
             left join public.acc_accounts i on i.id = t.input_account_id
            where t.org_id = $1 order by t.code`,
          [orgA],
        ),
      );
      expect(rows).toEqual([
        { code: "BLK5", kind: "blocked", rate: 5, out: null, inp: null },
        { code: "EX", kind: "exempt", rate: 0, out: null, inp: null },
        { code: "OOS", kind: "out_of_scope", rate: 0, out: null, inp: null },
        { code: "RC5", kind: "reverse_charge", rate: 5, out: "2200", inp: "2210" },
        { code: "VAT5", kind: "standard", rate: 5, out: "2200", inp: "2210" },
        { code: "ZR", kind: "zero", rate: 0, out: null, inp: null },
      ]);
    });

    it("is idempotent, and a branch added later gets its mapping and cash ledger", async () => {
      const before = await one<{ n: number }>(
        "select count(*)::int as n from public.acc_accounts where org_id = $1",
        [orgA],
      );
      const again = await one<{ r: Record<string, unknown> }>(
        "select public.acc_seed_chart($1) as r",
        [orgA],
      );
      expect(again.r).toMatchObject({ accounts_added: 0, tax_codes_added: 0, branches_mapped: 0 });
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.acc_accounts where org_id = $1",
            [orgA],
          )
        ).n,
      ).toBe(before.n);
      await svc(() =>
        q(
          "insert into public.fin_ref_branches (org_id, code, name) values ($1, 'X', 'Extra Synthetic')",
          [orgA],
        ),
      );
      expect(
        await one(
          "select emirate from public.acc_entity_branches where org_id = $1 and branch_code = 'X'",
          [orgA],
        ),
      ).toEqual({ emirate: "Dubai" });
      expect(
        await one(
          "select name, control from public.acc_accounts where org_id = $1 and code = '1100-X'",
          [orgA],
        ),
      ).toEqual({
        name: "Cash - Extra Synthetic",
        control: "cash",
      });
    });

    it("seeds a new org through the orgs trigger (same chart size as an existing org)", async () => {
      const count = async (org: string) =>
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.acc_accounts where org_id = $1 and code not like '1100-%'",
            [org],
          )
        ).n;
      expect(await count(orgB)).toBe(await count(orgA));
      expect(await count(orgB)).toBeGreaterThanOrEqual(28 + 30);
    });
  });

  describe("who reads what", () => {
    const seen = async (user: string, table: string) =>
      as(user, async () =>
        Number(
          (await q(`select count(*)::int as n from public.${table} where org_id = $1`, [orgA]))
            .rows[0].n,
        ),
      );

    it("reference data for any accounting key; journals for ledger, prepare and approve keys only", async () => {
      for (const u of ["acct", "chief", "fm", "auditor", "alice"]) {
        expect(await seen(u, "acc_accounts"), u).toBeGreaterThan(0);
        expect(await seen(u, "acc_journals"), u).toBeGreaterThan(0);
        expect(await seen(u, "acc_journal_lines"), u).toBeGreaterThan(0);
        expect(await seen(u, "acc_periods"), u).toBeGreaterThan(0);
      }
      // the CEO reads the chart and reports (through server functions), not journal lines
      expect(await seen("ceo", "acc_accounts")).toBeGreaterThan(0);
      expect(await seen("ceo", "acc_journals")).toBe(0);
      expect(await seen("ceo", "acc_journal_lines")).toBe(0);
      for (const u of ["fin", "nobody", "bob"])
        for (const t of [
          "acc_accounts",
          "acc_journals",
          "acc_journal_lines",
          "acc_entities",
          "acc_tax_codes",
          "acc_number_series",
        ])
          expect(await seen(u, t), `${u} ${t}`).toBe(0);
    });

    it("lets nobody write directly, not even the org's admin; every function is service-role only", async () => {
      const jid = (
        await one<{ id: string }>("select id from public.acc_journals where org_id = $1 limit 1", [
          orgA,
        ])
      ).id;
      for (const sql of [
        "insert into public.acc_accounts (org_id, code, name, nature, parent_id) select org_id, 'ZZ1', 'Sneaky', nature, id from public.acc_accounts where org_id = $1 and code = 'G-IEXP'",
        "update public.acc_accounts set name = 'Changed' where org_id = $1",
        "delete from public.acc_cost_centres where org_id = $1",
        "insert into public.acc_journals (org_id, entity_id, journal_date, narration) select org_id, id, '2026-07-01', 'x' from public.acc_entities where org_id = $1",
      ]) {
        const r = await as("alice", () =>
          q(sql, [orgA]).then(
            (x) => x.rowCount,
            (e: unknown) => code(e),
          ),
        );
        expect([0, "42501"], sql).toContain(r);
      }
      const e = await as("alice", () =>
        fails(
          q(
            "select public.acc_post_from_source($1, null, 'voucher', 'x', 1, '2026-07-01', 'journal', 'x', '[]'::jsonb)",
            [orgA],
          ),
        ),
      );
      expect(code(e)).toBe("42501");
      const h = await as("chief", () =>
        fails(q("select public.acc_journal_compute_hash($1)", [jid])),
      );
      expect(code(h)).toBe("42501");
    });
  });

  describe("journal rules", () => {
    it("refuses unbalanced, one-line, two-sided and over-precise journals, leaving nothing behind", async () => {
      const before = (
        await one<{ n: number }>(
          "select count(*)::int as n from public.acc_journals where org_id = $1",
          [orgA],
        )
      ).n;
      const cases: Array<[Line[], string]> = [
        [
          [
            { account_code: "6200", debit: 100 },
            { account_code: "9000", credit: 99.99 },
          ],
          "unbalanced",
        ],
        [[{ account_code: "6200", debit: 100 }], "too_few_lines"],
        [
          [
            { account_code: "6200", debit: 100, credit: 100 },
            { account_code: "9000", credit: 0 },
          ],
          "one_sided",
        ],
        [
          [
            { account_code: "6200", debit: 0 },
            { account_code: "9000", credit: 0 },
          ],
          "one_sided",
        ],
        [
          [
            { account_code: "6200", debit: 1.234 },
            { account_code: "9000", credit: 1.234 },
          ],
          "bad_amount",
        ],
        [
          [
            { account_code: "6200", debit: -5 },
            { account_code: "9000", credit: -5 },
          ],
          "bad_amount",
        ],
        [
          [
            { account_code: "G-IEXP", debit: 5 },
            { account_code: "9000", credit: 5 },
          ],
          "account_is_group",
        ],
        [
          [
            { account_code: "NOPE", debit: 5 },
            { account_code: "9000", credit: 5 },
          ],
          "account_not_found",
        ],
        [
          [
            { account_code: "6200", debit: 5, branch_code: "Q" },
            { account_code: "9000", credit: 5 },
          ],
          "branch_unknown",
        ],
        [
          [
            { account_code: "6200", debit: 5, doctor_id: "NOBODY" },
            { account_code: "9000", credit: 5 },
          ],
          "doctor_unknown",
        ],
        [
          [
            { account_code: "6200", debit: 5, tax_code: "NOPE" },
            { account_code: "9000", credit: 5 },
          ],
          "tax_code",
        ],
      ];
      for (const [i, [lines, expected]] of cases.entries())
        expect(
          hint(await fails(postSource("voucher", `BAD-${i}`, 1, "2026-07-10", lines))),
          expected,
        ).toBe(expected);
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.acc_journals where org_id = $1",
            [orgA],
          )
        ).n,
      ).toBe(before);
    });

    it("keeps control accounts for automatic postings and opening-balance journals", async () => {
      const id = await saveManual("acct", "2026-07-11", pair("1210", "9000", 50));
      expect(hint(await fails(act(id, "acct", "submit")))).toBe("control_account");
      // the Accountant may not enter opening balances (accounting.import); the Chief Accountant may
      expect(
        hint(
          await fails(
            saveManual("acct", "2026-07-11", pair("1210", "9100", 50), { voucher_type: "opening" }),
          ),
        ),
      ).toBe("not_permitted");
      const opening = await saveManual("chief", "2026-07-11", pair("1210", "9100", 50), {
        voucher_type: "opening",
      });
      const s = await act(opening, "chief", "submit");
      expect((await post(opening, "chief2", s.hash!)).number).toMatch(/^OPB\/2026-27\/\d{5}$/);
      // an account closed to manual journals
      await svc(() =>
        q(
          "update public.acc_accounts set allow_manual = false where org_id = $1 and code = '6300'",
          [orgA],
        ),
      );
      const m = await saveManual("acct", "2026-07-11", pair("6300", "9000", 5));
      expect(hint(await fails(act(m, "acct", "submit")))).toBe("manual_not_allowed");
      expect(
        hint(
          await fails(
            saveManual("acct", "2026-07-11", pair("6200", "9000", 5), { voucher_type: "sales" }),
          ),
        ),
      ).toBe("voucher_type_not_manual");
    });

    it("needs a maker and a different checker, bound to the hash the checker reviewed", async () => {
      const id = await saveManual("acct", "2026-07-12", pair("6200", "9000", 75));
      expect(hint(await fails(post(id, "fm", await hashOf(id))))).toBe("not_submitted");
      const s = await act(id, "acct", "submit");
      expect(s.hash).toBe(await hashOf(id));
      expect(hint(await fails(post(id, "acct", s.hash!)))).toBe("not_permitted");
      expect(hint(await fails(post(id, "fm", "f".repeat(64))))).toBe("hash_mismatch");
      expect(hint(await fails(post(id, "fm", null)))).toBe("hash_mismatch");
      // the Chief Accountant may approve, but never their own journal
      const own = await saveManual("chief", "2026-07-12", pair("6200", "9000", 5));
      const so = await act(own, "chief", "submit");
      expect(hint(await fails(post(own, "chief", so.hash!)))).toBe("same_person");
      // sending back needs a reason and empties the queue; editing makes the editor the maker
      expect(hint(await fails(act(own, "fm", "return", "")))).toBe("remarks_required");
      await act(own, "fm", "return", "Wrong account");
      expect(
        await one("select submitted_at, return_remarks from public.acc_journals where id = $1", [
          own,
        ]),
      ).toEqual({
        submitted_at: null,
        return_remarks: "Wrong account",
      });
      await saveManual("chief2", "2026-07-12", pair("6200", "9000", 6), {}, own);
      const so2 = await act(own, "chief2", "submit");
      expect(hint(await fails(post(own, "chief2", so2.hash!)))).toBe("same_person");
      expect((await post(own, "chief", so2.hash!)).status).toBe("posted");
      const r = await post(id, "fm", s.hash!);
      expect(r.status).toBe("posted");
      const row = await one<{ sha256: string; approved_by: string; prepared_by: string }>(
        "select sha256, approved_by, prepared_by from public.acc_journals where id = $1",
        [id],
      );
      expect(row).toEqual({ sha256: s.hash, approved_by: users.fm, prepared_by: users.acct });
      // the table refuses the same person as maker and checker on a manual journal (CHECK, every role)
      const e = await fails(
        svc(() =>
          q(
            "insert into public.acc_journals (org_id, entity_id, journal_date, narration, prepared_by, approved_by) select org_id, id, '2026-07-12', 'x', $2, $2 from public.acc_entities where org_id = $1",
            [orgA, users.acct],
          ),
        ),
      );
      expect(code(e)).toBe("23514");
    });

    it("never changes a posted journal or its lines, for any role including the service role and the owner", async () => {
      const id = await manualPosted("2026-07-13", pair("6200", "9000", 12));
      const lineId = (
        await one<{ id: string }>(
          "select id from public.acc_journal_lines where journal_id = $1 limit 1",
          [id],
        )
      ).id;
      const account = await accountId("6300");
      const attempts = [
        ["update public.acc_journals set narration = 'changed' where id = $1", [id]],
        ["update public.acc_journals set journal_date = journal_date + 1 where id = $1", [id]],
        ["update public.acc_journals set status = 'reversed' where id = $1", [id]],
        ["delete from public.acc_journals where id = $1", [id]],
        ["update public.acc_journal_lines set debit = debit + 1 where id = $1", [lineId]],
        ["delete from public.acc_journal_lines where id = $1", [lineId]],
        [
          "insert into public.acc_journal_lines (org_id, journal_id, line_no, account_id, debit) values ($2, $1, 9, $3, 1)",
          [id, orgA, account],
        ],
      ] as const;
      for (const [sql, params] of attempts) {
        expect(code(await fails(svc(() => q(sql, [...params])))), `service: ${sql}`).toBe("42501");
        expect(code(await fails(q(sql, [...params]))), `owner: ${sql}`).toBe("42501");
      }
      // a draft cannot be marked posted around the posting function either
      const draft = await saveManual("acct", "2026-07-13", pair("6200", "9000", 1));
      expect(
        code(
          await fails(
            svc(() =>
              q(
                "update public.acc_journals set status = 'posted', number = 'X', sha256 = $2, posted_at = now() where id = $1",
                [draft, "a".repeat(64)],
              ),
            ),
          ),
        ),
      ).toBe("42501");
      expect(
        code(
          await fails(
            svc(() =>
              q(
                "insert into public.acc_journals (org_id, entity_id, journal_date, narration, status, number) select org_id, id, '2026-07-13', 'x', 'posted', 'X' from public.acc_entities where org_id = $1",
                [orgA],
              ),
            ),
          ),
        ),
      ).toBe("42501");
    });
  });

  describe("numbering and fiscal years", () => {
    it("numbers each series without gaps; a refused posting gives its number back", async () => {
      const nums: string[] = [];
      for (let i = 0; i < 3; i++) {
        nums.push(
          (
            await postSource(
              "bank_line",
              `GAP-${i}`,
              1,
              "2026-08-03",
              pair("1150", "9000", 10 + i),
              { type: "receipt" },
            )
          ).number,
        );
        await fails(
          postSource(
            "bank_line",
            `GAP-BAD-${i}`,
            1,
            "2026-08-03",
            [
              { account_code: "1150", debit: 1 },
              { account_code: "9000", credit: 2 },
            ],
            { type: "receipt" },
          ),
        );
      }
      expect(nums).toEqual([1, 2, 3].map((n) => formatJournalNumber("RCT", "2026-27", n)));
    });

    it("stays gap-free and unique under concurrent posts", async () => {
      const clients = await Promise.all(Array.from({ length: 6 }, () => connect()));
      try {
        await Promise.all(clients.map((x) => x.query("set role service_role")));
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) =>
            clients[i % clients.length].query<{ r: { number: string } }>(
              "select public.acc_post_from_source($1, null, 'cashup', $2, 1, '2026-08-20', 'contra', 'Concurrent synthetic', $3::jsonb) as r",
              [orgA, `PAR-${i}`, JSON.stringify(pair("6200", "9000", 1 + i))],
            ),
          ),
        );
        const numbers = results.map((r) => r.rows[0].r.number).sort();
        expect(numbers).toEqual(
          Array.from({ length: 24 }, (_, i) => formatJournalNumber("CTR", "2026-27", i + 1)),
        );
      } finally {
        await Promise.all(clients.map((x) => x.end()));
      }
    });

    it("splits fiscal years at 30 June / 1 July (July start) and keeps one year for a January start", async () => {
      expect(fiscalYearOf(7, "2027-06-30").code).toBe("2026-27");
      const a = await postSource("voucher", "FY-1", 1, "2027-06-30", pair("6200", "9000", 1), {
        type: "debit_note",
      });
      const b = await postSource("voucher", "FY-2", 1, "2027-07-01", pair("6200", "9000", 1), {
        type: "debit_note",
      });
      expect([a.number, b.number]).toEqual(["DBN/2026-27/00001", "DBN/2027-28/00001"]);
      const fy = await svc(() =>
        q(
          "select f.label, f.start_date::text, f.end_date::text from public.acc_journals j join public.acc_fiscal_years f on f.id = j.fiscal_year_id where j.id = any($1) order by f.start_date",
          [[a.id, b.id]],
        ),
      );
      expect(fy.rows).toEqual([
        { label: "FY 2026-27", start_date: "2026-07-01", end_date: "2027-06-30" },
        { label: "FY 2027-28", start_date: "2027-07-01", end_date: "2028-06-30" },
      ]);
      // org B switches to the calendar year before its first fiscal year exists... it already has one (the seed posting)
      const entityB = (
        await one<{ id: string }>("select id from public.acc_entities where org_id = $1", [orgB])
      ).id;
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_entities set fiscal_year_start_month = 1 where id = $1", [
                entityB,
              ]),
            ),
          ),
        ),
      ).toBe("fy_in_use");
      // a fresh org (calendar year) puts both dates in one year
      const orgC = (
        await one<{ id: string }>(
          "insert into public.orgs (name, slug) values ('Org Cal', 'org-cal-22a') returning id",
        )
      ).id;
      await svc(() =>
        q("update public.acc_entities set fiscal_year_start_month = 1 where org_id = $1", [orgC]),
      );
      const x = await postSource("voucher", "CAL-1", 1, "2027-06-30", pair("6200", "9000", 1), {
        org: orgC,
      });
      const y = await postSource("voucher", "CAL-2", 1, "2027-07-01", pair("6200", "9000", 1), {
        org: orgC,
      });
      expect([x.number, y.number]).toEqual(["JV/2027/00001", "JV/2027/00002"]);
    });
  });

  describe("periods and locks", () => {
    const periodOf = async (date: string) =>
      (
        await one<{ id: string }>(
          "select public.acc_ensure_period($1, (select id from public.acc_entities where org_id = $1 and is_default), $2) as id",
          [orgA, date],
        )
      ).id;
    const setStatus = (id: string, user: string, status: string) =>
      one("select public.acc_set_period_status($1, $2, $3, $4) as r", [
        orgA,
        id,
        users[user],
        status,
      ]);

    it("a closed period takes postings only from people who manage periods; a locked one from nobody", async () => {
      const jan = await periodOf("2025-01-15");
      expect(hint(await fails(setStatus(jan, "acct", "closed")))).toBe("not_permitted");
      expect(hint(await fails(setStatus(jan, "chief", "locked")))).toBe("period_status");
      await setStatus(jan, "chief", "closed");
      expect(
        hint(await fails(postSource("voucher", "CL-1", 1, "2025-01-20", pair("6200", "9000", 1)))),
      ).toBe("period_closed");
      const id = await saveManual("acct", "2025-01-20", pair("6200", "9000", 2));
      const s = await act(id, "acct", "submit");
      expect(hint(await fails(post(id, "fm", s.hash!)))).toBe("period_closed");
      expect((await post(id, "chief2", s.hash!)).status).toBe("posted");
      await setStatus(jan, "chief", "locked");
      const id2 = await saveManual("acct", "2025-01-21", pair("6200", "9000", 2));
      const s2 = await act(id2, "acct", "submit");
      expect(hint(await fails(post(id2, "chief2", s2.hash!)))).toBe("period_locked");
      expect(hint(await fails(setStatus(jan, "chief", "open")))).toBe("period_locked");
      expect(
        code(
          await fails(
            svc(() => q("update public.acc_periods set status = 'open' where id = $1", [jan])),
          ),
        ),
      ).toBe("42501");
      expect(
        code(await fails(svc(() => q("delete from public.acc_periods where id = $1", [jan])))),
      ).toBe("42501");
    });

    it("the CEO month lock (fin_period_closes) refuses postings for everyone", async () => {
      await svc(() =>
        q(
          `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
           values ($1, '2025-03-01', 'locked', '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'), now(), now(), now(), now())`,
          [orgA],
        ),
      );
      expect(
        hint(await fails(postSource("voucher", "ML-1", 1, "2025-03-10", pair("6200", "9000", 1)))),
      ).toBe("month_locked");
      const id = await saveManual("acct", "2025-03-10", pair("6200", "9000", 2));
      const s = await act(id, "acct", "submit");
      expect(hint(await fails(post(id, "chief2", s.hash!)))).toBe("month_locked");
    });

    it("audit adjustments go to the year's adjustment period, by people who manage periods, even after the CEO lock", async () => {
      await svc(() =>
        q(
          `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
           values ($1, '2024-06-01', 'locked', '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'), now(), now(), now(), now())`,
          [orgA],
        ),
      );
      const wrongDate = await saveManual("acct", "2024-06-29", pair("6200", "9000", 3), {
        is_adjustment: true,
      });
      const w = await act(wrongDate, "acct", "submit");
      expect(hint(await fails(post(wrongDate, "chief", w.hash!)))).toBe("adjustment_date");
      const id = await saveManual("acct", "2024-06-30", pair("6200", "9000", 3), {
        is_adjustment: true,
      });
      const s = await act(id, "acct", "submit");
      expect(hint(await fails(post(id, "fm", s.hash!)))).toBe("adjustment_period");
      expect((await post(id, "chief", s.hash!)).number).toBe("JV/2023-24/00001");
      expect(
        await one(
          "select p.month, p.is_adjustment, p.start_date::text as d from public.acc_journals j join public.acc_periods p on p.id = j.period_id where j.id = $1",
          [id],
        ),
      ).toEqual({ month: 13, is_adjustment: true, d: "2024-06-30" });
      // an ordinary journal in the same (CEO-locked) June is still refused
      expect(
        hint(
          await fails(postSource("voucher", "ADJ-ORD", 1, "2024-06-30", pair("6200", "9000", 1))),
        ),
      ).toBe("month_locked");
    });
  });

  describe("acc_post_from_source and reversals", () => {
    it("is idempotent on (kind, id, version); a new version reverses the old journal first; an old one is stale", async () => {
      const v1 = await postSource(
        "supplier_invoice",
        "SI-1",
        1,
        "2026-07-15",
        pair("6200", "2100", 100),
      );
      expect(v1).toMatchObject({ created: true, replaced: null, status: "posted" });
      const again = await postSource(
        "supplier_invoice",
        "SI-1",
        1,
        "2026-07-15",
        pair("6200", "2100", 999),
      );
      expect(again).toMatchObject({ id: v1.id, created: false, number: v1.number });
      const v2 = await postSource(
        "supplier_invoice",
        "SI-1",
        2,
        "2026-07-16",
        pair("6200", "2100", 120),
      );
      expect(v2).toMatchObject({ created: true, replaced: v1.id });
      const old = await one<{ status: string; reversed_by: string }>(
        "select status, reversed_by from public.acc_journals where id = $1",
        [v1.id],
      );
      expect(old.status).toBe("reversed");
      const rev = await one(
        "select source_kind, source_id, reversal_of, journal_date::text as d, status from public.acc_journals where id = $1",
        [old.reversed_by],
      );
      expect(rev).toEqual({
        source_kind: "reversal",
        source_id: v1.id,
        reversal_of: v1.id,
        d: "2026-07-16",
        status: "posted",
      });
      await postSource("supplier_invoice", "SI-1", 4, "2026-07-17", pair("6200", "2100", 130));
      expect(
        hint(
          await fails(
            postSource("supplier_invoice", "SI-1", 3, "2026-07-17", pair("6200", "2100", 1)),
          ),
        ),
      ).toBe("stale_version");
      const live = await svc(() =>
        q(
          "select count(*)::int as n from public.acc_journals where org_id = $1 and source_kind = 'supplier_invoice' and source_id = 'SI-1' and status = 'posted'",
          [orgA],
        ),
      );
      expect(live.rows[0].n).toBe(1);
      expect(
        hint(await fails(postSource("reversal", "x", 1, "2026-07-17", pair("6200", "2100", 1)))),
      ).toBe("source_kind");
    });

    it("keeps the Tally GUID of an imported journal (one live journal per GUID)", async () => {
      const t = await postSource(
        "tally_import",
        "guid-synthetic-0001",
        1,
        "2026-07-18",
        pair("6200", "9000", 7),
        { type: "payment" },
      );
      expect(await one("select tally_guid from public.acc_journals where id = $1", [t.id])).toEqual(
        { tally_guid: "guid-synthetic-0001" },
      );
      const t2 = await postSource(
        "tally_import",
        "guid-synthetic-0001",
        2,
        "2026-07-18",
        pair("6200", "9000", 8),
        { type: "payment" },
      );
      expect(t2.replaced).toBe(t.id);
    });

    it("reverses a posted journal once, on or after its date, with a reason, linking both", async () => {
      const id = await manualPosted("2026-07-20", pair("6200", "9000", 40));
      const reverse = (user: string, date: string, reason: string, jid = id) =>
        one<{ r: { id: string; number: string; reversal_of: string } }>(
          "select public.acc_reverse_journal($1, $2, $3, $4, $5) as r",
          [orgA, jid, users[user], date, reason],
        ).then((x) => x.r);
      expect(hint(await fails(reverse("acct", "2026-07-21", "Typo")))).toBe("not_permitted");
      expect(hint(await fails(reverse("fm", "2026-07-19", "Typo")))).toBe(
        "reversal_before_original",
      );
      expect(hint(await fails(reverse("fm", "2026-07-21", "")))).toBe("remarks_required");
      const r = await reverse("fm", "2026-07-21", "Typo in amount");
      expect(r.reversal_of).toBe(id);
      expect(
        await one("select status, reversed_by from public.acc_journals where id = $1", [id]),
      ).toEqual({ status: "reversed", reversed_by: r.id });
      const lines = await svc(() =>
        q(
          "select a.account_id, a.debit::float8 as ad, a.credit::float8 as ac, b.debit::float8 as bd, b.credit::float8 as bc from public.acc_journal_lines a join public.acc_journal_lines b on b.line_no = a.line_no where a.journal_id = $1 and b.journal_id = $2",
          [id, r.id],
        ),
      );
      for (const l of lines.rows) expect([l.ad, l.ac]).toEqual([l.bc, l.bd]);
      expect(hint(await fails(reverse("fm", "2026-07-22", "Again")))).toBe("already_reversed");
      expect(hint(await fails(reverse("fm", "2026-07-22", "Undo the undo", r.id)))).toBe(
        "is_reversal",
      );
    });

    it("posts automatic reversals on their date, once", async () => {
      const id = await manualPosted("2026-09-10", pair("6200", "2300", 55), {
        auto_reverse_on: "2026-10-01",
      });
      const run = (day: string) =>
        one<{ r: { done: string[]; failed: unknown[] } }>(
          "select public.acc_run_auto_reversals($1, $2) as r",
          [orgA, day],
        ).then((x) => x.r);
      expect((await run("2026-09-30")).done).toEqual([]);
      expect((await run("2026-10-01")).done).toEqual([id]);
      expect((await run("2026-10-02")).done).toEqual([]);
      const rev = await one<{ d: string; approved_by: string | null }>(
        "select r.journal_date::text as d, r.approved_by from public.acc_journals j join public.acc_journals r on r.id = j.reversed_by where j.id = $1",
        [id],
      );
      expect(rev).toEqual({ d: "2026-10-01", approved_by: null });
      expect(
        hint(
          await fails(
            saveManual("acct", "2026-09-10", pair("6200", "2300", 1), {
              auto_reverse_on: "2026-09-10",
            }),
          ),
        ),
      ).toBe("invalid");
    });
  });

  describe("reports", () => {
    it("the trial balance sums to zero and every closing balance matches the account's ledger", async () => {
      const tb = (
        await one<{
          r: {
            rows: Array<{ account_id: string; code: string; closing: number; opening: number }>;
            totals: Record<string, number>;
            earlier_years_pl: number;
          };
        }>("select public.acc_trial_balance($1, null, '2026-07-01', '2026-08-31') as r", [orgA])
      ).r;
      expect(Number(tb.totals.closing)).toBe(0);
      expect(Number(tb.totals.debit)).toBe(Number(tb.totals.credit));
      expect(Number(tb.totals.opening)).toBe(0);
      expect(tb.rows.length).toBeGreaterThan(3);
      for (const r of tb.rows) {
        const led = (
          await one<{
            r: {
              closing: number;
              opening: number;
              total_lines: number;
              lines: Array<{ balance: number }>;
            };
          }>("select public.acc_ledger($1, $2, '2026-07-01', '2026-08-31', 1000, 0) as r", [
            orgA,
            r.account_id,
          ])
        ).r;
        expect(Number(led.closing), r.code).toBe(Number(r.closing));
        expect(Number(led.opening), r.code).toBe(Number(r.opening));
        if (led.lines.length)
          expect(Number(led.lines[led.lines.length - 1].balance), r.code).toBe(Number(r.closing));
      }
    });

    it("income and expenses restart each fiscal year; earlier years show as one line and the totals still net to zero", async () => {
      const tb = (
        await one<{
          r: {
            rows: Array<{ code: string; opening: number }>;
            totals: Record<string, number>;
            earlier_years_pl: number;
          };
        }>("select public.acc_trial_balance($1, null, '2027-07-01', '2027-07-31') as r", [orgA])
      ).r;
      expect(Number(tb.earlier_years_pl)).not.toBe(0);
      expect(tb.rows.find((r) => r.code === "6200")?.opening ?? 0).toBe(0);
      expect(Number(tb.rows.find((r) => r.code === "9000")!.opening)).not.toBe(0);
      expect(Number(tb.totals.opening)).toBe(0);
      expect(Number(tb.totals.closing)).toBe(0);
      expect(
        hint(
          await fails(
            one("select public.acc_trial_balance($1, null, '2026-08-01', '2026-07-01')", [orgA]),
          ),
        ),
      ).toBe("invalid");
    });

    it("the day book lists posted journals with their lines in date order", async () => {
      const book = (
        await one<{
          r: {
            truncated: boolean;
            journals: Array<{ date: string; number: string; lines: unknown[] }>;
          };
        }>("select public.acc_day_book($1, null, '2026-07-01', '2026-07-31') as r", [orgA])
      ).r;
      expect(book.truncated).toBe(false);
      const dates = book.journals.map((j) => j.date);
      expect([...dates].sort()).toEqual(dates);
      expect(book.journals.every((j) => j.number && j.lines.length >= 2)).toBe(true);
    });
  });

  it("builds the same canonical text and hash as lib/accounting/canonical.ts", async () => {
    const cc = (
      await one<{ id: string }>(
        "insert into public.acc_cost_centres (org_id, code, name) values ($1, 'LEASE', 'Leased unit') returning id",
        [orgA],
      )
    ).id;
    const supplier = (
      await one<{ id: string }>(
        "insert into public.fin_suppliers (org_id, name) values ($1, 'Supplier Synthetic 22A') returning id",
        [orgA],
      )
    ).id;
    const id = await saveManual(
      "acct",
      "2026-07-25",
      [
        {
          account_code: "6200",
          debit: 1234.5,
          description: "Rent | July\nback\\slash ünïcode",
          branch_code: "m",
          cost_centre_id: cc,
          supplier_id: supplier,
          tax_code: "VAT5",
          currency: "USD",
          fx_rate: 3.6725,
          amount_fx: 336.15,
          department: "Admin",
          payer_id: "PAYER-SYN",
          party_kind: "supplier",
          party_id: "S-1",
        },
        { account_code: "9000", credit: 1234.5 },
      ],
      { narration: "Rent \\ July | accrual", auto_reverse_on: "2026-08-01" },
    );
    const j = await one<Record<string, unknown>>(
      "select * from public.acc_journals where id = $1",
      [id],
    );
    const lines = (
      await svc(() =>
        q("select * from public.acc_journal_lines where journal_id = $1 order by line_no", [id]),
      )
    ).rows;
    const content = {
      orgId: j.org_id as string,
      entityId: j.entity_id as string,
      voucherType: j.voucher_type as string,
      journalDate: "2026-07-25",
      narration: j.narration as string,
      sourceKind: null,
      sourceId: null,
      sourceVersion: null,
      reversalOf: null,
      isAdjustment: false,
      autoReverseOn: "2026-08-01",
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        accountId: l.account_id,
        debit: l.debit,
        credit: l.credit,
        taxCodeId: l.tax_code_id,
        branchCode: l.branch_code,
        department: l.department,
        doctorId: l.doctor_id,
        payerId: l.payer_id,
        supplierId: l.supplier_id,
        costCentreId: l.cost_centre_id,
        partyKind: l.party_kind,
        partyId: l.party_id,
        currency: l.currency,
        fxRate: l.fx_rate,
        amountFx: l.amount_fx,
        description: l.description,
      })),
    };
    expect(lines[0].branch_code).toBe("M");
    expect((await one<{ t: string }>("select public.acc_journal_canonical($1) as t", [id])).t).toBe(
      journalCanonical(content),
    );
    expect(await hashOf(id)).toBe(journalContentHash(content));
    const s = await act(id, "acct", "submit");
    expect(s.hash).toBe(journalContentHash(content));
  });

  it("keeps the chart sound: system groups, natures, cycles, used ledgers", async () => {
    const sys = await accountId("G-IEXP");
    expect(
      hint(await fails(svc(() => q("delete from public.acc_accounts where id = $1", [sys])))),
    ).toBe("system_group");
    expect(
      hint(
        await fails(
          svc(() => q("update public.acc_accounts set nature = 'asset' where id = $1", [sys])),
        ),
      ),
    ).toBe("system_group");
    await svc(() => q("update public.acc_accounts set name = 'Overheads' where id = $1", [sys])); // renaming is fine
    expect(
      hint(
        await fails(
          svc(() =>
            q(
              "insert into public.acc_accounts (org_id, parent_id, code, name, nature) values ($1, $2, 'ZZ2', 'Wrong nature', 'asset')",
              [orgA, sys],
            ),
          ),
        ),
      ),
    ).toBe("nature_mismatch");
    expect(
      hint(
        await fails(
          svc(() =>
            q(
              "insert into public.acc_accounts (org_id, parent_id, code, name, nature, is_system) values ($1, $2, 'ZZ3', 'Fake system', 'expense', true)",
              [orgA, sys],
            ),
          ),
        ),
      ),
    ).toBe("system_group");
    const g1 = (
      await one<{ id: string }>(
        "insert into public.acc_accounts (org_id, parent_id, code, name, nature, is_group) values ($1, $2, 'GX1', 'Group one', 'expense', true) returning id",
        [orgA, sys],
      )
    ).id;
    const g2 = (
      await one<{ id: string }>(
        "insert into public.acc_accounts (org_id, parent_id, code, name, nature, is_group) values ($1, $2, 'GX2', 'Group two', 'expense', true) returning id",
        [orgA, g1],
      )
    ).id;
    expect(
      hint(
        await fails(
          svc(() => q("update public.acc_accounts set parent_id = $2 where id = $1", [g1, g2])),
        ),
      ),
    ).toBe("cycle");
    const used = await accountId("6200");
    expect(
      hint(await fails(svc(() => q("delete from public.acc_accounts where id = $1", [used])))),
    ).toBe("has_lines");
    expect(
      hint(
        await fails(
          svc(() => q("update public.acc_accounts set is_group = true where id = $1", [used])),
        ),
      ),
    ).toBe("has_lines");
    await svc(() => q("update public.acc_accounts set is_active = false where id = $1", [used])); // deactivate instead
    expect(
      hint(
        await fails(postSource("voucher", "INACTIVE", 1, "2026-07-26", pair("6200", "9000", 1))),
      ),
    ).toBe("account_inactive");
    await svc(() => q("update public.acc_accounts set is_active = true where id = $1", [used]));
    // the history names who changed an account
    const h = await svc(() =>
      q(
        "select count(*)::int as n from public.record_history where table_name = 'acc_accounts' and record_id = $1 and op = 'update'",
        [sys],
      ),
    );
    expect(h.rows[0].n).toBeGreaterThan(0);
  });

  it("migration: creates the accounting roles and grants the Finance Manager and CEO keys, matching the code presets", async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261108000100_accounting_core.sql"),
      "utf8",
    );
    const grant = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    const roleInserts =
      sql.match(/insert into public\.roles[\s\S]*?on conflict \(org_id, name\) do nothing;/g) ?? [];
    expect(grant).toBeTruthy();
    expect(roleInserts).toHaveLength(3);
    const orgC = (
      await one<{ id: string }>(
        "insert into public.orgs (name, slug) values ('Org C', 'org-c-22a') returning id",
      )
    ).id;
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
          [orgC, r.name, JSON.stringify(r.permissions.filter((p) => !p.startsWith("accounting.")))],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Custom books', '', '[\"accounting.view\"]'::jsonb, false)",
        [orgC],
      );
    });
    const run = () =>
      svc(async () => {
        await q(grant!);
        for (const s of roleInserts) await q(s);
      });
    await run();
    await run(); // idempotent
    const roles = Object.fromEntries(
      (
        await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
      ).rows.map((r) => [r.name, [...(r.permissions as string[])].sort()]),
    );
    for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
      expect(roles[r.name], r.name).toEqual([...r.permissions].sort());
    expect(roles["Custom books"]).toEqual(["accounting.view"]);
  });
});
