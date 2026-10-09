import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseWebhookBody,
  previewFor,
  resolveIdentity,
  type WebhookEvent,
} from "@/lib/whatsapp/parse";

const FIXTURES = path.resolve(__dirname, "../../scripts/wa-fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

function one(name: string): WebhookEvent {
  const res = parseWebhookBody(load(name));
  if (!res.ok) throw new Error(res.error);
  expect(res.events).toHaveLength(1);
  return res.events[0];
}

describe("parseWebhookBody", () => {
  it("parses every fixture without unknown events", () => {
    for (const file of readdirSync(FIXTURES)) {
      const res = parseWebhookBody(load(file.replace(/\.json$/, "")));
      expect(res.ok, file).toBe(true);
      if (!res.ok) continue;
      expect(res.events.length, file).toBeGreaterThan(0);
      expect(
        res.events.filter((e) => e.kind === "unknown"),
        file,
      ).toHaveLength(0);
    }
  });

  it("rejects bodies that are not whatsapp_business_account", () => {
    expect(parseWebhookBody({ object: "page", entry: [] })).toMatchObject({ ok: false });
    expect(parseWebhookBody(null)).toMatchObject({ ok: false });
    expect(parseWebhookBody({ object: "whatsapp_business_account" })).toMatchObject({ ok: false });
  });

  it("text message: phone identity, body, waba + phone number id", () => {
    const e = one("message-text");
    expect(e.kind).toBe("message");
    if (e.kind !== "message") return;
    expect(e.type).toBe("text");
    expect(e.body).toBe("Hello, I would like to book an appointment");
    expect(e.identity.phoneE164).toBe("+971500000001");
    expect(e.identity.bsuid).toBeNull();
    expect(e.identity.profileName).toBe("Test Patient");
    expect(e.phoneNumberId).toBe("100000000000001");
    expect(e.wabaId).toBe("200000000000001");
    expect(e.timestamp.toISOString()).toBe("2025-10-09T08:53:20.000Z");
    expect(e.media).toBeNull();
    expect(e.replyToWaMessageId).toBeNull();
  });

  it("reply context is captured", () => {
    const e = one("message-text-reply");
    if (e.kind !== "message") throw new Error();
    expect(e.replyToWaMessageId).toBe("wamid.FIXTURE_OUT_1");
  });

  it.each([
    ["message-image", "image", "MEDIA_IMG_1", "my insurance card", false],
    ["message-video", "video", "MEDIA_VID_1", null, false],
    ["message-audio", "audio", "MEDIA_AUD_1", null, true],
    ["message-document", "document", "MEDIA_DOC_1", "lab report", false],
    ["message-sticker", "sticker", "MEDIA_STK_1", null, false],
  ])("%s → media %s", (fixture, type, mediaId, caption, voice) => {
    const e = one(fixture);
    if (e.kind !== "message") throw new Error();
    expect(e.type).toBe(type);
    expect(e.media?.metaId).toBe(mediaId);
    expect(e.media?.voice).toBe(voice);
    expect(e.body).toBe(caption);
    if (type === "document") expect(e.media?.filename).toBe("report.pdf");
  });

  it("location", () => {
    const e = one("message-location");
    if (e.kind !== "message") throw new Error();
    expect(e.type).toBe("location");
    expect(e.location).toEqual({
      latitude: 25.0772,
      longitude: 55.1332,
      name: "Al Das Medical Clinic",
      address: "Palm Jumeirah, Dubai",
    });
    expect(e.body).toBe("Al Das Medical Clinic");
  });

  it("contacts card", () => {
    const e = one("message-contacts");
    if (e.kind !== "message") throw new Error();
    expect(e.type).toBe("contacts");
    expect(e.body).toBe("Sample Relative");
  });

  it("interactive button and list replies", () => {
    const b = one("message-interactive-button");
    if (b.kind !== "message") throw new Error();
    expect(b.interactive).toEqual({
      type: "button_reply",
      id: "confirm",
      title: "Confirm",
      payload: null,
    });
    expect(b.body).toBe("Confirm");
    const l = one("message-interactive-list");
    if (l.kind !== "message") throw new Error();
    expect(l.interactive?.type).toBe("list_reply");
    expect(l.interactive?.id).toBe("svc_derma");
  });

  it("template quick-reply button", () => {
    const e = one("message-button");
    if (e.kind !== "message") throw new Error();
    expect(e.type).toBe("button");
    expect(e.interactive).toMatchObject({
      type: "template_button",
      id: "RESCHEDULE",
      title: "Reschedule",
    });
    expect(e.replyToWaMessageId).toBe("wamid.FIXTURE_OUT_4");
  });

  it("reaction", () => {
    const e = one("message-reaction");
    if (e.kind !== "message") throw new Error();
    expect(e.type).toBe("reaction");
    expect(e.reaction).toEqual({ messageId: "wamid.FIXTURE_OUT_1", emoji: "👍" });
  });

  it("unsupported message keeps Meta's errors", () => {
    const e = one("message-unsupported");
    if (e.kind !== "message") throw new Error();
    expect(e.type).toBe("unsupported");
    expect(e.errors).toHaveLength(1);
  });

  it("CTWA referral is captured", () => {
    const e = one("message-referral");
    if (e.kind !== "message") throw new Error();
    expect(e.referral).toMatchObject({ source_type: "ad", ctwa_clid: "CLID_EXAMPLE" });
  });

  it("username (BSUID) user without a phone", () => {
    const e = one("message-username-bsuid");
    if (e.kind !== "message") throw new Error();
    expect(e.identity.phoneE164).toBeNull();
    expect(e.identity.bsuid).toBe("BSUID_EXAMPLE_0001");
    expect(e.identity.username).toBe("username_patient");
    expect(e.identity.waId).toBe("BSUID_EXAMPLE_0001");
  });

  it("statuses incl. errors", () => {
    const sent = one("status-sent");
    expect(sent).toMatchObject({
      kind: "status",
      status: "sent",
      waMessageId: "wamid.FIXTURE_OUT_1",
      conversationOrigin: "service",
      billable: true,
    });
    if (sent.kind === "status")
      expect(sent.conversationExpiresAt?.toISOString()).toBe("2025-10-10T08:53:20.000Z");
    const failed = one("status-failed");
    expect(failed).toMatchObject({ kind: "status", status: "failed", errorCode: 131047 });
    if (failed.kind === "status") expect(failed.errorMessage).toContain("24 hours");
    const stop = one("status-failed-stop-marketing");
    expect(stop).toMatchObject({ kind: "status", errorCode: 131050 });
    expect(one("status-deleted")).toMatchObject({ kind: "status", status: "deleted" });
  });

  it("template, phone, account and user-id updates", () => {
    expect(one("template-status-update")).toMatchObject({
      kind: "template_status",
      templateId: "300000000000001",
      name: "appointment_reminder",
      language: "en",
      event: "APPROVED",
      reason: null,
    });
    expect(one("template-status-rejected")).toMatchObject({
      kind: "template_status",
      event: "REJECTED",
      reason: "INVALID_FORMAT",
    });
    expect(one("template-category-update")).toMatchObject({
      kind: "template_category",
      previousCategory: "MARKETING",
      newCategory: "UTILITY",
    });
    expect(one("template-quality-update")).toMatchObject({
      kind: "template_quality",
      previousQuality: "GREEN",
      newQuality: "YELLOW",
    });
    expect(one("phone-quality-update")).toMatchObject({
      kind: "phone_quality",
      event: "DOWNGRADE",
      currentLimit: "TIER_1K",
      oldLimit: "TIER_10K",
    });
    expect(one("account-update")).toMatchObject({
      kind: "account_update",
      event: "VERIFIED_ACCOUNT",
    });
    expect(one("user-id-update")).toMatchObject({
      kind: "user_id_update",
      phoneNumberId: "100000000000001",
      oldBsuid: "BSUID_EXAMPLE_0001",
      newBsuid: "BSUID_EXAMPLE_0002",
      phoneE164: "+971500000001",
    });
    expect(one("business-username-update")).toMatchObject({
      kind: "business_username",
      username: "aldas_clinic",
    });
  });

  it("a batch yields one event per message and status, in order", () => {
    const res = parseWebhookBody(load("batch-mixed"));
    if (!res.ok) throw new Error(res.error);
    expect(res.events.map((e) => e.kind)).toEqual(["message", "message", "status"]);
  });

  it("unknown fields are reported, not dropped", () => {
    const res = parseWebhookBody({
      object: "whatsapp_business_account",
      entry: [{ id: "w", changes: [{ field: "calls", value: { foo: 1 } }] }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.events[0]).toMatchObject({ kind: "unknown", field: "calls" });
  });
});

describe("resolveIdentity", () => {
  it("prefers the matching contact and falls back to the first", () => {
    const id = resolveIdentity("971500000009", [
      { wa_id: "971500000001", profile: { name: "A" } },
      { wa_id: "971500000009", profile: { name: "B" }, user_id: "BS9" },
    ]);
    expect(id.profileName).toBe("B");
    expect(id.bsuid).toBe("BS9");
    expect(id.phoneE164).toBe("+971500000009");
  });
  it("treats a non-numeric from as a BSUID when no contact says otherwise", () => {
    const id = resolveIdentity("ABCDEF123", undefined);
    expect(id.phoneE164).toBeNull();
    expect(id.bsuid).toBe("ABCDEF123");
  });
});

describe("previewFor", () => {
  it("summarises kinds without leaking media contents", () => {
    expect(previewFor("text", "hello")).toBe("hello");
    expect(previewFor("image", null)).toBe("📷 Photo");
    expect(previewFor("audio", null)).toBe("🎤 Voice message");
    expect(previewFor("document", null, "x.pdf")).toBe("📄 x.pdf");
    expect(previewFor("note", "internal")).toBe("📝 internal");
    expect(previewFor("whatever", null)).toBe("Unsupported message");
    expect(previewFor("text", "x".repeat(300)).length).toBe(140);
  });
});
