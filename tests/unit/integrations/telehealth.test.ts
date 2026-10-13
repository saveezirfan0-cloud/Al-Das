import { describe, expect, it } from "vitest";

import { appointmentValueMap, buildAppointmentTemplateValues } from "@/lib/appointments/reminders";
import {
  allFields,
  integrationDef,
  needsConfirmation,
  validateFields,
} from "@/lib/integrations/catalog";
import type { CallRecord } from "@/lib/integrations/client";
import { extraValidation } from "@/lib/integrations/extra-validate";
import { readinessProblems } from "@/lib/integrations/readiness";
import { createDailyProvider } from "@/lib/integrations/telehealth/daily";
import { readTelehealthConfig } from "@/lib/integrations/telehealth/config";
import { createFakeTelehealthProvider } from "@/lib/integrations/telehealth/fake";
import {
  effectiveVisitMode,
  IN_PERSON_TEXT,
  linkAllowedFor,
  roomIsCurrent,
  roomWindow,
  videoLinkValue,
  VIDEO_LINK_PENDING_TEXT,
} from "@/lib/integrations/telehealth/policy";
import { createStaticProvider } from "@/lib/integrations/telehealth/static";
import { hashRoomToken, newRoomToken } from "@/lib/integrations/telehealth/token";
import { buildRoomUrl, validateRoomTemplate } from "@/lib/integrations/telehealth/url";
import { isTemplateSource } from "@/lib/templates/sources";

describe("room address template", () => {
  it("accepts an https address with {token} once, after the host", () => {
    for (const t of [
      "https://meet.example.com/{token}",
      "https://video.clinic.ae/room/{token}/join",
      "https://meet.example.com/join?room={token}",
      "  https://meet.example.com/{token}  ",
    ])
      expect(validateRoomTemplate(t), t).toMatchObject({
        ok: true,
        host: expect.stringMatching(/\.(com|ae)$/),
      });
  });

  it("refuses unsafe or unusable addresses", () => {
    for (const t of [
      "",
      "   ",
      "http://meet.example.com/{token}",
      "https://meet.example.com/",
      "https://meet.example.com/{token}/{token}",
      "https://{token}.example.com/x",
      "https://user:pw@meet.example.com/{token}",
      "https://meet.example.com:8443/{token}",
      "https://127.0.0.1/{token}",
      "https://10.0.0.5/{token}",
      "https://[::1]/{token}",
      "https://2130706433/{token}",
      "https://localhost/{token}",
      "https://meet.local/{token}",
      "https://pulse.internal/{token}",
      "https://printer.lan/{token}",
      "https://singlelabel/{token}",
      "https://meet.example.com/{token} x",
      "javascript:alert(1)//{token}",
      "https://meet.example.com/" + "a".repeat(400) + "{token}",
    ])
      expect(validateRoomTemplate(t).ok, t).toBe(false);
    expect(validateRoomTemplate(undefined).ok).toBe(false);
  });

  it("builds an address from a valid template and a real token only", () => {
    const token = newRoomToken();
    expect(buildRoomUrl("https://meet.example.com/{token}", token)).toBe(
      `https://meet.example.com/${token}`,
    );
    expect(buildRoomUrl("https://meet.example.com/{token}", "short")).toBeNull();
    expect(buildRoomUrl("https://meet.example.com/{token}", "a b".repeat(10))).toBeNull();
    expect(buildRoomUrl("http://meet.example.com/{token}", token)).toBeNull();
  });

  it("is also checked by the settings action and the readiness rules", () => {
    expect(
      extraValidation("telehealth", "static", { url_template: "https://localhost/{token}" }),
    ).toMatch(/public|internal/i);
    expect(
      extraValidation("telehealth", "static", { url_template: "https://meet.example.com/{token}" }),
    ).toBeNull();
    expect(extraValidation("telehealth", "daily", { domain: "myclinic" })).toBeNull();
    expect(extraValidation("sms", "twilio", {})).toBeNull();
  });
});

describe("room tokens", () => {
  it("are 256 random bits as base64url, unique, with a SHA-256 hash for lookup", () => {
    const a = newRoomToken();
    const b = newRoomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashRoomToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRoomToken(a)).toBe(hashRoomToken(a));
    expect(hashRoomToken(a)).not.toContain(a);
    expect(new Set(Array.from({ length: 500 }, newRoomToken)).size).toBe(500);
  });
});

