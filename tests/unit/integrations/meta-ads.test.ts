/**
 * Phase 20i (G13): Meta ads spend. The adapter is driven by a fake fetch with responses written from Meta's documentation; nothing
 * here reaches Meta (tests/setup.ts makes any fetch to graph.facebook.com throw, and the first test proves it). Synthetic ids only.
 */
import { describe, expect, it } from "vitest";

import {
  allFields,
  integrationDef,
  needsConfirmation,
  validateFields,
} from "@/lib/integrations/catalog";
import type { CallRecord } from "@/lib/integrations/client";
import { CALL_PROVIDERS } from "@/lib/integrations/health";
import { confirmationMatches, readinessProblems } from "@/lib/integrations/readiness";
import { createMetaAdsClient, insightsUrl } from "@/lib/integrations/meta-ads/client";
import { normalizeAdAccountId, readMetaAdsConfig } from "@/lib/integrations/meta-ads/config";
import {
  adIdOf,
  costPerMilli,
  formatMilli,
  mergeAdPerformance,
  totalsByCurrency,
  type AttributionCounts,
  type SpendTotals,
} from "@/lib/integrations/meta-ads/cost";
import {
  cleanName,
  hasDuplicateDays,
  INSIGHT_FIELDS,
  insightsRange,
  isIsoDay,
  parseCount,
  parseInsightsPage,
  parseSpendMilli,
} from "@/lib/integrations/meta-ads/insights";

const TOKEN = "EAAB-SYNTHETIC-ADS-READ-TOKEN";
const ACCOUNT = "1234567890123";
const RANGE = { since: "2026-10-07", until: "2026-10-13" };

describe("the test setup", () => {
  it("blocks every real call to Meta's Graph host", () => {
    expect(() => fetch(`https://graph.facebook.com/v21.0/act_${ACCOUNT}/insights`)).toThrow(/Meta/);
  });
});

describe("catalogue entry", () => {
  const def = integrationDef("meta_ads");

  it("is a read-only pull: no typed words, no patient contact, no money, no shared data", () => {
    expect(def.outbound).toBe(true);
    expect(def.contactsPatients).toBe(false);
    expect(def.movesMoney).toBe(false);
    expect(def.sharesData).toBe(false);
    expect(def.confirmWord).toBeNull();
    expect(needsConfirmation("meta_ads")).toBe(false);
    expect(confirmationMatches("meta_ads", "")).toBe(true);
    expect(def.viewPermission).toBe("integrations.manage");
    expect(CALL_PROVIDERS.meta_ads).toEqual(["meta_ads"]);
  });

  it("keeps the token encrypted and validates the ad account id", () => {
    const fields = allFields("meta_ads", "meta_ads");
    expect(fields.filter((f) => f.secret).map((f) => f.key)).toEqual(["access_token"]);
    const ok = validateFields(fields, {
      ad_account_id: `act_${ACCOUNT}`,
      access_token: TOKEN,
      lookback_days: "",
    });
    expect(ok).toEqual({
      ok: true,
      secrets: { access_token: TOKEN },
      config: { ad_account_id: `act_${ACCOUNT}`, lookback_days: 7, graph_version: "" },
    });
    for (const bad of ["act_12", "12345abc", "act-1234567", "1234567890123456789012345678"])
      expect(validateFields(fields, { ad_account_id: bad, access_token: TOKEN }).ok, bad).toBe(
        false,
      );
    expect(
      validateFields(fields, { ad_account_id: ACCOUNT, access_token: TOKEN, lookback_days: 29 }).ok,
    ).toBe(false);
  });

  it("cannot be switched on before the ad account id and token are saved", () => {
    expect(
      readinessProblems({
        kind: "meta_ads",
        provider: "meta_ads",
        config: {},
        secretsStored: { access_token: false },
      }),
    ).toEqual(["Ad account ID is missing.", "Access token is missing."]);
    expect(
      readinessProblems({
        kind: "meta_ads",
        provider: "meta_ads",
        config: { ad_account_id: ACCOUNT, lookback_days: 7 },
        secretsStored: { access_token: true },
      }),
    ).toEqual([]);
  });
});

