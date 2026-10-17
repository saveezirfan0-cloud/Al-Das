/**
 * The typed HTTP client every integration builds on (Phase 19).
 *
 *   - Only https, only the hosts the provider adapter lists (a base URL typed into a settings form can never point it at an
 *     internal address), no redirects followed, a response size cap and a timeout on every call.
 *   - Exponential back-off with jitter on timeouts, network errors, 429 and 5xx. A request that is not idempotent (an SMS, a
 *     payment) is retried only after a 429, which the provider did not process: after a timeout or a 5xx nobody can tell whether
 *     the message went out, so it is reported as `ambiguous` and the caller decides (it must not blindly send again).
 *   - A circuit breaker (breaker.ts) around all of it; its state is stored by the caller (integration_accounts).
 *   - Every attempt is logged as provider, operation, outcome, status code, latency and attempt number. Never a URL, header,
 *     request body, response body, phone number or amount.
 *
 * Tests inject `fetchFn`, `now`, `sleep` and `rng`; nothing in a test ever reaches a real provider.
 */
import {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  parseRetryAfterMs,
  type BackoffOptions,
} from "@/lib/integrations/backoff";
import {
  CLOSED,
  DEFAULT_BREAKER,
  canAttempt,
  onFailure,
  onSuccess,
  type BreakerConfig,
  type BreakerState,
} from "@/lib/integrations/breaker";

export type CallOutcome =
  | "ok"
  | "client_error"
  | "auth_error"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "timeout"
  | "breaker_open"
  | "blocked";

export type CallRecord = {
  provider: string;
  operation: string;
  outcome: CallOutcome;
  httpStatus: number | null;
  durationMs: number;
  attempt: number;
};

export interface CallSink {
  record(call: CallRecord): Promise<void> | void;
}

export interface BreakerStore {
  load(): Promise<BreakerState>;
  save(state: BreakerState): Promise<void>;
}

export type ErrorKind =
  | "breaker_open"
  | "blocked"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "timeout"
  | "response_too_large";

/** Thrown when no usable HTTP answer was obtained. The message never contains a URL, header or body. */
export class IntegrationError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly kind: ErrorKind,
    readonly status: number | null,
    /** Worth trying again later (a queue can re-deliver the job). */
    readonly retryable: boolean,
    /** The provider may have acted on the request even though no answer came back. */
    readonly ambiguous: boolean,
  ) {
    super(`${provider} ${operation} failed (${kind}${status ? ` ${status}` : ""})`);
    this.name = "IntegrationError";
  }
}

export type HttpResult = {
  status: number;
  ok: boolean;
  text: string;
  /** The body's bytes as received (for answers that are not UTF-8, such as TallyPrime's UTF-16). */
  bytes: Uint8Array;
  headers: Headers;
  /** Parsed JSON body, or null when it is not JSON. */
  json: unknown;
};

export type RequestOptions = {
  /** Short stable name for the log and the health page, e.g. "sms.send". Never user data. */
  operation: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** Already serialised (JSON or application/x-www-form-urlencoded). */
  body?: string;
  /** True only when sending the same request twice is harmless (a GET, or a POST with an idempotency key). */
  idempotent?: boolean;
  timeoutMs?: number;
};

export type ClientDeps = {
  provider: string;
  /** Exact host names this client may call. */
  allowedHosts: readonly string[];
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  sink?: CallSink;
  breaker?: BreakerStore;
  breakerConfig?: BreakerConfig;
  backoff?: BackoffOptions;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
};

const COUNTS_AGAINST_BREAKER: ReadonlySet<ErrorKind> = new Set([
  "rate_limited",
  "server_error",
  "network_error",
  "timeout",
]);

export function outcomeForStatus(status: number): CallOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** https only, no credentials in the URL, host on the adapter's list. Returns the parsed URL or null. */
export function checkUrl(raw: string, allowedHosts: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!allowedHosts.includes(url.hostname.toLowerCase())) return null;
  return url;
}

