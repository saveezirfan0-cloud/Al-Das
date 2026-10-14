/**
 * Sanoflow parity G11 pure rules: forward planning, contact cards, catalogue product messages, the click-to-call
 * link and the closed-window wording. Synthetic data only (reserved +44 7700 900xxx numbers).
 */
import { describe, expect, it } from "vitest";

import { buildContactCard } from "@/lib/inbox/contact-card";
import {
  FORWARD_ERRORS,
  PRODUCT_LIMITS,
  buildProductMessage,
  extrasWindowClosedMessage,
  parseRetailerIds,
  planForward,
  telHref,
  type ForwardSource,
} from "@/lib/inbox/extras";
import { kindForSpec, sendSpecSchema } from "@/lib/inbox/send";
import { SENDER_ERRORS, checkChatSender, senderOf } from "@/lib/inbox/unlink";
import { WhatsAppClient } from "@/lib/whatsapp/client";

const base: ForwardSource = {
  direction: "in",
  kind: "text",
  body: "Hello from Layla Demo-07",
  media_path: null,
  media_mime: null,
  media_filename: null,
};
const PATH =
  "00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-0000000000c1/00000000-0000-4000-8000-0000000000f1.jpg";

describe("planForward", () => {
  it("forwards text as text, trimmed", () => {
    expect(planForward({ ...base, body: "  hi  " }, "whatsapp")).toEqual({
      ok: true,
      kind: "text",
      body: "hi",
    });
  });

  it("forwards text to every channel type (non-WhatsApp channels take text)", () => {
    for (const t of ["web", "instagram", "messenger"] as const)
      expect(planForward(base, t).ok).toBe(true);
  });

  it("refuses empty text, notes and system rows", () => {
    expect(planForward({ ...base, body: "  " }, "whatsapp")).toEqual({
      ok: false,
      error: FORWARD_ERRORS.empty,
    });
    expect(planForward({ ...base, direction: "note", kind: "note" }, "whatsapp")).toEqual({
      ok: false,
      error: FORWARD_ERRORS.note,
    });
    expect(planForward({ ...base, direction: "system" }, "whatsapp").ok).toBe(false);
  });

  it("refuses templates, interactive messages, locations, contact cards, reactions and unsupported rows", () => {
    for (const kind of [
      "template",
      "interactive",
      "location",
      "contacts",
      "reaction",
      "button",
      "order",
      "unsupported",
    ])
      expect(planForward({ ...base, kind }, "whatsapp")).toEqual({
        ok: false,
        error: FORWARD_ERRORS.kind,
      });
  });

  it("re-sends a stored file with its caption", () => {
    const plan = planForward(
      {
        ...base,
        kind: "image",
        body: "x-ray",
        media_path: PATH,
        media_mime: "image/jpeg",
        media_filename: "scan.jpg",
      },
      "whatsapp",
    );
    expect(plan).toEqual({
      ok: true,
      kind: "media",
      mediaType: "image",
      sourcePath: PATH,
      mime: "image/jpeg",
      filename: "scan.jpg",
      caption: "x-ray",
    });
  });

  it("drops captions on audio and stickers", () => {
    for (const kind of ["audio", "sticker"]) {
      const plan = planForward(
        { ...base, kind, body: "ignored", media_path: PATH, media_mime: "audio/ogg" },
        "whatsapp",
      );
      expect(plan.ok && plan.kind === "media" && plan.caption).toBe(null);
    }
  });

  it("refuses a file that has not been downloaded yet", () => {
    expect(
      planForward({ ...base, kind: "document", media_mime: "application/pdf" }, "whatsapp"),
    ).toEqual({ ok: false, error: FORWARD_ERRORS.notDownloaded });
  });

  it("refuses a file to a text-only channel", () => {
    for (const t of ["web", "instagram", "messenger"] as const)
      expect(
        planForward({ ...base, kind: "image", media_path: PATH, media_mime: "image/jpeg" }, t),
      ).toEqual({ ok: false, error: FORWARD_ERRORS.textOnly });
  });

  it("caps text and captions at the WhatsApp limits", () => {
    const long = "a".repeat(5000);
    const t = planForward({ ...base, body: long }, "whatsapp");
    expect(t.ok && t.kind === "text" && t.body.length).toBe(4096);
    const m = planForward(
      { ...base, kind: "video", body: long, media_path: PATH, media_mime: "video/mp4" },
      "whatsapp",
    );
    expect(m.ok && m.kind === "media" && m.caption?.length).toBe(1024);
  });
});

