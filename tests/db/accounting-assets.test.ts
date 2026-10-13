/**
 * Phase 22H: fixed assets, depreciation, prepayments and accruals, database side. Seeding (ledgers and classes, new
 * orgs, idempotent); the register guards (branch, bill over-capitalised, figures locked once depreciated, status only
 * through the functions, never deleted once used); runs prepared by one person (or the job) and posted by another with
 * accounting.journals.approve, bound to the hash, as one balanced journal; idempotent re-runs and new versions that
 * reverse the old journal; later-month and over-depreciation refusals; disposals with the gain, a stale preparation and
 * the disposed asset kept out of later runs; schedule releases (prepayment, deferred revenue) and a reversing accrual
 * reversed by acc_run_auto_reversals; waiting_ledger_start when the ledger refuses with that hint; who reads what.
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

type Res = Record<string, unknown> & {
  id: string;
  status: string;
  sha256: string;
  version: number;
};

describe.skipIf(!TEST_DATABASE_URL)("Accounting fixed assets and schedules (Phase 22H)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const ids: Record<string, string> = {};
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
  const account = async (code: string, org = orgA) =>
    (
      await one<{ id: string }>(
        "select id from public.acc_accounts where org_id = $1 and code = $2",
        [org, code],
      )
    ).id;
  const cls = async (code: string) =>
    (
      await one<{ id: string }>(
        "select id from public.acc_asset_classes where org_id = $1 and code = $2",
        [orgA, code],
      )
    ).id;

  const prepare = (kind: string, month: string, user: string | null, lines: unknown[]) =>
    one<{ r: Res }>("select public.acc_asset_run_prepare($1, null, $2, $3, $4, $5::jsonb) as r", [
      orgA,
      kind,
      month,
      user ? users[user] : null,
      JSON.stringify(lines),
    ]).then((x) => x.r);
  const post = (runId: string, user: string, hash: string) =>
    one<{ r: Res & { journal_id: string | null; number: string | null } }>(
      "select public.acc_asset_run_post($1, $2, $3, $4) as r",
      [orgA, runId, users[user], hash],
    ).then((x) => x.r);
  const journalLines = (journalId: string) =>
    svc(() =>
      q(
        `select a.code, l.debit::float as debit, l.credit::float as credit, l.branch_code
           from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id
          where l.journal_id = $1 order by l.line_no`,
        [journalId],
      ),
    ).then(
      (r) =>
        r.rows as Array<{
          code: string;
          debit: number;
          credit: number;
          branch_code: string | null;
        }>,
    );
  const balanceOf = async (code: string) =>
    Number(
      (
        await one<{ b: string }>(
          `select coalesce(sum(l.debit - l.credit), 0)::text as b from public.acc_journal_lines l
             join public.acc_journals j on j.id = l.journal_id
            where l.org_id = $1 and l.account_id = $2 and j.status in ('posted', 'reversed')`,
          [orgA, await account(code)],
        )
      ).b,
    );
  const addAsset = async (
    code: string,
    classCode: string,
    cost: number,
    inService: string,
    extra: Record<string, unknown> = {},
  ) => {
    const entity = (
      await one<{ id: string }>(
        "select id from public.acc_entities where org_id = $1 and is_default",
        [orgA],
      )
    ).id;
    const cols = {
      org_id: orgA,
      entity_id: entity,
      code,
      class_id: await cls(classCode),
      description: `Synthetic ${code}`,
      branch_code: "P",
      acquisition_date: inService,
      in_service_date: inService,
      cost,
      residual: 0,
      life_months: 60,
      method: "straight_line",
      ...extra,
    };
    const keys = Object.keys(cols);
    return (
      await one<{ id: string }>(
        `insert into public.acc_assets (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
        Object.values(cols),
      )
    ).id;
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "acct", "chief", "fm", "auditor", "nobody"])
      users[n] = await createAuthUser(c, `${n}-22h@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-22h", users.alice);
    orgB = await createOrg(c, "Org B", "org-b-22h", users.bob);
    await svc(async () => {
      for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      for (const [u, role] of [
        ["acct", "Accountant"],
        ["chief", "Chief Accountant"],
        ["fm", "Finance Manager"],
        ["auditor", "Auditor"],
      ])
        await q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      // 22D's ledger start rule refuses every non-import posting until the date is set (22K)
      await q(
        "update public.acc_entities set ledger_start_date = '2000-01-01' where org_id in ($1, $2)",
        [orgA, orgB],
      );
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("seeding", () => {
    it("gives every org the five classes on their own ledgers, idempotently", async () => {
      for (const org of [orgA, orgB]) {
        const { rows } = await svc(() =>
          q(
            `select k.code, k.life_months, k.method, c.code as cost, a.code as accum, e.code as expense, d.code as gain
               from public.acc_asset_classes k
               join public.acc_accounts c on c.id = k.cost_account_id join public.acc_accounts a on a.id = k.accum_account_id
               join public.acc_accounts e on e.id = k.expense_account_id join public.acc_accounts d on d.id = k.disposal_account_id
              where k.org_id = $1 order by k.code`,
            [org],
          ),
        );
        expect(rows).toEqual([
          {
            code: "FURN",
            life_months: 60,
            method: "straight_line",
            cost: "1510",
            accum: "1593",
            expense: "6400",
            gain: "4920",
          },
          {
            code: "IT",
            life_months: 36,
            method: "straight_line",
            cost: "1520",
            accum: "1592",
            expense: "6400",
            gain: "4920",
          },
          {
            code: "LHI",
            life_months: 60,
            method: "straight_line",
            cost: "1530",
            accum: "1594",
            expense: "6400",
            gain: "4920",
          },
          {
            code: "MED",
            life_months: 60,
            method: "straight_line",
            cost: "1500",
            accum: "1591",
            expense: "6400",
            gain: "4920",
          },
          {
            code: "VEH",
            life_months: 60,
            method: "straight_line",
            cost: "1540",
            accum: "1595",
            expense: "6400",
            gain: "4920",
          },
        ]);
      }
      const again = await one<{ r: { accounts_added: number; classes_added: number } }>(
        "select public.acc_assets_seed($1) as r",
        [orgA],
      );
      expect(again.r).toEqual({ accounts_added: 0, classes_added: 0 });
      expect(await account("2310")).toBeTruthy();
    });

    it("refuses a class whose ledgers do not fit", async () => {
      const e = await fails(
        svc(() =>
          q(
            "update public.acc_asset_classes set expense_account_id = $2 where org_id = $1 and code = 'MED'",
            [orgA, "00000000-0000-0000-0000-000000000000"],
          ),
        ),
      );
      expect(e).not.toBeNull();
      const e2 = await fails(
        svc(async () =>
          q(
            "update public.acc_asset_classes set expense_account_id = $2 where org_id = $1 and code = 'MED'",
            [orgA, await account("1150")],
          ),
        ),
      );
      expect(hint(e2)).toBe("class_accounts");
    });
  });

  describe("register guards", () => {
    it("checks the branch, keeps status for the functions and records history", async () => {
      expect(
        hint(await fails(addAsset("FA-BAD", "MED", 100, "2026-07-01", { branch_code: "NOPE" }))),
      ).toBe("branch_unknown");
      ids.a = await addAsset("FA-A", "MED", 12000, "2026-07-01");
      ids.b = await addAsset("FA-B", "IT", 3600, "2026-07-15", { life_months: 36 });
      expect(
        hint(
          await fails(
            svc(() => q("update public.acc_assets set status = 'disposed' where id = $1", [ids.a])),
          ),
        ),
      ).toBe("invalid");
      const h = await one<{ n: string }>(
        "select count(*)::text as n from public.record_history where table_name = 'acc_assets' and record_id = $1",
        [ids.a],
      );
      expect(Number(h.n)).toBe(1);
    });

    it("never capitalises more than a bill's net amount", async () => {
      const supplier = (
        await one<{ id: string }>(
          "insert into public.fin_suppliers (org_id, name) values ($1, 'Synthetic Supplier 22H') returning id",
          [orgA],
        )
      ).id;
      const invoice = (
        await one<{ id: string }>(
          "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat) values ($1, $2, 'SYN-22H-1', '2026-07-01', 'Equipment', 5000, 250) returning id",
          [orgA, supplier],
        )
      ).id;
      await addAsset("FA-INV1", "FURN", 3000, "2026-07-01", { supplier_invoice_id: invoice });
      expect(
        hint(
          await fails(
            addAsset("FA-INV2", "FURN", 2500, "2026-07-01", { supplier_invoice_id: invoice }),
          ),
        ),
      ).toBe("invoice_over_capitalised");
      await addAsset("FA-INV3", "FURN", 2000, "2026-07-01", { supplier_invoice_id: invoice });
      await svc(() =>
        q("delete from public.acc_assets where org_id = $1 and code like 'FA-INV%'", [orgA]),
      );
    });
  });

  describe("depreciation runs", () => {
    it("is prepared by one person and posted by another with approval, bound to the hash, as one balanced journal", async () => {
      const r = await prepare("depreciation", "2026-07-01", "chief", [
        { asset_id: ids.a, amount: 150 },
        { asset_id: ids.b, amount: 100 },
      ]);
      expect(r).toMatchObject({ status: "draft", version: 1, changed: true, total: 250, lines: 2 });
      ids.jul = r.id;
      expect(hint(await fails(post(r.id, "acct", r.sha256)))).toBe("not_permitted");
      expect(hint(await fails(post(r.id, "chief", r.sha256)))).toBe("same_person");
      expect(hint(await fails(post(r.id, "fm", "0".repeat(64))))).toBe("hash_mismatch");
      const p = await post(r.id, "fm", r.sha256);
      expect(p.status).toBe("posted");
      const lines = await journalLines(p.journal_id!);
      expect(lines).toEqual(
        expect.arrayContaining([
          { code: "6400", debit: 150, credit: 0, branch_code: "P" },
          { code: "1591", debit: 0, credit: 150, branch_code: "P" },
          { code: "6400", debit: 100, credit: 0, branch_code: "P" },
          { code: "1592", debit: 0, credit: 100, branch_code: "P" },
        ]),
      );
      const j = await one<{
        source_kind: string;
        source_id: string;
        source_version: number;
        total: string;
      }>(
        "select source_kind, source_id, source_version, total::text from public.acc_journals where id = $1",
        [p.journal_id],
      );
      expect(j).toEqual({
        source_kind: "fixed_asset",
        source_id: r.id,
        source_version: 1,
        total: "250.00",
      });
    });

    it("is idempotent, and a changed month becomes a new version that reverses the old journal", async () => {
      const same = await prepare("depreciation", "2026-07-01", "acct", [
        { asset_id: ids.b, amount: 100 },
        { asset_id: ids.a, amount: 150 },
      ]);
      expect(same).toMatchObject({ changed: false, status: "posted", version: 1 });
      const v2 = await prepare("depreciation", "2026-07-01", "acct", [
        { asset_id: ids.a, amount: 200 },
        { asset_id: ids.b, amount: 100 },
      ]);
      expect(v2).toMatchObject({ changed: true, status: "draft", version: 2 });
      const before = await one<{ journal_id: string }>(
        "select journal_id from public.acc_depreciation_runs where id = $1",
        [v2.id],
      );
      const p = await post(v2.id, "fm", v2.sha256);
      expect(p.status).toBe("posted");
      const old = await one<{ status: string }>(
        "select status from public.acc_journals where id = $1",
        [before.journal_id],
      );
      expect(old.status).toBe("reversed");
      expect(await balanceOf("6400")).toBe(300);
      expect(await balanceOf("1591")).toBe(-200);
      const kept = await one<{ n: string }>(
        "select count(*)::text as n from public.acc_asset_run_lines where run_id = $1 and version <> 2",
        [v2.id],
      );
      expect(kept.n).toBe("0");
    });

    it("refuses an earlier month once a later one is posted, and anything below the residual", async () => {
      const aug = await prepare("depreciation", "2026-08-01", null, [
        { asset_id: ids.a, amount: 200 },
        { asset_id: ids.b, amount: 100 },
      ]);
      expect(aug).toMatchObject({ status: "draft", changed: true });
      const row = await one<{ prepared_by: string | null }>(
        "select prepared_by from public.acc_depreciation_runs where id = $1",
        [aug.id],
      );
      expect(row.prepared_by).toBeNull(); // the monthly job
      ids.aug = aug.id;
      ids.augHash = aug.sha256;
      expect(hint(await fails(prepare("depreciation", "2026-06-01", "acct", [])))).toBe(
        "later_month_posted",
      );
      expect(hint(await fails(prepare("depreciation", "2099-01-01", "acct", [])))).toBe(
        "future_month",
      );
      const huge = await prepare("depreciation", "2026-09-01", "acct", [
        { asset_id: ids.a, amount: 11900 },
      ]);
      expect(hint(await fails(post(huge.id, "fm", huge.sha256)))).toBe("over_depreciated");
      await svc(async () => {
        await q("select set_config('app.acc_asset_ctx', 'on', false)");
        await q("delete from public.acc_depreciation_runs where id = $1", [huge.id]);
        await q("select set_config('app.acc_asset_ctx', '', false)");
      });
    });

    it("keeps runs, their lines and the figures of a depreciated asset out of reach of direct writes", async () => {
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_depreciation_runs set total = 1 where id = $1", [ids.jul]),
            ),
          ),
        ),
      ).toBe("posted_immutable");
      expect(
        hint(
          await fails(
            svc(() => q("delete from public.acc_asset_run_lines where run_id = $1", [ids.jul])),
          ),
        ),
      ).toBe("posted_immutable");
      expect(
        hint(
          await fails(
            svc(() => q("update public.acc_assets set cost = 13000 where id = $1", [ids.a])),
          ),
        ),
      ).toBe("asset_in_use");
      await svc(() =>
        q("update public.acc_assets set description = 'Synthetic renamed' where id = $1", [ids.a]),
      );
      expect(
        hint(await fails(svc(() => q("delete from public.acc_assets where id = $1", [ids.a])))),
      ).toBe("asset_in_use");
    });
  });

  describe("disposals", () => {
    it("is refused when depreciation was posted after it was prepared, then posts the gain", async () => {
      const bank = await account("1150");
      // the purchase itself is the bill's posting (20D / 22D), here a synthetic stand-in
      await one(
        "select public.acc_post_from_source($1, null, 'supplier_invoice', 'SYN-22H-B', 1, '2026-07-15', 'purchase', 'Synthetic IT purchase', $2::jsonb)",
        [
          orgA,
          JSON.stringify([
            { account_code: "1520", debit: 3600 },
            { account_code: "2100", credit: 3600 },
          ]),
        ],
      );
      // B: 3,600 over 36 months = 100 a month; disposed 10 Sep: depreciated Jul and Aug = 200
      const prep = await one<{ r: { sha256: string } }>(
        "select public.acc_asset_disposal_prepare($1, $2, $3, $4::jsonb) as r",
        [
          orgA,
          ids.b,
          users.acct,
          JSON.stringify({
            disposal_date: "2026-09-10",
            proceeds: 3500,
            proceeds_account_id: bank,
            accumulated: 200,
          }),
        ],
      );
      // August is posted after the disposal was prepared (by fm: the job prepared it)
      await post(ids.aug, "fm", ids.augHash);
      expect(
        hint(
          await fails(
            one("select public.acc_asset_disposal_post($1, $2, $3, $4)", [
              orgA,
              ids.b,
              users.fm,
              prep.r.sha256,
            ]),
          ),
        ),
      ).toBe("disposal_stale");
      const again = await one<{ r: { sha256: string; gain: number } }>(
        "select public.acc_asset_disposal_prepare($1, $2, $3, $4::jsonb) as r",
        [
          orgA,
          ids.b,
          users.acct,
          JSON.stringify({
            disposal_date: "2026-09-10",
            proceeds: 3500,
            proceeds_account_id: bank,
            accumulated: 200,
          }),
        ],
      );
      expect(Number(again.r.gain)).toBe(100);
      expect(
        hint(
          await fails(
            one("select public.acc_asset_disposal_post($1, $2, $3, $4)", [
              orgA,
              ids.b,
              users.acct,
              again.r.sha256,
            ]),
          ),
        ),
      ).toBe("not_permitted");
      const p = await one<{ r: { status: string; journal_id: string } }>(
        "select public.acc_asset_disposal_post($1, $2, $3, $4) as r",
        [orgA, ids.b, users.fm, again.r.sha256],
      );
      expect(p.r.status).toBe("posted");
      expect(await journalLines(p.r.journal_id)).toEqual([
        { code: "1592", debit: 200, credit: 0, branch_code: "P" },
        { code: "1150", debit: 3500, credit: 0, branch_code: "P" },
        { code: "1520", debit: 0, credit: 3600, branch_code: "P" },
        { code: "4920", debit: 0, credit: 100, branch_code: "P" },
      ]);
      const a = await one<{ status: string }>(
        "select status from public.acc_assets where id = $1",
        [ids.b],
      );
      expect(a.status).toBe("disposed");
      expect(await balanceOf("1592")).toBe(0);
      expect(await balanceOf("1520")).toBe(0);
    });

    it("charges no new depreciation to a disposed asset", async () => {
      const sep = await prepare("depreciation", "2026-09-01", "acct", [
        { asset_id: ids.a, amount: 200 },
        { asset_id: ids.b, amount: 100 },
      ]);
      expect(hint(await fails(post(sep.id, "fm", sep.sha256)))).toBe("asset_disposed");
      const ok = await prepare("depreciation", "2026-09-01", "acct", [
        { asset_id: ids.a, amount: 200 },
      ]);
      expect((await post(ok.id, "fm", ok.sha256)).status).toBe("posted");
    });
  });

  describe("opening depreciation (assets already in the books before Pulse)", () => {
    it("counts the opening amount toward the residual floor and the fully depreciated status", async () => {
      ids.c = await addAsset("FA-C", "MED", 12000, "2021-01-01", { opening_accumulated: 11950 });
      expect(
        await fails(
          svc(() =>
            q("update public.acc_assets set opening_accumulated = 12001 where id = $1", [ids.c]),
          ),
        ),
      ).not.toBeNull();
      const over = await prepare("depreciation", "2026-10-01", "acct", [
        { asset_id: ids.c, amount: 100 },
      ]);
      expect(hint(await fails(post(over.id, "fm", over.sha256)))).toBe("over_depreciated");
      const ok = await prepare("depreciation", "2026-10-01", "acct", [
        { asset_id: ids.c, amount: 50 },
      ]);
      expect((await post(ok.id, "fm", ok.sha256)).status).toBe("posted");
      const a = await one<{ status: string }>(
        "select status from public.acc_assets where id = $1",
        [ids.c],
      );
      expect(a.status).toBe("fully_depreciated");
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_assets set opening_accumulated = 0 where id = $1", [ids.c]),
            ),
          ),
        ),
      ).toBe("asset_in_use");
    });
  });

  describe("schedules", () => {
    const addSchedule = async (
      kind: string,
      pl: string,
      bs: string,
      total: number,
      months: number,
      autoReverse = false,
    ) => {
      const entity = (
        await one<{ id: string }>(
          "select id from public.acc_entities where org_id = $1 and is_default",
          [orgA],
        )
      ).id;
      return (
        await one<{ id: string }>(
          `insert into public.acc_schedules (org_id, entity_id, kind, description, pl_account_id, bs_account_id, total, start_month, months, auto_reverse, branch_code)
           values ($1, $2, $3, 'Synthetic schedule', $4, $5, $6, '2026-07-01', $7, $8, 'P') returning id`,
          [orgA, entity, kind, await account(pl), await account(bs), total, months, autoReverse],
        )
      ).id;
    };

    it("checks the ledgers fit the kind", async () => {
      expect(hint(await fails(addSchedule("prepayment", "6200", "2300", 1200, 12)))).toBe(
        "schedule_accounts",
      );
      expect(hint(await fails(addSchedule("deferred_revenue", "6200", "2310", 1200, 12)))).toBe(
        "schedule_accounts",
      );
    });

    it("releases prepayments and deferred revenue in one journal, then locks the schedule's figures", async () => {
      ids.prepaid = await addSchedule("prepayment", "6200", "1400", 1200, 12);
      ids.deferred = await addSchedule("deferred_revenue", "4100", "2310", 600, 6);
      const r = await prepare("schedules", "2026-07-01", "acct", [
        { schedule_id: ids.prepaid, amount: 100 },
        { schedule_id: ids.deferred, amount: 100 },
      ]);
      expect(
        hint(
          await fails(prepare("schedules", "2026-07-01", "acct", [{ asset_id: ids.a, amount: 1 }])),
        ),
      ).toBe("invalid");
      const p = await post(r.id, "fm", r.sha256);
      expect(await journalLines(p.journal_id!)).toEqual(
        expect.arrayContaining([
          { code: "6200", debit: 100, credit: 0, branch_code: "P" },
          { code: "1400", debit: 0, credit: 100, branch_code: "P" },
          { code: "2310", debit: 100, credit: 0, branch_code: "P" },
          { code: "4100", debit: 0, credit: 100, branch_code: "P" },
        ]),
      );
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_schedules set total = 2400 where id = $1", [ids.prepaid]),
            ),
          ),
        ),
      ).toBe("schedule_in_use");
      expect(
        hint(
          await fails(
            svc(() => q("delete from public.acc_schedules where id = $1", [ids.prepaid])),
          ),
        ),
      ).toBe("schedule_in_use");
    });

    it("posts a reversing accrual that acc_run_auto_reversals undoes on the 1st of the next month", async () => {
      ids.accrual = await addSchedule("accrual", "6300", "2300", 600, 6, true);
      expect(
        hint(
          await fails(
            prepare("schedules", "2026-08-01", "acct", [{ schedule_id: ids.accrual, amount: 100 }]),
          ),
        ),
      ).toBe("schedule_unknown");
      const r = await prepare("reversing_accruals", "2026-07-01", "acct", [
        { schedule_id: ids.accrual, amount: 100 },
      ]);
      const p = await post(r.id, "fm", r.sha256);
      const j = await one<{ auto_reverse_on: string; journal_date: string }>(
        "select auto_reverse_on::text, journal_date::text from public.acc_journals where id = $1",
        [p.journal_id],
      );
      expect(j).toEqual({ auto_reverse_on: "2026-08-01", journal_date: "2026-07-31" });
      expect(await balanceOf("2300")).toBe(-100);
      const rev = await one<{ r: { done: string[] } }>(
        "select public.acc_run_auto_reversals($1, '2026-08-01') as r",
        [orgA],
      );
      expect(rev.r.done).toContain(p.journal_id);
      expect(await balanceOf("2300")).toBe(0);
    });
  });

  describe("ledger start", () => {
    it("keeps a run waiting_ledger_start when the ledger refuses with that hint, and posts it later", async () => {
      await q(`create or replace function public.test_22h_ledger_start() returns trigger language plpgsql as $$
               begin
                 if new.source_kind = 'fixed_asset' then
                   raise exception 'before the ledger start' using errcode = 'check_violation', hint = 'before_ledger_start';
                 end if;
                 return new;
               end $$`);
      await q(
        "create trigger acc_journals_zz_test_ledger_start before insert on public.acc_journals for each row execute function public.test_22h_ledger_start()",
      );
      try {
        const r = await prepare("schedules", "2026-08-01", "acct", [
          { schedule_id: ids.prepaid, amount: 100 },
        ]);
        const p = await post(r.id, "fm", r.sha256);
        expect(p).toMatchObject({ status: "waiting_ledger_start", journal_id: null });
        const row = await one<{ status: string; journal_id: string | null }>(
          "select status, journal_id from public.acc_depreciation_runs where id = $1",
          [r.id],
        );
        expect(row).toEqual({ status: "waiting_ledger_start", journal_id: null });
        ids.waiting = r.id;
        ids.waitingHash = r.sha256;
      } finally {
        await q("drop trigger acc_journals_zz_test_ledger_start on public.acc_journals");
        await q("drop function public.test_22h_ledger_start()");
      }
      const p2 = await post(ids.waiting, "fm", ids.waitingHash);
      expect(p2.status).toBe("posted");
      expect(p2.journal_id).toBeTruthy();
    });
  });

  describe("who reads what", () => {
    it("lets accounting staff read, hides org A from others, and lets nobody write directly", async () => {
      await asUser(c, users.auditor, async () => {
        for (const t of [
          "acc_asset_classes",
          "acc_assets",
          "acc_schedules",
          "acc_depreciation_runs",
          "acc_asset_run_lines",
        ]) {
          const { rows } = await q(`select count(*)::int as n from public.${t} where org_id = $1`, [
            orgA,
          ]);
          expect(rows[0].n, t).toBeGreaterThan(0);
        }
        expect(
          await fails(
            q(
              "insert into public.acc_asset_classes (org_id, code, name, cost_account_id, accum_account_id, expense_account_id, disposal_account_id, life_months) values ($1, 'X', 'X', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 12)",
              [orgA],
            ),
          ),
        ).not.toBeNull();
        expect(
          (await q("update public.acc_assets set description = 'x' where org_id = $1", [orgA]))
            .rowCount,
        ).toBe(0);
      });
      for (const u of ["bob", "nobody"])
        await asUser(c, users[u], async () => {
          for (const t of [
            "acc_asset_classes",
            "acc_assets",
            "acc_schedules",
            "acc_depreciation_runs",
            "acc_asset_run_lines",
          ]) {
            const { rows } = await q(
              `select count(*)::int as n from public.${t} where org_id = $1`,
              [orgA],
            );
            expect(rows[0].n, `${u} ${t}`).toBe(0);
          }
        });
    });

    it("lets the service role alone run the functions", async () => {
      await asUser(c, users.alice, async () => {
        expect(
          hint(
            await fails(
              q(
                "select public.acc_asset_run_prepare($1, null, 'depreciation', '2026-07-01', null, '[]')",
                [orgA],
              ),
            ),
          ) ?? "denied",
        ).toBe("denied");
      });
    });
  });
});
