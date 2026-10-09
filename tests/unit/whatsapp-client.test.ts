import { describe, expect, it, vi } from "vitest";

import { WhatsAppClient } from "@/lib/whatsapp/client";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(responses: Array<{ status?: number; body?: unknown }>) {
  const { fn, calls } = mockFetch(responses);
  const c = new WhatsAppClient({
    accessToken: "TOKEN",
    phoneNumberId: "PNID",
    wabaId: "WABA",
    graphVersion: "v21.0",
    fetch: fn,
  });
  return { c, calls };
}

describe("WhatsAppClient", () => {
  it("sends text with the right URL, auth header and payload", async () => {
    const { c, calls } = client([
      { body: { messaging_product: "whatsapp", messages: [{ id: "wamid.1" }] } },
    ]);
    const res = await c.sendText("971500000001", "hello", { replyTo: "wamid.0" });
    expect(res.messages[0].id).toBe("wamid.1");
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/PNID/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "971500000001",
      context: { message_id: "wamid.0" },
      type: "text",
      text: { body: "hello", preview_url: false },
    });
  });

  it("builds media, interactive, template, reaction and mark-read payloads", async () => {
    const { c, calls } = client([{}, {}, {}, {}, {}, {}]);
    await c.sendMedia("1", "image", { id: "M1", caption: "c" });
    await c.sendMedia("1", "audio", { id: "M2", caption: "ignored" });
    await c.sendInteractive("1", {
      type: "button",
      body: { text: "?" },
      action: { buttons: [{ type: "reply", reply: { id: "a", title: "A" } }] },
    });
    await c.sendTemplate("1", { name: "t", language: { code: "en" } });
    await c.sendReaction("1", "wamid.9", "👍");
    await c.markRead("wamid.9", { typing: true });
    const bodies = calls.map((x) => JSON.parse(x.init.body as string));
    expect(bodies[0]).toMatchObject({ type: "image", image: { id: "M1", caption: "c" } });
    expect(bodies[1]).toMatchObject({ type: "audio", audio: { id: "M2" } });
    expect(bodies[1].audio.caption).toBeUndefined();
    expect(bodies[2]).toMatchObject({ type: "interactive" });
    expect(bodies[3]).toMatchObject({ type: "template", template: { name: "t" } });
    expect(bodies[4]).toMatchObject({
      type: "reaction",
      reaction: { message_id: "wamid.9", emoji: "👍" },
    });
    expect(bodies[5]).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.9",
      typing_indicator: { type: "text" },
    });
  });

  it("maps Graph errors to WhatsAppApiError", async () => {
    const { c } = client([
      {
        status: 400,
        body: {
          error: { message: "(#131047) Re-engagement message", code: 131047, fbtrace_id: "T" },
        },
      },
    ]);
    await expect(c.sendText("1", "x")).rejects.toBeInstanceOf(WhatsAppApiError);
    try {
      await c.sendText("1", "x");
    } catch {
      // consumed above
    }
  });

  it("treats network failures as transient", async () => {
    const c = new WhatsAppClient({
      accessToken: "T",
      phoneNumberId: "P",
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    const err = await c.sendText("1", "x").catch((e) => e as WhatsAppApiError);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect((err as WhatsAppApiError).mapped.retryable).toBe(true);
  });

  it("uploads media as multipart and reads media info / bytes", async () => {
    const { fn, calls } = mockFetch([
      { body: { id: "MEDIA1" } },
      {
        body: {
          id: "MEDIA1",
          url: "https://lookaside.example/x",
          mime_type: "image/jpeg",
          sha256: "s",
          file_size: 3,
          messaging_product: "whatsapp",
        },
      },
    ]);
    const c = new WhatsAppClient({ accessToken: "T", phoneNumberId: "P", fetch: fn });
    const up = await c.uploadMedia({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      filename: "a.jpg",
    });
    expect(up.id).toBe("MEDIA1");
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    const form = calls[0].init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/jpeg");
    const info = await c.getMediaInfo("MEDIA1");
    expect(info.url).toContain("lookaside");
    expect(calls[1].url).toBe("https://graph.facebook.com/v21.0/MEDIA1?phone_number_id=P");
  });

  it("business profile, phone fields, subscribed apps and templates hit the right endpoints", async () => {
    const { c, calls } = client([
      { body: { data: [{ about: "Clinic" }] } },
      { body: { success: true } },
      { body: { id: "PNID", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" } },
      { body: { data: [] } },
      { body: { success: true } },
      {
        body: {
          data: [
            {
              id: "1",
              name: "a",
              language: "en",
              status: "APPROVED",
              category: "UTILITY",
              components: [],
            },
          ],
          paging: { cursors: { after: "c2" }, next: "https://next" },
        },
      },
      {
        body: {
          data: [
            {
              id: "2",
              name: "b",
              language: "en",
              status: "APPROVED",
              category: "UTILITY",
              components: [],
            },
          ],
          paging: {},
        },
      },
      { body: { id: "3", status: "PENDING", category: "UTILITY" } },
      { body: { success: true } },
    ]);
    expect((await c.getBusinessProfile()).about).toBe("Clinic");
    expect(calls[0].url).toContain("/PNID/whatsapp_business_profile?fields=about%2Caddress");
    await c.updateBusinessProfile({ about: "New" });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      messaging_product: "whatsapp",
      about: "New",
    });
    expect((await c.getPhoneNumber()).quality_rating).toBe("GREEN");
    expect(calls[2].url).toContain("/PNID?fields=id%2Cverified_name");
    await c.getSubscribedApps();
    expect(calls[3].url).toBe("https://graph.facebook.com/v21.0/WABA/subscribed_apps");
    await c.subscribeApp();
    expect(calls[4].init.method).toBe("POST");
    const all = await c.listAllTemplates();
    expect(all.map((t) => t.id)).toEqual(["1", "2"]);
    expect(calls[6].url).toContain("after=c2");
    const created = await c.createTemplate({
      name: "n",
      language: "en",
      category: "UTILITY",
      components: [],
    });
    expect(created.id).toBe("3");
    await c.deleteTemplate("n", { hsmId: "3" });
    expect(calls[8].init.method).toBe("DELETE");
    expect(calls[8].url).toContain("name=n&hsm_id=3");
  });

  it("requires phoneNumberId / wabaId for scoped calls", () => {
    const c = new WhatsAppClient({ accessToken: "T", fetch: mockFetch([]).fn });
    expect(() => c.getPhoneNumber()).toThrow(/phoneNumberId/);
    expect(() => c.getSubscribedApps()).toThrow(/wabaId/);
    expect(() => new WhatsAppClient({ accessToken: "" })).toThrow();
  });
});
