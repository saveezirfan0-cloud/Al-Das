/**
 * Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md), database side: security_alerts accepts the new
 * 'finance_access_denied' kind (service role only), still refuses unknown kinds, dedupes per (org, key), and the alert
 * is visible to the org's settings.manage holders only. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { financeAccessAlert } from "@/lib/security/finance-access";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("finance access window: security alert kind", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const insert = (org: string, kind: string, key: string, userId: string | null) =>
    c.query(
      `insert into public.security_alerts (org_id, kind, user_id, dedupe_key, summary, detail)
       values ($1, $2, $3, $4, 'Finance access refused', '{"reason":"outside_hours"}'::jsonb)
       on conflict (org_id, dedupe_key) do nothing`,
      [org, kind, userId, key],
    );

  it("accepts the new kind with the draft's own dedupe key, once per member per day", async () => {
    const draft = financeAccessAlert({
      userId: alice,
      reason: "outside_hours",
      now: new Date("2026-10-12T20:00:00Z"),
      timeZone: "Asia/Dubai",
      network: "203.0.113.0/24",
      ipHash: null,
    });
    expect(draft.dedupeKey.length).toBeLessThanOrEqual(200);
    expect(draft.summary.length).toBeLessThanOrEqual(300);
    await asServiceRole(c, async () => {
      await insert(orgA, draft.kind, draft.dedupeKey, alice);
      await insert(orgA, draft.kind, draft.dedupeKey, alice);
    });
    expect(
      await count(
        c,
        "select 1 from public.security_alerts where org_id = $1 and kind = 'finance_access_denied'",
        [orgA],
      ),
    ).toBe(1);
  });

  /** Runs one insert as the given role inside a throw-away transaction; returns the error code, or null. */
  async function failsAs(
    role: "service" | string,
    kind: string,
    key: string,
  ): Promise<string | null> {
    await c.query("begin");
    try {
      if (role === "service") await c.query("set local role service_role");
      else {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: role, role: "authenticated" }),
        ]);
      }
      await insert(orgA, kind, key, null);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? "unknown";
    } finally {
      await c.query("rollback");
    }
  }

  it("still refuses an unknown kind", async () => {
    expect(await failsAs("service", "not_a_kind", "x-1")).toBe("23514");
  });

  it("is readable by the org's own admin and never by another org's", async () => {
    const sql = "select 1 from public.security_alerts where kind = 'finance_access_denied'";
    expect(await asUser(c, alice, () => count(c, sql))).toBe(1);
    expect(await asUser(c, bob, () => count(c, sql))).toBe(0);
  });

  it("cannot be written by a signed-in user, even the org's admin", async () => {
    expect(await failsAs(alice, "finance_access_denied", "x-2")).toBe("42501");
    expect(await failsAs(bob, "finance_access_denied", "x-3")).toBe("42501");
    expect(orgB).toBeTruthy();
  });
});
