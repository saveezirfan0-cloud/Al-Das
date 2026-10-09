import { describe, expect, it } from "vitest";

import { classifyButtonReply } from "@/lib/appointments/button-reply";
import {
  alignExamples,
  applyFormat,
  buildComponents,
  draftFromComponents,
  emptyDraft,
  insertVariable,
  nextVariable,
  slugifyName,
  validateDraft,
  variableNumbers,
  type TemplateDraft,
} from "@/lib/templates/builder";
import { GALLERY, galleryItem } from "@/lib/templates/gallery";
import { isTemplateSource, sampleFor } from "@/lib/templates/sources";
import { renderTemplatePreview, templateVariables } from "@/lib/whatsapp/templates";

const base = (o: Partial<TemplateDraft> = {}) =>
  emptyDraft({
    name: "hello_there",
    body: "Hello {{1}}, your visit is booked for tomorrow.",
    bodyExamples: ["Sara"],
    ...o,
  });
const errs = (d: TemplateDraft) => validateDraft(d).errors.map((e) => e.path);

describe("variables and formatting helpers", () => {
  it("numbers variables and inserts the next one", () => {
    expect(variableNumbers("a {{1}} b {{ 2 }} c {{1}}")).toEqual([1, 2]);
    expect(nextVariable("no vars")).toBe(1);
    expect(nextVariable("{{1}} {{3}}")).toBe(4);
    const r = insertVariable("Hello @ there", 6, 1);
    expect(r.text).toBe("Hello {{1}} there");
    expect(r.caret).toBe(11);
  });
  it("wraps the selection in formatting marks", () => {
    expect(applyFormat("make bold now", 5, 9, "*")).toEqual({
      text: "make *bold* now",
      start: 6,
      end: 10,
    });
    expect(applyFormat("x", 0, 1, "```").text).toBe("```x```");
  });
  it("aligns examples with the variables in the body", () => {
    expect(alignExamples("a {{1}} {{2}}", ["Sam"])).toEqual(["Sam", "Sample"]);
    expect(alignExamples("none", ["x"])).toEqual([]);
  });
  it("slugifies names", () => {
    expect(slugifyName("Appointment reminder!")).toBe("appointment_reminder");
    expect(slugifyName("  --Hi-- ")).toBe("hi");
  });
});

