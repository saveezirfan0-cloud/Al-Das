/**
 * Read-only Unite client.
 *
 * - GET only (the only POST in this package is the documented token refresh, in auth.ts).
 * - One call at a time with a minimum gap between calls; exponential back-off on 5xx / 429 /
 *   network errors; a circuit breaker that stops calling after repeated failures.
 * - Every call is logged (endpoint, outcome, timing — never bodies or patient data).
 * - Endpoints are checked against an allow-list; the Finance API is refused (it is sync-once:
 *   each call permanently dequeues records).
 */
import { format } from "date-fns";

import { isAllowedEndpoint, type UniteConfig } from "@/lib/unite/config";
import { isTokenProblem, type UniteAuth, type UniteEnvelope } from "@/lib/unite/sync-auth";

export class UniteApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "UniteApiError";
  }
}
export class UniteNotConfigured extends Error {
  constructor(what: string) {
    super(`Unite ${what} is not configured`);
    this.name = "UniteNotConfigured";
  }
}
export class UniteBreakerOpen extends Error {
  constructor() {
    super("Unite calls are paused after repeated failures");
    this.name = "UniteBreakerOpen";
  }
}

export interface BreakerStore {
  isOpen(): Promise<boolean>;
  recordSuccess(): Promise<void>;
  /** Returns true when this failure tripped the breaker. */
  recordFailure(): Promise<boolean>;
}

export type CallLog = {
  endpoint: string;
  outcome: "ok" | "error" | "auth_error" | "rate_limited" | "breaker_open";
  httpStatus: number | null;
  durationMs: number;
};

export type ClientDeps = {
  baseUrl: string;
  config: UniteConfig;
  auth: UniteAuth;
  breaker: BreakerStore;
  fetchFn: typeof fetch;
  onCall?: (call: CallLog) => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
};

/** Raw appointment as Unite returns it (lowercase keys). Validated in mappers.ts. */
export type RawRecord = Record<string, unknown>;

const EMPTY_RESULT = /no (record|data|appointment|patient|doctor)s?( found)?|not found/i;

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Unite takes dates as DD-MM-YYYY. */
export function uniteDate(d: Date, timezone: string): string {
  // Format in the clinic's clock, not the server's.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

/** Pulls the record list out of an envelope's Data, whatever wrapper the endpoint uses. */
export function extractRecords(data: unknown): RawRecord[] {
  if (Array.isArray(data)) return data.filter((x): x is RawRecord => !!x && typeof x === "object");
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>))
      if (Array.isArray(v)) return extractRecords(v);
  }
  return [];
}

