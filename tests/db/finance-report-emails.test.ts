/**
 * Phase G: scheduled report e-mails in the database. Who reads the schedules and runs (finance.report_emails.manage; not
 * Billing, nobody in another org), that browsers write nothing, the permission grant to Finance and Finance Manager, and
 * the claim: one run per schedule and period however often it is called, never while switched off, never for a training
 * workspace or a period of the wrong shape, and never by a signed-in user. Synthetic data only. Needs TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("Finance report e-mails (Phase G)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let flashA: string;
  let summaryA: string;
  let flashB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
  const claim = async (schedule: string, period: string) =>
    (
      await svc(() =>
        q("select public.fin_report_schedule_claim($1, $2) as id", [schedule, period]),
      )
    ).rows[0].id as string | null;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "finmgr", "billing"])
      users[n] = await createAuthUser(c, `${n}-report-emails@example.test`);
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
      await member("finmgr", "Finance Manager");
      await member("billing", "Billing");
      const schedule = async (org: string, kind: string, day: number | null, enabled = true) =>
        (
          await q(
            "insert into public.fin_report_schedules (org_id, kind, enabled, send_time, day_of_month, recipient_ids, enabled_at) values ($1, $2, $3, '07:00', $4, array[$5::uuid], case when $3 then now() end) returning id",
            [org, kind, enabled, day, users.fin],
          )
        ).rows[0].id as string;
      flashA = await schedule(orgA, "daily_flash", null);
      summaryA = await schedule(orgA, "monthly_summary", 3);
      flashB = await schedule(orgB, "daily_flash", null);
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("claims each schedule and period once, however often it is asked", async () => {
    const first = await claim(flashA, "2026-10-13");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await claim(flashA, "2026-10-13")).toBeNull();
    expect(await claim(flashA, "2026-10-13")).toBeNull();
    // another period, another schedule: new claims
    expect(await claim(flashA, "2026-10-14")).not.toBeNull();
    expect(await claim(summaryA, "2026-09")).not.toBeNull();
    const { rows } = await svc(() =>
      q(
        "select kind, period_key, status, org_id from public.fin_report_schedule_runs where schedule_id = $1 order by period_key",
        [flashA],
      ),
    );
    expect(rows).toEqual([
      { kind: "daily_flash", period_key: "2026-10-13", status: "claimed", org_id: orgA },
      { kind: "daily_flash", period_key: "2026-10-14", status: "claimed", org_id: orgA },
    ]);
  });

  it("claims nothing for a period of the wrong shape, a switched-off schedule or a training workspace", async () => {
    expect(await claim(flashA, "2026-10")).toBeNull();
    expect(await claim(summaryA, "2026-10-01")).toBeNull();
    expect(await err(claim(flashA, "2026-13-01"))).toBeNull(); // refused by the shape check, no error
    await svc(() =>
      q("update public.fin_report_schedules set enabled = false, enabled_at = null where id = $1", [
        summaryA,
      ]),
    );
    expect(await claim(summaryA, "2026-10")).toBeNull();
    await svc(() => q("update public.orgs set is_training = true where id = $1", [orgB]));
    expect(await claim(flashB, "2026-10-13")).toBeNull();
    await svc(() => q("update public.orgs set is_training = false where id = $1", [orgB]));
    expect(await claim(flashB, "2026-10-13")).not.toBeNull();
  });

  it("lets only the service role claim", async () => {
    const e = await err(
      asRole("fin", () => q("select public.fin_report_schedule_claim($1, '2026-10-20')", [flashA])),
    );
    expect(e?.code).toBe("42501");
  });

  it("keeps the schedule rules in the table (one per kind, the summary has a day, on needs a time it was switched on)", async () => {
    const dup = await err(
      svc(() =>
        q(
          "insert into public.fin_report_schedules (org_id, kind, day_of_month) values ($1, 'monthly_summary', 5)",
          [orgA],
        ),
      ),
    );
    expect(dup?.code).toBe("23505");
    const noDay = await err(
      svc(() =>
        q("update public.fin_report_schedules set day_of_month = null where id = $1", [summaryA]),
      ),
    );
    expect(noDay?.code).toBe("23514");
    const flashDay = await err(
      svc(() => q("update public.fin_report_schedules set day_of_month = 3 where id = $1", [flashA])),
    );
    expect(flashDay?.code).toBe("23514");
    const onWithoutTime = await err(
      svc(() =>
        q("update public.fin_report_schedules set enabled = true, enabled_at = null where id = $1", [
          summaryA,
        ]),
      ),
    );
    expect(onWithoutTime?.code).toBe("23514");
    const seconds = await err(
      svc(() =>
        q("update public.fin_report_schedules set send_time = '07:00:30' where id = $1", [flashA]),
      ),
    );
    expect(seconds?.code).toBe("23514");
    const tooMany = await err(
      svc(() =>
        q(
          "update public.fin_report_schedules set recipient_ids = array(select gen_random_uuid() from generate_series(1, 26)) where id = $1",
          [flashA],
        ),
      ),
    );
    expect(tooMany?.code).toBe("23514");
  });

  it("shows schedules and runs to holders of the key in their own org only, and takes no browser writes", async () => {
    const seen = async (n: string) =>
      (
        await asRole(n, async () => ({
          schedules: (await q("select org_id from public.fin_report_schedules")).rows.length,
          runs: (await q("select org_id from public.fin_report_schedule_runs")).rows.length,
        }))
      ) as { schedules: number; runs: number };
    expect(await seen("fin")).toEqual({ schedules: 2, runs: 3 });
    expect(await seen("finmgr")).toEqual({ schedules: 2, runs: 3 });
    expect(await seen("alice")).toEqual({ schedules: 2, runs: 3 });
    expect(await seen("billing")).toEqual({ schedules: 0, runs: 0 });
    expect(await seen("bob")).toEqual({ schedules: 1, runs: 1 });
    for (const sql of [
      "update public.fin_report_schedules set enabled = true",
      "delete from public.fin_report_schedule_runs",
    ]) {
      const res = await asRole("fin", () => q(sql));
      expect(res.rowCount, sql).toBe(0);
    }
    const ins = await err(
      asRole("fin", () =>
        q("insert into public.fin_report_schedules (org_id, kind) values ($1, 'daily_flash')", [
          orgA,
        ]),
      ),
    );
    expect(ins?.code).toBe("42501");
    // a run must belong to its schedule's org
    const cross = await err(
      svc(() =>
        q(
          "insert into public.fin_report_schedule_runs (org_id, schedule_id, kind, period_key) values ($1, $2, 'daily_flash', '2026-10-01')",
          [orgB, flashA],
        ),
      ),
    );
    expect(cross).not.toBeNull();
  });

  it("grants finance.report_emails.manage to the Finance and Finance Manager system roles only (idempotent), as the presets do", async () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261207000100_finance_report_emails.sql"),
      "utf8",
    );
    const grant = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(grant).toBeTruthy();
    const orgC = await svc(async () => {
      const id = (
        await q("insert into public.orgs (name, slug) values ('Org C', 'org-c-g') returning id")
      ).rows[0].id as string;
      for (const [name, system] of [
        ["Finance", true],
        ["Finance Manager", true],
        ["CEO", true],
        ["Billing", true],
        ["Finance helper", false],
      ] as const)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '[\"finance.view\"]'::jsonb, $3)",
          [id, name, system],
        );
      return id;
    });
    await svc(() => q(grant!));
    await svc(() => q(grant!));
    const { rows } = await svc(() =>
      q("select name, permissions from public.roles where org_id = $1 order by name", [orgC]),
    );
    const has = Object.fromEntries(
      rows.map((r) => [
        r.name,
        (r.permissions as string[]).filter((p) => p === "finance.report_emails.manage").length,
      ]),
    );
    expect(has).toEqual({
      Billing: 0,
      CEO: 0,
      Finance: 1,
      "Finance helper": 0,
      "Finance Manager": 1,
    });
    const preset = (n: string) => FINANCE_ROLES.find((r) => r.name === n)!.permissions;
    expect(preset("Finance")).toContain("finance.report_emails.manage");
    expect(preset("Finance Manager")).toContain("finance.report_emails.manage");
    expect(preset("Billing")).not.toContain("finance.report_emails.manage");
  });
});
