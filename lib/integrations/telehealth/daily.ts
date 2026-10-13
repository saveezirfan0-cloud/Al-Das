import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";
import type {
  RoomRequest,
  RoomResult,
  TelehealthProvider,
} from "@/lib/integrations/telehealth/types";

/**
 * A Daily.co-style adapter: create a room with an expiry, delete it again. Request and response shapes follow Daily's documented REST
 * API as the author knows it; they have NOT been checked against a live account (docs/19_PHASE_19B_NOTES.md). Tests use recorded fakes.
 *
 *   POST https://api.daily.co/v1/rooms    Authorization: Bearer {api key}
 *     {"name": <token>, "privacy": "public", "properties": {"nbf": s, "exp": s, "eject_at_room_exp": true, "max_participants": 6}}
 *   200 {"id":"…","name":"<token>","url":"https://{domain}.daily.co/<token>","privacy":"public","config":{"exp":…}}
 *   400 {"error":"invalid-request-error","info":"a room named … already exists"}
 *   DELETE /v1/rooms/{name} -> 200 {"deleted":true,"name":"…"} | 404
 *   GET /v1/ -> 200 {"domain_id":"…","domain_name":"…","config":{…}}   (used for Test connection)
 *
 * The room is public to anyone who has its 256-bit name, never recorded (no recording property is sent), and the name carries no patient
 * data. The address handed out is rebuilt from the configured domain and the name Pulse chose, not copied from the response.
 */
export const DAILY_API_HOST = "api.daily.co";
const DOMAIN = /^[a-z0-9][a-z0-9-]{1,40}$/;

export type DailyOptions = { apiKey: string; domain: string } & Partial<
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

function alreadyExists(res: HttpResult): boolean {
  const info = (res.json as { info?: unknown } | null)?.info;
  return res.status === 400 && typeof info === "string" && /already exists/i.test(info);
}

export function createDailyProvider(o: DailyOptions): TelehealthProvider | null {
  if (!DOMAIN.test(o.domain) || !o.apiKey) return null;
  const client = createIntegrationClient({
    provider: "daily",
    allowedHosts: [DAILY_API_HOST],
    fetchFn: o.fetchFn,
    now: o.now,
    sleep: o.sleep,
    rng: o.rng,
    sink: o.sink,
    breaker: o.breaker,
    breakerConfig: o.breakerConfig,
    timeoutMs: o.timeoutMs,
    maxRetries: o.maxRetries,
  });
  const auth = { Authorization: `Bearer ${o.apiKey}`, Accept: "application/json" };
  const base = `https://${DAILY_API_HOST}/v1`;

  return {
    id: "daily",

    async createRoom(r: RoomRequest): Promise<RoomResult> {
      const url = `https://${o.domain}.daily.co/${r.roomName}`;
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "telehealth.create_room",
          method: "POST",
          url: `${base}/rooms`,
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: r.roomName,
            privacy: "public",
            properties: {
              nbf: Math.floor(r.notBefore.getTime() / 1000),
              exp: Math.floor(r.expiresAt.getTime() / 1000),
              eject_at_room_exp: true,
              max_participants: 6,
            },
          }),
          // The name is chosen by Pulse, so a repeat after a lost answer comes back as "already exists", which is success.
          idempotent: true,
        });
      } catch (err) {
        if (err instanceof IntegrationError)
          return { ok: false, code: err.kind, retryable: err.retryable };
        throw err;
      }
      if (res.ok || alreadyExists(res)) return { ok: true, roomRef: r.roomName, url };
      const auth401 = res.status === 401 || res.status === 403;
      return { ok: false, code: auth401 ? "auth" : `http_${res.status}`, retryable: false };
    },

    async deleteRoom(roomRef: string): Promise<boolean> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomRef)) return true; // not one of ours; nothing to delete
      try {
        const res = await client.request({
          operation: "telehealth.delete_room",
          method: "DELETE",
          url: `${base}/rooms/${encodeURIComponent(roomRef)}`,
          headers: auth,
          idempotent: true,
        });
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },

    async verify() {
      try {
        const res = await client.request({
          operation: "telehealth.verify",
          method: "GET",
          url: `${base}/`,
          headers: auth,
        });
        if (res.ok) return { ok: true };
        return {
          ok: false,
          code: res.status === 401 || res.status === 403 ? "auth" : `http_${res.status}`,
        };
      } catch (err) {
        return { ok: false, code: err instanceof IntegrationError ? err.kind : "error" };
      }
    },
  };
}
