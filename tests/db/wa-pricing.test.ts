/** wa_pricing_daily (20261012000200): access rules and the cost report SQL. Synthetic figures only. */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, asUser, connect, count, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("WhatsApp pricing data", () => {
  let c: Client;
  let alice: string; // admin A (reports.view via *)
  let agent: string; // member of A without reports.view
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const role = (await c.query("select id from public.roles where org_id = $1 and name = 'Agent'", [orgA])).rows[0].id;
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [orgA, agent, role]);
      const row = (org: string, waba: string, day: string, cat: string, vol: number, cost: number) =>
        c.query("insert into public.wa_pricing_daily (org_id, waba_id, day, category, pricing_type, country, volume, cost, currency) values ($1, $2, $3, $4, 'REGULAR', 'AE', $5, $6, 'USD')", [org, waba, day, cat, vol, cost]);
      await row(orgA, "w1", "2026-10-05", "MARKETING", 10, 1.5);
      await row(orgA, "w1", "2026-10-05", "UTILITY", 4, 0.2);
      await row(orgA, "w2", "2026-10-05", "MARKETING", 5, 0.75); // a second WABA in the same org adds up
      await row(orgA, "w1", "2026-10-06", "MARKETING", 2, 0.3);
      await row(orgA, "w1", "2026-09-01", "MARKETING", 99, 99); // outside the period
      await row(orgB, "wb", "2026-10-05", "MARKETING", 7, 7);
    });
  });
  afterAll(async () => {
    await c.end();
  });

  it("is readable with reports.view in the member's own org only", async () => {
    await asUser(c, alice, async () => expect(await count(c, "select 1 from public.wa_pricing_daily")).toBe(5));
    await asUser(c, agent, async () => expect(await count(c, "select 1 from public.wa_pricing_daily")).toBe(0));
    await asUser(c, bob, async () => expect(await count(c, "select 1 from public.wa_pricing_daily")).toBe(1));
  });

  it("cannot be written by signed-in users", async () => {
    await asUser(c, alice, async () => {
      await expect(
        c.query("insert into public.wa_pricing_daily (org_id, waba_id, day, category, pricing_type, country, volume, cost, currency) values ($1, 'w', '2026-10-07', 'X', 'Y', 'AE', 1, 1, 'USD')", [orgA]),
      ).rejects.toThrow(/row-level security|permission denied/);
    });
  });

  it("sums cost per day and category across WABAs, for the period and org asked for", async () => {
    await asServiceRole(c, async () => {
      const r = (await c.query("select day::text, category, currency, volume, cost::float8 as cost from public.report_wa_cost_by_day($1, '2026-10-01', '2026-10-31')", [orgA])).rows;
      expect(r).toEqual([
        { day: "2026-10-05", category: "MARKETING", currency: "USD", volume: 15, cost: 2.25 },
        { day: "2026-10-05", category: "UTILITY", currency: "USD", volume: 4, cost: 0.2 },
        { day: "2026-10-06", category: "MARKETING", currency: "USD", volume: 2, cost: 0.3 },
      ]);
    });
  });

  it("keeps the report function and view away from signed-in users", async () => {
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.report_wa_cost_by_day($1, '2026-10-01', '2026-10-31')", [orgA])).rejects.toThrow(/permission denied/);
    });
    await asUser(c, alice, async () => {
      await expect(c.query("select * from public.v_wa_cost_daily")).rejects.toThrow(/permission denied/);
    });
  });
});
