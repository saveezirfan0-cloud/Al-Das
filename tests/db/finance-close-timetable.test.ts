/**
 * Phase 20G: the close timetable's SQL. Who reads steps, tasks and holidays (and nobody writes them directly), that the
 * functions are service-role only, the seed and the month generation are idempotent, a blocked step needs its
 * dependency, only the owner or backup marks a step (unless the server says the caller manages the close), a locked
 * month's timetable never changes, and the reminder claim never notifies twice. Synthetic data only. Needs
 * TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

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
const AUG = "2026-08-01";
const FUNCTIONS = [
  "fin_close_claim_reminders",
  "fin_close_generate_tasks",
  "fin_close_seed_steps",
  "fin_close_set_task_status",
];

describe.skipIf(!TEST_DATABASE_URL)("Finance close timetable (Phase 20G)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const generate = (org: string, month: string) =>
    svc(async () =>
      Number(
        (await q("select public.fin_close_generate_tasks($1, $2) as n", [org, month])).rows[0].n,
      ),
    );
  const taskId = (org: string, month: string, code: string) =>
    svc(
      async () =>
        (
          await q(
            "select id::text from public.fin_close_tasks where org_id = $1 and month = $2 and step_code = $3",
            [org, month, code],
          )
        ).rows[0]?.id as string,
    );
  const setStatus = (
    task: string,
    user: string,
    status: string,
    reason = "",
    any = false,
    org = orgA,
  ) =>
    svc(() =>
      q("select public.fin_close_set_task_status($1, $2, $3, $4, $5, '', $6) as r", [
        org,
        task,
        user,
        status,
        reason,
        any,
      ]),
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "ceo", "md", "billing", "owner", "backup", "other"])
      users[n] = await createAuthUser(c, `${n}-close@example.test`);
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
      await member("ceo", "CEO");
      await member("md", "Medical Director");
      await member("billing", "Billing");
      await member("owner", "Insurance");
      await member("backup", "Insurance");
      await member("other", "Insurance");
      for (const org of [orgA, orgB]) {
        await q(
          "insert into public.fin_ref_holidays (org_id, holiday_on, name) values ($1, '2026-12-02', 'National Day')",
          [org],
        );
      }
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("seed and generation", () => {
    it("seeds the standard steps once, without owners, and never overwrites an edited step", async () => {
      const seed = (org: string) =>
        svc(async () =>
          Number((await q("select public.fin_close_seed_steps($1) as n", [org])).rows[0].n),
        );
      expect(await seed(orgA)).toBe(10);
      expect(await seed(orgB)).toBe(10);
      await svc(() =>
        q(
          "update public.fin_close_steps set title = 'Bank reconciled (edited)', owner_user_id = $2, backup_user_id = $3 where org_id = $1 and code = 'BANK_CASH'",
          [orgA, users.owner, users.backup],
        ),
      );
      expect(await seed(orgA)).toBe(0);
      const { rows } = await svc(() =>
        q(
          "select code, title, owner_user_id, due_wd, depends_on from public.fin_close_steps where org_id = $1 order by sort_order",
          [orgA],
        ),
      );
      expect(rows.map((r) => r.code)).toEqual([
        "INS_SUBMISSIONS",
        "DILIGENCE_REC",
        "REVENUE_UNITE",
        "BANK_CASH",
        "SUPPLIER_INVOICES",
        "HR_INPUTS",
        "LAB_REFERRALS",
        "REVENUE_SHARES",
        "TALLY_CLOSE",
        "DRAFT_ACCOUNTS",
      ]);
      expect(rows.find((r) => r.code === "BANK_CASH")!.title).toBe("Bank reconciled (edited)");
      expect(
        rows.filter((r) => r.code !== "BANK_CASH").every((r) => r.owner_user_id === null),
      ).toBe(true);
      expect(rows.find((r) => r.code === "DRAFT_ACCOUNTS")).toMatchObject({
        due_wd: 8,
        depends_on: ["TALLY_CLOSE", "REVENUE_SHARES", "DILIGENCE_REC"],
      });
    });

    it("makes a month's tasks once from the active steps, copying the due day", async () => {
      await svc(() =>
        q(
          "update public.fin_close_steps set active = false where org_id = $1 and code = 'LAB_REFERRALS'",
          [orgA],
        ),
      );
      expect(await generate(orgA, SEPT)).toBe(9);
      expect(await generate(orgA, SEPT)).toBe(0);
      // a step added (or re-activated) later joins the month; a changed due day does not rewrite existing tasks
      await svc(() =>
        q(
          "update public.fin_close_steps set active = true where org_id = $1 and code = 'LAB_REFERRALS'",
          [orgA],
        ),
      );
      await svc(() =>
        q("update public.fin_close_steps set due_wd = 3 where org_id = $1 and code = 'BANK_CASH'", [
          orgA,
        ]),
      );
      expect(await generate(orgA, SEPT)).toBe(1);
      const { rows } = await svc(() =>
        q(
          "select due_wd from public.fin_close_tasks where org_id = $1 and month = $2 and step_code = 'BANK_CASH'",
          [orgA, SEPT],
        ),
      );
      expect(rows[0].due_wd).toBe(5);
      await expect(generate(orgA, "2026-09-02")).rejects.toThrow(/first day/);
    });

    it("the steps of a task cannot be deleted, and a task cannot move to another month", async () => {
      await expect(
        svc(() =>
          q("delete from public.fin_close_steps where org_id = $1 and code = 'BANK_CASH'", [orgA]),
        ),
      ).rejects.toMatchObject({ code: "23503" });
      const id = await taskId(orgA, SEPT, "BANK_CASH");
      await expect(
        svc(() => q("update public.fin_close_tasks set month = '2026-10-01' where id = $1", [id])),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("access", () => {
    const visible = async (who: string) =>
      asRole(who, async () => ({
        steps: Number((await q("select count(*)::int as n from public.fin_close_steps")).rows[0].n),
        tasks: Number((await q("select count(*)::int as n from public.fin_close_tasks")).rows[0].n),
        holidays: Number(
          (await q("select count(*)::int as n from public.fin_ref_holidays")).rows[0].n,
        ),
      }));

    it("Finance, the CEO and step owners (Billing, Insurance) read their own org's timetable only", async () => {
      for (const who of ["fin", "ceo", "billing", "owner", "alice"])
        expect(await visible(who), who).toEqual({ steps: 10, tasks: 10, holidays: 1 });
    });

    it("the Medical Director and another org's admin see nothing", async () => {
      expect(await visible("md")).toEqual({ steps: 0, tasks: 0, holidays: 0 });
      expect(await visible("bob")).toEqual({ steps: 10, tasks: 0, holidays: 1 }); // org B's own seed only
      const leaked = await asRole("bob", async () =>
        Number(
          (
            await q("select count(*)::int as n from public.fin_close_steps where org_id = $1", [
              orgA,
            ])
          ).rows[0].n,
        ),
      );
      expect(leaked).toBe(0);
    });

    it("nobody writes the timetable directly, not even Finance or an admin", async () => {
      for (const who of ["fin", "alice"]) {
        await expect(
          asRole(who, () =>
            q(
              "insert into public.fin_ref_holidays (org_id, holiday_on, name) values ($1, '2026-12-25', 'X')",
              [orgA],
            ),
          ),
        ).rejects.toMatchObject({ code: "42501" });
        const upd = await asRole(who, () =>
          q(
            "update public.fin_close_tasks set status = 'done', done_at = now() where org_id = $1",
            [orgA],
          ),
        );
        expect(upd.rowCount).toBe(0);
        const upd2 = await asRole(who, () =>
          q("update public.fin_close_steps set owner_user_id = null where org_id = $1", [orgA]),
        );
        expect(upd2.rowCount).toBe(0);
      }
    });

    it("the functions run for the service role only", async () => {
      const { rows } = await q(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1) order by 1`,
        [FUNCTIONS],
      );
      expect(rows).toEqual(
        FUNCTIONS.map((name) => ({ name, anon: false, auth: false, svc: true })),
      );
    });
  });

  describe("marking steps", () => {
    it("a blocked step must name what it waits for (function and table both refuse)", async () => {
      const id = await taskId(orgA, SEPT, "BANK_CASH");
      await expect(setStatus(id, users.owner, "blocked", "   ")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(
        svc(() =>
          q(
            "update public.fin_close_tasks set status = 'blocked', blocked_reason = null where id = $1",
            [id],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await setStatus(id, users.owner, "blocked", "Bank statement not received");
      const { rows } = await svc(() =>
        q("select status, blocked_reason from public.fin_close_tasks where id = $1", [id]),
      );
      expect(rows[0]).toEqual({ status: "blocked", blocked_reason: "Bank statement not received" });
    });

    it("only the owner or backup marks a step, unless the server says the caller manages the close", async () => {
      const bank = await taskId(orgA, SEPT, "BANK_CASH");
      const ins = await taskId(orgA, SEPT, "INS_SUBMISSIONS"); // no owner
      await expect(setStatus(bank, users.other, "done")).rejects.toMatchObject({ code: "42501" });
      await expect(setStatus(ins, users.owner, "done")).rejects.toMatchObject({ code: "42501" });
      await setStatus(bank, users.backup, "done");
      const { rows } = await svc(() =>
        q(
          "select status, blocked_reason, done_by, done_at is not null as done from public.fin_close_tasks where id = $1",
          [bank],
        ),
      );
      expect(rows[0]).toEqual({
        status: "done",
        blocked_reason: null,
        done_by: users.backup,
        done: true,
      });
      // marking done again keeps the first person and time
      await setStatus(bank, users.owner, "done");
      expect(
        (await svc(() => q("select done_by from public.fin_close_tasks where id = $1", [bank])))
          .rows[0].done_by,
      ).toBe(users.backup);
      await setStatus(ins, users.fin, "done", "", true);
      await setStatus(ins, users.fin, "open", "", true);
      const reopened = await svc(() =>
        q("select status, done_by, done_at from public.fin_close_tasks where id = $1", [ins]),
      );
      expect(reopened.rows[0]).toEqual({ status: "open", done_by: null, done_at: null });
    });

    it("another org's task is not found", async () => {
      const bank = await taskId(orgA, SEPT, "BANK_CASH");
      await expect(setStatus(bank, users.bob, "open", "", true, orgB)).rejects.toMatchObject({
        code: "P0002",
      });
    });
  });

  describe("reminders", () => {
    const claim = (ids: string[], today: string, org = orgA) =>
      svc(
        async () =>
          (
            await q(
              "select task_id::text, owner_user_id::text from public.fin_close_claim_reminders($1, $2::uuid[], $3) order by 1",
              [org, ids, today],
            )
          ).rows,
      );

    it("claims each unfinished task once a day; a retry claims nothing; done tasks and other orgs never", async () => {
      const bank = await taskId(orgA, SEPT, "BANK_CASH"); // done
      const rev = await taskId(orgA, SEPT, "REVENUE_UNITE"); // open, no owner
      await svc(() =>
        q(
          "update public.fin_close_steps set owner_user_id = $2 where org_id = $1 and code = 'HR_INPUTS'",
          [orgA, users.owner],
        ),
      );
      const hr = await taskId(orgA, SEPT, "HR_INPUTS");
      const first = await claim([bank, rev, hr], "2026-10-07");
      expect(first).toEqual(
        [
          { task_id: rev, owner_user_id: null },
          { task_id: hr, owner_user_id: users.owner },
        ].sort((a, b) => a.task_id.localeCompare(b.task_id)),
      );
      expect(await claim([bank, rev, hr], "2026-10-07")).toEqual([]);
      expect(await claim([rev], "2026-10-08")).toHaveLength(1);
      expect(await claim([hr], "2026-10-08", orgB)).toEqual([]);
    });
  });

  describe("permission migration", () => {
    it("grants finance.close.tasks to Finance, Billing, Insurance and Cost / Payroll once, and to nobody else", async () => {
      const sql = fs.readFileSync(
        path.join(
          __dirname,
          "../../supabase/migrations/20261029000100_finance_close_timetable.sql",
        ),
        "utf8",
      );
      const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
      expect(block, "the grant block was not found").toBeTruthy();
      const orgC = await svc(async () => {
        const id = (
          await q(
            "insert into public.orgs (name, slug) values ('Org C', 'org-c-close') returning id",
          )
        ).rows[0].id as string;
        for (const name of [
          "Finance",
          "Billing",
          "Insurance",
          "Cost / Payroll",
          "CEO",
          "Medical Director",
        ])
          await q(
            `insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '["finance.view"]'::jsonb, true)`,
            [id, name],
          );
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Billing team', '', '[]'::jsonb, false)",
          [id],
        );
        return id;
      });
      const read = async (): Promise<Record<string, string[]>> =>
        Object.fromEntries(
          (
            await svc(() =>
              q("select name, permissions from public.roles where org_id = $1", [orgC]),
            )
          ).rows.map((r) => [r.name, r.permissions as string[]]),
        );
      await svc(() => q(block!));
      await svc(() => q(block!));
      const roles = await read();
      for (const name of ["Finance", "Billing", "Insurance", "Cost / Payroll"])
        expect(roles[name], name).toEqual(["finance.view", "finance.close.tasks"]);
      for (const name of ["CEO", "Medical Director", "Billing team"])
        expect(roles[name], name).not.toContain("finance.close.tasks");
    });
  });

  describe("a locked month", () => {
    it("keeps its timetable: no new tasks, no status change, no reminder", async () => {
      expect(await generate(orgA, AUG)).toBe(10);
      const hr = await taskId(orgA, AUG, "HR_INPUTS");
      await svc(async () => {
        await q(
          `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_by, finance_signed_at)
           values ($1, $2, 'finance_signed', '{"m":1}'::jsonb, encode(sha256(convert_to('{"m": 1}', 'UTF8')), 'hex'), now(), $3, now())`,
          [orgA, AUG, users.fin],
        );
        await q(
          "update public.fin_period_closes set status = 'locked', ceo_signed_by = $3, ceo_signed_at = now(), locked_at = now() where org_id = $1 and month = $2",
          [orgA, AUG, users.ceo],
        );
      });
      expect(await generate(orgA, AUG)).toBe(0);
      await expect(setStatus(hr, users.fin, "done", "", true)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        svc(() => q("delete from public.fin_close_tasks where id = $1", [hr])),
      ).rejects.toMatchObject({
        code: "42501",
      });
      expect(await claim([hr], "2026-09-14")).toEqual([]);
      async function claim(ids: string[], today: string) {
        return svc(
          async () =>
            (
              await q("select * from public.fin_close_claim_reminders($1, $2::uuid[], $3)", [
                orgA,
                ids,
                today,
              ])
            ).rows,
        );
      }
    });
  });
});