describe("validateDraft", () => {
  it("accepts a plain template", () => {
    expect(validateDraft(base()).errors).toEqual([]);
  });
  it("checks the name and language", () => {
    expect(errs(base({ name: "" }))).toContain("name");
    expect(errs(base({ name: "Has Caps" }))).toContain("name");
    expect(errs(base({ language: "english" }))).toContain("language");
  });
  it("requires a body within the limit, with sequential variables and examples", () => {
    expect(errs(base({ body: "" }))).toContain("body");
    expect(errs(base({ body: "x".repeat(1025), bodyExamples: [] }))).toContain("body");
    expect(
      errs(base({ body: "Hi {{1}} and {{3}} are here today.", bodyExamples: ["a", "b", "c"] })),
    ).toContain("body");
    expect(errs(base({ bodyExamples: [] }))).toContain("bodyExamples.0");
  });
  it("rejects variables at the start/end or side by side", () => {
    expect(errs(base({ body: "{{1}} is booked for tomorrow at noon" }))).toContain("body");
    expect(errs(base({ body: "Your booking is for {{1}}" }))).toContain("body");
    expect(
      errs(
        base({
          body: "Hi {{1}}{{2}} your booking is confirmed for tomorrow.",
          bodyExamples: ["a", "b"],
        }),
      ),
    ).toContain("body");
  });
  it("warns when there are too many variables for the text", () => {
    const d = base({ body: "Hi {{1}} {{2}} {{3}} ok.", bodyExamples: ["a", "b", "c"] });
    expect(validateDraft(d).warnings.map((w) => w.path)).toContain("body");
  });
  it("limits header and footer", () => {
    expect(
      errs(base({ type: "media_interactive", header: { kind: "text", text: "x".repeat(61) } })),
    ).toContain("header.text");
    expect(
      errs(base({ type: "media_interactive", header: { kind: "text", text: "Hi {{1}}" } })),
    ).toContain("header.example");
    expect(errs(base({ footer: "y".repeat(61) }))).toContain("footer");
    expect(errs(base({ footer: "Hi {{1}}" }))).toContain("footer");
  });
  it("needs a media sample for a media header and the right type", () => {
    expect(
      errs(base({ type: "media_interactive", header: { kind: "media", format: "IMAGE" } })),
    ).toContain("header.handle");
    expect(errs(base({ header: { kind: "media", format: "IMAGE", handle: "4::x" } }))).toContain(
      "type",
    );
    expect(errs(base({ buttons: [{ type: "QUICK_REPLY", text: "Yes" }] }))).toContain("type");
  });
  it("enforces button rules", () => {
    const mi = (buttons: TemplateDraft["buttons"]) => base({ type: "media_interactive", buttons });
    expect(errs(mi([{ type: "QUICK_REPLY", text: "" }]))).toContain("buttons.0.text");
    expect(errs(mi([{ type: "QUICK_REPLY", text: "x".repeat(26) }]))).toContain("buttons.0.text");
    expect(errs(mi([{ type: "URL", text: "Go", url: "http://insecure.test" }]))).toContain(
      "buttons.0.url",
    );
    expect(errs(mi([{ type: "URL", text: "Go", url: "https://a.test/{{1}}" }]))).toContain(
      "buttons.0.example",
    );
    expect(
      errs(mi([{ type: "URL", text: "Go", url: "https://a.test/{{1}}/x", example: "1" }])),
    ).toContain("buttons.0.url");
    expect(errs(mi([{ type: "PHONE_NUMBER", text: "Call", phone_number: "043000000" }]))).toContain(
      "buttons.0.phone_number",
    );
    const three = [1, 2, 3].map((n) => ({
      type: "URL" as const,
      text: `L${n}`,
      url: `https://a.test/${n}`,
    }));
    expect(errs(mi(three))).toContain("buttons");
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      type: "QUICK_REPLY" as const,
      text: `B${i}`,
    }));
    expect(errs(mi(eleven))).toContain("buttons");
  });
  it("asks marketing templates for an opt-out and flags placeholder links", () => {
    const marketing = base({ category: "MARKETING" });
    expect(validateDraft(marketing).warnings.map((w) => w.path)).toContain("footer");
    expect(
      validateDraft({ ...marketing, footer: "Reply STOP to unsubscribe" }).warnings.filter(
        (w) => w.path === "footer",
      ),
    ).toEqual([]);
    const placeholder = base({
      type: "media_interactive",
      buttons: [{ type: "URL", text: "Go", url: "https://example.com/x" }],
    });
    expect(validateDraft(placeholder).warnings.map((w) => w.path)).toContain("buttons");
  });
  it("validates carousels", () => {
    const card = (o = {}) => ({
      format: "IMAGE" as const,
      handle: "4::h",
      body: "Card text",
      buttons: [{ type: "URL" as const, text: "Open", url: "https://a.test/1" }],
      ...o,
    });
    const car = (cards: TemplateDraft["cards"], o: Partial<TemplateDraft> = {}) =>
      base({ type: "carousel", cards, ...o });
    expect(validateDraft(car([card(), card()])).errors).toEqual([]);
    expect(errs(car([card()]))).toContain("cards");
    expect(errs(car([card(), card({ handle: undefined })]))).toContain("cards.1.handle");
    expect(errs(car([card(), card({ format: "VIDEO" })]))).toContain("cards.1.format");
    expect(errs(car([card(), card({ buttons: [{ type: "QUICK_REPLY", text: "x" }] })]))).toContain(
      "cards.1.buttons",
    );
    expect(errs(car([card(), card({ body: "Hi {{1}}" })]))).toContain("cards.1.body");
    expect(errs(car([card(), card()], { header: { kind: "text", text: "x" } }))).toContain(
      "header",
    );
  });
});

describe("buildComponents / draftFromComponents", () => {
  it("builds header, body with examples, footer and buttons (call-to-action before quick replies)", () => {
    const d = base({
      type: "media_interactive",
      header: { kind: "media", format: "IMAGE", handle: "4::abc" },
      footer: "Reply STOP to unsubscribe",
      buttons: [
        { type: "QUICK_REPLY", text: "Tell me more" },
        { type: "URL", text: "Open", url: "https://a.test/p/{{1}}", example: "42" },
      ],
    });
    const c = buildComponents(d);
    expect(c.map((x) => x.type)).toEqual(["HEADER", "BODY", "FOOTER", "BUTTONS"]);
    expect(c[0]).toMatchObject({ format: "IMAGE", example: { header_handle: ["4::abc"] } });
    expect(c[1]).toMatchObject({ text: d.body, example: { body_text: [["Sara"]] } });
    const buttons = (c[3] as { buttons: Array<{ type: string; example?: string[] }> }).buttons;
    expect(buttons.map((b) => b.type)).toEqual(["URL", "QUICK_REPLY"]);
    expect(buttons[0].example).toEqual(["https://a.test/p/42"]);
  });
  it("omits examples when there are no variables", () => {
    const c = buildComponents(
      base({ body: "No variables in this message at all.", bodyExamples: [] }),
    );
    expect(c).toEqual([{ type: "BODY", text: "No variables in this message at all." }]);
  });
  it("builds a carousel after a top-level body", () => {
    const d = base({
      type: "carousel",
      cards: [0, 1].map((i) => ({
        format: "IMAGE" as const,
        handle: `4::${i}`,
        body: `Card ${i}`,
        buttons: [{ type: "URL" as const, text: "Open", url: `https://a.test/${i}` }],
      })),
    });
    const c = buildComponents(d);
    expect(c.map((x) => x.type)).toEqual(["BODY", "CAROUSEL"]);
    expect((c[1] as { cards: unknown[] }).cards).toHaveLength(2);
    expect(renderTemplatePreview(c, {}).cards.map((x) => x.body)).toEqual(["Card 0", "Card 1"]);
  });
  it("round-trips through Meta components", () => {
    const d = base({
      type: "media_interactive",
      header: { kind: "text", text: "Clinic news", example: undefined },
      footer: "Thanks",
      buttons: [
        { type: "URL", text: "Open", url: "https://a.test/p/{{1}}", example: "42" },
        { type: "QUICK_REPLY", text: "Stop" },
      ],
      variableMap: { "body.1": "contact.first_name" },
    });
    const back = draftFromComponents(
      { name: d.name, language: d.language, category: d.category, variableMap: d.variableMap },
      buildComponents(d),
    );
    expect(back.body).toBe(d.body);
    expect(back.bodyExamples).toEqual(["Sara"]);
    expect(back.footer).toBe("Thanks");
    expect(back.type).toBe("media_interactive");
    expect(back.buttons).toEqual([
      { type: "URL", text: "Open", url: "https://a.test/p/{{1}}", example: "42" },
      { type: "QUICK_REPLY", text: "Stop" },
    ]);
    expect(validateDraft(back).errors).toEqual([]);
  });
});

