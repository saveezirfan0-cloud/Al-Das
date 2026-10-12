/**
 * Meta WhatsApp pricing analytics: request and response shape in ONE place (like lib/finance/unite-mapping.ts).
 *
 *   GET /{waba-id}?fields=currency,pricing_analytics.start(<unix>).end(<unix>).granularity(DAILY)
 *         .dimensions(["PRICING_CATEGORY","PRICING_TYPE","COUNTRY"])
 *   -> { currency: "USD", pricing_analytics: { data: [ { data_points: [
 *          { start, end, pricing_category, pricing_type, country, volume, cost } ] } ] } }
 *
 * Written from Meta's documentation and not yet checked against a live account (open question OQ-62):
 * the parser fails closed. An unexpected shape throws, so nothing half-understood reaches the cost report.
 * No phone numbers are requested (no PHONE dimension), so nothing here identifies a patient.
 */

export type PricingPoint = {
  /** UTC calendar day the bucket starts on (YYYY-MM-DD). */
  day: string;
  category: string;
  pricingType: string;
  country: string;
  volume: number;
  cost: number;
};

export type PricingResult = { currency: string; points: PricingPoint[] };

export class PricingShapeError extends Error {
  constructor(message: string) {
    super(`Unexpected pricing analytics response: ${message}`);
    this.name = "PricingShapeError";
  }
}

export function pricingFields(startSec: number, endSec: number): string {
  return (
    `currency,pricing_analytics.start(${Math.trunc(startSec)}).end(${Math.trunc(endSec)})` +
    `.granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE","COUNTRY"])`
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new PricingShapeError(`${what} is missing`);
  return v.trim().toUpperCase().slice(0, 40);
};
const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new PricingShapeError(`${what} is not a non-negative number`);
  return v;
};

export function parsePricingAnalytics(raw: unknown): PricingResult {
  if (!isObj(raw)) throw new PricingShapeError("not an object");
  const currency = text(raw.currency, "currency");
  if (!/^[A-Z]{3}$/.test(currency)) throw new PricingShapeError("currency is not a 3-letter code");
  const analytics = raw.pricing_analytics;
  // An account with no spend in the window can return no pricing_analytics at all: that is "no data", not an error.
  if (analytics === undefined) return { currency, points: [] };
  if (!isObj(analytics) || !Array.isArray(analytics.data)) throw new PricingShapeError("pricing_analytics.data is not a list");

  const points: PricingPoint[] = [];
  for (const block of analytics.data) {
    if (!isObj(block) || !Array.isArray(block.data_points)) throw new PricingShapeError("data_points is not a list");
    for (const p of block.data_points) {
      if (!isObj(p)) throw new PricingShapeError("a data point is not an object");
      const start = num(p.start, "start");
      points.push({
        day: new Date(start * 1000).toISOString().slice(0, 10),
        category: text(p.pricing_category, "pricing_category"),
        pricingType: text(p.pricing_type, "pricing_type"),
        country: text(p.country, "country"),
        volume: Math.trunc(num(p.volume, "volume")),
        cost: num(p.cost, "cost"),
      });
    }
  }
  return { currency, points };
}

/** Sums points that share a bucket key (Meta can split one bucket across blocks). */
export function mergePoints(points: readonly PricingPoint[]): PricingPoint[] {
  const merged = new Map<string, PricingPoint>();
  for (const p of points) {
    const key = [p.day, p.category, p.pricingType, p.country].join("|");
    const cur = merged.get(key);
    if (cur) {
      cur.volume += p.volume;
      cur.cost += p.cost;
    } else merged.set(key, { ...p });
  }
  return [...merged.values()];
}
