/**
 * Phase 22I: the Tally import, the reconciliation against Tally's trial balance and the year-end close, database side.
 * The dry run stages rows and creates nothing; the commit creates the masters, one opening journal and a journal per
 * voucher; a second import of the same files changes nothing; an altered voucher (higher ALTERID) is reversed and
 * posted again; reconciliation with zero and non-zero differences; locking the imported months; the year-end close
 * posts, locks the year and drops it from "earlier years' profit"; re-opening reverses it. Synthetic fixtures only
 * (tests/unit/accounting/tally/fixtures). Needs TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseTallyXml } from "@/lib/accounting/tally/parse";
import {
  mergeParsed,
  planTallyImport,
  type PlanContext,
  type TallyPlan,
} from "@/lib/accounting/tally/plan";
import { stagedRows } from "@/lib/accounting/tally/stage";
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

const FIX = join(__dirname, "../unit/accounting/tally/fixtures");
const fixture = (name: string, edit?: (s: string) => string) => {
  const text = readFileSync(join(FIX, name), "utf8");
  return parseTallyXml(new TextEncoder().encode(edit ? edit(text) : text));
};

describe.skipIf(!TEST_DATABASE_URL)("Tally import and year-end close (Phase 22I)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const n = async (sql: string, p: unknown[] = []) => Number((await one<{ n: string }>(sql, p)).n);
  const rpc = async <T = Record<string, unknown>>(fn: string, args: unknown[]) =>
    (
      await one<{ r: T }>(
        `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`,
        args,
      )
    ).r;

  async function context(org: string): Promise<PlanContext> {
    const accounts = (
      await svc(() =>
        q(
          "select id, code, name, is_group, is_system, tally_guid, tally_group, control from public.acc_accounts where org_id = $1",
          [org],
        ),
      )
    ).rows;
    const costCentres = (
      await svc(() =>
        q("select id, code, name from public.acc_cost_centres where org_id = $1", [org]),
      )
    ).rows;
    const tallyJournals = (
      await svc(() =>
        q(
          "select tally_guid as guid, source_version as version from public.acc_journals where org_id = $1 and source_kind = 'tally_import' and status = 'posted'",
          [org],
        ),
      )
    ).rows;
    return { accounts, costCentres, tallyJournals } as PlanContext;
  }

  /** The dry run: plan against the database, store the import and its staged rows (what the server action does). */
  async function stage(org: string, plan: TallyPlan, sha: string): Promise<string> {
    const entity = await one<{ id: string }>(
      "select id from public.acc_entities where org_id = $1 and is_default",
      [org],
    );
    const imp = await one<{ id: string }>(
      `insert into public.acc_tally_imports (org_id, entity_id, file_sha256, file_bytes, report, opening_date, first_date, last_date, created_by)
       values ($1, $2, $3, 100, $4::jsonb, $5, $6, $7, $8) returning id`,
      [
        org,
        entity.id,
        [sha],
        JSON.stringify(plan.report),
        plan.report.opening.date,
        plan.report.firstDate,
        plan.report.lastDate,
        users.chief,
      ],
    );
    const rows = stagedRows(org, imp.id, plan);
    if (rows.length)
      await svc(() =>
        q(
          `insert into public.acc_tally_staged (org_id, import_id, seq, kind, guid, alter_id, payload)
           select org_id, import_id, seq, kind, guid, alter_id, payload from jsonb_populate_recordset(null::public.acc_tally_staged, $1::jsonb)`,
          [JSON.stringify(rows)],
        ),
      );
    return imp.id;
  }

  /** The commit: masters, opening, vouchers in small batches, finish. */
  async function commit(org: string, importId: string, openingDate: string | null) {
    const masters = await rpc("acc_tally_apply_masters", [org, importId, users.chief]);
    const opening = openingDate
      ? await rpc("acc_tally_post_opening", [org, importId, users.chief, openingDate])
      : null;
    const batches: Array<Record<string, number>> = [];
    for (let i = 0; i < 20; i++) {
      const b = await rpc<Record<string, number>>("acc_tally_post_vouchers", [
        org,
        importId,
        users.chief,
        3,
      ]);
      batches.push(b);
      if (Number(b.remaining) === 0) break;
    }
    const finish = await rpc<Record<string, unknown>>("acc_tally_finish", [
      org,
      importId,
      users.chief,
    ]);
    return { masters, opening, batches, finish };
  }

  const tallyJournal = (org: string, guid: string) =>
    one<{
      id: string;
      total: string;
      source_version: number;
      status: string;
      voucher_type: string;
      narration: string;
    }>(
      "select id, total, source_version, status, voucher_type, narration from public.acc_journals where org_id = $1 and tally_guid = $2 and status = 'posted'",
      [org, guid],
    );
  const tb = (org: string, from: string, to: string) =>
    rpc<{
      rows: Array<{ code: string; name: string; closing: number }>;
      earlier_years_pl: number;
      totals: { closing: number };
    }>("acc_trial_balance", [org, null, from, to]);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const u of ["alice", "bob", "chief", "chief2", "acct"])
      users[u] = await createAuthUser(c, `${u}-tally@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const org of [orgA, orgB]) {
        for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
            [org, r.name, r.description, JSON.stringify(r.permissions)],
          );
        for (const [u, role] of [
          ["chief", "Chief Accountant"],
          ["chief2", "Chief Accountant"],
          ["acct", "Accountant"],
        ])
          await q(
            "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
            [org, users[u], role],
          );
      }
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("import", () => {
    let importId: string;
    let plan: TallyPlan;

    it("the dry run stages sanitised rows and creates no account, cost centre or journal", async () => {
      const before = await n(
        "select (select count(*) from public.acc_accounts where org_id = $1) + (select count(*) from public.acc_journals where org_id = $1) + (select count(*) from public.acc_cost_centres where org_id = $1) as n",
        [orgA],
      );
      plan = planTallyImport(
        mergeParsed([fixture("masters.xml"), fixture("vouchers.xml")]),
        await context(orgA),
      );
      expect(plan.report.blocking).toEqual([]);
      importId = await stage(orgA, plan, "a".repeat(64));
      const after = await n(
        "select (select count(*) from public.acc_accounts where org_id = $1) + (select count(*) from public.acc_journals where org_id = $1) + (select count(*) from public.acc_cost_centres where org_id = $1) as n",
        [orgA],
      );
      expect(after).toBe(before);
      expect(
        await n("select count(*) as n from public.acc_tally_staged where import_id = $1", [
          importId,
        ]),
      ).toBe(plan.masters.length + plan.vouchers.length);
    });

    it("refuses the commit to someone without accounting.import, and to another org", async () => {
      expect(hint(await fails(rpc("acc_tally_apply_masters", [orgA, importId, users.acct])))).toBe(
        "not_permitted",
      );
      expect(hint(await fails(rpc("acc_tally_apply_masters", [orgB, importId, users.chief])))).toBe(
        "not_found",
      );
      expect(
        hint(await fails(rpc("acc_tally_post_vouchers", [orgA, importId, users.chief, 10]))),
      ).toBe("wrong_status");
    });

    it("signed-in staff read the import with accounting.import only, and never the staged rows", async () => {
      const seen = async (u: string, table: string) =>
        asUser(c, users[u], async () =>
          Number((await q(`select count(*) as n from public.${table}`)).rows[0].n),
        );
      expect(await seen("chief", "acc_tally_imports")).toBe(1);
      expect(await seen("acct", "acc_tally_imports")).toBe(0);
      expect(await seen("bob", "acc_tally_imports")).toBe(0);
      expect(await seen("chief", "acc_tally_staged")).toBe(0);
    });

    it("commits masters, one opening journal and the vouchers", async () => {
      const r = await commit(orgA, importId, "2026-06-30");
      expect(r.masters).toMatchObject({ refused: 0 });
      expect(r.opening).toMatchObject({ posted: 1, unchanged: 0, lines: 6 });
      const totals = r.batches.reduce(
        (a, b) => ({ done: a.done + Number(b.done), refused: a.refused + Number(b.refused) }),
        { done: 0, refused: 0 },
      );
      expect(totals).toEqual({ done: 7, refused: 0 });
      expect(
        await n("select count(*) as n from public.acc_tally_staged where import_id = $1", [
          importId,
        ]),
      ).toBe(0);
      const imp = await one<{ status: string; result: { counts: Record<string, number> } }>(
        "select status, result from public.acc_tally_imports where id = $1",
        [importId],
      );
      expect(imp.status).toBe("committed");
      expect(imp.result.counts["voucher.done"]).toBe(7);

      // the chart
      const acc = async (name: string) =>
        one<{
          code: string;
          nature: string;
          is_group: boolean;
          tally_guid: string | null;
          parent: string | null;
          affects_gross_profit: boolean;
        }>(
          "select a.code, a.nature, a.is_group, a.tally_guid, p.name as parent, a.affects_gross_profit from public.acc_accounts a left join public.acc_accounts p on p.id = a.parent_id where a.org_id = $1 and a.name = $2",
          [orgA, name],
        );
      expect(await acc("Insurance Receivables")).toMatchObject({
        is_group: true,
        nature: "asset",
        parent: "Sundry Debtors",
        tally_guid: "demo-guid-grp-insrec",
      });
      expect(await acc("Demo Primary Income")).toMatchObject({
        is_group: true,
        nature: "income",
        parent: null,
      });
      expect(await acc("Insurer Demo A")).toMatchObject({
        is_group: false,
        nature: "asset",
        parent: "Insurance Receivables",
      });
      expect(await acc("Consultation Fees Demo")).toMatchObject({
        nature: "income",
        affects_gross_profit: true,
      });
      expect(await acc("Sundry Debtors")).toMatchObject({
        code: "G-DEBT",
        tally_guid: "demo-guid-grp-debtors",
      });
      expect(await acc("Retained earnings")).toMatchObject({
        code: "3100",
        tally_guid: "demo-guid-led-pl",
      });
      expect((await acc("Rent Demo")).code).toMatch(/^T-[0-9A-F]{8}$/);
      expect(
        await n(
          "select count(*) as n from public.acc_cost_centres where org_id = $1 and code like 'T%'",
          [orgA],
        ),
      ).toBe(3);

      // the opening journal
      const op = await one<{
        voucher_type: string;
        journal_date: string;
        total: string;
        lines: string;
        source_id: string;
      }>(
        `select j.voucher_type, j.journal_date::text, j.total, j.source_id, (select count(*) from public.acc_journal_lines l where l.journal_id = j.id) as lines
         from public.acc_journals j where j.org_id = $1 and j.source_kind = 'opening' and j.status = 'posted'`,
        [orgA],
      );
      expect(op).toMatchObject({
        voucher_type: "opening",
        journal_date: "2026-06-30",
        total: "177000.00",
        lines: "6",
      });

      // the vouchers
      const v1 = await tallyJournal(orgA, "demo-guid-v1");
      expect(v1).toMatchObject({ total: "10500.00", source_version: 101, voucher_type: "receipt" });
      expect(v1.narration).toBe("Tally Insurance Receipt IR-0001: Remittance batch 42");
      const v2lines = (
        await svc(() =>
          q(
            "select l.debit, l.credit, cc.name as cc from public.acc_journal_lines l join public.acc_journals j on j.id = l.journal_id left join public.acc_cost_centres cc on cc.id = l.cost_centre_id where j.tally_guid = 'demo-guid-v2' and j.org_id = $1 order by l.line_no",
            [orgA],
          ),
        )
      ).rows;
      expect(v2lines.map((l) => [l.debit, l.credit, l.cc])).toEqual([
        ["1050.00", "0.00", null],
        ["0.00", "600.00", "Branch Demo North"],
        ["0.00", "400.00", "Branch Demo South"],
        ["0.00", "50.00", null],
      ]);
      const fx = await one<{ currency: string; fx_rate: string; amount_fx: string }>(
        "select l.currency, l.fx_rate, l.amount_fx from public.acc_journal_lines l join public.acc_journals j on j.id = l.journal_id where j.tally_guid = 'demo-guid-v4' and l.currency is not null",
      );
      expect(fx).toEqual({ currency: "USD", fx_rate: "3.67250000", amount_fx: "100.00" });
      expect((await tallyJournal(orgA, "demo-guid-v7")).narration).not.toContain(
        "4111111111111111",
      );
    });

    it("gives a trial balance that nets to zero with the expected bank balance", async () => {
      const t = await tb(orgA, "2026-08-31", "2026-08-31");
      expect(Number(t.totals.closing)).toBe(0);
      const bank = t.rows.find((r) => r.name === "Bank - Demo Main")!;
      expect(Number(bank.closing)).toBe(53_932.75); // 50,000 + 10,500 - 5,000 - 367.25 - 2,000 + 800
    });

    it("a second import of the same files changes nothing", async () => {
      const journals = await n("select count(*) as n from public.acc_journals where org_id = $1", [
        orgA,
      ]);
      const again = planTallyImport(
        mergeParsed([fixture("masters.xml"), fixture("vouchers.xml")]),
        await context(orgA),
      );
      expect(again.report.counts).toMatchObject({ toPost: 0, unchanged: 7 });
      expect(again.report.ledgers.linkedByGuid).toBe(11);
      expect(again.report.groups.create).toEqual([]);
      const id = await stage(orgA, again, "b".repeat(64));
      const r = await commit(orgA, id, "2026-06-30");
      expect(r.masters).toMatchObject({ refused: 0 });
      expect(r.opening).toMatchObject({ posted: 0, unchanged: 1 });
      expect(
        await n("select count(*) as n from public.acc_journals where org_id = $1", [orgA]),
      ).toBe(journals);
      expect(
        await n(
          "select count(*) as n from public.acc_accounts where org_id = $1 and name = 'Retained earnings'",
          [orgA],
        ),
      ).toBe(1);
    });

    it("an altered voucher (higher ALTERID) is reversed and posted again; an older one is skipped", async () => {
      const edited = fixture("vouchers.xml", (s) =>
        s
          .replace("<ALTERID>101</ALTERID>", "<ALTERID>150</ALTERID>")
          .replaceAll("10500.00", "11000.00"),
      );
      const plan2 = planTallyImport(
        mergeParsed([fixture("masters.xml"), edited]),
        await context(orgA),
      );
      expect(plan2.report.counts).toMatchObject({ altered: 1, toPost: 1, unchanged: 6 });
      const old = await tallyJournal(orgA, "demo-guid-v1");
      const id = await stage(orgA, plan2, "c".repeat(64));
      await commit(orgA, id, "2026-06-30");
      const now = await tallyJournal(orgA, "demo-guid-v1");
      expect(now).toMatchObject({ total: "11000.00", source_version: 150 });
      expect(
        (
          await one<{ status: string }>("select status from public.acc_journals where id = $1", [
            old.id,
          ])
        ).status,
      ).toBe("reversed");

      // a staged row older than what is posted is skipped by the database too (stale version)
      const plan3 = planTallyImport(
        mergeParsed([fixture("masters.xml"), fixture("vouchers.xml")]),
        { ...(await context(orgA)), tallyJournals: [] },
      );
      const only = {
        masters: [],
        vouchers: plan3.vouchers
          .filter((v) => v.guid === "demo-guid-v1")
          .map((v) => ({ ...v, alter_id: 90 })),
      };
      const id3 = await stage(orgA, { ...plan3, ...only }, "d".repeat(64));
      await rpc("acc_tally_apply_masters", [orgA, id3, users.chief]);
      const b = await rpc<Record<string, number>>("acc_tally_post_vouchers", [
        orgA,
        id3,
        users.chief,
        10,
      ]);
      expect(b).toMatchObject({ done: 0, older: 1, remaining: 0 });
      await rpc("acc_tally_finish", [orgA, id3, users.chief]);
      expect((await tallyJournal(orgA, "demo-guid-v1")).source_version).toBe(150);
    });

    it("a changed opening balance replaces the opening journal (reversal and version 2)", async () => {
      const m = fixture("masters.xml", (s) =>
        s
          .replace(
            "<OPENINGBALANCE>-2000.00</OPENINGBALANCE>",
            "<OPENINGBALANCE>-2500.00</OPENINGBALANCE>",
          )
          .replace(
            "<OPENINGBALANCE>30000.00</OPENINGBALANCE>",
            "<OPENINGBALANCE>30500.00</OPENINGBALANCE>",
          ),
      );
      const p = planTallyImport(mergeParsed([m, fixture("vouchers.xml")]), await context(orgA));
      expect(p.report.opening.balanced).toBe(true);
      const id = await stage(orgA, p, "e".repeat(64));
      const r = await commit(orgA, id, "2026-06-30");
      expect(r.opening).toMatchObject({ posted: 1, unchanged: 0 });
      const ops = (
        await svc(() =>
          q(
            "select source_version, status, total from public.acc_journals where org_id = $1 and source_kind = 'opening' order by source_version",
            [orgA],
          ),
        )
      ).rows;
      expect(ops.map((o) => [o.source_version, o.status, o.total])).toEqual([
        [1, "reversed", "177000.00"],
        [2, "posted", "177500.00"],
      ]);
    });

    it("refuses opening balances that do not net to zero", async () => {
      const m = fixture("masters.xml", (s) =>
        s.replace(
          "<OPENINGBALANCE>-2000.00</OPENINGBALANCE>",
          "<OPENINGBALANCE>-2000.01</OPENINGBALANCE>",
        ),
      );
      const p = planTallyImport(m, await context(orgA), { openingDate: "2026-06-30" });
      expect(p.report.blocking).toContain("opening_unbalanced");
      // the database refuses it as well, whatever the server says
      const id = await stage(orgA, { ...p, vouchers: [] }, "f".repeat(64));
      await rpc("acc_tally_apply_masters", [orgA, id, users.chief]);
      expect(
        hint(await fails(rpc("acc_tally_post_opening", [orgA, id, users.chief, "2026-06-30"]))),
      ).toBe("opening_unbalanced");
      await svc(() =>
        q("update public.acc_tally_imports set status = 'discarded' where id = $1", [id]),
      );
      await svc(() => q("delete from public.acc_tally_staged where import_id = $1", [id]));
    });
  });

  describe("reconciliation and locking", () => {
    let importId: string;
    let tallyRows: Array<{ name: string; debit: number; credit: number }>;

    beforeAll(async () => {
      importId = (
        await one<{ id: string }>(
          "select id from public.acc_tally_imports where org_id = $1 and status = 'committed' order by created_at limit 1",
          [orgA],
        )
      ).id;
      // what Tally's trial balance at 31 Aug 2026 would say: every ledger by its Tally name, Profit & Loss A/c for the
      // accumulated profit, and a group subtotal row (ignored)
      const t = await tb(orgA, "2026-08-31", "2026-08-31");
      tallyRows = t.rows
        .filter((r) => Number(r.closing) !== 0)
        .map((r) => ({
          name: r.name === "Retained earnings" ? "Profit & Loss A/c" : r.name,
          debit: Math.max(Number(r.closing), 0),
          credit: Math.max(-Number(r.closing), 0),
        }));
      tallyRows.push({ name: "Current Assets", debit: 1, credit: 0 });
    });

    it("locking the imported months needs a clean reconciliation first", async () => {
      expect(hint(await fails(rpc("acc_tally_lock_periods", [orgA, importId, users.chief])))).toBe(
        "not_reconciled",
      );
    });

    it("finds a difference per ledger", async () => {
      const off = tallyRows.map((r) =>
        r.name === "Rent Demo" ? { ...r, debit: r.debit + 10 } : r,
      );
      const r = await rpc<{
        reconciled: boolean;
        differences: number;
        rows: Array<{ name: string; difference: number }>;
      }>("acc_tally_reconcile", [
        orgA,
        null,
        importId,
        users.chief,
        "2026-08-31",
        "1".repeat(64),
        JSON.stringify([...off, { name: "Ghost Ledger Demo", debit: 5, credit: 0 }]),
      ]);
      expect(r.reconciled).toBe(false);
      expect(r.differences).toBe(2);
      expect(r.rows.map((x) => [x.name, Number(x.difference)])).toEqual([
        ["Rent Demo", -10],
        ["Ghost Ledger Demo", -5],
      ]);
      expect(
        (
          await one<{ reconciled_at: string | null }>(
            "select reconciled_at from public.acc_tally_imports where id = $1",
            [importId],
          )
        ).reconciled_at,
      ).toBeNull();
    });

    it("zero differences mark the import reconciled; then the months lock", async () => {
      const r = await rpc<{ reconciled: boolean; differences: number; group_rows_ignored: number }>(
        "acc_tally_reconcile",
        [
          orgA,
          null,
          importId,
          users.chief,
          "2026-08-31",
          "2".repeat(64),
          JSON.stringify(tallyRows),
        ],
      );
      expect(r).toMatchObject({ reconciled: true, differences: 0, group_rows_ignored: 1 });
      expect(
        hint(
          await fails(
            rpc("acc_tally_reconcile", [
              orgA,
              null,
              importId,
              users.acct,
              "2026-08-31",
              "2".repeat(64),
              "[]",
            ]),
          ),
        ),
      ).toBe("not_permitted");
      const locked = await rpc<{ locked: number }>("acc_tally_lock_periods", [
        orgA,
        importId,
        users.chief,
      ]);
      expect(locked.locked).toBe(3); // June (opening), July, August 2026
      const statuses = (
        await svc(() =>
          q(
            "select to_char(start_date, 'YYYY-MM') as m, status from public.acc_periods where org_id = $1 and not is_adjustment order by start_date",
            [orgA],
          ),
        )
      ).rows;
      expect(statuses).toEqual([
        { m: "2026-06", status: "locked" },
        { m: "2026-07", status: "locked" },
        { m: "2026-08", status: "locked" },
      ]);
    });
  });

  describe("year-end close", () => {
    const fyId = async (start: string) =>
      (
        await one<{ id: string }>(
          "select f.id from public.acc_fiscal_years f join public.acc_entities e on e.id = f.entity_id and e.is_default where f.org_id = $1 and f.start_date = $2",
          [orgB, start],
        )
      ).id;
    const post = (id: string, date: string, lines: unknown[]) =>
      rpc("acc_post_from_source", [
        orgB,
        null,
        "voucher",
        id,
        1,
        date,
        "journal",
        "Synthetic posting",
        JSON.stringify(lines),
      ]);
    const preview = (fy: string) =>
      rpc<{ problems: string[]; result: number; lines: unknown[]; open_months: number }>(
        "acc_year_end_preview",
        [orgB, fy],
      );

    beforeAll(async () => {
      await post("YE-0", "2026-03-01", [
        { account_code: "6200", debit: 20 },
        { account_code: "9000", credit: 20 },
      ]);
      await post("YE-1", "2026-07-05", [
        { account_code: "1210", debit: 105 },
        { account_code: "4100", credit: 100 },
        { account_code: "2200", credit: 5 },
      ]);
      await post("YE-2", "2026-09-10", [
        { account_code: "6200", debit: 30 },
        { account_code: "1150", credit: 30 },
      ]);
      await post("YE-3", "2027-07-02", [
        { account_code: "1150", debit: 1 },
        { account_code: "4900", credit: 1 },
      ]);
    });

    it("lists what stops the close: open months, an earlier open year, drafts", async () => {
      const fy = await fyId("2026-07-01");
      await svc(() =>
        q(
          "insert into public.acc_journals (org_id, entity_id, journal_date, narration) select $1, id, '2026-08-01', 'Draft' from public.acc_entities where org_id = $1 and is_default",
          [orgB],
        ),
      );
      const p = await preview(fy);
      expect(p.problems).toEqual(["periods_open", "drafts_waiting", "previous_year_open"]);
      expect(Number(p.result)).toBe(-70); // a profit of 70: income 100, expenses 30
      await svc(() =>
        q("delete from public.acc_journals where org_id = $1 and status = 'draft'", [orgB]),
      );
      expect(hint(await fails(rpc("acc_year_end_close", [orgB, fy, users.chief])))).toBe(
        "periods_open",
      );
      expect(hint(await fails(rpc("acc_year_end_close", [orgB, fy, users.acct])))).toBe(
        "not_permitted",
      );
    });

    it("closes the earlier year first, then this one: posts the closing journal and closes the year", async () => {
      const prev = await fyId("2025-07-01");
      await rpc("acc_year_end_close_months", [orgB, prev, users.chief]);
      const pr = await rpc<{ number: string; result: number }>("acc_year_end_close", [
        orgB,
        prev,
        users.chief,
      ]);
      expect(Number(pr.result)).toBe(20);

      const fy = await fyId("2026-07-01");
      const before = await tb(orgB, "2027-07-01", "2027-07-31");
      expect(Number(before.earlier_years_pl)).toBe(-70);
      expect(
        (await rpc<{ closed: number }>("acc_year_end_close_months", [orgB, fy, users.chief]))
          .closed,
      ).toBe(12 - 0);
      expect((await preview(fy)).problems).toEqual([]);
      const r = await rpc<{ journal_id: string; number: string; result: number; lines: number }>(
        "acc_year_end_close",
        [orgB, fy, users.chief],
      );
      expect(r.number).toMatch(/^JV\/2026-27\/\d{5}$/);
      expect(r.lines).toBe(3);
      const lines = (
        await svc(() =>
          q(
            "select a.code, l.debit, l.credit from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id where l.journal_id = $1 order by l.line_no",
            [r.journal_id],
          ),
        )
      ).rows;
      expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
        ["4100", "100.00", "0.00"],
        ["6200", "0.00", "30.00"],
        ["3100", "0.00", "70.00"],
      ]);
      const j = await one<{ source_kind: string; is_adjustment: boolean; journal_date: string }>(
        "select source_kind, is_adjustment, journal_date::text from public.acc_journals where id = $1",
        [r.journal_id],
      );
      expect(j).toEqual({
        source_kind: "year_end",
        is_adjustment: true,
        journal_date: "2027-06-30",
      });
      expect(
        (
          await one<{ status: string }>(
            "select status from public.acc_fiscal_years where id = $1",
            [fy],
          )
        ).status,
      ).toBe("closed");

      // earlier years' profit is no longer a separate line: it sits in retained earnings
      const after = await tb(orgB, "2027-07-01", "2027-07-31");
      expect(Number(after.earlier_years_pl)).toBe(0);
      expect(Number(after.rows.find((x) => x.code === "3100")!.closing)).toBe(-50); // a profit of 70 this year, a loss of 20 the year before
      expect(Number(after.totals.closing)).toBe(0);
    });

    it("refuses any posting into the closed year, even into a reopened month", async () => {
      const aug = await one<{ id: string }>(
        "select id from public.acc_periods where org_id = $1 and start_date = '2026-08-01' and not is_adjustment",
        [orgB],
      );
      await rpc("acc_set_period_status", [orgB, aug.id, users.chief, "open"]);
      expect(
        hint(
          await fails(
            post("YE-LATE", "2026-08-10", [
              { account_code: "6200", debit: 1 },
              { account_code: "9000", credit: 1 },
            ]),
          ),
        ),
      ).toBe("year_closed");
      await rpc("acc_set_period_status", [orgB, aug.id, users.chief, "closed"]);
    });

    it("re-opens only by reversing the closing journal (with a reason), and can close again", async () => {
      const fy = await fyId("2026-07-01");
      const prev = await fyId("2025-07-01");
      expect(
        hint(await fails(rpc("acc_year_end_reopen", [orgB, fy, users.acct, "Audit adjustment"]))),
      ).toBe("not_permitted");
      expect(hint(await fails(rpc("acc_year_end_reopen", [orgB, fy, users.chief, ""])))).toBe(
        "remarks_required",
      );
      expect(
        hint(
          await fails(rpc("acc_year_end_reopen", [orgB, prev, users.chief, "Audit adjustment"])),
        ),
      ).toBe("later_year_closed");
      const closing = await one<{ closing_journal_id: string }>(
        "select closing_journal_id from public.acc_fiscal_years where id = $1",
        [fy],
      );
      const r = await rpc<{ reversal_number: string }>("acc_year_end_reopen", [
        orgB,
        fy,
        users.chief2,
        "Audit adjustment",
      ]);
      expect(r.reversal_number).toMatch(/^JV\/2026-27\//);
      expect(
        (
          await one<{ status: string }>("select status from public.acc_journals where id = $1", [
            closing.closing_journal_id,
          ])
        ).status,
      ).toBe("reversed");
      expect(
        (
          await one<{ status: string }>(
            "select status from public.acc_fiscal_years where id = $1",
            [fy],
          )
        ).status,
      ).toBe("open");
      expect(Number((await tb(orgB, "2027-07-01", "2027-07-31")).earlier_years_pl)).toBe(-70);

      const again = await rpc<{ journal_id: string }>("acc_year_end_close", [
        orgB,
        fy,
        users.chief,
      ]);
      expect(
        (
          await one<{ source_version: number }>(
            "select source_version from public.acc_journals where id = $1",
            [again.journal_id],
          )
        ).source_version,
      ).toBe(2);
      expect(Number((await tb(orgB, "2027-07-01", "2027-07-31")).earlier_years_pl)).toBe(0);
      expect(hint(await fails(rpc("acc_year_end_close", [orgB, fy, users.chief])))).toBe(
        "year_closed",
      );
    });
  });
});
