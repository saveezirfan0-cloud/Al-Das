import { describe, expect, it } from "vitest";

import { allFields, integrationDef, validateFields } from "@/lib/integrations/catalog";
import type { CallRecord } from "@/lib/integrations/client";
import { createGcalClient } from "@/lib/integrations/gcal/client";
import {
  gcalBackoffMs,
  gcalRedirectUri,
  GOOGLE_SCOPES,
  readGcalConfig,
} from "@/lib/integrations/gcal/config";
import {
  buildBusyEvent,
  busyBlocksFromEvents,
  gcalEventId,
  isPulseEvent,
  planPush,
  syncHash,
  type ApptForSync,
  type LinkForSync,
} from "@/lib/integrations/gcal/event";
import {
  buildAuthUrl,
  hashOAuthState,
  newOAuthState,
  readCallback,
  stateDecision,
  STATE_TTL_MS,
} from "@/lib/integrations/gcal/oauth";

const ORG = "0f9b6a3e-1c1d-4e8b-9a77-2f6b1c3d4e5f";
const SPEC = "1a2b3c4d-1c1d-4e8b-9a77-2f6b1c3d4e5f";

describe("the event Pulse writes to Google", () => {
  it("has exactly the fixed shape: Busy, start, end, opaque, private, no reminders, the marker", () => {
    expect(
      buildBusyEvent({ startsAt: "2026-11-01T06:00:00Z", endsAt: "2026-11-01T06:30:00+00:00" }),
    ).toEqual({
      summary: "Busy",
      start: { dateTime: "2026-11-01T06:00:00.000Z" },
      end: { dateTime: "2026-11-01T06:30:00.000Z" },
      transparency: "opaque",
      visibility: "private",
      status: "confirmed",
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { pulse: "1" } },
    });
  });

  it("carries no patient detail even when the caller passes some (hostile extras)", () => {
    const hostile = {
      startsAt: "2026-11-01T06:00:00Z",
      endsAt: "2026-11-01T06:30:00Z",
      contactName: "Layla Demo-07",
      phone: "+447700900007",
      notes: "Diabetes follow-up",
      service: "Endocrinology",
      location: "Branch 2",
      attendees: [{ email: "patient@example.test" }],
      description: "secret",
      summary: "Layla Demo-07",
    } as unknown as { startsAt: string; endsAt: string };
    const event = buildBusyEvent(hostile);
    const text = JSON.stringify(event);
    for (const leak of [
      "Layla",
      "+447700900007",
      "Diabetes",
      "Endocrinology",
      "Branch",
      "patient@",
      "secret",
    ])
      expect(text).not.toContain(leak);
    expect(Object.keys(event).sort()).toEqual(
      [
        "end",
        "extendedProperties",
        "reminders",
        "start",
        "status",
        "summary",
        "transparency",
        "visibility",
      ].sort(),
    );
  });

  it("refuses impossible times", () => {
    expect(() => buildBusyEvent({ startsAt: "nope", endsAt: "2026-11-01T06:30:00Z" })).toThrow();
    expect(() =>
      buildBusyEvent({ startsAt: "2026-11-01T07:00:00Z", endsAt: "2026-11-01T06:30:00Z" }),
    ).toThrow();
  });

  it("uses a deterministic Google-valid event id, so a repeated insert finds the same event", () => {
    const id = gcalEventId(ORG, "appt-1");
    expect(id).toMatch(/^pulse[0-9a-f]{48}$/);
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(gcalEventId(ORG, "appt-1")).toBe(id);
    expect(gcalEventId(ORG, "appt-2")).not.toBe(id);
    expect(isPulseEvent({ id })).toBe(true);
  });
});

