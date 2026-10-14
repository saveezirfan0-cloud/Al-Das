import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import { META_ADS_HOST } from "@/lib/integrations/meta-ads/config";
import {
  hasDuplicateDays,
  INSIGHT_FIELDS,
  parseInsightsPage,
  type InsightRow,
  type InsightsRange,
} from "@/lib/integrations/meta-ads/insights";

/**
 * Meta Marketing API adapter, read only (Phase 20i). Shapes follow Meta's documentation as the author knows it; they have NOT been
 * checked against a live ad account (docs/31_PHASE_20I_ADS_SPEND_NOTES.md). Tests use recorded fake responses.
 *
 *   GET https://graph.facebook.com/{version}/act_{ad account id}/insights
 *       ?level=ad&time_increment=1&time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
 *       &fields=ad_id,ad_name,campaign_name,date_start,spend,impressions,clicks,account_currency&limit=500[&after={cursor}]
 *       Authorization: Bearer {ads_read system-user token}
 *   200 {"data":[{"ad_id":"…","date_start":"…","spend":"12.34",…}],"paging":{"cursors":{"after":"…"},"next":"…"}}
 *   4xx {"error":{"message":"…","type":"OAuthException","code":190,"fbtrace_id":"…"}}
 *
 *   GET https://graph.facebook.com/{version}/act_{id}?fields=id,currency     (Test connection)
 *
 * Every call is a GET, so the shared client retries timeouts, 429 and 5xx with back-off. The next page is requested with our own URL
 * and Graph's `after` cursor, never by following `paging.next` (which can carry a token in its query string). The token travels only
 * in the Authorization header: never in a URL, a log row or an error.
 */
export type InsightsResult =
  | { ok: true; rows: InsightRow[]; pages: number }
  | { ok: false; code: string; retryable: boolean; auth: boolean };

export interface MetaAdsClient {
  readonly id: "meta_ads";
  fetchInsights(range: InsightsRange): Promise<InsightsResult>;
  verify(): Promise<{ ok: boolean; code?: string }>;
}

export type MetaAdsClientOptions = {
  /** Digits only (normalizeAdAccountId). */
  adAccountId: string;
  accessToken: string;
  graphVersion: string;
  pageSize?: number;
  maxPages?: number;
} & Partial<
  Pick<
    ClientDeps,
    | "fetchFn"
    | "now"
    | "sleep"
    | "rng"
    | "sink"
    | "breaker"
    | "breakerConfig"
    | "timeoutMs"
    | "maxRetries"
  >
>;

/** Graph error codes that mean the token or its permission on the ad account is the problem. */
const AUTH_CODES = new Set([102, 190, 200, 10, 270, 272, 294, 299]);
/** Graph "slow down" codes, including the ads-insights throttles (80000 range). */
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);

export const DEFAULT_PAGE_SIZE = 500;
/** 40 pages of 500 rows: far beyond a clinic's ads over 28 days. More is refused, not stored in part. */
export const DEFAULT_MAX_PAGES = 40;

function errorOf(res: HttpResult): { code: number | null; retryable: boolean; auth: boolean } {
  const e = (res.json as { error?: { code?: unknown } } | null)?.error;
  const code = typeof e?.code === "number" ? e.code : null;
  const auth = res.status === 401 || res.status === 403 || (code !== null && AUTH_CODES.has(code));
  return { code, auth, retryable: !auth && code !== null && THROTTLE_CODES.has(code) };
}

export function insightsUrl(
  graphVersion: string,
  adAccountId: string,
  range: InsightsRange,
  pageSize: number,
  after: string | null,
): string {
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since: range.since, until: range.until }),
    fields: INSIGHT_FIELDS.join(","),
    limit: String(pageSize),
  });
  if (after) params.set("after", after);
  return `https://${META_ADS_HOST}/${encodeURIComponent(graphVersion)}/act_${encodeURIComponent(adAccountId)}/insights?${params.toString()}`;
}

export function createMetaAdsClient(o: MetaAdsClientOptions): MetaAdsClient {
  const client = createIntegrationClient({
    provider: "meta_ads",
    allowedHosts: [META_ADS_HOST],
    fetchFn: o.fetchFn,
    now: o.now,
    sleep: o.sleep,
    rng: o.rng,
    sink: o.sink,
    breaker: o.breaker,
    breakerConfig: o.breakerConfig,
    timeoutMs: o.timeoutMs ?? 30_000,
    maxRetries: o.maxRetries,
  });
  const headers = { Authorization: `Bearer ${o.accessToken}`, Accept: "application/json" };
  const pageSize = o.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = o.maxPages ?? DEFAULT_MAX_PAGES;

  const failure = (err: unknown): InsightsResult => {
    if (err instanceof IntegrationError)
      return { ok: false, code: err.kind, retryable: err.retryable, auth: false };
    throw err;
  };

  return {
    id: "meta_ads",

    async fetchInsights(range) {
      const rows: InsightRow[] = [];
      let after: string | null = null;
      for (let page = 1; page <= maxPages; page++) {
        let res: HttpResult;
        try {
          res = await client.request({
            operation: "ads.insights",
            method: "GET",
            url: insightsUrl(o.graphVersion, o.adAccountId, range, pageSize, after),
            headers,
          });
        } catch (err) {
          return failure(err);
        }
        if (!res.ok) {
          const e = errorOf(res);
          return {
            ok: false,
            code: e.code !== null ? `graph_${e.code}` : `http_${res.status}`,
            retryable: e.retryable,
            auth: e.auth,
          };
        }
        const parsed = parseInsightsPage(res.json, range);
        if (!parsed.ok) return { ok: false, code: parsed.code, retryable: false, auth: false };
        rows.push(...parsed.rows);
        if (!parsed.after) {
          if (hasDuplicateDays(rows))
            return { ok: false, code: "duplicate_row", retryable: false, auth: false };
          return { ok: true, rows, pages: page };
        }
        after = parsed.after;
      }
      return { ok: false, code: "too_many_pages", retryable: false, auth: false };
    },

    async verify() {
      try {
        const res = await client.request({
          operation: "ads.verify",
          method: "GET",
          url: `https://${META_ADS_HOST}/${encodeURIComponent(o.graphVersion)}/act_${encodeURIComponent(o.adAccountId)}?fields=id,currency`,
          headers,
        });
        if (res.ok) {
          const id = (res.json as { id?: unknown } | null)?.id;
          return typeof id === "string" && id ? { ok: true } : { ok: false, code: "bad_answer" };
        }
        const e = errorOf(res);
        return {
          ok: false,
          code: e.auth ? "auth" : e.code !== null ? `graph_${e.code}` : `http_${res.status}`,
        };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}
