import { describe, expect, it } from "vitest";

import {
  componentsToDraft,
  draftKind,
  draftToComponents,
  emptyDraft,
  insertVariable,
  nextVariableNumber,
  renumberVariables,
  staleVariableMapKeys,
  variableNumbers,
  type TemplateDraft,
} from "@/lib/whatsapp/template-draft";
import { renderTemplatePreview, templateVariables } from "@/lib/whatsapp/templates";

const reminder = (): TemplateDraft =>
  emptyDraft({
    name: "appointment_reminder",
    language: "en",
    category: "UTILITY",
    kind: "media_interactive",
    header: { format: "TEXT", text: "Hello {{1}}", example: "Sara" },
    body: "Your appointment is on {{1}} with {{2}}. See you soon.",
    bodyExamples: ["Monday 10 November", "Dr. Noor"],
    footer: "Al Das Medical",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirm" },
      { type: "QUICK_REPLY", text: "Reschedule" },
    ],
    variableMap: { "body.1": "appointment.datetime", "body.2": "appointment.specialist" },
  });

describe("variables", () => {
  it("finds, numbers and inserts positional variables", () => {
    expect(variableNumbers("a {{2}} b {{1}} c {{2}}")).toEqual([1, 2]);
    expect(nextVariableNumber("no vars")).toBe(1);
    expect(nextVariableNumber("x {{1}} y {{3}}")).toBe(4);
    expect(insertVariable("Hello , bye", 6)).toEqual({ text: "Hello {{1}}, bye", number: 1 });
    expect(insertVariable("Hi {{1}}", 99).text).toBe("Hi {{1}}{{2}}");
  });
  it("renumbers in order of appearance and reports the mapping", () => {
    const r = renumberVariables("x {{3}} y {{1}} z {{3}}");
    expect(r.text).toBe("x {{1}} y {{2}} z {{1}}");
    expect(r.mapping).toEqual({ 3: 1, 1: 2 });
  });
  it("tolerates spaces inside braces", () => {
    expect(variableNumbers("a {{ 1 }} b")).toEqual([1]);
  });
});

describe("draftToComponents", () => {
  it("builds header, body (with examples), footer and buttons in Meta's order", () => {
    const c = draftToComponents(reminder());
    expect(c.map((x) => x.type)).toEqual(["HEADER", "BODY", "FOOTER", "BUTTONS"]);
    expect(c[0]).toMatchObject({
      format: "TEXT",
      text: "Hello {{1}}",
      example: { header_text: ["Sara"] },
    });
    expect(c[1]).toMatchObject({
      type: "BODY",
      example: { body_text: [["Monday 10 November", "Dr. Noor"]] },
    });
    expect(c[3]).toMatchObject({
      buttons: [
        { type: "QUICK_REPLY", text: "Confirm" },
        { type: "QUICK_REPLY", text: "Reschedule" },
      ],
    });
  });

  it("omits examples when there are no variables and omits empty optional parts", () => {
    const c = draftToComponents(
      emptyDraft({ name: "x", body: "Plain text with nothing to fill in." }),
    );
    expect(c).toEqual([{ type: "BODY", text: "Plain text with nothing to fill in." }]);
  });

  it("writes media headers with a handle, URL buttons with examples and copy-code buttons", () => {
    const c = draftToComponents(
      emptyDraft({
        header: { format: "IMAGE", handle: "4::abc" },
        body: "See the details here today.",
        buttons: [
          {
            type: "URL",
            text: "Open",
            url: "https://example.com/p/{{1}}",
            example: "https://example.com/p/42",
          },
          { type: "COPY_CODE", example: "SAVE20" },
        ],
      }),
    );
    expect(c[0]).toMatchObject({ format: "IMAGE", example: { header_handle: ["4::abc"] } });
    const buttons = c.find((x) => x.type === "BUTTONS") as { buttons: unknown[] };
    expect(buttons.buttons[0]).toMatchObject({
      type: "URL",
      example: ["https://example.com/p/42"],
    });
    expect(buttons.buttons[1]).toEqual({ type: "COPY_CODE", example: "SAVE20" });
  });

  it("builds a carousel as body + CAROUSEL cards", () => {
    const c = draftToComponents(
      emptyDraft({
        kind: "carousel",
        body: "Our services this month are below.",
        cards: [1, 2].map((i) => ({
          header: { format: "IMAGE" as const, handle: `4::h${i}` },
          body: `Card number ${i} describes a service.`,
          bodyExamples: [],
          buttons: [{ type: "QUICK_REPLY" as const, text: "Book" }],
        })),
      }),
    );
    expect(c.map((x) => x.type)).toEqual(["BODY", "CAROUSEL"]);
    const cards = (c[1] as { cards: Array<{ components: Array<{ type: string }> }> }).cards;
    expect(cards).toHaveLength(2);
    expect(cards[0].components.map((x) => x.type)).toEqual(["HEADER", "BODY", "BUTTONS"]);
  });
});

