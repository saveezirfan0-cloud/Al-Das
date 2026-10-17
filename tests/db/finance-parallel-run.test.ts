/**
 * W4 parallel run: RLS on the manual figures and the per-area decisions (cross-org read and write fail, a role without
 * the area's own report key sees nothing, no browser writes), the constraints, the tolerance column, and who holds
 * finance.parallel_run.manage. Synthetic amounts only. Needs TEST_DATABASE_URL.
 */
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

describe.skipIf(!TEST_DATABASE_URL)("Finance parallel run (W4)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fm", "rc", "costs", "plain"])
      users[n] = await createAuthUser(c, `${n}-parallel@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);

    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Plain', '', '[\"finance.view\"]'::jsonb, false)",
        [orgA],
      );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fm", "Finance Manager");
      await member("rc", "Revenue & Collections");
      await member("costs", "Costs & Expenses");
      await member("plain", "Plain");
      for (const [org, area] of [
        [orgA, "revenue"],
        [orgA, "labs"],
        [orgA, "bank"],
        [orgA, "insurance"],
        [orgB, "revenue"],
      ])
        await q(
          "insert into public.fin_parallel_figures (org_id, area, month, manual_amount, note) values ($1, $2, '2026-09-01', 1234.567, 'synthetic')",
          [org, area],
        );
      await q(
        "insert into public.fin_parallel_decisions (org_id, area, status) values ($1, 'revenue', 'switched'), ($1, 'labs', 'running'), ($2, 'revenue', 'switched')",
        [orgA, orgB],
      );
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const areas = (
    u: string,
    table: "fin_parallel_figures" | "fin_parallel_decisions",
    org: string,
  ) =>
    asUser(c, users[u], async () => {
      const { rows } = await q(`select area from public.${table} where org_id = $1 order by area`, [
        org,
      ]);
      return rows.map((r) => r.area as string);
    });

  it("each area is read only with that area's own report key", async () => {
    for (const table of ["fin_parallel_figures", "fin_parallel_decisions"] as const) {
      const all = await areas("fm", table, orgA);
      expect(all).toEqual(
        table === "fin_parallel_figures"
          ? ["bank", "insurance", "labs", "revenue"]
          : ["labs", "revenue"],
      );
      // Revenue & Collections: revenue, bank and claims keys, no labs key
      expect(await areas("rc", table, orgA)).toEqual(all.filter((a) => a !== "labs"));
      // Costs & Expenses: labs only, no revenue
      expect(await areas("costs", table, orgA)).toEqual(all.filter((a) => a === "labs"));
      // admin sees everything
      expect(await areas("alice", table, orgA)).toEqual(all);
    }
  });

  it("a role without any of the keys sees nothing", async () => {
    expect(await areas("plain", "fin_parallel_figures", orgA)).toEqual([]);
    expect(await areas("plain", "fin_parallel_decisions", orgA)).toEqual([]);
  });

  it("never reads across orgs", async () => {
    expect(await areas("bob", "fin_parallel_figures", orgA)).toEqual([]);
    expect(await areas("bob", "fin_parallel_decisions", orgA)).toEqual([]);
    expect(await areas("fm", "fin_parallel_figures", orgB)).toEqual([]);
    expect(await areas("alice", "fin_parallel_decisions", orgB)).toEqual([]);
    expect(await areas("bob", "fin_parallel_figures", orgB)).toEqual(["revenue"]);
  });

  it("has no browser writes: not even the Finance Manager, nor across orgs", async () => {
    for (const u of ["fm", "alice", "bob"]) {
      await expect(
        asUser(c, users[u], () =>
          q(
            "insert into public.fin_parallel_figures (org_id, area, month, manual_amount) values ($1, 'collections', '2026-09-01', 1)",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asUser(c, users[u], () =>
          q(
            "insert into public.fin_parallel_decisions (org_id, area, status) values ($1, 'bank', 'switched')",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    }
    for (const u of ["fm", "alice", "bob"]) {
      const upd = await asUser(c, users[u], () =>
        q("update public.fin_parallel_figures set manual_amount = 1 where org_id = $1", [orgA]),
      );
      expect(upd.rowCount).toBe(0);
      const del = await asUser(c, users[u], () =>
        q("delete from public.fin_parallel_decisions where org_id = $1", [orgA]),
      );
      expect(del.rowCount).toBe(0);
    }
    const { rows } = await svc(() =>
      q(
        "select manual_amount::text as a from public.fin_parallel_figures where org_id = $1 and area = 'revenue'",
        [orgA],
      ),
    );
    expect(rows[0].a).toBe("1234.567");
  });

  it("keeps the money type to the fils and refuses malformed rows", async () => {
    const bad = (sql: string, re: RegExp) => expect(svc(() => q(sql, [orgA]))).rejects.toThrow(re);
    await bad(
      "insert into public.fin_parallel_figures (org_id, area, month, manual_amount) values ($1, 'revenue', '2026-08-15', 1)",
      /month_check/,
    );
    await bad(
      "insert into public.fin_parallel_figures (org_id, area, month, manual_amount) values ($1, 'payroll', '2026-08-01', 1)",
      /area_check/,
    );
    await bad(
      "insert into public.fin_parallel_figures (org_id, area, month, manual_amount) values ($1, 'revenue', '2026-09-01', 5)",
      /duplicate key/,
    );
    await bad(
      "insert into public.fin_parallel_figures (org_id, area, month, manual_amount, note) values ($1, 'collections', '2026-09-01', 1, repeat('x', 501))",
      /note_check/,
    );
    await bad(
      "insert into public.fin_parallel_decisions (org_id, area, status) values ($1, 'collections', 'done')",
      /status_check/,
    );
    const { rows } = await svc(() =>
      q(
        "insert into public.fin_parallel_figures (org_id, area, month, manual_amount) values ($1, 'collections', '2026-09-01', 0.0014) returning manual_amount::text as a",
        [orgA],
      ),
    );
    expect(rows[0].a).toBe("0.001");
  });

  it("the tolerance is a settings column with a default and a range", async () => {
    await svc(() =>
      q("insert into public.fin_ref_finance_settings (org_id) values ($1) on conflict do nothing", [
        orgA,
      ]),
    );
    const { rows } = await svc(() =>
      q(
        "select parallel_tolerance::text as t from public.fin_ref_finance_settings where org_id = $1",
        [orgA],
      ),
    );
    expect(rows[0].t).toBe("1.000");
    await expect(
      svc(() =>
        q("update public.fin_ref_finance_settings set parallel_tolerance = -1 where org_id = $1", [
          orgA,
        ]),
      ),
    ).rejects.toThrow(/parallel_tolerance/);
  });

  it("finance.parallel_run.manage belongs to the Finance Manager only (reporting separation)", () => {
    const has = (name: string) =>
      FINANCE_ROLES.find((r) => r.name === name)!.permissions.includes(
        "finance.parallel_run.manage",
      );
    expect(has("Finance Manager")).toBe(true);
    for (const n of ["Finance", "Revenue & Collections", "Costs & Expenses", "CEO", "Billing"])
      if (FINANCE_ROLES.some((r) => r.name === n)) expect(has(n), n).toBe(false);
  });

  it("the migration adds the key to an existing Finance Manager role once", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261210000300_finance_parallel_run.sql", "utf8");
    const block = /update public\.roles r[\s\S]*?;\n/.exec(sql)![0];
    await svc(async () => {
      await q(
        "update public.roles set permissions = permissions - 'finance.parallel_run.manage' where org_id = $1 and name in ('Finance Manager', 'Finance')",
        [orgA],
      );
      await q(block);
      await q(block);
    });
    const { rows } = await svc(() =>
      q(
        "select name, (select count(*)::int from jsonb_array_elements_text(permissions) p where p = 'finance.parallel_run.manage') as n from public.roles where org_id = $1 and name in ('Finance Manager', 'Finance') order by name",
        [orgA],
      ),
    );
    expect(rows).toEqual([
      { name: "Finance", n: 0 },
      { name: "Finance Manager", n: 1 },
    ]);
  });
});