describe("planning the writes", () => {
  const window = { from: new Date("2026-10-27T00:00:00Z"), to: new Date("2026-12-27T00:00:00Z") };
  const appt = (id: string, over: Partial<ApptForSync> = {}): ApptForSync => ({
    id,
    specialistId: SPEC,
    startsAt: "2026-11-01T06:00:00Z",
    endsAt: "2026-11-01T06:30:00Z",
    status: "confirmed",
    ...over,
  });
  const linkFor = (a: ApptForSync): LinkForSync => ({
    appointmentId: a.id,
    eventId: gcalEventId(ORG, a.id),
    syncedHash: syncHash({ startsAt: a.startsAt, endsAt: a.endsAt, busy: true }),
    status: "live",
  });
  const plan = (appointments: ApptForSync[], links: LinkForSync[], enabled = true) =>
    planPush({ orgId: ORG, specialistId: SPEC, window, appointments, links, enabled });

  it("writes new busy appointments once, and nothing when nothing changed", () => {
    const a = appt("a");
    expect(plan([a], []).upsert).toEqual([
      expect.objectContaining({ appointmentId: "a", eventId: gcalEventId(ORG, "a"), known: false }),
    ]);
    expect(plan([a], [linkFor(a)])).toEqual({ upsert: [], remove: [] });
  });

  it("updates a moved appointment and removes cancelled, no-show, reassigned and deleted ones", () => {
    const a = appt("a");
    const moved = { ...a, startsAt: "2026-11-02T06:00:00Z", endsAt: "2026-11-02T06:30:00Z" };
    expect(plan([moved], [linkFor(a)]).upsert).toEqual([
      expect.objectContaining({ appointmentId: "a", known: true }),
    ]);
    for (const gone of [
      { ...a, status: "cancelled" },
      { ...a, status: "no_show" },
      { ...a, specialistId: "someone-else" },
    ])
      expect(plan([gone], [linkFor(a)]).remove).toEqual([
        { eventId: gcalEventId(ORG, "a"), appointmentId: "a" },
      ]);
    expect(plan([], [linkFor(a)]).remove).toHaveLength(1); // the appointment row no longer exists
    expect(plan([], [{ ...linkFor(a), appointmentId: null }]).remove).toHaveLength(1);
  });

  it("leaves an event alone when its appointment is merely outside the window", () => {
    const far = appt("far", { startsAt: "2027-03-01T06:00:00Z", endsAt: "2027-03-01T06:30:00Z" });
    expect(plan([far], [linkFor(far)])).toEqual({ upsert: [], remove: [] });
    expect(plan([far], []).upsert).toEqual([]);
  });

  it("removes every live event when pushing is switched off", () => {
    const a = appt("a");
    expect(plan([a], [linkFor(a)], false)).toEqual({
      upsert: [],
      remove: [{ eventId: gcalEventId(ORG, "a"), appointmentId: "a" }],
    });
    expect(plan([a], [{ ...linkFor(a), status: "deleted" }], false)).toEqual({
      upsert: [],
      remove: [],
    });
  });
});

describe("busy times read from Google", () => {
  const ev = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    status: "confirmed",
    start: { dateTime: "2026-11-01T08:00:00+04:00" },
    end: { dateTime: "2026-11-01T09:00:00+04:00" },
    ...over,
  });

  it("gives the same keyed blocks for the same calendar (idempotent), in UTC", () => {
    const events = [
      ev("e1"),
      ev("e2", {
        start: { dateTime: "2026-11-02T10:00:00Z" },
        end: { dateTime: "2026-11-02T11:00:00Z" },
      }),
    ];
    const a = busyBlocksFromEvents(events, "Asia/Dubai");
    const b = busyBlocksFromEvents(structuredClone(events), "Asia/Dubai");
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect(a[0]).toEqual({
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      starts_at: "2026-11-01T04:00:00.000Z",
      ends_at: "2026-11-01T05:00:00.000Z",
    });
    expect(busyBlocksFromEvents([ev("e1"), ev("e1")], "Asia/Dubai")).toHaveLength(1);
  });

  it("skips free, cancelled, Pulse's own and malformed events", () => {
    expect(
      busyBlocksFromEvents(
        [
          ev("free", { transparency: "transparent" }),
          ev("gone", { status: "cancelled" }),
          ev("ours", { extendedProperties: { private: { pulse: "1" } } }),
          ev(gcalEventId(ORG, "x")),
          ev("bad", { end: { dateTime: "2026-11-01T03:00:00Z" } }),
          ev("nostart", { start: null }),
          { status: "confirmed" },
        ],
        "Asia/Dubai",
      ),
    ).toEqual([]);
  });

  it("puts an all-day event in the clinic's time zone", () => {
    const [b] = busyBlocksFromEvents(
      [ev("leave", { start: { date: "2026-11-05" }, end: { date: "2026-11-06" } })],
      "Asia/Dubai",
    );
    expect(b).toMatchObject({
      starts_at: "2026-11-04T20:00:00.000Z",
      ends_at: "2026-11-05T20:00:00.000Z",
    });
  });

  it("never keeps a title, description, attendee or location", () => {
    const blocks = busyBlocksFromEvents(
      [
        ev("e9", {
          summary: "Private: therapy",
          description: "x",
          attendees: [{ email: "a@b.test" }],
          location: "Home",
        }),
      ],
      "Asia/Dubai",
    );
    expect(Object.keys(blocks[0]).sort()).toEqual(["ends_at", "key", "starts_at"]);
    expect(JSON.stringify(blocks)).not.toMatch(/therapy|a@b\.test|Home/);
  });
});

