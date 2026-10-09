import { describe, expect, it } from "vitest";

import { emptyDraft, type TemplateDraft } from "@/lib/whatsapp/template-draft";
import { LIMITS, validateDraft } from "@/lib/whatsapp/template-validate";

const good = (over: Partial<TemplateDraft> = {}): TemplateDraft =>
  emptyDraft({
    name: "appointment_reminder",
    language: "en",
    body: "Hello {{1}}, your appointment is on {{2}}. Please let us know if it still suits you.",
    bodyExamples: ["Sara", "Monday 10 November"],
    footer: "Al Das Medical",
    buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
    ...over,
  });

const errs = (d: TemplateDraft) => validateDraft(d).errors.map((e) => `${e.path}: ${e.message}`);
const has = (d: TemplateDraft, path: string, re: RegExp) =>
  validateDraft(d).errors.some((e) => e.path === path && re.test(e.message));

describe("validateDraft: a good template", () => {
  it("passes", () => {
    const r = validateDraft(good());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("identity", () => {
  it.each([
    ["", /name/i],
    ["Has Caps", /lowercase/i],
    ["has-dash", /lowercase/i],
    ["spaces here", /lowercase/i],
  ])("rejects name %j", (name, re) => expect(has(good({ name }), "name", re)).toBe(true));

  it("rejects an over-long name and a bad language", () => {
    expect(has(good({ name: "a".repeat(LIMITS.nameMax + 1) }), "name", /at most/i)).toBe(true);
    expect(has(good({ language: "english" }), "language", /language/i)).toBe(true);
    expect(validateDraft(good({ language: "en_US" })).ok).toBe(true);
    expect(validateDraft(good({ language: "ar" })).ok).toBe(true);
  });
});

describe("body", () => {
  it("requires text and respects the length limit", () => {
    expect(has(good({ body: "  " }), "body", /required/)).toBe(true);
    expect(
      has(good({ body: "x".repeat(LIMITS.bodyMax + 1), bodyExamples: [] }), "body", /characters/),
    ).toBe(true);
    expect(validateDraft(good({ body: "x".repeat(LIMITS.bodyMax), bodyExamples: [] })).ok).toBe(
      true,
    );
  });

  it("requires variables numbered 1..n without gaps", () => {
    expect(
      has(
        good({ body: "Hello {{2}}, welcome to our clinic today.", bodyExamples: ["", "Sara"] }),
        "body",
        /no gaps/,
      ),
    ).toBe(true);
  });

  it("cannot start or end with a variable, nor have two adjacent", () => {
    expect(
      has(good({ body: "{{1}} is welcome to visit us.", bodyExamples: ["Sara"] }), "body", /start/),
    ).toBe(true);
    expect(
      has(good({ body: "Please welcome our guest {{1}}", bodyExamples: ["Sara"] }), "body", /end/),
    ).toBe(true);
    expect(
      has(
        good({ body: "Hello {{1}}{{2}} welcome to the clinic.", bodyExamples: ["a", "b"] }),
        "body",
        /next to each other/,
      ),
    ).toBe(true);
    // trailing punctuation after a variable is still "ending with a variable"
    expect(
      has(good({ body: "Please welcome our guest {{1}}.", bodyExamples: ["Sara"] }), "body", /end/),
    ).toBe(true);
  });

  it("requires an example for every variable, without line breaks", () => {
    expect(has(good({ bodyExamples: ["Sara"] }), "body", /example for \{\{2\}\}/)).toBe(true);
    expect(has(good({ bodyExamples: ["Sara", "two\nlines"] }), "body", /line breaks/)).toBe(true);
  });

  it("rejects bodies that are mostly variables, bad braces and non-numeric variables", () => {
    expect(
      has(
        good({ body: "A {{1}} B {{2}} C {{3}} D", bodyExamples: ["a", "b", "c"] }),
        "body",
        /Too many variables/,
      ),
    ).toBe(true);
    expect(
      has(
        good({ body: "Hello {{1} and welcome to the clinic.", bodyExamples: ["a"] }),
        "body",
        /Unbalanced/,
      ),
    ).toBe(true);
    expect(
      has(
        good({ body: "Hello {{name}}, welcome to the clinic today.", bodyExamples: [] }),
        "body",
        /numbers/,
      ),
    ).toBe(true);
  });
});

describe("header and footer", () => {
  it("limits text headers to 60 characters, one variable, no formatting", () => {
    const h = (text: string, example = "x") => good({ header: { format: "TEXT", text, example } });
    expect(has(h("x".repeat(61)), "header", /at most 60/)).toBe(true);
    expect(has(h("Hi {{1}} and {{2}}"), "header", /one variable/)).toBe(true);
    expect(has(h("Hi {{1}}", ""), "header", /example/)).toBe(true);
    expect(has(h("*Bold* title"), "header", /formatting/)).toBe(true);
    expect(has(h(""), "header", /required/)).toBe(true);
    expect(validateDraft(h("Hello {{1}}", "Sara")).ok).toBe(true);
  });

  it("requires a sample file for media headers", () => {
    expect(has(good({ header: { format: "IMAGE" } }), "header", /sample/)).toBe(true);
    expect(validateDraft(good({ header: { format: "IMAGE", handle: "4::abc" } })).ok).toBe(true);
    expect(
      validateDraft(good({ header: { format: "DOCUMENT", samplePath: "org/x.pdf" } })).ok,
    ).toBe(true);
    expect(validateDraft(good({ header: { format: "LOCATION" } })).ok).toBe(true);
  });

  it("limits the footer and forbids variables in it", () => {
    expect(has(good({ footer: "x".repeat(61) }), "footer", /at most 60/)).toBe(true);
    expect(has(good({ footer: "Hi {{1}}" }), "footer", /variables/)).toBe(true);
  });
});

describe("buttons", () => {
  const btn = (b: TemplateDraft["buttons"]) => good({ buttons: b });
  const q = (text: string) => ({ type: "QUICK_REPLY" as const, text });

  it("limits count, text length and duplicates", () => {
    expect(
      has(btn(Array.from({ length: 11 }, (_, i) => q(`b${i}`))), "buttons", /at most 10/i),
    ).toBe(true);
    expect(has(btn([q("x".repeat(26))]), "buttons[0]", /25/)).toBe(true);
    expect(has(btn([q("Same"), q("same")]), "buttons[1]", /same text/)).toBe(true);
    expect(has(btn([q("")]), "buttons[0]", /required/)).toBe(true);
    expect(has(btn([q("Hi {{1}}")]), "buttons[0]", /variables/)).toBe(true);
  });

  it("limits URL, phone and copy-code buttons and keeps quick replies grouped", () => {
    const url = (n: number) => ({
      type: "URL" as const,
      text: `Link ${n}`,
      url: `https://example.com/${n}`,
    });
    expect(has(btn([url(1), url(2), url(3)]), "buttons", /URL buttons/)).toBe(true);
    const phone = (n: number) => ({
      type: "PHONE_NUMBER" as const,
      text: `Call ${n}`,
      phone_number: "+97140000000",
    });
    expect(has(btn([phone(1), phone(2)]), "buttons", /call button/)).toBe(true);
    const code = { type: "COPY_CODE" as const, example: "CODE1" };
    expect(has(btn([code, { ...code, example: "CODE2" }]), "buttons", /copy-code/)).toBe(true);
    expect(has(btn([q("A"), url(1), q("B")]), "buttons", /together/)).toBe(true);
    expect(validateDraft(btn([q("A"), q("B"), url(1)])).ok).toBe(true);
  });

  it("validates URL buttons", () => {
    const u = (url: string, example?: string) => btn([{ type: "URL", text: "Open", url, example }]);
    expect(has(u("http://example.com"), "buttons[0]", /https/)).toBe(true);
    expect(
      has(u("https://example.com/{{1}}/x", "https://example.com/1/x"), "buttons[0]", /very end/),
    ).toBe(true);
    expect(has(u("https://example.com/{{1}}"), "buttons[0]", /example address/)).toBe(true);
    expect(validateDraft(u("https://example.com/{{1}}", "https://example.com/42")).ok).toBe(true);
    expect(
      has(u(`https://example.com/${"a".repeat(LIMITS.urlMax)}`), "buttons[0]", /too long/),
    ).toBe(true);
  });

  it("validates phone and copy-code buttons", () => {
    expect(
      has(
        btn([{ type: "PHONE_NUMBER", text: "Call", phone_number: "04 000 0000" }]),
        "buttons[0]",
        /international/,
      ),
    ).toBe(true);
    expect(
      validateDraft(btn([{ type: "PHONE_NUMBER", text: "Call", phone_number: "+971 4 000 0000" }]))
        .ok,
    ).toBe(true);
    expect(has(btn([{ type: "COPY_CODE", example: "" }]), "buttons[0]", /example code/)).toBe(true);
    expect(has(btn([{ type: "COPY_CODE", example: "x".repeat(16) }]), "buttons[0]", /15/)).toBe(
      true,
    );
  });
});

describe("carousel", () => {
  const card = (n: number, over: Partial<TemplateDraft["cards"][number]> = {}) => ({
    header: { format: "IMAGE" as const, handle: `4::h${n}` },
    body: `Card ${n} describes one of our services.`,
    bodyExamples: [],
    buttons: [{ type: "QUICK_REPLY" as const, text: "Book" }],
    ...over,
  });
  const carousel = (cards: TemplateDraft["cards"]) =>
    emptyDraft({
      name: "services",
      kind: "carousel",
      category: "MARKETING",
      body: "Our services are below. Reply STOP to opt out.",
      cards,
    });

  it("accepts 2–10 matching cards", () => {
    expect(errs(carousel([card(1), card(2)]))).toEqual([]);
    expect(has(carousel([card(1)]), "cards", /2–10/)).toBe(true);
    expect(has(carousel(Array.from({ length: 11 }, (_, i) => card(i))), "cards", /2–10/)).toBe(
      true,
    );
  });

  it("requires identical card shape, sample media and buttons", () => {
    expect(
      has(
        carousel([card(1), card(2, { header: { format: "VIDEO", handle: "4::v" } })]),
        "cards[1]",
        /same media/,
      ),
    ).toBe(true);
    expect(
      has(
        carousel([
          card(1),
          card(2, {
            buttons: [
              { type: "QUICK_REPLY", text: "Other" },
              { type: "QUICK_REPLY", text: "More" },
            ],
          }),
        ]),
        "cards[1]",
        /same media/,
      ),
    ).toBe(true);
    expect(
      has(
        carousel([card(1), card(2, { header: { format: "IMAGE" } })]),
        "cards[1].header",
        /sample/,
      ),
    ).toBe(true);
    expect(
      has(
        carousel([card(1, { buttons: [] }), card(2, { buttons: [] })]),
        "cards[0].buttons",
        /at least one/,
      ),
    ).toBe(true);
  });

  it("forbids authentication carousels", () => {
    expect(
      has({ ...carousel([card(1), card(2)]), category: "AUTHENTICATION" }, "category", /Carousels/),
    ).toBe(true);
  });
});

describe("advice (warnings, not errors)", () => {
  const warns = (d: TemplateDraft) => validateDraft(d).warnings.map((w) => w.message);
  it("asks marketing messages to explain opt-out", () => {
    expect(warns(good({ category: "MARKETING", footer: "" })).join()).toMatch(/opt out/);
    expect(
      warns(good({ category: "MARKETING", footer: "Reply STOP to opt out" })).join(),
    ).not.toMatch(/opt out/);
    expect(validateDraft(good({ category: "MARKETING", footer: "" })).ok).toBe(true);
  });
  it("flags promotional wording in a utility template", () => {
    expect(
      warns(good({ body: "Hello {{1}}, enjoy a free scan on {{2}} as our thanks to you." })).join(),
    ).toMatch(/reclassify/);
  });
  it("flags unknown variable_map sources", () => {
    expect(warns(good({ variableMap: { "body.1": "contact.shoe_size" } })).join()).toMatch(
      /Unknown source/,
    );
  });
  it("notes that authentication templates have a fixed layout", () => {
    expect(warns(good({ category: "AUTHENTICATION" })).join()).toMatch(/one-time-code/);
  });
});
