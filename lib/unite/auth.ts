/**
 * Unite token handling. Tokens live ~240 s, so they are refreshed on demand, never on a timer.
 *
 * Flow (docs/audit/make-replacement-design.md §1):
 *   1. GET  authorize?app_id&app_key   (Bearer <previous access token> when we have one)
 *   2. if the answer is "Token Expired" and we hold a refresh token:
 *      POST refreshtoken               (Bearer <refresh token>, body { app_id, app_key, token })
 *
 * The vendor answers HTTP 200 for everything, so success is read from the body: Status/Message.
 * Tokens and credentials never appear in an error message or a log line.
 */
export type TokenState = {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number;
};

export interface TokenStore {
  get(): Promise<TokenState | null>;
  set(token: TokenState): Promise<void>;
  /** True for exactly one caller at a time (single-flight refresh across serverless invocations). */
  claimRefresh(): Promise<boolean>;
  /** Drop the refresh claim after a failed login so the next caller can retry at once. */
  release?(): Promise<void>;
}

export class UniteAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniteAuthError";
  }
}

export type UniteEnvelope = {
  Data?: unknown;
  Status?: string;
  Message?: string;
};

export function isTokenProblem(message: string | undefined): boolean {
  return /token (has )?expired|invalid token|unauthori[sz]ed/i.test(message ?? "");
}

export type AuthDeps = {
  baseUrl: string;
  paths: { authorize: string; refresh: string };
  appId: string;
  appKey: string;
  store: TokenStore;
  fetchFn: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Treat a token as expired this long before it really is. */
  skewMs?: number;
  /** How long to wait for another worker's refresh before refreshing anyway. */
  waitMs?: number;
  timeoutMs?: number;
};

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createUniteAuth(deps: AuthDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const skew = deps.skewMs ?? 30_000;
  const waitMs = deps.waitMs ?? 5_000;

  async function call(url: string, init: RequestInit): Promise<UniteEnvelope> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 15_000);
    try {
      const res = await deps.fetchFn(url, { ...init, signal: ctrl.signal });
      if (!res.ok) throw new UniteAuthError(`Unite auth endpoint answered HTTP ${res.status}`);
      return (await res.json()) as UniteEnvelope;
    } catch (e) {
      if (e instanceof UniteAuthError) throw e;
      throw new UniteAuthError("Could not reach the Unite auth endpoint");
    } finally {
      clearTimeout(timer);
    }
  }

  function toState(env: UniteEnvelope): TokenState {
    const d = (env.Data ?? {}) as Record<string, unknown>;
    const access = typeof d.access_token === "string" ? d.access_token : null;
    if (env.Status !== "Success" || !access)
      throw new UniteAuthError(
        env.Message ? `Unite refused the login: ${env.Message}` : "Unite refused the login",
      );
    const seconds = Number(d.expires_in);
    return {
      accessToken: access,
      refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : null,
      expiresAt: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 240) * 1000,
    };
  }

  async function login(previous: TokenState | null): Promise<TokenState> {
    const authorize = new URL(join(deps.baseUrl, deps.paths.authorize));
    authorize.searchParams.set("app_id", deps.appId);
    authorize.searchParams.set("app_key", deps.appKey);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (previous?.accessToken) headers.Authorization = `Bearer ${previous.accessToken}`;
    const first = await call(authorize.toString(), { method: "GET", headers });
    if (first.Status === "Success") return toState(first);

    if (/token (has )?expired/i.test(first.Message ?? "") && previous?.refreshToken) {
      const second = await call(join(deps.baseUrl, deps.paths.refresh), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${previous.refreshToken}`,
        },
        body: JSON.stringify({
          app_id: deps.appId,
          app_key: deps.appKey,
          token: previous.accessToken,
        }),
      });
      return toState(second);
    }
    return toState(first); // throws UniteAuthError with the vendor's message
  }

  return {
    /**
     * A valid access token. `stale` is the token a caller just saw rejected: if the stored one
     * differs, somebody else already refreshed and we can use theirs.
     */
    async getToken(opts: { force?: boolean; stale?: string } = {}): Promise<string> {
      const cached = await deps.store.get();
      if (cached) {
        const fresh = cached.expiresAt - now() > skew;
        const replaced = opts.stale !== undefined && cached.accessToken !== opts.stale;
        if (fresh && (!opts.force || replaced)) return cached.accessToken;
      }

      if (!(await deps.store.claimRefresh())) {
        // Another worker is refreshing: give it a moment, then use its token.
        const deadline = now() + waitMs;
        while (now() < deadline) {
          await sleep(250);
          const again = await deps.store.get();
          if (again && again.expiresAt - now() > skew && again.accessToken !== cached?.accessToken)
            return again.accessToken;
        }
      }
      try {
        const next = await login(cached);
        await deps.store.set(next);
        return next.accessToken;
      } catch (e) {
        await deps.store.release?.();
        throw e;
      }
    },
  };
}

export type UniteAuth = ReturnType<typeof createUniteAuth>;
