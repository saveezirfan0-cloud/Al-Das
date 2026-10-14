/**
 * Phase 20i (G13): Meta ads spend in the database. RLS on ad_insights_daily (ads.view, own org only, no browser writes), the
 * service-only replace and report functions (idempotent re-pull of the same days), and, when PostgREST is running, the daily sync
 * end to end with a fake Graph fetch: off and training workspaces make no call, a failed or unreadable pull stores nothing.
 * Nothing leaves the machine. Synthetic ids and amounts only. Runs only with TEST_DATABASE_URL.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAccount, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { ATTEMPT_MARKER, loadAdSpend, syncAdInsights } from "@/lib/integrations/meta-ads/server";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const AD_A = "120211111111111";
const AD_B = "120222222222222";
const TOKEN = "EAAB-SYNTHETIC-ADS-TOKEN";

type Row = {
  ad_id: string;
  day: string;
  ad_name?: string | null;
  campaign_name?: string | null;
  currency: string;
  spend_milli: number;
  impressions?: number;
  clicks?: number;
};

describe.skipIf(!TEST_DATABASE_URL)("phase 20i: meta ads spend (database)", () => {
  let c: Client;
  let alice: string;
  let agent: string;
  let bob: string;
  let orgA: string;
  let orgB: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const replace = (org: string, since: string, until: string, rows: Row[]) =>
    svc(
      async () =>
        (
          await q("select public.ad_insights_replace($1, $2, $3, $4::jsonb) as r", [
            org,
            since,
            until,
            JSON.stringify(rows),
          ])
        ).rows[0].r,
    );
  const stored = async (org: string) =>
    (
      await svc(() =>
        q(
          "select ad_id, to_char(day, 'YYYY-MM-DD') as day, currency, spend_milli::int, impressions::int, clicks::int, ad_name from public.ad_insights_daily where org_id = $1 order by day, ad_id",
          [org],
        ),
      )
    ).rows;
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(() =>
      q(
        "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA, agent],
      ),
    );
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("replaces a pulled range idempotently: the same pull twice gives the same rows, a re-pull overwrites the same day", async () => {
    const rows: Row[] = [
      {
        ad_id: AD_A,
        day: "2026-10-10",
        ad_name: "Synthetic A",
        currency: "AED",
        spend_milli: 10_000,
        impressions: 100,
        clicks: 4,
      },
      {
        ad_id: AD_A,
        day: "2026-10-11",
        ad_name: "Synthetic A",
        currency: "AED",
        spend_milli: 12_500,
        impressions: 120,
        clicks: 5,
      },
      {
        ad_id: AD_B,
        day: "2026-10-11",
        ad_name: "Synthetic B",
        currency: "AED",
        spend_milli: 3_000,
        impressions: 30,
        clicks: 1,
      },
    ];
    expect(await replace(orgA, "2026-10-10", "2026-10-12", rows)).toEqual({
      upserted: 3,
      removed: 0,
    });
    const first = await stored(orgA);
    expect(await replace(orgA, "2026-10-10", "2026-10-12", rows)).toEqual({
      upserted: 3,
      removed: 0,
    });
    expect(await stored(orgA)).toEqual(first);
    expect(first).toHaveLength(3);

    // Meta corrected day 11 for ad A and no longer reports ad B that day: the range becomes exactly the new answer.
    expect(
      await replace(orgA, "2026-10-11", "2026-10-12", [
        {
          ad_id: AD_A,
          day: "2026-10-11",
          ad_name: "Synthetic A (renamed)",
          currency: "AED",
          spend_milli: 13_000,
          impressions: 130,
          clicks: 6,
        },
      ]),
    ).toEqual({ upserted: 1, removed: 1 });
    expect(await stored(orgA)).toEqual([
      {
        ad_id: AD_A,
        day: "2026-10-10",
        currency: "AED",
        spend_milli: 10_000,
        impressions: 100,
        clicks: 4,
        ad_name: "Synthetic A",
      },
      {
        ad_id: AD_A,
        day: "2026-10-11",
        currency: "AED",
        spend_milli: 13_000,
        impressions: 130,
        clicks: 6,
        ad_name: "Synthetic A (renamed)",
      },
    ]);
  });

  it("never touches another organisation and refuses rows outside the range, bad ranges and malformed values", async () => {
    await replace(orgB, "2026-10-10", "2026-10-10", [
      { ad_id: AD_A, day: "2026-10-10", currency: "USD", spend_milli: 99_000 },
    ]);
    // an empty pull for org B's range does not remove org A's rows on the same days
    expect(await replace(orgB, "2026-10-10", "2026-10-12", [])).toEqual({
      upserted: 0,
      removed: 1,
    });
    expect(await stored(orgA)).toHaveLength(2);
    expect(await stored(orgB)).toHaveLength(0);

    const before = await stored(orgA);
    const call = (since: string, until: string, rows: unknown) =>
      code(
        svc(() =>
          q("select public.ad_insights_replace($1, $2, $3, $4::jsonb)", [
            orgA,
            since,
            until,
            JSON.stringify(rows),
          ]),
        ),
      );
    expect(
      await call("2026-10-10", "2026-10-11", [
        { ad_id: AD_A, day: "2026-10-12", currency: "AED", spend_milli: 1 },
      ]),
    ).toBe("22023");
    expect(await call("2026-10-12", "2026-10-10", [])).toBe("22023");
    expect(await call("2026-01-01", "2026-10-10", [])).toBe("22023");
    expect(await call("2026-10-10", "2026-10-10", {})).toBe("22023");
    expect(
      await call("2026-10-10", "2026-10-10", [
        { ad_id: "x1", day: "2026-10-10", currency: "AED", spend_milli: 1 },
      ]),
    ).toBe("23514");
    expect(
      await call("2026-10-10", "2026-10-10", [
        { ad_id: AD_A, day: "2026-10-10", currency: "aed", spend_milli: 1 },
      ]),
    ).toBe("23514");
    expect(
      await call("2026-10-10", "2026-10-10", [
        { ad_id: AD_A, day: "2026-10-10", currency: "AED", spend_milli: -1 },
      ]),
    ).toBe("23514");
    expect(
      await call("2026-10-10", "2026-10-10", [{ ad_id: AD_A, day: "2026-10-10", currency: "AED" }]),
    ).toBe("23502");
    // all or nothing: a failed call left the earlier rows exactly as they were
    expect(await stored(orgA)).toEqual(before);
  });

  it("sums spend, impressions and clicks per ad for the report (service role only)", async () => {
    const r = await svc(
      async () =>
        (await q("select public.ad_spend_report($1, '2026-10-01') as r", [orgA])).rows[0].r,
    );
    expect(r).toEqual([
      expect.objectContaining({
        ad_id: AD_A,
        currency: "AED",
        ad_name: "Synthetic A (renamed)",
        spend_milli: 23_000,
        impressions: 230,
        clicks: 10,
        days: 2,
      }),
    ]);
    const later = await svc(
      async () =>
        (await q("select public.ad_spend_report($1, '2026-10-11') as r", [orgA])).rows[0].r,
    );
    expect(later).toEqual([expect.objectContaining({ spend_milli: 13_000, days: 1 })]);
  });

  it("lets a member with ads.view read their own organisation's rows and nobody else's; no browser can write", async () => {
    const visible = (user: string) =>
      asUser(c, user, async () =>
        Number((await q("select count(*) as n from public.ad_insights_daily")).rows[0].n),
      );
    expect(await visible(alice)).toBe(2);
    expect(await visible(agent)).toBe(0); // in org A, but without ads.view
    await replace(orgB, "2026-10-10", "2026-10-10", [
      { ad_id: AD_B, day: "2026-10-10", currency: "USD", spend_milli: 5 },
    ]);
    expect(await visible(bob)).toBe(1); // org B's own row only

    for (const user of [alice, bob]) {
      await asUser(c, user, async () => {
        expect(
          await code(
            q(
              "insert into public.ad_insights_daily (org_id, ad_id, day, currency, spend_milli) values ($1, '1', '2026-10-01', 'AED', 1)",
              [orgA],
            ),
          ),
        ).toBe("42501");
        // update and delete see no row through RLS: nothing changes
        await q("update public.ad_insights_daily set spend_milli = 0");
        await q("delete from public.ad_insights_daily");
        expect(
          await code(
            q("select public.ad_insights_replace($1, '2026-10-10', '2026-10-10', '[]'::jsonb)", [
              orgA,
            ]),
          ),
        ).toBe("42501");
        expect(await code(q("select public.ad_spend_report($1, '2026-10-01')", [orgA]))).toBe(
          "42501",
        );
      });
    }
    expect((await stored(orgA)).map((r) => r.spend_milli)).toEqual([10_000, 13_000]);
    await q("set role anon");
    try {
      expect(await code(q("select public.ad_spend_report($1, '2026-10-01')", [orgA]))).toBe(
        "42501",
      );
    } finally {
      await q("reset role");
    }
  });

  it("schedules the daily pull under its own name", async () => {
    const { rows } = await q(
      "select schedule, command from cron.job where jobname = 'pulse:ads_insights_sync'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toContain("app.ping_jobs('ads_insights_sync')");
  });

  describe.skipIf(!POSTGREST_URL || !SERVICE_JWT)(
    "the daily sync through PostgREST with a fake Graph",
    () => {
      let admin: AdminClient;
      let orgC: string;
      let carol: string;
      const requests: string[] = [];
      let answer: () => Response = () => new Response("{}", { status: 500 });
      const fetchFn = (async (url: string) => {
        requests.push(String(url));
        return answer();
      }) as unknown as typeof fetch;
      const now = () => new Date("2026-10-14T04:17:00Z");
      const deps = { fetchFn, now, sleep: async () => undefined, rng: () => 0.5 };
      const insight = (adId: string, day: string, spend: string) => ({
        ad_id: adId,
        ad_name: `Synthetic ${adId}`,
        campaign_name: "Synthetic campaign",
        date_start: day,
        date_stop: day,
        spend,
        impressions: "1000",
        clicks: "25",
        account_currency: "AED",
      });
      const ok = (rows: unknown[]) => () =>
        new Response(JSON.stringify({ data: rows }), { status: 200 });

      beforeAll(async () => {
        process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
        process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
        process.env.JOB_SECRET = "test-job-secret-0123456789";
        process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
        process.env.APP_URL = "https://pulse.test";
        admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
          auth: { persistSession: false },
        }) as AdminClient;
        carol = await createAuthUser(c, "carol@example.test");
        orgC = await createOrg(c, "Org C", "org-c", carol);
        await saveSettings(admin, {
          orgId: orgC,
          kind: "meta_ads",
          provider: "meta_ads",
          secrets: { access_token: TOKEN },
          config: { ad_account_id: "act_1234567890123", lookback_days: 3, graph_version: "v21.0" },
        });
      });

      it("makes no call while the integration is off", async () => {
        requests.length = 0;
        answer = ok([insight(AD_A, "2026-10-12", "1.00")]);
        expect(await syncAdInsights(admin, deps)).toEqual({
          orgs: 0,
          synced: 0,
          rows: 0,
          failed: 0,
          skipped: 0,
          deferred: 0,
        });
        expect(requests).toHaveLength(0);
        expect(await stored(orgC)).toHaveLength(0);
      });

      it("pulls the last N complete days and stores them; a second run replaces the same days with the same rows", async () => {
        await setEnabled(admin, { orgId: orgC, kind: "meta_ads", userId: carol, enabled: true });
        requests.length = 0;
        answer = ok([
          insight(AD_A, "2026-10-11", "20.50"),
          insight(AD_A, "2026-10-13", "7.25"),
          insight(AD_B, "2026-10-13", "3"),
        ]);
        expect(await syncAdInsights(admin, deps)).toEqual({
          orgs: 1,
          synced: 1,
          rows: 3,
          failed: 0,
          skipped: 0,
          deferred: 0,
        });
        expect(requests).toHaveLength(1);
        const url = new URL(requests[0]);
        expect(url.hostname).toBe("graph.facebook.com");
        expect(url.pathname).toBe("/v21.0/act_1234567890123/insights");
        expect(url.searchParams.get("time_range")).toBe(
          JSON.stringify({ since: "2026-10-11", until: "2026-10-13" }),
        );
        expect(requests[0]).not.toContain("EAAB");
        const first = await stored(orgC);
        expect(first.map((r) => `${r.ad_id}:${r.day}:${r.spend_milli}`)).toEqual([
          `${AD_A}:2026-10-11:20500`,
          `${AD_A}:2026-10-13:7250`,
          `${AD_B}:2026-10-13:3000`,
        ]);
        expect(await syncAdInsights(admin, deps)).toMatchObject({ synced: 1, rows: 3 });
        expect(await stored(orgC)).toEqual(first);

        const spend = await loadAdSpend(admin, orgC, "2026-10-01");
        expect(spend.find((s) => s.ad_id === AD_A)).toMatchObject({
          spend_milli: 27_750,
          impressions: 2000,
          clicks: 50,
          days: 2,
        });

        // the call log names the provider and operation only: no URL, token or account id
        const calls = (
          await svc(() => q("select * from public.integration_calls where org_id = $1", [orgC]))
        ).rows;
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(
          calls.every((r) => r.provider === "meta_ads" && r.operation === "ads.insights"),
        ).toBe(true);
        expect(JSON.stringify(calls)).not.toMatch(/EAAB|1234567890123|graph\.facebook/);
        const account = await loadAccount(admin, orgC, "meta_ads");
        expect(account?.last_ok_at).toBeTruthy();
      });

      it("stores nothing when Meta refuses or sends something unreadable, and remembers a short reason", async () => {
        const before = await stored(orgC);
        answer = () =>
          new Response(
            JSON.stringify({ error: { code: 190, message: "Invalid OAuth access token." } }),
            { status: 400 },
          );
        expect(await syncAdInsights(admin, deps)).toMatchObject({ synced: 0, failed: 1 });
        answer = ok([insight(AD_A, "2026-10-13", "1.00"), { ...insight(AD_B, "2026-10-13", "x") }]);
        expect(await syncAdInsights(admin, deps)).toMatchObject({ synced: 0, failed: 1 });
        expect(await stored(orgC)).toEqual(before);
        const account = await loadAccount(admin, orgC, "meta_ads");
        expect(account?.last_error).toMatch(/insights/);
        expect(account?.last_error ?? "").not.toMatch(/EAAB|OAuth access token/);
      });

      it("makes no call for a training workspace", async () => {
        await svc(() => q("update public.orgs set is_training = true where id = $1", [orgC]));
        requests.length = 0;
        answer = ok([]);
        expect(await syncAdInsights(admin, deps)).toEqual({
          orgs: 1,
          synced: 0,
          rows: 0,
          failed: 0,
          skipped: 1,
          deferred: 0,
        });
        expect(requests).toHaveLength(0);
        await svc(() => q("update public.orgs set is_training = false where id = $1", [orgC]));
      });

      it("stops starting workspaces at the deadline and takes the one tried longest ago first; a cut-off run leaves an attempt on record", async () => {
        const dave = await createAuthUser(c, "dave@example.test");
        const orgD = await createOrg(c, "Org D", "org-d", dave);
        await saveSettings(admin, {
          orgId: orgD,
          kind: "meta_ads",
          provider: "meta_ads",
          secrets: { access_token: TOKEN },
          config: { ad_account_id: "act_9876543210987", lookback_days: 3, graph_version: "v21.0" },
        });
        await setEnabled(admin, { orgId: orgD, kind: "meta_ads", userId: dave, enabled: true });
        // org D has never been tried, org C has: D goes first, and the clock then passes the budget, so C is not started
        let t = 0;
        requests.length = 0;
        answer = () => {
          t += 41_000;
          return ok([])();
        };
        const before = await loadAccount(admin, orgC, "meta_ads");
        expect(await syncAdInsights(admin, { ...deps, clock: () => t })).toEqual({
          orgs: 1,
          synced: 1,
          rows: 0,
          failed: 0,
          skipped: 0,
          deferred: 1,
        });
        expect(requests).toHaveLength(1);
        expect(new URL(requests[0]).pathname).toBe("/v21.0/act_9876543210987/insights");
        const after = await loadAccount(admin, orgC, "meta_ads");
        expect(after?.last_error_at).toBe(before?.last_error_at); // untouched: keeps its place at the front
        expect(after?.last_ok_at).toBe(before?.last_ok_at);

        // the attempt is on record before the first request (so a run killed mid-request leaves it, and the workspace goes to the
        // back); the one tried longest ago (C) goes first now
        const seen: Array<string | null> = [];
        const probe = (async (url: string) => {
          requests.push(String(url));
          seen.push((await loadAccount(admin, orgC, "meta_ads"))?.last_error ?? null);
          return ok([])();
        }) as unknown as typeof fetch;
        requests.length = 0;
        expect(
          await syncAdInsights(admin, { ...deps, fetchFn: probe, clock: () => 0 }),
        ).toMatchObject({
          orgs: 2,
          synced: 2,
          deferred: 0,
        });
        expect(new URL(requests[0]).pathname).toBe("/v21.0/act_1234567890123/insights");
        expect(seen[0]).toBe(ATTEMPT_MARKER);
        expect((await loadAccount(admin, orgC, "meta_ads"))?.last_error).toBeNull();
        await setEnabled(admin, { orgId: orgD, kind: "meta_ads", userId: dave, enabled: false });
      });
    },
  );
});
