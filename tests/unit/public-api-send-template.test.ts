import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: vi.fn(async () => 1), scheduleJob: vi.fn(async () => undefined) }));

import { enqueue } from "@/lib/jobs/enqueue";
import { sendTemplateSchema, sendTemplateViaApi } from "@/lib/public-api/send-template";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

const TEMPLATE_ID = "7a1f3a52-0a3b-4b8e-9a43-1f2e3d4c5b6a";
const body = (text: string) => ({ type: "BODY", text });
const TEMPLATE = {
  id: TEMPLATE_ID, org_id: "org1", waba_id: "w1", name: "appt_reminder", language: "en", status: "APPROVED", category: "UTILITY", archived_at: null,
  components: [body("Hi {{1}}, see you {{2}}")],
};
const CHANNEL = { id: "ch1", org_id: "org1", waba_id: "w1", status: "active" };

function setup(seed: Record<string, Record<string, unknown>[]> = {}) {
  const admin = createFakeAdmin(
    { orgs: [{ id: "org1", settings: {} }], channels: [CHANNEL], wa_templates: [TEMPLATE], contacts: [], conversations: [], messages: [], ...seed },
    {
      unique: { contacts: [["org_id", "phone_e164"]] },
      defaults: {
        contacts: () => ({ first_name: "", last_name: "", stop_marketing: false, deleted_at: null }),
        conversations: () => ({ status: "open", unread_count: 0 }),
      },
    },
  );
  return { admin, as: admin as unknown as AdminClient };
}

const input = (over: Record<string, unknown> = {}) =>
  sendTemplateSchema.parse({ to: "+971501234567", template: "appt_reminder", language: "en", variables: { "body.1": "Amal", "body.2": "Tuesday 10:00" }, ...over });

beforeEach(() => vi.mocked(enqueue).mockClear());

describe("sendTemplateSchema", () => {
  it("is strict and bounded", () => {
    expect(sendTemplateSchema.safeParse({ to: "+971501234567", template: "t", language: "en" }).success).toBe(true);
    expect(sendTemplateSchema.safeParse({ to: "+971501234567", template: "t", language: "en", conversation_id: "x" }).success).toBe(false);
    expect(sendTemplateSchema.safeParse({ to: "", template: "t", language: "en" }).success).toBe(false);
    expect(sendTemplateSchema.safeParse({ to: "+97150", template: "t", language: "e" }).success).toBe(false);
    expect(sendTemplateSchema.safeParse({ to: "+97150", template: "t", language: "en", variables: { a: "x".repeat(2000) } }).success).toBe(false);
    expect(sendTemplateSchema.safeParse({ to: "+97150", template: "t", language: "en", channel_id: "nope" }).success).toBe(false);
  });
});