describe("buildContactCard", () => {
  it("builds a WhatsApp contact with an E.164 phone", () => {
    const r = buildContactCard({
      name: " Clinic  Lab Demo ",
      phone: "+44 7700 900123",
      company: "Demo Lab",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card).toEqual({
      name: { formatted_name: "Clinic Lab Demo", first_name: "Clinic", last_name: "Lab Demo" },
      phones: [{ phone: "+447700900123", type: "WORK" }],
      org: { company: "Demo Lab" },
    });
    expect(r.label).toBe("Clinic Lab Demo");
  });

  it("has no last name or organisation when none is given", () => {
    const r = buildContactCard({ name: "Reception", phone: "+447700900124" });
    expect(r.ok && r.card).toEqual({
      name: { formatted_name: "Reception", first_name: "Reception" },
      phones: [{ phone: "+447700900124", type: "WORK" }],
    });
  });

  it("refuses a blank name and an invalid phone", () => {
    expect(buildContactCard({ name: " ", phone: "+447700900124" }).ok).toBe(false);
    expect(buildContactCard({ name: "Reception", phone: "12" }).ok).toBe(false);
    expect(buildContactCard({ name: "Reception", phone: "call me" }).ok).toBe(false);
  });

  it("the card passes the outbound send schema and is stored as a contacts message", () => {
    const r = buildContactCard({ name: "Reception", phone: "+447700900124" });
    if (!r.ok) throw new Error("card");
    const spec = sendSpecSchema.parse({ type: "contacts", contacts: [r.card] });
    expect(kindForSpec(spec)).toBe("contacts");
    // One card per message, never a list of patients.
    expect(sendSpecSchema.safeParse({ type: "contacts", contacts: [r.card, r.card] }).success).toBe(
      false,
    );
    expect(sendSpecSchema.safeParse({ type: "contacts", contacts: [] }).success).toBe(false);
  });
});

describe("buildProductMessage", () => {
  it("fails closed without a catalogue", () => {
    for (const catalogId of [null, undefined, "", "  "])
      expect(buildProductMessage({ catalogId, retailerIds: ["sku-1"] }).ok).toBe(false);
  });

  it("builds a single product (no header)", () => {
    const r = buildProductMessage({
      catalogId: "123456",
      retailerIds: [" sku-1 "],
      header: "ignored for one product",
      body: "Our check-up",
      footer: "Al Das demo",
    });
    expect(r.ok && r.interactive).toEqual({
      type: "product",
      body: { text: "Our check-up" },
      footer: { text: "Al Das demo" },
      action: { catalog_id: "123456", product_retailer_id: "sku-1" },
    });
  });

  it("builds a product list with one section and deduplicated ids", () => {
    const r = buildProductMessage({
      catalogId: "123456",
      retailerIds: ["a", "b", "a"],
      header: "Dental packages for the summer",
      body: "Pick one",
    });
    expect(r.ok && r.interactive).toEqual({
      type: "product_list",
      header: { type: "text", text: "Dental packages for the summer" },
      body: { text: "Pick one" },
      action: {
        catalog_id: "123456",
        sections: [
          {
            title: "Dental packages for the",
            product_items: [{ product_retailer_id: "a" }, { product_retailer_id: "b" }],
          },
        ],
      },
    });
  });

  it("requires a heading and text for several products", () => {
    expect(buildProductMessage({ catalogId: "1", retailerIds: ["a", "b"], body: "x" }).ok).toBe(
      false,
    );
    expect(buildProductMessage({ catalogId: "1", retailerIds: ["a", "b"], header: "x" }).ok).toBe(
      false,
    );
  });

  it("enforces Meta's limits", () => {
    const many = Array.from({ length: PRODUCT_LIMITS.items + 1 }, (_, i) => `sku-${i}`);
    expect(
      buildProductMessage({ catalogId: "1", retailerIds: many, header: "h", body: "b" }).ok,
    ).toBe(false);
    expect(buildProductMessage({ catalogId: "1", retailerIds: [] }).ok).toBe(false);
    expect(buildProductMessage({ catalogId: "1", retailerIds: ["x".repeat(101)] }).ok).toBe(false);
    expect(
      buildProductMessage({ catalogId: "1", retailerIds: ["a"], footer: "f".repeat(61) }).ok,
    ).toBe(false);
  });

  it("parses typed retailer ids", () => {
    expect(parseRetailerIds("a, b\nc;; a  d")).toEqual(["a", "b", "c", "d"]);
    expect(parseRetailerIds("   ")).toEqual([]);
  });
});

describe("telHref", () => {
  it("links only a valid E.164 number", () => {
    expect(telHref("+447700900123")).toBe("tel:+447700900123");
    expect(telHref(null)).toBe(null);
    expect(telHref("")).toBe(null);
    expect(telHref("07700900123")).toBe(null);
    expect(telHref("+44 7700 900123")).toBe(null);
    expect(telHref("+447700900123;ext=1")).toBe(null);
  });
});

describe("extrasWindowClosedMessage", () => {
  it("never offers a template on Instagram or Messenger, and names the feature on WhatsApp", () => {
    expect(extrasWindowClosedMessage("instagram", "forward")).not.toMatch(/template/);
    expect(extrasWindowClosedMessage("whatsapp", "forward")).toMatch(/^Forwarding/);
    expect(extrasWindowClosedMessage("whatsapp", "card")).toMatch(/contact card/);
    expect(extrasWindowClosedMessage("whatsapp", "product")).toMatch(/catalogue product/);
  });
});

describe("Cloud API bodies (fake fetch, Meta never reached)", () => {
  async function bodiesFor(send: (c: WhatsAppClient) => Promise<unknown>) {
    const bodies: unknown[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.x" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const c = new WhatsAppClient({
      accessToken: "TOKEN",
      phoneNumberId: "PNID",
      wabaId: "WABA",
      graphVersion: "v21.0",
      fetch: fetchFn,
    });
    await send(c);
    return bodies;
  }

  it("a contact card goes out as a `contacts` message", async () => {
    const r = buildContactCard({ name: "Reception", phone: "+447700900124" });
    if (!r.ok) throw new Error("card");
    const [body] = await bodiesFor((c) => c.sendContacts("447700900125", [r.card]));
    expect(body).toMatchObject({
      type: "contacts",
      to: "447700900125",
      contacts: [{ name: { formatted_name: "Reception" }, phones: [{ phone: "+447700900124" }] }],
    });
  });

  it("a product list goes out as an interactive `product_list`", async () => {
    const r = buildProductMessage({
      catalogId: "1",
      retailerIds: ["a", "b"],
      header: "H",
      body: "B",
    });
    if (!r.ok) throw new Error("product");
    const [body] = await bodiesFor((c) => c.sendInteractive("447700900125", r.interactive));
    expect(body).toMatchObject({
      type: "interactive",
      interactive: { type: "product_list", action: { catalog_id: "1" } },
    });
  });
});