describe("config", () => {
  it("normalises the ad account id to digits and bounds the look-back", () => {
    expect(normalizeAdAccountId(`act_${ACCOUNT}`)).toBe(ACCOUNT);
    expect(normalizeAdAccountId(` ${ACCOUNT} `)).toBe(ACCOUNT);
    for (const bad of ["", "act_", "act_12", "x1234567", null, undefined, "act_123/../me"])
      expect(normalizeAdAccountId(bad), String(bad)).toBe("");
    expect(readMetaAdsConfig({ ad_account_id: ACCOUNT })).toEqual({
      adAccountId: ACCOUNT,
      lookbackDays: 7,
      graphVersion: null,
    });
    expect(readMetaAdsConfig({ lookback_days: 28, graph_version: "v21.0" })).toMatchObject({
      lookbackDays: 28,
      graphVersion: "v21.0",
    });
    expect(readMetaAdsConfig({ lookback_days: 0 }).lookbackDays).toBe(7);
    expect(readMetaAdsConfig({ lookback_days: 90 }).lookbackDays).toBe(7);
    expect(readMetaAdsConfig({ graph_version: "v21/../x" }).graphVersion).toBeNull();
  });
});

describe("pure insight parsing", () => {
  it("reads the N complete days before today (UTC)", () => {
    expect(insightsRange(new Date("2026-10-14T04:17:00Z"), 7)).toEqual(RANGE);
    expect(insightsRange(new Date("2026-10-14T23:59:59Z"), 1)).toEqual({
      since: "2026-10-13",
      until: "2026-10-13",
    });
    expect(insightsRange(new Date("2026-03-01T00:00:00Z"), 2)).toEqual({
      since: "2026-02-27",
      until: "2026-02-28",
    });
  });

  it("turns spend into exact thousandths, refusing anything that is not a plain non-negative amount", () => {
    expect(parseSpendMilli("12.34")).toBe(12_340);
    expect(parseSpendMilli("0")).toBe(0);
    expect(parseSpendMilli("0.001")).toBe(1);
    expect(parseSpendMilli("1.2345")).toBe(1_235); // half up on the fourth decimal
    expect(parseSpendMilli("1.2344")).toBe(1_234);
    expect(parseSpendMilli("7.125")).toBe(7_125); // KWD, BHD, OMR have three decimals
    expect(parseSpendMilli(" 100 ")).toBe(100_000);
    expect(parseSpendMilli(0.1 + 0.2)).toBe(300);
    expect(parseSpendMilli("999999999999.999")).toBe(999_999_999_999_999);
    for (const bad of [
      "-1",
      "1e3",
      "",
      "1,000.00",
      "abc",
      "1.",
      ".5",
      "1000000000000",
      -2,
      NaN,
      null,
      {},
    ])
      expect(parseSpendMilli(bad), String(bad)).toBeNull();
  });

  it("reads counts and cleans names", () => {
    expect(parseCount("1234")).toBe(1234);
    expect(parseCount(undefined)).toBe(0);
    expect(parseCount(5)).toBe(5);
    for (const bad of ["-1", "1.5", "x", 1.5, -3]) expect(parseCount(bad), String(bad)).toBeNull();
    expect(cleanName("  Spring\ncheck-up  ")).toBe("Spring check-up");
    expect(cleanName("x".repeat(300))).toHaveLength(200);
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("2028-02-29")).toBe(true);
  });

  const row = (over: Record<string, unknown> = {}) => ({
    ad_id: "120211111111111",
    ad_name: "Synthetic ad A",
    campaign_name: "Synthetic campaign",
    date_start: "2026-10-12",
    date_stop: "2026-10-12",
    spend: "45.50",
    impressions: "3200",
    clicks: "41",
    account_currency: "AED",
    ...over,
  });

  it("reads only the listed keys of a page and follows the cursor only when Graph says there is a next page", () => {
    const parsed = parseInsightsPage(
      {
        data: [row({ actions: [{ action_type: "x" }], cpc: "1.1", ad_body: "NOT STORED" })],
        paging: { cursors: { before: "QVFIUm", after: "QVFIUnext" }, next: "https://graph…" },
      },
      RANGE,
    );
    expect(parsed).toEqual({
      ok: true,
      after: "QVFIUnext",
      rows: [
        {
          ad_id: "120211111111111",
          day: "2026-10-12",
          ad_name: "Synthetic ad A",
          campaign_name: "Synthetic campaign",
          currency: "AED",
          spend_milli: 45_500,
          impressions: 3200,
          clicks: 41,
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/NOT STORED|action_type|cpc/);
    // a cursor without `next` is the last page
    expect(parseInsightsPage({ data: [], paging: { cursors: { after: "QVFIU" } } }, RANGE)).toEqual(
      { ok: true, rows: [], after: null },
    );
    expect(parseInsightsPage({ data: [] }, RANGE)).toEqual({ ok: true, rows: [], after: null });
  });

  it("fails the whole page closed on anything it cannot read", () => {
    expect(parseInsightsPage(null, RANGE)).toEqual({ ok: false, code: "bad_page" });
    expect(parseInsightsPage({ data: "x" }, RANGE)).toEqual({ ok: false, code: "bad_page" });
    for (const bad of [
      { ad_id: "" },
      { ad_id: "12ab" },
      { date_start: "12/10/2026" },
      { account_currency: "aed" },
      { account_currency: undefined },
      { spend: undefined },
      { spend: "-3" },
      { impressions: "many" },
    ])
      expect(parseInsightsPage({ data: [row(), row(bad)] }, RANGE), JSON.stringify(bad)).toEqual({
        ok: false,
        code: "bad_row",
      });
    expect(parseInsightsPage({ data: [row({ date_start: "2026-10-14" })] }, RANGE)).toEqual({
      ok: false,
      code: "out_of_range",
    });
    expect(
      parseInsightsPage(
        { data: [], paging: { next: "https://x", cursors: { after: "a&access_token=x" } } },
        RANGE,
      ),
    ).toEqual({ ok: false, code: "bad_cursor" });
  });

  it("spots a repeated ad and day", () => {
    const r = {
      ad_id: "1",
      day: "2026-10-12",
      ad_name: null,
      campaign_name: null,
      currency: "AED",
      spend_milli: 1,
      impressions: 0,
      clicks: 0,
    };
    expect(hasDuplicateDays([r, { ...r, day: "2026-10-13" }])).toBe(false);
    expect(hasDuplicateDays([r, { ...r }])).toBe(true);
  });
});

describe("the adapter", () => {
  function harness(
    responses: Array<Response | Error>,
    extra: { maxPages?: number; graphVersion?: string } = {},
  ) {
    const calls: CallRecord[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sleeps: number[] = [];
    let i = 0;
    const client = createMetaAdsClient({
      adAccountId: ACCOUNT,
      accessToken: TOKEN,
      graphVersion: extra.graphVersion ?? "v21.0",
      maxPages: extra.maxPages,
      fetchFn: (async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        const next = responses[Math.min(i++, responses.length - 1)];
        if (next instanceof Error) throw next;
        return next.clone();
      }) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      rng: () => 0.5,
      sink: { record: (c) => void calls.push(c) },
    });
    return { client, calls, requests, sleeps };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const page = (rows: unknown[], after?: string) => ({
    data: rows,
    paging: after
      ? {
          cursors: { after },
          next: `https://graph.facebook.com/next?access_token=LEAK&after=${after}`,
        }
      : { cursors: { after: "END" } },
  });
  const adRow = (adId: string, day: string, spend = "10.00") => ({
    ad_id: adId,
    ad_name: `Synthetic ${adId}`,
    campaign_name: "Synthetic campaign",
    date_start: day,
    date_stop: day,
    spend,
    impressions: "100",
    clicks: "3",
    account_currency: "AED",
  });

  it("asks for ad-level daily insights with only the listed fields, a bearer token and GET, and logs no token or id", async () => {
    const h = harness([json(200, page([adRow("111111", "2026-10-12")]))]);
    const r = await h.client.fetchInsights(RANGE);
    expect(r).toMatchObject({ ok: true, pages: 1 });
    expect(h.requests).toHaveLength(1);
    const url = new URL(h.requests[0].url);
    expect(url.origin + url.pathname).toBe(
      `https://graph.facebook.com/v21.0/act_${ACCOUNT}/insights`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      level: "ad",
      time_increment: "1",
      time_range: JSON.stringify(RANGE),
      fields: INSIGHT_FIELDS.join(","),
      limit: "500",
    });
    expect(INSIGHT_FIELDS).toEqual([
      "ad_id",
      "ad_name",
      "campaign_name",
      "date_start",
      "spend",
      "impressions",
      "clicks",
      "account_currency",
    ]);
    const init = h.requests[0].init!;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe("manual");
    expect(h.requests[0].url).not.toContain("EAAB");
    expect(JSON.stringify(h.calls)).not.toMatch(/EAAB|1234567890123|111111/);
    expect(h.calls).toEqual([
      expect.objectContaining({
        provider: "meta_ads",
        operation: "ads.insights",
        outcome: "ok",
        httpStatus: 200,
      }),
    ]);
  });

  it("pages with its own URL and Graph's cursor, never by following paging.next", async () => {
    const h = harness([
      json(200, page([adRow("111111", "2026-10-12")], "CURSOR1")),
      json(200, page([adRow("222222", "2026-10-12")], "CURSOR2")),
      json(200, page([adRow("111111", "2026-10-13")])),
    ]);
    const r = await h.client.fetchInsights(RANGE);
    expect(r.ok && r.rows.map((x) => `${x.ad_id}:${x.day}`)).toEqual([
      "111111:2026-10-12",
      "222222:2026-10-12",
      "111111:2026-10-13",
    ]);
    expect(r).toMatchObject({ ok: true, pages: 3 });
    expect(h.requests.map((q) => new URL(q.url).searchParams.get("after"))).toEqual([
      null,
      "CURSOR1",
      "CURSOR2",
    ]);
    for (const q of h.requests) {
      expect(q.url).not.toContain("LEAK");
      expect(q.url.startsWith(`https://graph.facebook.com/v21.0/act_${ACCOUNT}/insights?`)).toBe(
        true,
      );
    }
  });

  it("refuses more pages than the cap, a repeated ad and day, and an unreadable row: nothing partial is returned", async () => {
    const endless = harness([json(200, page([adRow("111111", "2026-10-12")], "MORE"))], {
      maxPages: 3,
    });
    expect(await endless.client.fetchInsights(RANGE)).toEqual({
      ok: false,
      code: "too_many_pages",
      retryable: false,
      auth: false,
    });
    expect(endless.requests).toHaveLength(3);
    expect(
      await harness([
        json(200, page([adRow("111111", "2026-10-12")], "C1")),
        json(200, page([adRow("111111", "2026-10-12")])),
      ]).client.fetchInsights(RANGE),
    ).toMatchObject({ ok: false, code: "duplicate_row" });
    expect(
      await harness([
        json(200, page([adRow("111111", "2026-10-12", "lots")])),
      ]).client.fetchInsights(RANGE),
    ).toMatchObject({ ok: false, code: "bad_row" });
    expect(await harness([json(200, "not json")]).client.fetchInsights(RANGE)).toMatchObject({
      ok: false,
      code: "bad_page",
    });
  });

  it("classifies Graph errors: token problems are auth failures, throttles are retryable, the rest final", async () => {
    expect(
      await harness([
        json(400, {
          error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 },
        }),
      ]).client.fetchInsights(RANGE),
    ).toEqual({ ok: false, code: "graph_190", retryable: false, auth: true });
    expect(
      await harness([json(403, { error: { code: 200 } })]).client.fetchInsights(RANGE),
    ).toEqual({ ok: false, code: "graph_200", retryable: false, auth: true });
    expect(
      await harness([json(400, { error: { code: 80000 } })]).client.fetchInsights(RANGE),
    ).toEqual({ ok: false, code: "graph_80000", retryable: true, auth: false });
    expect(
      await harness([json(400, { error: { code: 100 } })]).client.fetchInsights(RANGE),
    ).toEqual({ ok: false, code: "graph_100", retryable: false, auth: false });
    expect(await harness([json(404, "x")]).client.fetchInsights(RANGE)).toEqual({
      ok: false,
      code: "http_404",
      retryable: false,
      auth: false,
    });
  });

  it("retries a 5xx, a 429 and a timeout with back-off (a GET is safe to repeat), then gives up with a retryable code", async () => {
    const h = harness([
      json(503, {}),
      new DOMException("t", "TimeoutError"),
      json(200, page([adRow("111111", "2026-10-12")])),
    ]);
    expect(await h.client.fetchInsights(RANGE)).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    const down = harness([json(429, {}), json(500, {}), json(502, {})]);
    expect(await down.client.fetchInsights(RANGE)).toEqual({
      ok: false,
      code: "server_error",
      retryable: true,
      auth: false,
    });
    expect(down.requests).toHaveLength(3);
  });

  it("never leaves the Graph host, even with a hostile version string", async () => {
    const h = harness([json(200, page([]))], { graphVersion: "@evil.example/" });
    const r = await h.client.fetchInsights(RANGE);
    expect(r.ok).toBe(true);
    expect(new URL(h.requests[0].url).hostname).toBe("graph.facebook.com");
    expect(insightsUrl("v21.0", ACCOUNT, RANGE, 10, "A_b-1=")).toContain("after=A_b-1%3D");
  });

  it("tests the connection with one read of the ad account", async () => {
    const ok = harness([json(200, { id: `act_${ACCOUNT}`, currency: "AED" })]);
    expect(await ok.client.verify()).toEqual({ ok: true });
    expect(ok.requests[0].url).toBe(
      `https://graph.facebook.com/v21.0/act_${ACCOUNT}?fields=id,currency`,
    );
    expect(ok.requests[0].init?.method).toBe("GET");
    expect(ok.calls[0]).toMatchObject({ provider: "meta_ads", operation: "ads.verify" });
    expect(await harness([json(400, { error: { code: 190 } })]).client.verify()).toEqual({
      ok: false,
      code: "auth",
    });
    expect(await harness([json(400, { error: { code: 100 } })]).client.verify()).toEqual({
      ok: false,
      code: "graph_100",
    });
    expect(await harness([json(200, {})]).client.verify()).toEqual({
      ok: false,
      code: "bad_answer",
    });
    expect(
      await harness([
        new TypeError("down"),
        new TypeError("down"),
        new TypeError("down"),
      ]).client.verify(),
    ).toEqual({ ok: false, code: "network_error" });
  });
});

describe("cost per result (pure)", () => {
  const attribution = (over: Partial<AttributionCounts>): AttributionCounts => ({
    source_id: "120211111111111",
    source_type: "ad",
    headline: "Synthetic check-up offer",
    conversations: 0,
    patients: 0,
    enquiries: 0,
    appointments: 0,
    ...over,
  });
  const spend = (over: Partial<SpendTotals>): SpendTotals => ({
    ad_id: "120211111111111",
    currency: "AED",
    ad_name: "Synthetic ad A",
    campaign_name: "Synthetic campaign",
    spend_milli: 0,
    impressions: 0,
    clicks: 0,
    days: 1,
    pulled_at: "2026-10-14T04:17:00Z",
    ...over,
  });

  it("divides spend by a count, rounding to the nearest thousandth, and never by zero", () => {
    expect(costPerMilli(100_000, 3)).toBe(33_333);
    expect(costPerMilli(100_000, 6)).toBe(16_667);
    expect(costPerMilli(0, 4)).toBe(0);
    expect(costPerMilli(100_000, 0)).toBeNull();
    expect(costPerMilli(100_000, -1)).toBeNull();
    expect(costPerMilli(-5, 1)).toBeNull();
    expect(costPerMilli(Number.NaN, 1)).toBeNull();
  });

  it("joins spend on the ad id from the referral, and only for referrals that were ads", () => {
    expect(adIdOf("ad", "120211111111111")).toBe("120211111111111");
    expect(adIdOf("post", "120211111111111")).toBeNull();
    expect(adIdOf("ad", "unknown")).toBeNull();
    const rows = mergeAdPerformance(
      [
        attribution({ conversations: 10, patients: 8, enquiries: 4, appointments: 2 }),
        attribution({
          source_type: "post",
          source_id: "999",
          headline: "A post",
          conversations: 3,
        }),
      ],
      [
        spend({ spend_milli: 250_000, impressions: 10_000, clicks: 300 }),
        spend({
          ad_id: "120222222222222",
          ad_name: "Synthetic ad B",
          spend_milli: 80_000,
          impressions: 500,
          clicks: 9,
        }),
      ],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        key: "ad:120211111111111",
        adId: "120211111111111",
        label: "Synthetic check-up offer",
        campaignName: "Synthetic campaign",
        conversations: 10,
        enquiries: 4,
        appointments: 2,
        spendMilli: 250_000,
        currency: "AED",
        impressions: 10_000,
        clicks: 300,
        costPerConversationMilli: 25_000,
        costPerEnquiryMilli: 62_500,
        costPerBookingMilli: 125_000,
      }),
      // an ad Meta charged for that brought no conversation in the period
      expect.objectContaining({
        key: "ad:120222222222222",
        label: "Synthetic ad B",
        conversations: 0,
        spendMilli: 80_000,
        costPerConversationMilli: null,
        costPerBookingMilli: null,
      }),
      // a boosted post: counts, no spend
      expect.objectContaining({
        key: "post:999",
        adId: null,
        spendMilli: null,
        impressions: null,
        costPerConversationMilli: null,
      }),
    ]);
  });

  it("shows no spend or cost for an ad billed in two currencies, and totals per currency over ads with spend only", () => {
    const rows = mergeAdPerformance(
      [
        attribution({ conversations: 4, enquiries: 2, appointments: 1 }),
        attribution({
          source_id: "120233333333333",
          conversations: 6,
          enquiries: 1,
          appointments: 0,
        }),
        attribution({ source_id: "120244444444444", conversations: 5 }),
      ],
      [
        spend({ spend_milli: 40_000, impressions: 1000, clicks: 20 }),
        spend({ ad_id: "120233333333333", spend_milli: 20_000, impressions: 500, clicks: 5 }),
        spend({ ad_id: "120244444444444", currency: "AED", spend_milli: 1_000 }),
        spend({ ad_id: "120244444444444", currency: "USD", spend_milli: 2_000 }),
      ],
    );
    const mixed = rows.find((r) => r.adId === "120244444444444")!;
    expect(mixed).toMatchObject({
      mixedCurrency: true,
      spendMilli: null,
      currency: null,
      costPerConversationMilli: null,
    });
    expect(totalsByCurrency(rows)).toEqual([
      {
        currency: "AED",
        spendMilli: 60_000,
        impressions: 1500,
        clicks: 25,
        conversations: 10,
        enquiries: 3,
        appointments: 1,
        costPerConversationMilli: 6_000,
        costPerEnquiryMilli: 20_000,
        costPerBookingMilli: 60_000,
      },
    ]);
    expect(totalsByCurrency([])).toEqual([]);
  });

  it("formats thousandths as money in the account currency", () => {
    const plain = (s: string) => s.replace(/\s/g, " ");
    expect(plain(formatMilli(1_234_500, "AED"))).toBe("AED 1,234.50");
    expect(plain(formatMilli(7_125, "KWD"))).toBe("KWD 7.125");
    expect(formatMilli(null, "AED")).toBe("n/a");
    expect(formatMilli(1, null)).toBe("n/a");
  });
});
