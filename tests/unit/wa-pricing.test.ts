import { beforeEach, describe, expect, it, vi } from "vitest";

import { mergePoints, parsePricingAnalytics, pricingFields, PricingShapeError } from "@/lib/whatsapp/pricing";
import { createFakeAdmin } from "../helpers/fake-admin";

const DAY1 = Date.UTC(2026, 9, 5) / 1000; // 5 Oct 2026 00:00 UTC
const response = (points: unknown[], currency: unknown = "USD") => ({
  currency,
  pricing_analytics: { data: [{ data_points: points }] },
});
const point = (over: Record<string, unknown> = {}) => ({
  start: DAY1, end: DAY1 + 86400, pricing_category: "MARKETING", pricing_type: "REGULAR", country: "AE", volume: 12, cost: 1.5, ...over,
});

describe("pricing analytics parser", () => {
  it("asks for daily buckets by category, type and country, and no phone dimension", () => {
    const f = pricingFields(100, 200);
    expect(f).toContain("pricing_analytics.start(100).end(200).granularity(DAILY)");
    expect(f).toContain('"PRICING_CATEGORY","PRICING_TYPE","COUNTRY"');
    expect(f).not.toMatch(/PHONE/);
  });

  it("parses data points into UTC days and upper-cased keys", () => {
    const r = parsePricingAnalytics(response([point({ pricing_category: "marketing" }), point({ pricing_category: "UTILITY", cost: 0.4, volume: 3 })]));
    expect(r.currency).toBe("USD");
    expect(r.points).toEqual([
      { day: "2026-10-05", category: "MARKETING", pricingType: "REGULAR", country: "AE", volume: 12, cost: 1.5 },
      { day: "2026-10-05", category: "UTILITY", pricingType: "REGULAR", country: "AE", volume: 3, cost: 0.4 },
    ]);
  });

  it("treats a response without pricing_analytics as no data, not an error", () => {
    expect(parsePricingAnalytics({ currency: "AED" })).toEqual({ currency: "AED", points: [] });
  });

  it("fails closed on anything it does not understand", () => {
    const bad: unknown[] = [
      null,
      "x",
      { pricing_analytics: { data: [] } }, // no currency
      response([], "dollars"),
      { currency: "USD", pricing_analytics: { data: "nope" } },
      { currency: "USD", pricing_analytics: { data: [{ data_points: "nope" }] } },
      response([point({ cost: "1.5" })]),
      response([point({ cost: -1 })]),
      response([point({ volume: null })]),
      response([point({ pricing_category: undefined })]),
      response([point({ start: "yesterday" })]),
    ];
    for (const b of bad) expect(() => parsePricingAnalytics(b), JSON.stringify(b)).toThrow(PricingShapeError);
  });

  it("merges points that share a bucket", () => {
    const parsed = parsePricingAnalytics(response([point(), point({ volume: 8, cost: 0.5 })]));
    expect(mergePoints(parsed.points)).toEqual([{ day: "2026-10-05", category: "MARKETING", pricingType: "REGULAR", country: "AE", volume: 20, cost: 2 }]);
  });
});

const getPricing = vi.fn();
vi.mock("@/lib/whatsapp/channel", () => ({ clientForChannel: async () => ({ getPricingAnalytics: getPricing }) }));

describe("wa_pricing_sync task", () => {
  beforeEach(() => getPricing.mockReset());

  async function run(admin: ReturnType<typeof createFakeAdmin>) {
    await import("@/lib/jobs/handlers/wa-pricing");
    const { getTask } = await import("@/lib/jobs/tasks");
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const result = await getTask("wa_pricing_sync")!.run(admin as never, log as never);
    return { result, log };
  }
  const channels = [
    { id: "c1", org_id: "org1", type: "whatsapp", phone_number_id: "p1", waba_id: "w1", status: "active", created_at: "1" },
    { id: "c2", org_id: "org1", type: "whatsapp", phone_number_id: "p2", waba_id: "w1", status: "active", created_at: "2" }, // same WABA
    { id: "c3", org_id: "org2", type: "whatsapp", phone_number_id: "p3", waba_id: "w2", status: "active", created_at: "3" },
  ];

  it("calls Meta once per WABA and stores each bucket against the right org", async () => {
    const admin = createFakeAdmin({ channels, wa_pricing_daily: [] }, { unique: { wa_pricing_daily: [["org_id", "waba_id", "day", "category", "pricing_type", "country"]] } });
    getPricing.mockImplementation(async (waba: string) => response([point({ cost: waba === "w1" ? 1.5 : 9 })]));
    const { result } = await run(admin);
    expect(getPricing).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ accounts: 2, rows: 2, failed: 0 });
    const rows = admin._rows("wa_pricing_daily");
    expect(rows.map((r) => [r.org_id, r.waba_id, Number(r.cost), r.currency])).toEqual([["org1", "w1", 1.5, "USD"], ["org2", "w2", 9, "USD"]]);
  });

  it("re-syncing the same window is idempotent (upsert, no duplicates)", async () => {
    const admin = createFakeAdmin({ channels: [channels[0]], wa_pricing_daily: [] }, { unique: { wa_pricing_daily: [["org_id", "waba_id", "day", "category", "pricing_type", "country"]] } });
    getPricing.mockResolvedValue(response([point()]));
    await run(admin);
    getPricing.mockResolvedValue(response([point({ cost: 2.25 })])); // Meta adjusted the figure
    await run(admin);
    const rows = admin._rows("wa_pricing_daily");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].cost)).toBe(2.25);
  });

  it("stores nothing for an account whose response has an unexpected shape, and still syncs the others", async () => {
    const admin = createFakeAdmin({ channels: [channels[0], channels[2]], wa_pricing_daily: [] }, { unique: { wa_pricing_daily: [["org_id", "waba_id", "day", "category", "pricing_type", "country"]] } });
    getPricing.mockImplementation(async (waba: string) => (waba === "w1" ? { surprise: true } : response([point()])));
    const { result, log } = await run(admin);
    expect(result).toEqual({ accounts: 2, rows: 1, failed: 1 });
    expect(admin._rows("wa_pricing_daily").map((r) => r.waba_id)).toEqual(["w2"]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
