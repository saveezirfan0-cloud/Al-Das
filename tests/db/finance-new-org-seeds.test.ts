/**
 * Phase 20: a workspace created after the Phase 20 migrations gets the close checklist (20G), the starter settlement
 * rules (20C) and the approval tiers (20D) without running `pnpm finance:seed`. Synthetic data only. Needs
 * TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Phase 20 seeds for a new workspace", () => {
  let c: Client;
  let org: string;
  const count = async (table: string) =>
    Number(
      (
        await asServiceRole(c, () =>
          c.query(`select count(*)::int as n from public.${table} where org_id = $1`, [org]),
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    org = await createOrg(c, "New Clinic", "new-clinic", await createAuthUser(c, "owner-seeds@example.test"));
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("has the close checklist, the settlement rules and the approval tiers", async () => {
    expect(await count("fin_close_steps")).toBeGreaterThan(0);
    expect(await count("fin_ref_settlement_rules")).toBe(7);
    expect(await count("fin_ref_approval_tiers")).toBeGreaterThan(0);
  });

  it("re-running the seeds adds nothing", async () => {
    const steps = await count("fin_close_steps");
    await asServiceRole(c, async () => {
      await c.query("select public.fin_close_seed_steps($1)", [org]);
      await c.query("select public.fin_seed_settlement_rules($1)", [org]);
    });
    expect(await count("fin_close_steps")).toBe(steps);
    expect(await count("fin_ref_settlement_rules")).toBe(7);
  });
});