export function createIntegrationClient(deps: ClientDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = deps.rng ?? Math.random;
  const fetchFn = deps.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const maxRetries = deps.maxRetries ?? 2;
  const maxBytes = deps.maxResponseBytes ?? 1_000_000;
  const breakerCfg = deps.breakerConfig ?? DEFAULT_BREAKER;

  async function log(call: CallRecord): Promise<void> {
    try {
      await deps.sink?.record(call);
    } catch {
      /* logging must never break a call */
    }
  }

  async function request(o: RequestOptions): Promise<HttpResult> {
    const base = { provider: deps.provider, operation: o.operation };
    const url = checkUrl(o.url, deps.allowedHosts);
    if (!url) {
      await log({ ...base, outcome: "blocked", httpStatus: null, durationMs: 0, attempt: 1 });
      throw new IntegrationError(deps.provider, o.operation, "blocked", null, false, false);
    }

    let breakerState: BreakerState = CLOSED;
    if (deps.breaker) {
      try {
        breakerState = await deps.breaker.load();
      } catch {
        breakerState = CLOSED; // an unreadable breaker must not stop a clinic from sending; the call log still shows trouble
      }
      if (!canAttempt(breakerState, now(), breakerCfg)) {
        await log({
          ...base,
          outcome: "breaker_open",
          httpStatus: null,
          durationMs: 0,
          attempt: 1,
        });
        throw new IntegrationError(deps.provider, o.operation, "breaker_open", null, true, false);
      }
    }

    const idempotent = o.idempotent ?? o.method === "GET";
    let last: IntegrationError | null = null;
    let result: HttpResult | null = null;

    for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
      const started = now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? deps.timeoutMs ?? 15_000);
      let retryAfterMs: number | null = null;
      try {
        const res = await fetchFn(url.toString(), {
          method: o.method,
          headers: o.headers,
          body: o.body,
          signal: ctrl.signal,
          redirect: "manual",
          cache: "no-store",
        });
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > maxBytes)
          throw new IntegrationError(
            deps.provider,
            o.operation,
            "response_too_large",
            res.status,
            false,
            true,
          );
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > maxBytes)
          throw new IntegrationError(
            deps.provider,
            o.operation,
            "response_too_large",
            res.status,
            false,
            true,
          );
        const text = new TextDecoder().decode(bytes);
        const durationMs = now() - started;
        const outcome = outcomeForStatus(res.status);
        await log({ ...base, outcome, httpStatus: res.status, durationMs, attempt });
        if (outcome === "rate_limited" || outcome === "server_error") {
          retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), now());
          last = new IntegrationError(
            deps.provider,
            o.operation,
            outcome,
            res.status,
            true,
            outcome === "server_error" && !idempotent,
          );
        } else {
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          result = { status: res.status, ok: res.ok, text, bytes, headers: res.headers, json };
          break;
        }
      } catch (err) {
        if (err instanceof IntegrationError) {
          await log({
            ...base,
            outcome: "server_error",
            httpStatus: err.status,
            durationMs: now() - started,
            attempt,
          });
          last = err;
          break;
        }
        const kind: ErrorKind = isTimeout(err) ? "timeout" : "network_error";
        await log({
          ...base,
          outcome: kind,
          httpStatus: null,
          durationMs: now() - started,
          attempt,
        });
        last = new IntegrationError(
          deps.provider,
          o.operation,
          kind,
          null,
          true,
          o.method !== "GET",
        );
      } finally {
        clearTimeout(timer);
      }

      // Retry policy: an idempotent request is retried on any transient failure; a non-idempotent one only after a 429.
      const mayRetry = idempotent || last?.kind === "rate_limited";
      if (!mayRetry || attempt > maxRetries) break;
      await sleep(retryAfterMs ?? backoffDelayMs(attempt, deps.backoff ?? DEFAULT_BACKOFF, rng));
    }

    if (result) {
      if (deps.breaker && breakerState.consecutiveFailures > 0) {
        await deps.breaker.save(onSuccess()).catch(() => undefined);
      }
      return result;
    }

    const failure =
      last ?? new IntegrationError(deps.provider, o.operation, "network_error", null, true, false);
    if (deps.breaker && COUNTS_AGAINST_BREAKER.has(failure.kind)) {
      await deps.breaker
        .save(onFailure(breakerState, now(), breakerCfg).state)
        .catch(() => undefined);
    }
    throw failure;
  }

  return { request };
}

export type IntegrationClient = ReturnType<typeof createIntegrationClient>;