export function createUniteClient(deps: ClientDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = deps.maxRetries ?? 3;
  const backoffBase = deps.backoffBaseMs ?? 500;
  const minGap = deps.config.min_interval_ms;

  let lastCallAt = 0;
  let chain: Promise<unknown> = Promise.resolve();

  async function log(c: CallLog) {
    try {
      await deps.onCall?.(c);
    } catch {
      /* logging must never break a sync */
    }
  }

  async function throttle() {
    const wait = lastCallAt + minGap - now();
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
  }

  async function run(endpoint: string, query: Record<string, string>): Promise<RawRecord[]> {
    if (!isAllowedEndpoint(deps.config, endpoint))
      throw new UniteApiError(`Endpoint "${endpoint}" is not allowed`);
    if (await deps.breaker.isOpen()) {
      await log({ endpoint, outcome: "breaker_open", httpStatus: null, durationMs: 0 });
      throw new UniteBreakerOpen();
    }

    const url = new URL(join(deps.baseUrl, endpoint));
    for (const [k, v] of Object.entries(query)) if (v !== "") url.searchParams.set(k, v);

    let forcedRefresh = false;
    let lastError: Error = new UniteApiError("Unite request failed", true);
    let token = await deps.auth.getToken();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await throttle();
      const started = now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 30_000);
      let httpStatus: number | null = null;
      try {
        const res = await deps.fetchFn(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        httpStatus = res.status;
        const duration = now() - started;

        if (res.status === 429 || res.status >= 500) {
          await log({
            endpoint,
            outcome: res.status === 429 ? "rate_limited" : "error",
            httpStatus,
            durationMs: duration,
          });
          lastError = new UniteApiError(`Unite answered HTTP ${res.status}`, true);
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : backoffBase * 2 ** attempt,
          );
          continue;
        }
        if (!res.ok) {
          await log({ endpoint, outcome: "error", httpStatus, durationMs: duration });
          throw new UniteApiError(`Unite answered HTTP ${res.status}`);
        }

        const env = (await res.json()) as UniteEnvelope;
        if (env.Status === "Success") {
          await log({ endpoint, outcome: "ok", httpStatus, durationMs: duration });
          await deps.breaker.recordSuccess();
          return extractRecords(env.Data);
        }
        if (isTokenProblem(env.Message)) {
          await log({ endpoint, outcome: "auth_error", httpStatus, durationMs: duration });
          if (forcedRefresh) throw new UniteApiError("Unite keeps rejecting the token");
          forcedRefresh = true;
          token = await deps.auth.getToken({ force: true, stale: token });
          attempt--; // a refreshed token is not a failed attempt
          continue;
        }
        if (EMPTY_RESULT.test(env.Message ?? "")) {
          await log({ endpoint, outcome: "ok", httpStatus, durationMs: duration });
          await deps.breaker.recordSuccess();
          return [];
        }
        await log({ endpoint, outcome: "error", httpStatus, durationMs: duration });
        throw new UniteApiError(
          env.Message ? `Unite error: ${env.Message}` : "Unite returned an error",
        );
      } catch (e) {
        if (e instanceof UniteApiError && !e.retryable) {
          lastError = e;
          break;
        }
        if (e instanceof UniteApiError) {
          lastError = e;
          continue;
        }
        // network error / timeout / bad JSON
        await log({
          endpoint,
          outcome: "error",
          httpStatus,
          durationMs: now() - started,
        });
        lastError = new UniteApiError("Could not reach Unite", true);
        await sleep(backoffBase * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    await deps.breaker.recordFailure();
    throw lastError;
  }

  /** Serialise calls: one in flight at a time, even if callers fire concurrently. */
  function enqueue(endpoint: string, query: Record<string, string>): Promise<RawRecord[]> {
    const next = chain.then(() => run(endpoint, query));
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    /** getallappointments for one branch. `to` empty means "open ended" like the old Make scenario. */
    getAppointments(opts: { clinicId: string; from: Date; to?: Date }) {
      const tz = deps.config.timezone;
      return enqueue(deps.config.paths.appointments, {
        clinic_id: opts.clinicId,
        from_date: uniteDate(opts.from, tz),
        to_date: opts.to ? uniteDate(opts.to, tz) : "",
      });
    },

    /** One page of an optional, configuration-driven list endpoint. */
    listPage(kind: "patients" | "doctors", opts: { page?: number; since?: Date } = {}) {
      const path = deps.config.paths[kind];
      if (!path) throw new UniteNotConfigured(`${kind} endpoint`);
      const paging = deps.config.paging;
      const query: Record<string, string> = {};
      if (paging.page_param && opts.page !== undefined)
        query[paging.page_param] = String(opts.page);
      if (paging.page_size_param) query[paging.page_size_param] = String(paging.page_size);
      if (paging.since_param && opts.since)
        query[paging.since_param] = format(opts.since, "yyyy-MM-dd'T'HH:mm:ss");
      return enqueue(path, query);
    },

    /** Walks every page (or the single page when paging is not configured). */
    async listAll(kind: "patients" | "doctors", opts: { since?: Date; maxPages?: number } = {}) {
      const paging = deps.config.paging;
      if (!paging.page_param) return this.listPage(kind, { since: opts.since });
      const out: RawRecord[] = [];
      for (let page = 1; page <= (opts.maxPages ?? 200); page++) {
        const rows = await this.listPage(kind, { page, since: opts.since });
        out.push(...rows);
        if (rows.length < paging.page_size) break;
      }
      return out;
    },
  };
}

export type UniteClient = ReturnType<typeof createUniteClient>;
