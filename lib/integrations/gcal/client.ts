import {
  createIntegrationClient,
  IntegrationError,
  type ClientDeps,
  type HttpResult,
} from "@/lib/integrations/client";

import { GOOGLE_API_HOST, GOOGLE_OAUTH_HOST } from "./config";
import type { BusyEvent, GoogleEventLike } from "./event";

/**
 * Google OAuth and Calendar API adapter on the shared integration client. Shapes from Google's documentation as the author knows
 * them, NOT verified against a live account:
 *
 *   POST https://oauth2.googleapis.com/token   (form) grant_type=authorization_code|refresh_token
 *        200 {"access_token":"...","expires_in":3599,"refresh_token":"...","scope":"...","token_type":"Bearer"}
 *        400 {"error":"invalid_grant","error_description":"..."}
 *   POST https://oauth2.googleapis.com/revoke  (form) token=...
 *   GET  https://www.googleapis.com/calendar/v3/calendars/{id}/events?singleEvents=true&timeMin&timeMax&maxResults=250&fields=...
 *   POST .../events (with our own id; 409 = it already exists)   PUT .../events/{id}   DELETE .../events/{id} (404/410 = gone)
 *
 * The events request asks Google for `id,status,transparency,start,end,extendedProperties` only, so titles, descriptions,
 * attendees and locations of the specialist's own events never reach Pulse. Tokens are never logged (the call log has six fields).
 */

export type TokenResult =
  | { ok: true; accessToken: string; expiresIn: number; refreshToken: string | null }
  | { ok: false; code: string; revoked: boolean; retryable: boolean };

export type CalResult =
  { ok: true } | { ok: false; code: string; retryable: boolean; auth: boolean; gone?: boolean };

export interface GcalClient {
  exchangeCode(code: string, redirectUri: string): Promise<TokenResult>;
  refresh(refreshToken: string): Promise<TokenResult>;
  revoke(token: string): Promise<{ ok: boolean }>;
  listEvents(
    accessToken: string,
    calendarId: string,
    timeMin: Date,
    timeMax: Date,
    pageToken?: string,
  ): Promise<
    | { ok: true; items: GoogleEventLike[]; nextPageToken: string | null }
    | Exclude<CalResult, { ok: true }>
  >;
  insertEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: BusyEvent,
  ): Promise<CalResult & { exists?: boolean }>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: BusyEvent,
  ): Promise<CalResult>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<CalResult>;
}

export type GcalClientOptions = { clientId: string; clientSecret: string } & Partial<
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

const FORM = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };

function failure(err: unknown): { ok: false; code: string; retryable: boolean; auth: boolean } {
  if (err instanceof IntegrationError)
    return { ok: false, code: err.kind, retryable: err.retryable, auth: false };
  throw err;
}

function httpFailure(res: HttpResult): {
  ok: false;
  code: string;
  retryable: boolean;
  auth: boolean;
} {
  return {
    ok: false,
    code: `http_${res.status}`,
    retryable: res.status === 429 || res.status >= 500,
    auth: res.status === 401 || res.status === 403,
  };
}

