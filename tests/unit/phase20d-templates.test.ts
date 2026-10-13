/**
 * Phase 20d templates: carousel parameters, header media per card, delivery rules (retry, TTL, SMS fallback) and the
 * performance shaping. Pure functions plus the header-media resolver with a fake client. Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveVariables } from "@/lib/campaigns/variables";
import { headerMediaSlots } from "@/lib/media/header";
import { checkMediaReferences, resolveHeaderMedia } from "@/lib/media/resolve";
import type { AdminClient } from "@/lib/supabase/admin";
import {
  deliverySettingsSchema,
  describeTtl,
  isRetryableCode,
  isTtlExpired,
  readRetryMarker,
  smsFallbackAllowed,
  TEMPLATE_RETRY_DELAYS_SECONDS,
  TEMPLATE_RETRY_MAX,
  templateRetryDecision,
} from "@/lib/templates/delivery";
import {
  sumPerformance,
  templateRates,
  toPerformanceRows,
  type TemplatePerformanceRow,
} from "@/lib/templates/performance";
import {
  buildTemplateSend,
  isHeaderMediaKey,
  renderTemplatePreview,
  templateVariables,
} from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent, TemplateComponent } from "@/lib/whatsapp/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const A1 = "33333333-3333-4333-8333-333333333333";
const A2 = "44444444-4444-4444-8444-444444444444";

const carousel: MetaTemplateComponent[] = [
  { type: "BODY", text: "Hi {{1}}, our offers this month:", example: { body_text: [["Layla"]] } },
  {
    type: "CAROUSEL",
    cards: [
      {
        components: [
          { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::a"] } },
          { type: "BODY", text: "Teeth whitening {{1}}", example: { body_text: [["20% off"]] } },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Interested" },
              {
                type: "URL",
                text: "Book",
                url: "https://book.example.test/{{1}}",
                example: ["https://book.example.test/w1"],
              },
            ],
          },
        ],
      },
      {
        components: [
          { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::b"] } },
          { type: "BODY", text: "Check-up package" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Interested" },
              {
                type: "URL",
                text: "Book",
                url: "https://book.example.test/{{1}}",
                example: ["https://book.example.test/c1"],
              },
            ],
          },
        ],
      },
    ],
  },
] as MetaTemplateComponent[];

const fullValues = {
  "body.1": "Layla",
  "card.0.header.media": "https://cdn.example.test/a.jpg",
  "card.0.body.1": "25% off",
  "card.0.button.1": "whitening",
  "card.1.header.media": "media-id-777",
  "card.1.button.1": "checkup",
};

describe("carousel variables (Phase 20d)", () => {
  it("lists the message's own variables first, then each card's media, text and URL suffix", () => {
    const keys = templateVariables(carousel).map((v) => v.key);
    expect(keys).toEqual([
      "body.1",
      "card.0.header.media",
      "card.0.body.1",
      "card.0.button.1",
      "card.1.header.media",
      "card.1.button.1",
    ]);
    const card0Media = templateVariables(carousel).find((v) => v.key === "card.0.header.media")!;
    expect(card0Media).toMatchObject({
      card: 0,
      kind: "image",
      component: "header",
      example: "4::a",
    });
    expect(templateVariables(carousel).find((v) => v.key === "body.1")!.card).toBeUndefined();
  });

  it("builds one carousel entry per card with header, body and button parameters in index order", () => {
    const t = buildTemplateSend(
      { name: "offers", language: "en", components: carousel },
      fullValues,
    );
    expect(t.components?.[0]).toEqual({
      type: "body",
      parameters: [{ type: "text", text: "Layla" }],
    });
    const car = t.components?.[1] as Extract<TemplateComponent, { type: "carousel" }>;
    expect(car.type).toBe("carousel");
    expect(car.cards).toHaveLength(2);
    expect(car.cards[0]).toEqual({
      card_index: 0,
      components: [
        {
          type: "header",
          parameters: [{ type: "image", image: { link: "https://cdn.example.test/a.jpg" } }],
        },
        { type: "body", parameters: [{ type: "text", text: "25% off" }] },
        {
          type: "button",
          sub_type: "quick_reply",
          index: 0,
          parameters: [{ type: "payload", payload: "card0_btn0" }],
        },
        {
          type: "button",
          sub_type: "url",
          index: 1,
          parameters: [{ type: "text", text: "whitening" }],
        },
      ],
    });
    // A Meta media id (not a link) is sent as an id; a card without body variables sends no body component.
    expect(car.cards[1]!.components[0]).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { id: "media-id-777" } }],
    });
    expect(car.cards[1]!.components.some((c) => c.type === "body")).toBe(false);
  });

  it("refuses to build a carousel with a card value missing", () => {
    const partial: Record<string, string> = { ...fullValues };
    delete partial["card.1.header.media"];
    expect(() =>
      buildTemplateSend({ name: "offers", language: "en", components: carousel }, partial),
    ).toThrow(/card\.1\.header\.media/);
  });

  it("keeps the phone preview working: card text uses the values, else Meta's example", () => {
    const p = renderTemplatePreview(carousel, { "card.0.body.1": "30% off" });
    expect(p.cards.map((c) => c.body)).toEqual(["Teeth whitening 30% off", "Check-up package"]);
    expect(p.cards[0]!.media).toBe("image");
    expect(renderTemplatePreview(carousel, {}).cards[0]!.body).toBe("Teeth whitening 20% off");
    expect(renderTemplatePreview(carousel, {}).missing).toContain("card.1.header.media");
  });

  it("leaves standard templates exactly as before (no card keys, same parameters)", () => {
    const std = [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Hello {{1}}" },
      {
        type: "BUTTONS",
        buttons: [{ type: "URL", text: "Go", url: "https://x.example.test/{{1}}" }],
      },
    ] as MetaTemplateComponent[];
    expect(templateVariables(std).map((v) => v.key)).toEqual([
      "header.media",
      "body.1",
      "button.0",
    ]);
    const t = buildTemplateSend(
      { name: "s", language: "en", components: std },
      {
        "header.media": "https://x.example.test/a.png",
        "body.1": "Sara",
        "button.0": "abc",
      },
    );
    expect(t.components?.map((c) => c.type)).toEqual(["header", "body", "button"]);
  });

  it("recognises header-media keys for the message and for cards only", () => {
    expect(isHeaderMediaKey("header.media")).toBe(true);
    expect(isHeaderMediaKey("card.3.header.media")).toBe(true);
    expect(isHeaderMediaKey("card.x.header.media")).toBe(false);
    expect(isHeaderMediaKey("body.1")).toBe(false);
    expect(headerMediaSlots(carousel)).toEqual([
      { key: "card.0.header.media", kind: "image" },
      { key: "card.1.header.media", kind: "image" },
    ]);
  });

  it("campaign variables resolve card keys from the campaign map, then the template map", () => {
    const r = resolveVariables({
      components: carousel,
      map: { "body.1": "contact.first_name", "card.0.header.media": `media:${A1}` },
      templateMap: {
        "card.0.body.1": "text:20% off",
        "card.0.button.1": "text:w",
        "card.1.header.media": `media:${A2}`,
        "card.1.button.1": "text:c",
      },
      contact: { first_name: "Layla" },
    });
    expect(r.missing).toEqual([]);
    expect(r.values["card.0.header.media"]).toBe(`media:${A1}`);
    expect(r.values["card.1.header.media"]).toBe(`media:${A2}`);
  });
});

function fakeAdmin(assets: Record<string, Record<string, unknown>>): AdminClient {
  return {
    from: () => {
      let id = "";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, v: string) => {
        if (col === "id") id = v;
        return q;
      };
      q.maybeSingle = async () => ({ data: assets[id] ?? null, error: null });
      return q;
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://storage.example.test/${path}?token=t` },
          error: null,
        }),
      }),
    },
  } as unknown as AdminClient;
}
const asset = (id: string) => ({
  id,
  org_id: ORG,
  kind: "image",
  mime_type: "image/jpeg",
  size_bytes: 1000,
  storage_path: `${ORG}/${id}/original.jpg`,
  status: "ready",
  scan_status: "unscanned",
});

describe("library files on carousel cards", () => {
  it("resolves every card's media:<id> to its own signed link just before sending", async () => {
    const values = {
      ...fullValues,
      "card.0.header.media": `media:${A1}`,
      "card.1.header.media": `media:${A2}`,
    };
    const out = await resolveHeaderMedia(
      fakeAdmin({ [A1]: asset(A1), [A2]: asset(A2) }),
      ORG,
      carousel,
      values,
    );
    expect(out["card.0.header.media"]).toContain(`${A1}/original.jpg`);
    expect(out["card.1.header.media"]).toContain(`${A2}/original.jpg`);
    const t = buildTemplateSend({ name: "offers", language: "en", components: carousel }, out);
    const car = t.components?.[1] as Extract<TemplateComponent, { type: "carousel" }>;
    expect(JSON.stringify(car)).not.toContain("media:");
  });

  it("reports an unusable card file before anything is sent", async () => {
    const msg = await checkMediaReferences(fakeAdmin({ [A1]: asset(A1) }), ORG, carousel, {
      "card.0.header.media": `media:${A1}`,
      "card.1.header.media": `media:${A2}`,
    });
    expect(msg).toMatch(/no longer exists/);
  });
});

describe("retry on fail (non-campaign template messages)", () => {
  const now = new Date("2026-10-27T09:00:00Z");
  const base = {
    retryOnFail: true,
    isTemplate: true,
    campaignRecipientId: null,
    errorCode: 131000,
    previousRetries: 0,
    ttlSeconds: null,
    originAt: "2026-10-27T08:59:00Z",
    now,
  };

  it("retries a retryable failure after 10 minutes, then 1 hour, then stops", () => {
    expect(templateRetryDecision(base)).toEqual({ retry: true, attempt: 1, delaySeconds: 600 });
    expect(templateRetryDecision({ ...base, previousRetries: 1 })).toEqual({
      retry: true,
      attempt: 2,
      delaySeconds: 3600,
    });
    expect(templateRetryDecision({ ...base, previousRetries: TEMPLATE_RETRY_MAX })).toEqual({
      retry: false,
      reason: "exhausted",
    });
    expect(TEMPLATE_RETRY_DELAYS_SECONDS).toHaveLength(TEMPLATE_RETRY_MAX);
  });

  it("never retries when switched off, for campaigns, for non-templates or for permanent errors", () => {
    expect(templateRetryDecision({ ...base, retryOnFail: false })).toEqual({
      retry: false,
      reason: "off",
    });
    expect(templateRetryDecision({ ...base, campaignRecipientId: "r1" })).toEqual({
      retry: false,
      reason: "campaign",
    });
    expect(templateRetryDecision({ ...base, isTemplate: false })).toEqual({
      retry: false,
      reason: "not_template",
    });
    for (const code of [131050, 131026, 131047, 131049, 132001, -1, -2, null])
      expect(templateRetryDecision({ ...base, errorCode: code })).toEqual({
        retry: false,
        reason: "not_retryable",
      });
    expect(isRetryableCode(130429)).toBe(true);
    expect(isRetryableCode(131050)).toBe(false);
  });

  it("does not retry when the retry would go out after the template's time limit", () => {
    // queued 8:59, limit 15 minutes, first retry would leave at 9:10: fine; a 5 minute limit is not.
    expect(templateRetryDecision({ ...base, ttlSeconds: 900 }).retry).toBe(true);
    expect(templateRetryDecision({ ...base, ttlSeconds: 300 })).toEqual({
      retry: false,
      reason: "expired",
    });
  });

  it("reads the retry marker from the message payload, ignoring junk", () => {
    expect(
      readRetryMarker({ send: {}, retry: { attempt: 2, origin_at: "2026-10-27T08:00:00Z" } }),
    ).toEqual({
      attempt: 2,
      origin_at: "2026-10-27T08:00:00Z",
    });
    expect(readRetryMarker({ retry: { attempt: "x" } })).toBeNull();
    expect(readRetryMarker(null)).toBeNull();
    expect(readRetryMarker({ retry: [] })).toBeNull();
  });
});

describe("message TTL guard", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  it("expires a message older than the limit, counted from the first queueing", () => {
    expect(isTtlExpired("2026-10-27T11:00:00Z", 3600, now)).toBe(false);
    expect(isTtlExpired("2026-10-27T10:59:59Z", 3600, now)).toBe(true);
  });
  it("never expires without a limit or a time", () => {
    expect(isTtlExpired("2020-01-01T00:00:00Z", null, now)).toBe(false);
    expect(isTtlExpired(null, 60, now)).toBe(false);
    expect(isTtlExpired("not a date", 60, now)).toBe(false);
  });
  it("validates the stored setting and describes it", () => {
    expect(
      deliverySettingsSchema.safeParse({
        retry_on_fail: true,
        sms_fallback: false,
        ttl_seconds: 30,
      }).success,
    ).toBe(false);
    expect(
      deliverySettingsSchema.safeParse({
        retry_on_fail: true,
        sms_fallback: false,
        ttl_seconds: 3600,
      }).success,
    ).toBe(true);
    expect(describeTtl(3600)).toBe("1 hour");
    expect(describeTtl(7200)).toBe("2 hours");
    expect(describeTtl(null)).toBe("No limit");
  });
});

describe("SMS fallback per template", () => {
  it("allows utility and authentication templates with the switch on", () => {
    expect(smsFallbackAllowed({ category: "UTILITY", sms_fallback: true })).toBe(true);
    expect(smsFallbackAllowed({ category: "authentication", sms_fallback: true })).toBe(true);
  });
  it("refuses marketing (whatever the switch says), unknown categories and a switched-off template", () => {
    expect(smsFallbackAllowed({ category: "MARKETING", sms_fallback: true })).toBe(false);
    expect(smsFallbackAllowed({ category: null, sms_fallback: true })).toBe(false);
    expect(smsFallbackAllowed({ category: "SOMETHING_NEW", sms_fallback: true })).toBe(false);
    expect(smsFallbackAllowed({ category: "UTILITY", sms_fallback: false })).toBe(false);
  });
});

describe("template performance shaping", () => {
  const row = (over: Partial<TemplatePerformanceRow>): TemplatePerformanceRow => ({
    template_id: "t",
    name: "n",
    language: "en",
    category: "UTILITY",
    messages: 0,
    sent: 0,
    delivered: 0,
    read_count: 0,
    replied: 0,
    clicked: 0,
    failed: 0,
    pending: 0,
    retries: 0,
    from_campaigns: 0,
    ...over,
  });
  it("computes rates against the right denominators and copes with zero", () => {
    const r = templateRates(
      row({ sent: 10, delivered: 8, read_count: 4, replied: 2, clicked: 1, failed: 2 }),
    );
    expect(r).toEqual({ delivered: 0.8, read: 0.5, replied: 0.25, clicked: 0.125, failed: 2 / 12 });
    expect(templateRates(row({}))).toEqual({
      delivered: null,
      read: null,
      replied: null,
      clicked: null,
      failed: null,
    });
  });
  it("sums rows and normalises driver output", () => {
    const rows = toPerformanceRows([
      {
        template_id: "a",
        name: "A",
        language: "en",
        category: "UTILITY",
        messages: "3",
        sent: "2",
        delivered: 2,
        read_count: 1,
        replied: 0,
        clicked: 0,
        failed: 1,
        pending: 0,
        retries: 1,
        from_campaigns: 0,
      },
      {
        template_id: "b",
        name: "B",
        language: "ar",
        category: "MARKETING",
        messages: 5,
        sent: 5,
        delivered: 4,
        read_count: 4,
        replied: 1,
        clicked: 2,
        failed: 0,
        pending: 0,
        retries: 0,
        from_campaigns: 5,
      },
    ]);
    expect(rows[0]!.messages).toBe(3);
    expect(sumPerformance(rows)).toMatchObject({
      messages: 8,
      sent: 7,
      delivered: 6,
      read_count: 5,
      clicked: 2,
      retries: 1,
      from_campaigns: 5,
    });
    expect(toPerformanceRows(null)).toEqual([]);
  });
});
