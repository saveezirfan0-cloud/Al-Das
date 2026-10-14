/**
 * Sanoflow parity G11 server actions with the session, the database and the queue replaced by fakes:
 *   - permission gating (inbox.send for every send; contacts.manage AND inbox.send to move a chat), refused before
 *     the service role is created
 *   - every send goes through queueOutbound, never outside the reply window, never a template fallback
 *   - a forwarded file is copied from the source conversation's own folder into the target's folder
 *   - catalogue products need the number's catalogue; contact cards and products are WhatsApp only
 *   - audit rows carry ids and counts only (no message text, names or numbers)
 * No network. Synthetic ids, names and reserved +44 7700 900xxx numbers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  rows: {} as Record<string, Row[]>,
  queued: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  copies: [] as Array<[string, string]>,
  rpc: [] as Array<[string, Record<string, unknown>]>,
  rpcResult: null as { data: unknown; error: { message: string; code?: string } | null } | null,
  takeovers: [] as string[],
  removed: [] as string[],
  queueFails: false,
}));

const ORG = "00000000-0000-4000-8000-000000000002";
const ME = "00000000-0000-4000-8000-000000000001";
const SRC_CONV = "00000000-0000-4000-8000-0000000000c1";
const DST_CONV = "00000000-0000-4000-8000-0000000000c2";
const MSG = "00000000-0000-4000-8000-0000000000a1";
const MEDIA_MSG = "00000000-0000-4000-8000-0000000000a2";
const NEW_CONTACT = "00000000-0000-4000-8000-0000000000d2";
const OLD_CONTACT = "00000000-0000-4000-8000-0000000000d1";
const SRC_PATH = `${ORG}/${SRC_CONV}/00000000-0000-4000-8000-0000000000f1.jpg`;

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", async () => {
  const can = (await import("@/lib/auth/can")) as { assertCan: (m: unknown, p: string) => void };
  const member = () => ({
    userId: ME,
    orgId: ORG,
    roleId: "r",
    roleName: "Test",
    status: "active" as const,
    permissions: state.permissions,
    org: { name: "Test", timezone: "Asia/Dubai", settings: {}, is_training: false },
    profile: { first_name: "T", last_name: "U" },
    user: { email: "t@example.test" },
    orgs: [],
  });
  return {
    requirePerm: async (p: string) => {
      const m = member();
      can.assertCan(m, p);
      return m;
    },
    requireMember: async () => member(),
  };
});

/** A tiny PostgREST-like builder over state.rows: eq filters, maybeSingle, or awaited lists. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () =>
        (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => !(k in r) || r[k] === v));
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return b;
        },
        gte: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(res),
      };
      return b;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    return {
      storage: {
        from: () => ({
          copy: async (from: string, to: string) => {
            state.copies.push([from, to]);
            return { data: {}, error: null };
          },
          remove: async (paths: string[]) => {
            state.removed.push(...paths);
            return { data: [], error: null };
          },
        }),
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        state.rpc.push([name, args]);
        return state.rpcResult ?? { data: null, error: { message: "no result" } };
      },
    };
  },
}));
vi.mock("@/lib/inbox/send", () => ({
  queueOutbound: async (_admin: unknown, input: Record<string, unknown>) => {
    if (state.queueFails) throw new Error("queueOutbound: insert failed");
    state.queued.push(input);
    return { id: "00000000-0000-4000-8000-0000000000e1" };
  },
}));
vi.mock("@/lib/flow-engine/takeover", () => ({
  takeOverFromBot: async (_a: unknown, id: string) => {
    state.takeovers.push(id);
    return false;
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, entry: Record<string, unknown>) => {
    state.audits.push(entry);
  },
}));

import * as extras from "@/app/(app)/inbox/extras-actions";
import { SENDER_ERRORS } from "@/lib/inbox/unlink";

const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const old = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

function conv(id: string, over: Row = {}, channel: Row = {}): Row {
  return {
    id,
    org_id: ORG,
    channel_id: "00000000-0000-4000-8000-0000000000b1",
    contact_id: OLD_CONTACT,
    status: "open",
    last_inbound_at: recent(),
    ad_referral: null,
    opened_at: recent(),
    channels: { id: "ch", type: "whatsapp", status: "active", catalog_id: "998877", ...channel },
    ...over,
  };
}

function setup(...permissions: string[]) {
  state.permissions = permissions;
  state.adminCalls = 0;
  state.queued = [];
  state.audits = [];
  state.copies = [];
  state.rpc = [];
  state.rpcResult = null;
  state.takeovers = [];
  state.removed = [];
  state.queueFails = false;
  state.rows = {
    conversations: [conv(SRC_CONV), conv(DST_CONV)],
    contacts: [{ id: OLD_CONTACT, org_id: ORG, phone_e164: "+447700900311", wa_bsuid: null }],
    messages: [
      {
        id: "00000000-0000-4000-8000-0000000000a3",
        org_id: ORG,
        conversation_id: DST_CONV,
        direction: "in",
        kind: "text",
        body: "synthetic",
        payload: { from: "447700900311" },
        media_path: null,
        media_mime: null,
        media_filename: null,
      },
      {
        id: MSG,
        org_id: ORG,
        conversation_id: SRC_CONV,
        direction: "in",
        kind: "text",
        body: "Synthetic text from Layla Demo-07",
        media_path: null,
        media_mime: null,
        media_filename: null,
      },
      {
        id: MEDIA_MSG,
        org_id: ORG,
        conversation_id: SRC_CONV,
        direction: "in",
        kind: "image",
        body: "caption",
        media_path: SRC_PATH,
        media_mime: "image/jpeg",
        media_filename: null,
      },
    ],
  };
}

const forward = (message_id = MSG, target = DST_CONV) =>
  extras.forwardMessage({ message_id, target_conversation_id: target });
const card = () =>
  extras.sendContactCard({ conversation_id: DST_CONV, name: "Demo Lab", phone: "+447700900123" });
const product = (ids = ["sku-1"]) =>
  extras.sendCatalogProduct({ conversation_id: DST_CONV, retailer_ids: ids });
const unlink = () =>
  extras.unlinkConversationContact({
    conversation_id: DST_CONV,
    first_name: "Layla",
    last_name: "Demo-07",
    keep_household: true,
    relationship: "spouse",
  });

describe("permissions", () => {
  beforeEach(() => setup("contacts.view", "contacts.manage"));

  it("every send needs inbox.send and never reaches the service role without it", async () => {
    for (const call of [forward, card, product, () => extras.listForwardTargets({})])
      await expect(call()).rejects.toThrow();
    expect(state.adminCalls).toBe(0);
    expect(state.queued).toHaveLength(0);
  });

  it("moving a chat needs contacts.manage as well as inbox.send", async () => {
    setup("inbox.send");
    await expect(unlink()).rejects.toThrow();
    setup("contacts.manage");
    expect(await unlink()).toEqual({ ok: false, error: "You don't have permission for that." });
    expect(state.adminCalls).toBe(0);
    expect(state.rpc).toHaveLength(0);
  });
});

describe("forwardMessage", () => {
  beforeEach(() => setup("inbox.send"));

  it("queues the text through queueOutbound and audits ids only", async () => {
    const r = await forward();
    expect(r.ok).toBe(true);
    expect(state.queued).toHaveLength(1);
    expect(state.queued[0]).toMatchObject({
      orgId: ORG,
      conversationId: DST_CONV,
      spec: { type: "text", body: "Synthetic text from Layla Demo-07" },
      sentByUserId: ME,
    });
    expect(state.takeovers).toEqual([DST_CONV]);
    expect(state.audits).toHaveLength(1);
    const audit = JSON.stringify(state.audits[0]);
    expect(audit).not.toMatch(/Layla|Synthetic|\+44/);
    expect(state.audits[0]).toMatchObject({
      action: "message.forwarded",
      diff: {
        source_message_id: MSG,
        from_conversation_id: SRC_CONV,
        to_conversation_id: DST_CONV,
      },
    });
  });

  it("copies a file into the target conversation's folder and sends it as media", async () => {
    const r = await forward(MEDIA_MSG);
    expect(r.ok).toBe(true);
    expect(state.copies).toHaveLength(1);
    const [from, to] = state.copies[0];
    expect(from).toBe(SRC_PATH);
    expect(to.startsWith(`${ORG}/${DST_CONV}/`)).toBe(true);
    expect(to.endsWith(".jpg")).toBe(true);
    expect(state.queued[0].spec).toMatchObject({
      type: "media",
      media_type: "image",
      media_path: to,
      mime_type: "image/jpeg",
      caption: "caption",
    });
  });

  it("refuses a file whose stored path is outside the source conversation", async () => {
    (state.rows.messages.find((m) => m.id === MEDIA_MSG) as Row).media_path =
      `${ORG}/${DST_CONV}/00000000-0000-4000-8000-0000000000f9.jpg`;
    const r = await forward(MEDIA_MSG);
    expect(r.ok).toBe(false);
    expect(state.copies).toHaveLength(0);
    expect(state.queued).toHaveLength(0);
  });

  it("removes the copied file and leaves the bot alone when queueing fails", async () => {
    state.queueFails = true;
    await expect(forward(MEDIA_MSG)).rejects.toThrow(/queueOutbound/);
    expect(state.copies).toHaveLength(1);
    expect(state.removed).toEqual([state.copies[0][1]]);
    expect(state.takeovers).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
    await expect(card()).rejects.toThrow();
    await expect(product()).rejects.toThrow();
    expect(state.takeovers).toHaveLength(0);
  });

  it("refuses outside the 24-hour window with no template fallback", async () => {
    state.rows.conversations[1] = conv(DST_CONV, { last_inbound_at: old() });
    const r = await forward();
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(/^Forwarding can only be sent within 24 hours/),
    });
    expect(state.queued).toHaveLength(0);
  });

  it("refuses the same conversation, an unknown message and a paused number", async () => {
    expect((await forward(MSG, SRC_CONV)).ok).toBe(false);
    expect((await forward("00000000-0000-4000-8000-0000000000ff")).ok).toBe(false);
    state.rows.conversations[1] = conv(DST_CONV, {}, { status: "paused" });
    expect((await forward()).ok).toBe(false);
    expect(state.queued).toHaveLength(0);
  });

  it("forwards text but not files to a text-only channel", async () => {
    state.rows.conversations[1] = conv(DST_CONV, {}, { type: "instagram" });
    expect((await forward()).ok).toBe(true);
    expect((await forward(MEDIA_MSG)).ok).toBe(false);
    expect(state.queued).toHaveLength(1);
  });

  it("lists only conversations with an open window, without the source", async () => {
    state.rows.conversations = [
      {
        ...conv(SRC_CONV),
        contacts: { first_name: "Layla", last_name: "Demo-07" },
        channels: { name: "Main", type: "whatsapp", status: "active" },
      },
      {
        ...conv(DST_CONV),
        contacts: { first_name: "Omar", last_name: "Demo-08" },
        channels: { name: "Main", type: "whatsapp", status: "active" },
      },
      {
        ...conv("00000000-0000-4000-8000-0000000000c3", { last_inbound_at: old() }),
        contacts: { first_name: "Sara", last_name: "Demo-09" },
        channels: { name: "Main", type: "whatsapp", status: "active" },
      },
    ];
    const r = await extras.listForwardTargets({ exclude: SRC_CONV });
    expect(r.ok && r.data.map((t) => t.id)).toEqual([DST_CONV]);
    const q = await extras.listForwardTargets({ exclude: SRC_CONV, q: "layla" });
    expect(q.ok && q.data).toEqual([]);
  });
});

describe("sendContactCard and sendCatalogProduct", () => {
  beforeEach(() => setup("inbox.send"));

  it("queues a contacts message and audits no number", async () => {
    const r = await card();
    expect(r.ok).toBe(true);
    expect(state.queued[0].spec).toEqual({
      type: "contacts",
      contacts: [
        {
          name: { formatted_name: "Demo Lab", first_name: "Demo", last_name: "Lab" },
          phones: [{ phone: "+447700900123", type: "WORK" }],
        },
      ],
    });
    expect(JSON.stringify(state.audits)).not.toMatch(/7700|Demo Lab/);
  });

  it("queues a product with the number's catalogue", async () => {
    const r = await product();
    expect(r.ok).toBe(true);
    expect(state.queued[0].spec).toEqual({
      type: "interactive",
      interactive: {
        type: "product",
        action: { catalog_id: "998877", product_retailer_id: "sku-1" },
      },
    });
    expect(state.audits[0]).toMatchObject({
      action: "message.product_sent",
      diff: { products: 1 },
    });
  });

  it("refuses a product when the number has no catalogue", async () => {
    state.rows.conversations[1] = conv(DST_CONV, {}, { catalog_id: null });
    const r = await product();
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/no catalogue/) });
    expect(state.queued).toHaveLength(0);
  });

  it("refuses both outside 24 hours and on text-only channels", async () => {
    state.rows.conversations[1] = conv(DST_CONV, { last_inbound_at: old() });
    expect((await card()).ok).toBe(false);
    expect((await product()).ok).toBe(false);
    state.rows.conversations[1] = conv(DST_CONV, {}, { type: "web" });
    expect((await card()).ok).toBe(false);
    expect((await product()).ok).toBe(false);
    expect(state.queued).toHaveLength(0);
  });
});

describe("unlinkConversationContact", () => {
  beforeEach(() => setup("inbox.send", "contacts.manage"));

  it("calls the SQL function, stops the bot on moved chats and audits ids", async () => {
    state.rpcResult = {
      data: { contact_id: NEW_CONTACT, old_contact_id: OLD_CONTACT, conversation_ids: [DST_CONV] },
      error: null,
    };
    const r = await unlink();
    expect(r).toMatchObject({ ok: true, data: { contact_id: NEW_CONTACT } });
    expect(state.rpc[0]).toEqual([
      "unlink_conversation_contact",
      {
        p_org_id: ORG,
        p_conversation_id: DST_CONV,
        p_first_name: "Layla",
        p_last_name: "Demo-07",
        p_keep_household: true,
        p_relationship: "spouse",
        p_user_id: ME,
      },
    ]);
    expect(state.takeovers).toEqual([DST_CONV]);
    expect(state.audits[0]).toMatchObject({
      action: "conversation.contact_unlinked",
      entityId: DST_CONV,
      diff: { old_contact_id: OLD_CONTACT, new_contact_id: NEW_CONTACT, household_link: true },
    });
    expect(JSON.stringify(state.audits)).not.toMatch(/Layla|Demo-07/);
  });

  it("maps the database refusals to plain sentences and hides anything else", async () => {
    state.rpcResult = {
      data: null,
      error: { message: "the contact has family links: remove them first", code: "23514" },
    };
    expect(await unlink()).toEqual({
      ok: false,
      error: "This contact has family links. Remove them in the contact record first.",
    });
    state.rpcResult = {
      data: null,
      error: { message: "relation x does not exist", code: "42P01" },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await unlink()).toEqual({
      ok: false,
      error: "Could not move the chat. Nothing was changed.",
    });
    spy.mockRestore();
    expect(state.audits).toHaveLength(0);
  });

  it("refuses a chat on one of the contact's alternate numbers, or with no inbound message", async () => {
    state.rows.messages[0].payload = { from: "447700900312" }; // an alternate number, not the main one
    expect(await unlink()).toEqual({ ok: false, error: SENDER_ERRORS.other });
    state.rows.messages = state.rows.messages.filter((m) => m.conversation_id !== DST_CONV);
    expect(await unlink()).toEqual({ ok: false, error: SENDER_ERRORS.none });
    expect(state.rpc).toHaveLength(0);
    expect(state.adminCalls).toBe(0);
  });

  it("accepts a username (BSUID) user whose BSUID is the contact's", async () => {
    state.rows.contacts = [
      { id: OLD_CONTACT, org_id: ORG, phone_e164: null, wa_bsuid: "AE.demo-1" },
    ];
    state.rows.messages[0].payload = { from: "AE.demo-1" };
    state.rpcResult = {
      data: { contact_id: NEW_CONTACT, old_contact_id: OLD_CONTACT, conversation_ids: [DST_CONV] },
      error: null,
    };
    expect((await unlink()).ok).toBe(true);
  });

  it("refuses a nameless contact and a non-WhatsApp chat before calling the database", async () => {
    expect(
      (
        await extras.unlinkConversationContact({
          conversation_id: DST_CONV,
          first_name: " ",
          last_name: "",
          keep_household: false,
        })
      ).ok,
    ).toBe(false);
    state.rows.conversations[1] = conv(DST_CONV, {}, { type: "messenger" });
    expect((await unlink()).ok).toBe(false);
    expect(state.rpc).toHaveLength(0);
  });
});
