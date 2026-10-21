/**
 * docs/51 group pack: who holds finance.group_pack.export, and the migration that grants it to an existing Finance
 * Manager role exactly once. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Finance group pack key (docs/51)", () => {
  let c: Client;
  let org: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const owner = await createAuthUser(c, "owner-grouppack@example.test");
    org = await createOrg(c, "Org G", "org-g", owner);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [org, r.name, r.description, JSON.stringify(r.permissions)],
        );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("belongs to the Finance Manager only (reporting separation)", () => {
    const has = (name: string) =>
      FINANCE_ROLES.find((r) => r.name === name)!.permissions.includes("finance.group_pack.export");
    expect(has("Finance Manager")).toBe(true);
    for (const n of [
      "Finance",
      "Revenue & Collections",
      "Costs & Expenses",
      "CEO",
      "Billing",
      "Insurance",
    ])
      if (FINANCE_ROLES.some((r) => r.name === n)) expect(has(n), n).toBe(false);
  });

  it("the migration adds the key to an existing Finance Manager role once", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/20261225000100_finance_group_pack_key.sql",
      "utf8",
    );
    const block = /update public\.roles r[\s\S]*?;\n/.exec(sql)![0];
    await svc(async () => {
      await q(
        "update public.roles set permissions = permissions - 'finance.group_pack.export' where org_id = $1 and name in ('Finance Manager', 'Finance')",
        [org],
      );
      await q(block);
      await q(block);
    });
    const { rows } = await svc(() =>
      q(
        "select name, (select count(*)::int from jsonb_array_elements_text(permissions) p where p = 'finance.group_pack.export') as n from public.roles where org_id = $1 and name in ('Finance Manager', 'Finance') order by name",
        [org],
      ),
    );
    expect(rows).toEqual([
      { name: "Finance", n: 0 },
      { name: "Finance Manager", n: 1 },
    ]);
  });
});