describe("componentsToDraft (round trip)", () => {
  it("returns the same draft", () => {
    const d = reminder();
    const back = componentsToDraft(draftToComponents(d), {
      name: d.name,
      language: d.language,
      category: d.category,
      variableMap: d.variableMap,
    });
    expect(back).toEqual(d);
  });

  it("round-trips a carousel and media header", () => {
    const d = emptyDraft({
      name: "services",
      kind: "carousel",
      body: "Our services this month are below.",
      cards: [1, 2].map((i) => ({
        header: { format: "VIDEO" as const, handle: `4::v${i}` },
        body: `Card ${i} for {{1}} patients today.`,
        bodyExamples: ["new"],
        buttons: [
          { type: "URL" as const, text: "Open", url: "https://example.com/a", example: undefined },
        ],
      })),
    });
    const back = componentsToDraft(draftToComponents(d), {
      name: d.name,
      language: "en",
      category: "MARKETING",
    });
    expect(back.kind).toBe("carousel");
    expect(back.cards).toHaveLength(2);
    expect(back.cards[1].header).toEqual({ format: "VIDEO", handle: "4::v2" });
    expect(back.cards[0].bodyExamples).toEqual(["new"]);
  });

  it("reads a mirrored Meta template and infers the kind; unknown categories fall back to UTILITY", () => {
    const d = componentsToDraft(
      [
        {
          type: "BODY",
          text: "Hello {{1}}, welcome to the clinic today.",
          example: { body_text: [["Sara"]] },
        },
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: "1" },
            { type: "QUICK_REPLY", text: "Hi" },
          ],
        },
        { type: "SOMETHING_NEW", foo: 1 },
      ],
      { name: "w", language: "en", category: "WEIRD" },
    );
    expect(d.category).toBe("UTILITY");
    expect(d.buttons).toEqual([{ type: "QUICK_REPLY", text: "Hi" }]); // FLOW buttons are not editable
    expect(d.kind).toBe("media_interactive");
    expect(d.bodyExamples).toEqual(["Sara"]);
  });

  it("agrees with the send-time helpers: same variables and preview", () => {
    const comps = draftToComponents(reminder());
    expect(templateVariables(comps).map((v) => v.key)).toEqual(["header.1", "body.1", "body.2"]);
    const p = renderTemplatePreview(comps, {});
    expect(p.body).toBe("Your appointment is on Monday 10 November with Dr. Noor. See you soon.");
    expect(p.headerText).toBe("Hello Sara");
  });
});

describe("helpers", () => {
  it("finds stale variable_map keys after the body changes", () => {
    const d = reminder();
    d.body = "Only {{1}} remains in this body text now.";
    expect(staleVariableMapKeys(d)).toEqual(["body.2"]);
  });
  it("derives the stored kind", () => {
    expect(draftKind(emptyDraft({ body: "x" }))).toBe("standard");
    expect(draftKind(emptyDraft({ buttons: [{ type: "QUICK_REPLY", text: "a" }] }))).toBe(
      "media_interactive",
    );
    expect(draftKind(emptyDraft({ header: { format: "IMAGE" } }))).toBe("media_interactive");
    expect(draftKind(emptyDraft({ header: { format: "TEXT", text: "t" } }))).toBe("standard");
    expect(draftKind(emptyDraft({ kind: "carousel" }))).toBe("carousel");
  });
});

describe("checkSampleFile", () => {
  it("accepts the right type and size, rejects the rest", async () => {
    const { checkSampleFile } = await import("@/lib/whatsapp/template-draft");
    expect(checkSampleFile("IMAGE", { mimeType: "image/jpeg", size: 1000 })).toBeNull();
    expect(checkSampleFile("IMAGE", { mimeType: "image/gif", size: 1000 })).toMatch(/JPEG or PNG/);
    expect(checkSampleFile("IMAGE", { mimeType: "image/png", size: 6 * 1024 * 1024 })).toMatch(
      /5 MB/,
    );
    expect(checkSampleFile("VIDEO", { mimeType: "video/mp4", size: 10 })).toBeNull();
    expect(checkSampleFile("DOCUMENT", { mimeType: "application/pdf", size: 0 })).toMatch(/empty/);
  });
});