describe("OAuth state", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  const row = {
    org_id: ORG,
    user_id: "user-1",
    specialist_id: SPEC,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
    used_at: null,
  };

  it("is 256 random bits and only its hash is stored", () => {
    const a = newOAuthState();
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(hashOAuthState(a.state));
    expect(newOAuthState().state).not.toBe(a.state);
  });

  it("completes only for the same person and workspace, once, before it expires", () => {
    const who = { orgId: ORG, userId: "user-1" };
    expect(stateDecision(row, who, now)).toBe("ok");
    expect(stateDecision(null, who, now)).toBe("unknown");
    expect(stateDecision({ ...row, used_at: now.toISOString() }, who, now)).toBe("used");
    expect(stateDecision(row, { ...who, userId: "user-2" }, now)).toBe("wrong_person");
    expect(stateDecision(row, { ...who, orgId: SPEC }, now)).toBe("wrong_person");
    expect(stateDecision(row, who, new Date(now.getTime() + STATE_TTL_MS))).toBe("expired");
  });

  it("asks Google for offline access to calendar events only", () => {
    const u = new URL(
      buildAuthUrl({
        clientId: "cid.apps.googleusercontent.com",
        redirectUri: gcalRedirectUri("https://pulse.example.test/"),
        state: "s".repeat(43),
      }),
    );
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid.apps.googleusercontent.com",
      redirect_uri: "https://pulse.example.test/api/integrations/google-calendar/callback",
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: "s".repeat(43),
    });
    expect(GOOGLE_SCOPES).toEqual(["https://www.googleapis.com/auth/calendar.events"]);
  });

  it("reads Google's callback strictly", () => {
    const s = "a".repeat(43);
    expect(readCallback(new URLSearchParams({ code: "4/0Abc", state: s }))).toEqual({
      ok: true,
      code: "4/0Abc",
      state: s,
    });
    expect(readCallback(new URLSearchParams({ error: "access_denied", state: s }))).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(readCallback(new URLSearchParams({ code: "x", state: "short" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(readCallback(new URLSearchParams({ code: "a b", state: s }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(readCallback(new URLSearchParams({ state: s }))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("Google adapter (recorded responses, nothing leaves the machine)", () => {
  function client(responses: Array<{ status: number; body?: unknown }>, log: CallRecord[] = []) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const c = createGcalClient({
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "client-secret-test",
      sleep: async () => undefined,
      sink: { record: (r) => void log.push(r) },
      fetchFn: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = responses[Math.min(i++, responses.length - 1)];
        return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
          status: r.status,
        });
      }) as typeof fetch,
    });
    return { c, calls };
  }

  it("exchanges the code once (never retried) and keeps the refresh token", async () => {
    const log: CallRecord[] = [];
    const { c, calls } = client(
      [{ status: 200, body: { access_token: "at-1", expires_in: 3599, refresh_token: "rt-1" } }],
      log,
    );
    expect(await c.exchangeCode("code-1", "https://pulse.example.test/cb")).toEqual({
      ok: true,
      accessToken: "at-1",
      expiresIn: 3599,
      refreshToken: "rt-1",
    });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://pulse.example.test/cb",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "client-secret-test",
    });
    expect(JSON.stringify(log)).not.toMatch(/at-1|rt-1|code-1|client-secret/);
    const flaky = client([{ status: 500 }, { status: 200, body: { access_token: "x" } }]);
    expect(await flaky.c.exchangeCode("code-2", "https://pulse.example.test/cb")).toMatchObject({
      ok: false,
    });
    expect(flaky.calls).toHaveLength(1);
  });

  it("recognises a withdrawn grant on refresh", async () => {
    const { c } = client([{ status: 400, body: { error: "invalid_grant" } }]);
    expect(await c.refresh("rt")).toEqual({
      ok: false,
      code: "invalid_grant",
      revoked: true,
      retryable: false,
    });
  });

  it("lists events asking only for times, status, transparency and the marker", async () => {
    const { c, calls } = client([
      { status: 200, body: { items: [{ id: "e1" }], nextPageToken: "p2" } },
    ]);
    const r = await c.listEvents(
      "at",
      "primary",
      new Date("2026-10-27T00:00:00Z"),
      new Date("2026-12-27T00:00:00Z"),
    );
    expect(r).toEqual({ ok: true, items: [{ id: "e1" }], nextPageToken: "p2" });
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(u.searchParams.get("fields")).toBe(
      "items(id,status,transparency,start,end,extendedProperties/private),nextPageToken",
    );
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(calls[0].url).not.toContain("at&");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("treats 409 on insert as 'already there', 404 on update as gone and 404/410 on delete as done", async () => {
    const event = buildBusyEvent({
      startsAt: "2026-11-01T06:00:00Z",
      endsAt: "2026-11-01T06:30:00Z",
    });
    const id = gcalEventId(ORG, "a");
    const ins = client([{ status: 409, body: { error: { code: 409 } } }]);
    expect(await ins.c.insertEvent("at", "primary", id, event)).toEqual({ ok: true, exists: true });
    expect(JSON.parse(String(ins.calls[0].init.body))).toEqual({ id, ...event });
    expect(await client([{ status: 404 }]).c.updateEvent("at", "primary", id, event)).toMatchObject(
      { ok: false, gone: true },
    );
    const put = client([{ status: 200, body: {} }]);
    await put.c.updateEvent("at", "primary", id, event);
    expect(put.calls[0].init.method).toBe("PUT");
    expect(await client([{ status: 410 }]).c.deleteEvent("at", "primary", id)).toEqual({
      ok: true,
    });
    expect(await client([{ status: 401 }]).c.deleteEvent("at", "primary", id)).toMatchObject({
      ok: false,
      auth: true,
    });
  });
});

describe("settings", () => {
  it("is off by default behind typed words because it shares data with Google", () => {
    const def = integrationDef("google_calendar");
    expect(def.sharesData).toBe(true);
    expect(def.confirmWord).toBe("SYNC CALENDARS WITH GOOGLE");
    expect(def.viewPermission).toBe("integrations.calendar");
    expect(
      allFields("google_calendar", "google")
        .filter((f) => f.secret)
        .map((f) => f.key),
    ).toEqual(["client_secret"]);
    expect(
      validateFields(allFields("google_calendar", "google"), {
        client_id: "not-a-client",
        client_secret: "s",
      }).ok,
    ).toBe(false);
    expect(
      validateFields(allFields("google_calendar", "google"), {
        client_id: "123-abc.apps.googleusercontent.com",
        client_secret: "s",
      }),
    ).toMatchObject({
      ok: true,
      config: { pull_busy: "yes", push_appointments: "yes", window_days: 60 },
    });
  });

  it("reads the configuration conservatively and backs off", () => {
    expect(readGcalConfig({ client_id: "x", pull_busy: "no", window_days: 500 })).toEqual({
      clientId: "x",
      pullBusy: false,
      pushAppointments: true,
      windowDays: 60,
    });
    expect(gcalBackoffMs(1)).toBe(10 * 60_000);
    expect(gcalBackoffMs(50)).toBe(6 * 60 * 60_000);
  });
});
