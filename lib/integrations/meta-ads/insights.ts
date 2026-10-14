/**
 * Meta ad insights, pure parts: the fields Pulse asks for, the date range of a pull, and the parser that turns one page of Graph's
 * answer into rows for ad_insights_daily. The parser reads ONLY the listed keys and fails the whole page closed on anything it does
 * not understand (a missing or malformed id, day, currency or spend, a duplicate ad and day): a pull that cannot be read is stored
 * as nothing rather than as a guess.
 */

/** The only fields requested from Meta (level=ad, one row per ad and day). */
export const INSIGHT_FIELDS = [
  "ad_id",
  "ad_name",
  "campaign_name",
  "date_start",
  "spend",
  "impressions",
  "clicks",
  "account_currency",
] as const;

export type InsightRow = {
  ad_id: string;
  /** YYYY-MM-DD, Meta's day in the ad account's time zone. */
  day: string;
  ad_name: string | null;
  campaign_name: string | null;
  currency: string;
  /** Spend in thousandths of the currency (exact). */
  spend_milli: number;
  impressions: number;
  clicks: number;
};

export type InsightsRange = { since: string; until: string };

export type ParsedPage =
  { ok: true; rows: InsightRow[]; after: string | null } | { ok: false; code: string };

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The days a pull reads: the `days` complete days before `now` (UTC), ending yesterday. Re-reading them every day picks up Meta's
 * late corrections; the store replaces exactly this range.
 */
export function insightsRange(now: Date, days: number): InsightsRange {
  const n = Math.max(1, Math.min(Math.floor(days), 92));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { since: isoDay(today - n * DAY_MS), until: isoDay(today - DAY_MS) };
}

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A non-negative decimal amount (Meta sends spend as a string such as "12.34") as an exact integer number of thousandths, rounding
 * half up on the fourth decimal. Null for anything else (negative, exponent, empty, more than 12 integer digits).
 */
export function parseSpendMilli(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = value.toFixed(4);
  } else if (typeof value === "string") text = value.trim();
  else return null;
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(4, "0");
  const milli = Number(m[1]) * 1000 + Number(frac.slice(0, 3));
  return Number(frac[3]) >= 5 ? milli + 1 : milli;
}

/** A non-negative whole count (Meta sends them as strings). Absent means none. Null when malformed. */
export function parseCount(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** An ad or campaign name: trimmed, control characters removed, at most 200 characters; null when empty. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, 200) : null;
}

function parseRow(raw: unknown): InsightRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const adId = typeof r.ad_id === "string" ? r.ad_id.trim() : "";
  if (!/^\d{1,30}$/.test(adId)) return null;
  if (!isIsoDay(r.date_start)) return null;
  const currency = typeof r.account_currency === "string" ? r.account_currency.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const spend = parseSpendMilli(r.spend);
  const impressions = parseCount(r.impressions);
  const clicks = parseCount(r.clicks);
  if (spend === null || impressions === null || clicks === null) return null;
  return {
    ad_id: adId,
    day: r.date_start,
    ad_name: cleanName(r.ad_name),
    campaign_name: cleanName(r.campaign_name),
    currency,
    spend_milli: spend,
    impressions,
    clicks,
  };
}

/** One page of `GET /act_{id}/insights`. `range` refuses a row from another day than the ones asked for. */
export function parseInsightsPage(json: unknown, range: InsightsRange): ParsedPage {
  if (!json || typeof json !== "object" || Array.isArray(json))
    return { ok: false, code: "bad_page" };
  const body = json as { data?: unknown; paging?: unknown };
  if (!Array.isArray(body.data)) return { ok: false, code: "bad_page" };
  const rows: InsightRow[] = [];
  for (const raw of body.data) {
    const row = parseRow(raw);
    if (!row) return { ok: false, code: "bad_row" };
    if (row.day < range.since || row.day > range.until) return { ok: false, code: "out_of_range" };
    rows.push(row);
  }
  const paging = (body.paging ?? null) as {
    next?: unknown;
    cursors?: { after?: unknown };
  } | null;
  const after =
    paging && typeof paging.next === "string" && typeof paging.cursors?.after === "string"
      ? paging.cursors.after
      : null;
  if (after !== null && (after.length > 500 || !/^[A-Za-z0-9_=-]+$/.test(after)))
    return { ok: false, code: "bad_cursor" };
  return { ok: true, rows, after };
}

/** True when two rows share an ad and a day (Meta should never send that; the pull is refused if it does). */
export function hasDuplicateDays(rows: readonly InsightRow[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.ad_id}:${r.day}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