describe("sendTemplateViaApi", () => {
  it("creates the contact and conversation, queues the rendered message on the standard lane, and returns ids", async () => {
    const { admin, as } = setup();
    const r = await sendTemplateViaApi(as, "org1", input({ contact: { first_name: "Amal" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe("queued");

    expect(admin._rows("contacts")).toHaveLength(1);
    expect(admin._rows("contacts")[0]).toMatchObject({ org_id: "org1", phone_e164: "+971501234567", first_name: "Amal", source: "api" });
    expect(admin._rows("conversations")).toHaveLength(1);
    const msg = admin._rows("messages")[0];
    expect(msg).toMatchObject({ org_id: "org1", direction: "out", kind: "template", status: "queued", body: "Hi Amal, see you Tuesday 10:00", sent_by_user_id: null });
    expect((msg.payload as { send: unknown }).send).toEqual({ type: "template", template_id: TEMPLATE_ID, values: { "body.1": "Amal", "body.2": "Tuesday 10:00" } });
    // queued, never sent inline, and not on the live-chat priority lane
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueue).mock.calls[0]).toEqual(["outbound", { message_id: msg.id }]);
  });

  it("reuses the existing contact and the live conversation on that number", async () => {
    const { admin, as } = setup({
      contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", first_name: "Amal", stop_marketing: false, deleted_at: null }],
      conversations: [{ id: "v1", org_id: "org1", channel_id: "ch1", contact_id: "c1", status: "waiting" }],
    });
    const r = await sendTemplateViaApi(as, "org1", input());
    expect(r.ok && r.data).toMatchObject({ contact_id: "c1", conversation_id: "v1" });
    expect(admin._rows("contacts")).toHaveLength(1);
    expect(admin._rows("conversations")).toHaveLength(1);
  });

  it("opens a new conversation when the previous one is closed", async () => {
    const { admin, as } = setup({
      contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", stop_marketing: false, deleted_at: null }],
      conversations: [{ id: "v1", org_id: "org1", channel_id: "ch1", contact_id: "c1", status: "closed" }],
    });
    const r = await sendTemplateViaApi(as, "org1", input());
    expect(r.ok && r.data.conversation_id).not.toBe("v1");
    expect(admin._rows("conversations")).toHaveLength(2);
  });

  it("normalises a national-format number", async () => {
    const { admin, as } = setup();
    await sendTemplateViaApi(as, "org1", input({ to: "050 123 4567" }));
    expect(admin._rows("contacts")[0].phone_e164).toBe("+971501234567");
  });

  describe("refuses, and queues nothing, when", () => {
    const expectRefused = async (r: Awaited<ReturnType<typeof sendTemplateViaApi>>, admin: ReturnType<typeof setup>["admin"], status: number, code: string) => {
      expect(r).toMatchObject({ ok: false, status, code });
      expect(admin._rows("messages")).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    };

    it("the phone is invalid", async () => {
      const { admin, as } = setup();
      await expectRefused(await sendTemplateViaApi(as, "org1", input({ to: "123" })), admin, 422, "invalid_phone");
    });

    it("the workspace has no active number", async () => {
      const { admin, as } = setup({ channels: [{ ...CHANNEL, status: "paused" }] });
      await expectRefused(await sendTemplateViaApi(as, "org1", input()), admin, 422, "no_active_channel");
    });

    it("there are several numbers and none was chosen", async () => {
      const { admin, as } = setup({ channels: [CHANNEL, { ...CHANNEL, id: "ch2", waba_id: "w2" }] });
      const r = await sendTemplateViaApi(as, "org1", input());
      await expectRefused(r, admin, 422, "channel_required");
      expect(!r.ok && r.details).toEqual({ channel_ids: ["ch1", "ch2"] });
    });

    it("the chosen number belongs to another org or is not active", async () => {
      const { admin, as } = setup({ channels: [CHANNEL, { id: "chB", org_id: "orgB", waba_id: "wB", status: "active" }] });
      await expectRefused(await sendTemplateViaApi(as, "org1", input({ channel_id: "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e" })), admin, 422, "channel_not_found");
    });

    it("the template does not exist in that language, or is archived, or is another org's", async () => {
      for (const seed of [
        { wa_templates: [{ ...TEMPLATE, language: "ar" }] },
        { wa_templates: [{ ...TEMPLATE, archived_at: "2026-01-01" }] },
        { wa_templates: [{ ...TEMPLATE, org_id: "orgB" }] },
      ]) {
        vi.mocked(enqueue).mockClear();
        const { admin, as } = setup(seed);
        await expectRefused(await sendTemplateViaApi(as, "org1", input()), admin, 404, "template_not_found");
      }
    });

    it("the template is not approved", async () => {
      for (const status of ["PENDING", "REJECTED", "PAUSED"]) {
        vi.mocked(enqueue).mockClear();
        const { admin, as } = setup({ wa_templates: [{ ...TEMPLATE, status }] });
        await expectRefused(await sendTemplateViaApi(as, "org1", input()), admin, 422, "template_not_approved");
      }
    });

    it("a variable is missing", async () => {
      const { admin, as } = setup();
      const r = await sendTemplateViaApi(as, "org1", input({ variables: { "body.1": "Amal" } }));
      await expectRefused(r, admin, 422, "missing_variables");
      expect(!r.ok && r.details).toEqual({ missing: ["body.2"] });
    });

    it("the template needs a media header", async () => {
      const { admin, as } = setup({ wa_templates: [{ ...TEMPLATE, components: [{ type: "HEADER", format: "IMAGE" }, body("Hi {{1}}")] }] });
      await expectRefused(await sendTemplateViaApi(as, "org1", input({ variables: { "body.1": "A" } })), admin, 422, "unsupported_template");
    });

    it("a marketing template targets a contact who opted out", async () => {
      const { admin, as } = setup({
        wa_templates: [{ ...TEMPLATE, category: "MARKETING" }],
        contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", stop_marketing: true, deleted_at: null }],
      });
      await expectRefused(await sendTemplateViaApi(as, "org1", input()), admin, 422, "recipient_opted_out");
      expect(admin._rows("conversations")).toHaveLength(0);
    });
  });

  it("still sends a utility template to a contact who opted out of marketing", async () => {
    const { as } = setup({ contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", stop_marketing: true, deleted_at: null }] });
    expect((await sendTemplateViaApi(as, "org1", input())).ok).toBe(true);
  });

  it("sends a marketing template to a contact who has not opted out", async () => {
    const { as } = setup({ wa_templates: [{ ...TEMPLATE, category: "MARKETING" }] });
    expect((await sendTemplateViaApi(as, "org1", input())).ok).toBe(true);
  });

  it("scopes everything to the calling org", async () => {
    const { admin, as } = setup({ contacts: [{ id: "cB", org_id: "orgB", phone_e164: "+971501234567", stop_marketing: true, deleted_at: null }] });
    const r = await sendTemplateViaApi(as, "org1", input());
    expect(r.ok && r.data.contact_id).not.toBe("cB"); // org B's opted-out contact is irrelevant to org A
    expect(admin._rows("contacts")).toHaveLength(2);
  });
});
