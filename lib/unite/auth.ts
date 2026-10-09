/**
 * Unite token manager. Mirrors the Make "Token" scenario (docs/audit/make-raw/3576415_Token.summary.md):
 *   authorize : GET  {base}authorize?app_id&app_key    Authorization: Bearer <current access token>
 *   refresh   : POST {base}refreshtoken {app_id, app_key, token:<access>}   Authorization: Bearer <refresh token>
 * Unite answers HTTP 200 even on failure, so success is read from the body.
 * Tokens are refreshed on demand. The lifetime is treated as seconds (the safe
 * reading of expires_in = 240) and never longer than 240 s.
 */

export type AppCredentials = { app_id: string; app_key: string };

export type UniteCredentials = {
  /** Pair used by the authorize call. */
  authorize: AppCredentials;
  /** Pair used by the refreshtoken call (Unite issued a different pair in the Make scenario). */
  refresh: AppCredentials;
  access_token?: string;
  refresh_token?: string;
  /** Epoch ms when the current pair was issued. */
  issued_at?: number;
  /** Seconds the pair is valid for, as reported by Unite (capped at 240). */
  ttl_seconds?: number;
};

export type TokenStore = {
  load(): Promise<UniteCredentials | null>;
  save(creds: UniteCredentials): Promise<void>;
};

export type HttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
};
export type HttpResponse = { status: number; text: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export class UniteAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniteAuthError";
  }
}

export const TOKEN_SAFETY_MARGIN_MS = 30_000;
const MAX_TTL_SECONDS = 240;
const AUTH_TIMEOUT_MS = 15_000;

type TokenBody = {
  Status?: string;
  Message?: string;
  Data?: { access_token?: string; refresh_token?: string; expires_in?: number } | string;
};

function parseBody(text: string): TokenBody {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as TokenBody) : {};
  } catch {
    return {};
  }
}

export function isTokenRejected(
  body: { Status?: unknown; Message?: unknown } | null | undefined,
): boolean {
  const msg = typeof body?.Message === "string" ? body.Message.toLowerCase() : "";
  return msg.includes("token expired") || msg.includes("invalid token");
}

export function createTokenManager(deps: {
  store: TokenStore;
  http: Http;
  baseUrl: string;
  now?: () => number;
  /** Called after every auth call; must not receive tokens or keys. */
  onCall?: (c: {
    endpoint: "authorize" | "refreshtoken";
    httpStatus: number;
    uniteStatus: string;
    durationMs: number;
  }) => void;
}) {
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl.endsWith("/") ? deps.baseUrl : `${deps.baseUrl}/`;

  const valid = (c: UniteCredentials) =>
    !!c.access_token &&
    c.issued_at !== undefined &&
    now() < c.issued_at + (c.ttl_seconds ?? MAX_TTL_SECONDS) * 1000 - TOKEN_SAFETY_MARGIN_MS;

  async function call(endpoint: "authorize" | "refreshtoken", req: Omit<HttpRequest, "timeoutMs">) {
    const started = now();
    const res = await deps.http({ ...req, timeoutMs: AUTH_TIMEOUT_MS });
    const body = parseBody(res.text);
    deps.onCall?.({
      endpoint,
      httpStatus: res.status,
      uniteStatus: `${body.Status ?? ""} ${body.Message ?? ""}`.trim().slice(0, 100),
      durationMs: now() - started,
    });
    return body;
  }

  async function store(creds: UniteCredentials, body: TokenBody): Promise<UniteCredentials> {
    const data = typeof body.Data === "object" && body.Data ? body.Data : undefined;
    if (!data?.access_token)
      throw new UniteAuthError("Unite returned success without an access token");
    const next: UniteCredentials = {
      ...creds,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? creds.refresh_token,
      issued_at: now(),
      ttl_seconds: Math.min(
        data.expires_in && data.expires_in > 0 ? data.expires_in : MAX_TTL_SECONDS,
        MAX_TTL_SECONDS,
      ),
    };
    await deps.store.save(next);
    return next;
  }

  async function authorize(creds: UniteCredentials): Promise<UniteCredentials> {
    const { app_id, app_key } = creds.authorize;
    const url = `${base}authorize?app_id=${encodeURIComponent(app_id)}&app_key=${encodeURIComponent(app_key)}`;
    const body = await call("authorize", {
      method: "GET",
      url,
      headers: creds.access_token ? { Authorization: `Bearer ${creds.access_token}` } : {},
    });
    if (body.Status === "Success") return store(creds, body);
    if (isTokenRejected(body)) return refresh(creds);
    throw new UniteAuthError(
      `authorize failed: ${body.Message || body.Status || "no response body"}`,
    );
  }

  async function refresh(creds: UniteCredentials): Promise<UniteCredentials> {
    if (!creds.refresh_token)
      throw new UniteAuthError("refresh needed but no refresh token is stored");
    const body = await call("refreshtoken", {
      method: "POST",
      url: `${base}refreshtoken`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.refresh_token}`,
      },
      body: JSON.stringify({
        app_id: creds.refresh.app_id,
        app_key: creds.refresh.app_key,
        token: creds.access_token ?? "",
      }),
    });
    if (body.Status === "Success") return store(creds, body);
    throw new UniteAuthError(
      `refresh failed: ${body.Message || body.Status || "no response body"}`,
    );
  }

  async function load(): Promise<UniteCredentials> {
    const creds = await deps.store.load();
    if (!creds) throw new UniteAuthError("no Unite credentials are configured");
    return creds;
  }

  return {
    /** A token valid for at least the safety margin, authorising only when needed. */
    async getToken(): Promise<string> {
      const creds = await load();
      if (valid(creds)) return creds.access_token as string;
      const next = await authorize(creds);
      return next.access_token as string;
    },
    /** Called when a data call is rejected with Token Expired / Invalid Token: always re-issues. */
    async renewToken(): Promise<string> {
      const creds = await load();
      const next = await authorize({ ...creds, issued_at: undefined });
      return next.access_token as string;
    },
  };
}

export type TokenManager = ReturnType<typeof createTokenManager>;
