/**
 * Phase 20: the Finance Manager role in an existing workspace gains every key its org's Finance role holds (later Phase 20
 * migrations grant to "Finance" only). Additive, idempotent, per org. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const SQL = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20261102000100_finance_manager_sync.sql"),
  "utf8",
);

describe.skipIf(!TEST_DATABASE_URL)("Finance Manager keeps up with Finance", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const perms = async (org: string, name: string) =>
    (
      await asServiceRole(c, () =>
        c.query("select permissions from public.roles where org_id = $1 and name = $2", [org, name]),
      )
    ).rows[0].permissions as string[];
  const setRole = (org: string, name: string, p: string[]) =>
    asServiceRole(c, () =>
      c.query(
        `insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, 'x', $3::jsonb, true)
         on conflict (org_id, name) do update set permissions = excluded.permissions`,
        [org, name, JSON.stringify(p)],
      ),
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    orgA = await createOrg(c, "Org A", "org-a", await createAuthUser(c, "a-fms@example.test"));
    orgB = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "b-fms@example.test"));
    await setRole(orgA, "Finance", ["finance.view", "finance.bank.view", "finance.followup.manage"]);
    await setRole(orgA, "Finance Manager", ["finance.view", "finance.vouchers.check"]);
    await setRole(orgB, "Finance", ["finance.view"]);
    await setRole(orgB, "Finance Manager", ["finance.vouchers.check", "finance.vouchers.settings"]);
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("adds the missing Finance keys, keeps the checker's own keys, and only within the same org", async () => {
    await asServiceRole(c, () => c.query(SQL));
    expect((await perms(orgA, "Finance Manager")).sort()).toEqual(
      ["finance.bank.view", "finance.followup.manage", "finance.view", "finance.vouchers.check"].sort(),
    );
    expect((await perms(orgB, "Finance Manager")).sort()).toEqual(
      ["finance.view", "finance.vouchers.check", "finance.vouchers.settings"].sort(),
    );
    expect((await perms(orgA, "Finance")).sort()).toEqual(
      ["finance.bank.view", "finance.followup.manage", "finance.view"].sort(),
    );
  });

  it("is idempotent", async () => {
    const before = await perms(orgA, "Finance Manager");
    await asServiceRole(c, () => c.query(SQL));
    expect(await perms(orgA, "Finance Manager")).toEqual(before);
  });
});