describe("visit mode and room lifetime", () => {
  it("lets the appointment override the service, and defaults to in person", () => {
    expect(effectiveVisitMode(null, null)).toBe("in_person");
    expect(effectiveVisitMode(null, "video")).toBe("video");
    expect(effectiveVisitMode("in_person", "video")).toBe("in_person");
    expect(effectiveVisitMode("video", "in_person")).toBe("video");
    expect(effectiveVisitMode("nonsense", "video")).toBe("video");
    expect(effectiveVisitMode(undefined, undefined)).toBe("in_person");
  });

  it("opens early and closes after the booked end plus the grace", () => {
    const w = roomWindow(new Date("2026-10-20T10:00:00Z"), new Date("2026-10-20T10:30:00Z"), {
      graceMinutes: 30,
      earlyMinutes: 60,
    });
    expect(w.notBefore.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(w.expiresAt.toISOString()).toBe("2026-10-20T11:00:00.000Z");
  });

  it("knows when a stored room no longer fits the appointment", () => {
    const room = {
      status: "active",
      for_starts_at: "2026-10-20T10:00:00Z",
      for_ends_at: "2026-10-20T10:30:00Z",
      expires_at: "2026-10-20T11:00:00Z",
    };
    const appt = { starts_at: "2026-10-20T10:00:00Z", ends_at: "2026-10-20T10:30:00Z" };
    const now = new Date("2026-10-20T09:00:00Z");
    expect(roomIsCurrent(room, appt, now)).toBe(true);
    expect(roomIsCurrent(room, { ...appt, starts_at: "2026-10-20T10:15:00Z" }, now)).toBe(false); // moved
    expect(roomIsCurrent(room, { ...appt, ends_at: "2026-10-20T11:00:00Z" }, now)).toBe(false);
    expect(roomIsCurrent({ ...room, status: "revoked" }, appt, now)).toBe(false);
    expect(roomIsCurrent(room, appt, new Date("2026-10-20T11:00:00Z"))).toBe(false); // expired
  });

  it("gives out a link only for a visit that is still going to happen or just happened", () => {
    for (const s of ["awaiting", "confirmed", "completed"]) expect(linkAllowedFor(s), s).toBe(true);
    for (const s of ["cancelled", "no_show", "weird"]) expect(linkAllowedFor(s), s).toBe(false);
  });

  it("never gives a message an empty value", () => {
    expect(videoLinkValue("video", "https://meet.example.com/abc")).toBe(
      "https://meet.example.com/abc",
    );
    expect(videoLinkValue("video", null)).toBe(VIDEO_LINK_PENDING_TEXT);
    expect(videoLinkValue("in_person", "https://meet.example.com/abc")).toBe(IN_PERSON_TEXT);
    expect(videoLinkValue("in_person", null)).toBe(IN_PERSON_TEXT);
    for (const v of [VIDEO_LINK_PENDING_TEXT, IN_PERSON_TEXT])
      expect(v.trim().length).toBeGreaterThan(0);
  });
});

describe("the reminder pipeline", () => {
  const base = {
    contact: { first_name: "Layla", last_name: "Hassan" },
    startsAt: new Date("2026-10-20T10:00:00Z"),
    timezone: "Asia/Dubai",
  };

  it("exposes appointment.video_link as a template source with a safe default", () => {
    expect(isTemplateSource("appointment.video_link")).toBe(true);
    expect(appointmentValueMap(base)["appointment.video_link"]).toBe(IN_PERSON_TEXT);
    expect(
      appointmentValueMap({ ...base, videoLinkText: "https://meet.example.com/abc" })[
        "appointment.video_link"
      ],
    ).toBe("https://meet.example.com/abc");
    expect(appointmentValueMap({ ...base, videoLinkText: "  " })["appointment.video_link"]).toBe(
      IN_PERSON_TEXT,
    );
  });

  it("fills a template variable mapped to it, and only that one", () => {
    const comps = [{ type: "BODY", text: "Hi {{1}}, join at {{2}}" }] as never;
    const values = buildAppointmentTemplateValues(
      comps,
      { "body.1": "contact.first_name", "body.2": "appointment.video_link" },
      { ...base, videoLinkText: "https://meet.example.com/abc" },
    );
    expect(values).toEqual({ "body.1": "Layla", "body.2": "https://meet.example.com/abc" });
  });
});

describe("static provider", () => {
  it("makes an address without any network call, and cannot end a room", async () => {
    const p = createStaticProvider("https://meet.example.com/{token}")!;
    const token = newRoomToken();
    expect(
      await p.createRoom({ roomName: token, notBefore: new Date(), expiresAt: new Date() }),
    ).toEqual({
      ok: true,
      roomRef: null,
      url: `https://meet.example.com/${token}`,
    });
    expect(await p.deleteRoom("anything")).toBe(true);
    expect(await p.verify!()).toEqual({ ok: true });
    expect(createStaticProvider("https://localhost/{token}")).toBeNull();
    expect(createStaticProvider("")).toBeNull();
  });
});

describe("Daily-style adapter (recorded fake responses)", () => {
  const token = newRoomToken();
  const req = {
    roomName: token,
    notBefore: new Date("2026-10-20T09:00:00Z"),
    expiresAt: new Date("2026-10-20T11:00:00Z"),
  };
  function harness(responses: Array<Response | Error>) {
    const calls: CallRecord[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sleeps: number[] = [];
    let i = 0;
    const provider = createDailyProvider({
      apiKey: "DAILY-SECRET-KEY",
      domain: "myclinic",
      fetchFn: (async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        const next = responses[Math.min(i++, responses.length - 1)];
        if (next instanceof Error) throw next;
        return next.clone();
      }) as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      rng: () => 0.5,
      sink: { record: (c) => void calls.push(c) },
    })!;
    return { provider, calls, requests, sleeps };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("creates a private, expiring, unrecorded room named by the token and builds the address itself", async () => {
    const h = harness([
      json(200, { id: "x", name: token, url: "https://evil.example/ignored", privacy: "public" }),
    ]);
    const r = await h.provider.createRoom(req);
    expect(r).toEqual({ ok: true, roomRef: token, url: `https://myclinic.daily.co/${token}` });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe("https://api.daily.co/v1/rooms");
    const init = h.requests[0].init!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer DAILY-SECRET-KEY");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      name: token,
      privacy: "public",
      properties: {
        nbf: 1_792_486_800,
        exp: 1_792_494_000,
        eject_at_room_exp: true,
        max_participants: 6,
      },
    });
    // no recording, no patient detail, no key in the log
    expect(JSON.stringify(body)).not.toMatch(/record|patient|name_of|appointment|phone/i);
    expect(JSON.stringify(h.calls)).not.toMatch(/DAILY-SECRET|myclinic|rooms\//);
    expect(h.calls[0]).toMatchObject({
      provider: "daily",
      operation: "telehealth.create_room",
      outcome: "ok",
    });
  });

  it("treats 'already exists' (a repeat after a lost answer) as success and a bad key as an auth failure", async () => {
    const again = harness([
      json(400, { error: "invalid-request-error", info: `a room named ${token} already exists` }),
    ]);
    expect(await again.provider.createRoom(req)).toMatchObject({ ok: true, roomRef: token });
    expect(
      await harness([json(401, { error: "authentication-error" })]).provider.createRoom(req),
    ).toEqual({
      ok: false,
      code: "auth",
      retryable: false,
    });
    expect(
      await harness([
        json(400, { error: "invalid-request-error", info: "bad nbf" }),
      ]).provider.createRoom(req),
    ).toEqual({
      ok: false,
      code: "http_400",
      retryable: false,
    });
  });

  it("retries an outage with back-off and reports a persistent one as retryable", async () => {
    const h = harness([json(503, {}), json(200, { name: token })]);
    expect(await h.provider.createRoom(req)).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(2);
    expect(h.sleeps).toHaveLength(1);
    expect(await harness([json(500, {})]).provider.createRoom(req)).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it("deletes a room (a missing one counts as gone), refuses names that are not ours and reports a failure", async () => {
    const ok = harness([json(200, { deleted: true, name: token })]);
    expect(await ok.provider.deleteRoom(token)).toBe(true);
    expect(ok.requests[0].url).toBe(`https://api.daily.co/v1/rooms/${token}`);
    expect(ok.requests[0].init?.method).toBe("DELETE");
    expect(await harness([json(404, { error: "not-found" })]).provider.deleteRoom(token)).toBe(
      true,
    );
    const none = harness([json(200, {})]);
    expect(await none.provider.deleteRoom("../../etc/passwd")).toBe(true);
    expect(none.requests).toHaveLength(0);
    expect(await harness([json(500, {})]).provider.deleteRoom(token)).toBe(false);
  });

  it("verifies the key without creating anything", async () => {
    const ok = harness([json(200, { domain_name: "myclinic" })]);
    expect(await ok.provider.verify!()).toEqual({ ok: true });
    expect(ok.requests[0].url).toBe("https://api.daily.co/v1/");
    expect(ok.requests[0].init?.method).toBe("GET");
    expect(await harness([json(401, {})]).provider.verify!()).toEqual({ ok: false, code: "auth" });
  });

  it("only ever talks to api.daily.co, and refuses a bad domain or an empty key", async () => {
    const h = harness([json(200, {})]);
    await h.provider.createRoom(req);
    await h.provider.deleteRoom(token);
    for (const r of h.requests) expect(new URL(r.url).hostname).toBe("api.daily.co");
    expect(createDailyProvider({ apiKey: "k", domain: "Bad Domain" })).toBeNull();
    expect(createDailyProvider({ apiKey: "k", domain: "evil.com/x" })).toBeNull();
    expect(createDailyProvider({ apiKey: "", domain: "myclinic" })).toBeNull();
  });

  it("the fake records rooms and can fail on demand", async () => {
    const f = createFakeTelehealthProvider({ failCreate: { code: "boom", retryable: true } });
    expect(await f.createRoom(req)).toEqual({ ok: false, code: "boom", retryable: true });
    const g = createFakeTelehealthProvider();
    expect(await g.createRoom(req)).toMatchObject({ ok: true });
    expect(g.created).toHaveLength(1);
  });
});

describe("settings", () => {
  it("is a patient-contacting integration with a typed confirmation and one secret (Daily's key)", () => {
    const d = integrationDef("telehealth");
    expect(d.contactsPatients).toBe(true);
    expect(needsConfirmation("telehealth")).toBe(true);
    expect(d.confirmWord).toBe("ENABLE VIDEO VISITS");
    expect(
      allFields("telehealth", "daily")
        .filter((f) => f.secret)
        .map((f) => f.key),
    ).toEqual(["api_key"]);
    expect(allFields("telehealth", "static").filter((f) => f.secret)).toEqual([]);
  });

  it("validates each provider's own fields", () => {
    const stat = allFields("telehealth", "static");
    expect(validateFields(stat, {})).toMatchObject({ ok: false });
    expect(validateFields(stat, { url_template: "https://meet.example.com/room" })).toMatchObject({
      ok: false,
    });
    expect(
      validateFields(stat, { url_template: "https://meet.example.com/{token}" }),
    ).toMatchObject({
      ok: true,
      config: {
        url_template: "https://meet.example.com/{token}",
        grace_minutes: 30,
        early_minutes: 60,
      },
    });
    const daily = allFields("telehealth", "daily");
    expect(validateFields(daily, { api_key: "k", domain: "My Clinic" })).toMatchObject({
      ok: false,
    });
    expect(
      validateFields(daily, { api_key: "k", domain: "myclinic", grace_minutes: 500 }),
    ).toMatchObject({ ok: false });
    expect(validateFields(daily, { api_key: "k", domain: "myclinic" })).toMatchObject({
      ok: true,
      secrets: { api_key: "k" },
    });
  });

  it("is ready only with a usable address (static) or key and domain (Daily)", () => {
    const base = { kind: "telehealth" as const, secretsStored: {} };
    expect(readinessProblems({ ...base, provider: null, config: {} })).toEqual([
      "Choose a provider.",
    ]);
    expect(
      readinessProblems({
        ...base,
        provider: "static",
        config: { url_template: "https://meet.example.com/{token}" },
      }),
    ).toEqual([]);
    expect(
      readinessProblems({
        ...base,
        provider: "static",
        config: { url_template: "https://localhost/{token}" },
      })[0],
    ).toMatch(/not valid/);
    expect(
      readinessProblems({ ...base, provider: "daily", config: { domain: "myclinic" } }),
    ).toEqual(["API key is missing."]);
    expect(
      readinessProblems({
        ...base,
        provider: "daily",
        config: { domain: "myclinic" },
        secretsStored: { api_key: true },
      }),
    ).toEqual([]);
  });

  it("reads settings with defaults", () => {
    expect(readTelehealthConfig({})).toEqual({
      provider: "static",
      urlTemplate: "",
      dailyDomain: "",
      graceMinutes: 30,
      earlyMinutes: 60,
    });
    expect(
      readTelehealthConfig({
        provider: "daily",
        domain: " MyClinic ",
        grace_minutes: 10,
        early_minutes: 999,
      }),
    ).toMatchObject({
      provider: "daily",
      dailyDomain: "myclinic",
      graceMinutes: 10,
      earlyMinutes: 60,
    });
  });
});
