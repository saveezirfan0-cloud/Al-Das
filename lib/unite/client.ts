import { isTokenRejected, type Http, type TokenManager } from "@/lib/unite/auth";

/**
 * Unite Finance API client. THE ONLY CODE THAT CALLS GetFinanceDetails.
 *
 * The API is deliver-once: a successful call permanently dequeues the returned
 * records (CLAUDE.md rule 7). Therefore:
 *   - the response body is returned untouched so the caller can store it raw first;
 *   - the call is never retried, except once after the body says the token was
 *     rejected (nothing is consumed on a rejected call);
 *   - a transport failure after the request may have been sent is reported as
 *     `unknown_outcome` so the caller can alert instead of silently retrying.
 */

export type FinanceRequest = { fromDate: string; toDate: string; count: number };

export type FinanceCall = {
  httpStatus: number;
  /** Parsed JSON, or { _unparseable: true, text } when the response was not JSON. */
  body: unknown;
};

export class UniteCallError extends Error {
  constructor(
    readonly kind: "unknown_outcome",
    message: string,
  ) {
    super(message);
    this.name = "UniteCallError";
  }
}

const FINANCE_TIMEOUT_MS = 25_000;

export function createUniteClient(deps: {
  tokens: TokenManager;
  http: Http;
  baseUrl: string;
  now?: () => number;
  onCall?: (c: {
    endpoint: string;
    httpStatus: number | null;
    uniteStatus: string;
    durationMs: number;
  }) => void;
}) {
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl.endsWith("/") ? deps.baseUrl : `${deps.baseUrl}/`;

  async function post(token: string, req: FinanceRequest): Promise<FinanceCall> {
    const started = now();
    let res;
    try {
      res = await deps.http({
        method: "POST",
        url: `${base}GetFinanceDetails`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(req),
        timeoutMs: FINANCE_TIMEOUT_MS,
      });
    } catch (err) {
      deps.onCall?.({
        endpoint: "GetFinanceDetails",
        httpStatus: null,
        uniteStatus: "transport error",
        durationMs: now() - started,
      });
      throw new UniteCallError(
        "unknown_outcome",
        `transport failure after sending: ${(err as Error).name}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = { _unparseable: true, text: res.text.slice(0, 2000) };
    }
    const b = body as { Status?: unknown; Message?: unknown; MessageStatus?: unknown };
    deps.onCall?.({
      endpoint: "GetFinanceDetails",
      httpStatus: res.status,
      uniteStatus: `${b.MessageStatus ?? b.Status ?? ""} ${b.Message ?? ""}`.trim().slice(0, 100),
      durationMs: now() - started,
    });
    return { httpStatus: res.status, body };
  }

  return {
    async financeDetails(req: FinanceRequest): Promise<FinanceCall> {
      const first = await post(await deps.tokens.getToken(), req);
      const b = first.body as { Data?: unknown; Status?: unknown; Message?: unknown } | null;
      // A rejected token delivers no data, so a single retry with a fresh token cannot lose records.
      if (b && typeof b === "object" && !Array.isArray(b.Data) && isTokenRejected(b)) {
        return post(await deps.tokens.renewToken(), req);
      }
      return first;
    },
  };
}

export type UniteClient = ReturnType<typeof createUniteClient>;

/** Real transport. Used only by the guarded capture handler. */
export const fetchHttp: Http = async ({ method, url, headers, body, timeoutMs }) => {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  return { status: res.status, text: await res.text() };
};