export function createGcalClient(o: GcalClientOptions): GcalClient {
  const client = createIntegrationClient({
    provider: "google_calendar",
    allowedHosts: [GOOGLE_OAUTH_HOST, GOOGLE_API_HOST],
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
  const cal = (calendarId: string) =>
    `https://${GOOGLE_API_HOST}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: "application/json" });

  async function token(
    operation: string,
    form: Record<string, string>,
    idempotent: boolean,
  ): Promise<TokenResult> {
    let res: HttpResult;
    try {
      res = await client.request({
        operation,
        method: "POST",
        url: `https://${GOOGLE_OAUTH_HOST}/token`,
        headers: FORM,
        body: new URLSearchParams({
          ...form,
          client_id: o.clientId,
          client_secret: o.clientSecret,
        }).toString(),
        idempotent,
      });
    } catch (err) {
      if (err instanceof IntegrationError)
        return { ok: false, code: err.kind, revoked: false, retryable: err.retryable };
      throw err;
    }
    const j = (res.json ?? {}) as Record<string, unknown>;
    if (res.ok && typeof j.access_token === "string" && j.access_token) {
      const exp = Number(j.expires_in);
      return {
        ok: true,
        accessToken: j.access_token,
        expiresIn: Number.isFinite(exp) && exp > 0 ? exp : 3600,
        refreshToken:
          typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : null,
      };
    }
    const code = typeof j.error === "string" ? j.error.slice(0, 40) : `http_${res.status}`;
    return {
      ok: false,
      code,
      revoked: code === "invalid_grant" || code === "unauthorized_client",
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  return {
    exchangeCode: (code, redirectUri) =>
      // An authorisation code works once: never retried after an unknown answer.
      token(
        "gcal.exchange",
        { grant_type: "authorization_code", code, redirect_uri: redirectUri },
        false,
      ),

    refresh: (refreshToken) =>
      token("gcal.refresh", { grant_type: "refresh_token", refresh_token: refreshToken }, true),

    async revoke(t) {
      try {
        const res = await client.request({
          operation: "gcal.revoke",
          method: "POST",
          url: `https://${GOOGLE_OAUTH_HOST}/revoke`,
          headers: FORM,
          body: new URLSearchParams({ token: t }).toString(),
          idempotent: true,
        });
        // 400 invalid_token: already revoked or expired, which is what we wanted.
        return { ok: res.ok || res.status === 400 };
      } catch {
        return { ok: false };
      }
    },

    async listEvents(accessToken, calendarId, timeMin, timeMax, pageToken) {
      const u = new URL(cal(calendarId));
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("showDeleted", "false");
      u.searchParams.set("maxResults", "250");
      u.searchParams.set("timeMin", timeMin.toISOString());
      u.searchParams.set("timeMax", timeMax.toISOString());
      u.searchParams.set(
        "fields",
        "items(id,status,transparency,start,end,extendedProperties/private),nextPageToken",
      );
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "gcal.events.list",
          method: "GET",
          url: u.toString(),
          headers: bearer(accessToken),
        });
      } catch (err) {
        return failure(err);
      }
      if (!res.ok) return httpFailure(res);
      const j = (res.json ?? {}) as { items?: unknown; nextPageToken?: unknown };
      return {
        ok: true,
        items: Array.isArray(j.items) ? (j.items as GoogleEventLike[]) : [],
        nextPageToken:
          typeof j.nextPageToken === "string" && j.nextPageToken.length < 2000
            ? j.nextPageToken
            : null,
      };
    },

    async insertEvent(accessToken, calendarId, eventId, event) {
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "gcal.events.insert",
          method: "POST",
          url: cal(calendarId),
          headers: { ...bearer(accessToken), "Content-Type": "application/json" },
          body: JSON.stringify({ id: eventId, ...event }),
          // Our own deterministic id makes a repeated insert harmless (409), so a lost answer may be retried.
          idempotent: true,
        });
      } catch (err) {
        return failure(err);
      }
      if (res.ok) return { ok: true };
      if (res.status === 409) return { ok: true, exists: true };
      return httpFailure(res);
    },

    async updateEvent(accessToken, calendarId, eventId, event) {
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "gcal.events.update",
          method: "PUT",
          url: `${cal(calendarId)}/${encodeURIComponent(eventId)}`,
          headers: { ...bearer(accessToken), "Content-Type": "application/json" },
          body: JSON.stringify(event),
          idempotent: true,
        });
      } catch (err) {
        return failure(err);
      }
      if (res.ok) return { ok: true };
      if (res.status === 404 || res.status === 410)
        return { ok: false, code: "gone", retryable: false, auth: false, gone: true };
      return httpFailure(res);
    },

    async deleteEvent(accessToken, calendarId, eventId) {
      let res: HttpResult;
      try {
        res = await client.request({
          operation: "gcal.events.delete",
          method: "DELETE",
          url: `${cal(calendarId)}/${encodeURIComponent(eventId)}`,
          headers: bearer(accessToken),
          idempotent: true,
        });
      } catch (err) {
        return failure(err);
      }
      if (res.ok || res.status === 404 || res.status === 410) return { ok: true };
      return httpFailure(res);
    },
  };
}