describe("gallery", () => {
  it("ships about two dozen original templates in English and Arabic", () => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(20);
    expect(GALLERY.filter((g) => g.language === "en")).toHaveLength(GALLERY.length / 2);
    expect(GALLERY.filter((g) => g.language === "ar")).toHaveLength(GALLERY.length / 2);
    expect(new Set(GALLERY.map((g) => g.key)).size).toBe(GALLERY.length);
  });
  it("every entry is valid Meta-structure (media samples excepted) and its names are unique", () => {
    for (const g of GALLERY) {
      const { errors } = validateDraft(g.draft);
      const real = errors.filter((e) => !(g.needsMedia && e.path === "header.handle"));
      expect(real, g.key).toEqual([]);
    }
  });
  it("Arabic entries are Arabic, English entries are not", () => {
    for (const g of GALLERY) {
      const arabic = /[؀-ۿ]/.test(g.draft.body);
      expect(arabic, g.key).toBe(g.language === "ar");
    }
  });
  it("only maps variables to known sources, one per body variable, and gives every variable an example", () => {
    for (const g of GALLERY) {
      const nums = variableNumbers(g.draft.body);
      expect(Object.keys(g.draft.variableMap).sort(), g.key).toEqual(
        nums.map((n) => `body.${n}`).sort(),
      );
      for (const src of Object.values(g.draft.variableMap))
        expect(isTemplateSource(src), `${g.key}: ${src}`).toBe(true);
      expect(g.draft.bodyExamples).toHaveLength(nums.length);
    }
  });
  it("builds components whose variables match the mapping", () => {
    const g = galleryItem("appointment_reminder_en")!;
    const comps = buildComponents(g.draft);
    expect(templateVariables(comps).map((v) => v.key)).toEqual([
      "body.1",
      "body.2",
      "body.3",
      "body.4",
    ]);
    expect(renderTemplatePreview(comps, {}).body).toContain("Dr. Omar");
  });
  it("marketing entries carry an opt-out, appointment entries carry button replies reminders understand", () => {
    for (const g of GALLERY.filter((x) => x.draft.category === "MARKETING"))
      expect(
        validateDraft(g.draft).warnings.filter((w) => w.path === "footer"),
        g.key,
      ).toEqual([]);
    for (const key of [
      "appointment_reminder_en",
      "appointment_reminder_ar",
      "appointment_confirmation_ar",
    ]) {
      const titles = galleryItem(key)!.draft.buttons.map((b) => ("text" in b ? b.text : ""));
      expect(titles.map((t) => classifyButtonReply({ title: t }))).toEqual([
        "confirm",
        "reschedule",
        "cancel",
      ]);
    }
  });
  it("flags entries that need a media sample or a replaced link", () => {
    expect(galleryItem("clinic_news_with_image_en")).toMatchObject({
      needsMedia: true,
      placeholderLink: true,
    });
    expect(galleryItem("welcome_message_ar")).toMatchObject({
      needsMedia: false,
      placeholderLink: false,
    });
  });
});

describe("template sources", () => {
  it("recognises template-level sources and gives samples", () => {
    expect(isTemplateSource("appointment.date")).toBe(true);
    expect(isTemplateSource("contact.name")).toBe(true);
    expect(isTemplateSource("text:Hello")).toBe(true);
    expect(isTemplateSource("custom.plan")).toBe(true);
    expect(isTemplateSource("contact.password")).toBe(false);
    expect(sampleFor("contact.first_name")).toBe("Sara");
    expect(sampleFor("text:Friday")).toBe("Friday");
    expect(sampleFor(undefined)).toBeNull();
  });
});

describe("Arabic button replies", () => {
  it("classifies Arabic titles like the English ones", () => {
    expect(classifyButtonReply({ title: "تأكيد" })).toBe("confirm");
    expect(classifyButtonReply({ title: "تغيير الموعد" })).toBe("reschedule");
    expect(classifyButtonReply({ title: "إلغاء" })).toBe("cancel");
    expect(classifyButtonReply({ title: "لا" })).toBe("cancel");
    expect(classifyButtonReply({ title: "مرحبا" })).toBe("unknown");
  });
});