describe("checkChatSender (move chat to a new contact)", () => {
  const main = { phone_e164: "+447700900311", wa_bsuid: null };
  it("accepts the contact's main phone or BSUID", () => {
    expect(checkChatSender("447700900311", main)).toEqual({ ok: true });
    expect(checkChatSender("AE.demo-1", { phone_e164: null, wa_bsuid: "AE.demo-1" })).toEqual({
      ok: true,
    });
    expect(
      checkChatSender("AE.demo-1", { phone_e164: "+447700900311", wa_bsuid: "AE.demo-1" }),
    ).toEqual({ ok: true });
  });
  it("refuses an alternate number, a foreign BSUID or no inbound sender", () => {
    expect(checkChatSender("447700900312", main)).toEqual({
      ok: false,
      error: SENDER_ERRORS.other,
    });
    expect(checkChatSender("AE.other", main)).toEqual({ ok: false, error: SENDER_ERRORS.other });
    expect(checkChatSender(null, main)).toEqual({ ok: false, error: SENDER_ERRORS.none });
    expect(checkChatSender("  ", main)).toEqual({ ok: false, error: SENDER_ERRORS.none });
  });
  it("reads Meta's `from` from a stored payload", () => {
    expect(senderOf({ from: "447700900311", id: "wamid.x" })).toBe("447700900311");
    expect(senderOf({ source: "whatsapp" })).toBe(null);
    expect(senderOf(null)).toBe(null);
  });
});

describe("contact card name parts", () => {
  it("caps first and last name at 100 so the send schema always accepts the card", () => {
    const r = buildContactCard({
      name: `${"a".repeat(120)} ${"b".repeat(70)}`,
      phone: "+447700900124",
    });
    if (!r.ok) throw new Error("card");
    expect(r.card.name.first_name).toHaveLength(100);
    expect(sendSpecSchema.safeParse({ type: "contacts", contacts: [r.card] }).success).toBe(true);
    const r2 = buildContactCard({ name: `a ${"b".repeat(150)}`, phone: "+447700900124" });
    if (!r2.ok) throw new Error("card");
    expect(r2.card.name.last_name).toHaveLength(100);
    expect(sendSpecSchema.safeParse({ type: "contacts", contacts: [r2.card] }).success).toBe(true);
  });
});
