import { describe, expect, it } from "vitest";

import {
  GALLERY,
  galleryEntry,
  galleryState,
  GALLERY_USE_CASES,
} from "@/lib/whatsapp/template-gallery";
import {
  PLACEHOLDER_HOST,
  toComponents,
  validateBuilder,
  variableIndexes,
  type BuilderState,
} from "@/lib/whatsapp/template-builder";
import { templateVariables } from "@/lib/whatsapp/templates";

const LANGS = ["en", "ar"] as const;
const ARABIC = /[؀-ۿ]/;

/** What the clinic supplies before submitting: samples, a phone number, real links. */
function completed(s: BuilderState): BuilderState {
  const c: BuilderState = JSON.parse(JSON.stringify(s));
  if (c.header.format !== "NONE" && c.header.format !== "TEXT") c.header.handle = "4::sample";
  c.cards.forEach((card) => (card.handle = "4::sample"));
  const fix = (b: BuilderState["buttons"][number]) => {
    if (b.type === "PHONE_NUMBER" && !b.phone_number) b.phone_number = "+971501234567";
    if (b.type === "URL") {
      b.url = b.url.replace(PLACEHOLDER_HOST, "clinic.example.com");
      b.example = b.example.replace(PLACEHOLDER_HOST, "clinic.example.com");
    }
  };
  c.buttons.forEach(fix);
  c.cards.forEach((card) => card.buttons.forEach(fix));
  return c;
}

describe("starter gallery", () => {
  it("has about 20 templates in English and Arabic", () => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(20);
    expect(new Set(GALLERY.map((g) => g.key)).size).toBe(GALLERY.length);
  });

  it("uses valid Meta names, categories and use cases", () => {
    for (const g of GALLERY) {
      expect(g.key).toMatch(/^[a-z0-9_]+$/);
      expect(GALLERY_USE_CASES).toContain(g.useCase);
      expect(g.title.en.length).toBeGreaterThan(2);
      expect(ARABIC.test(g.title.ar)).toBe(true);
    }
    const cats = new Set(GALLERY.map((g) => g.category));
    expect(cats).toEqual(new Set(["UTILITY", "MARKETING", "AUTHENTICATION"]));
    expect(new Set(GALLERY.map((g) => g.type))).toEqual(
      new Set(["standard", "media_interactive", "carousel"]),
    );
  });

  for (const g of GALLERY) {
    for (const lang of LANGS) {
      it(`${g.key} (${lang}) passes validation once placeholders are supplied`, () => {
        const state = completed(galleryState(g, lang));
        expect(validateBuilder(state), JSON.stringify(validateBuilder(state))).toEqual([]);
        expect(toComponents(state).length).toBeGreaterThan(0);
      });
    }

    it(`${g.key}: English and Arabic share structure`, () => {
      const en = galleryState(g, "en");
      const ar = galleryState(g, "ar");
      expect(variableIndexes(ar.body)).toEqual(variableIndexes(en.body));
      expect(ar.buttons.map((b) => b.type)).toEqual(en.buttons.map((b) => b.type));
      expect(ar.cards.length).toBe(en.cards.length);
      expect(ar.header.format).toBe(en.header.format);
      expect(ar.language).toBe("ar");
      if (g.category !== "AUTHENTICATION") expect(ARABIC.test(ar.body)).toBe(true);
    });

    it(`${g.key}: maps only variables that exist`, () => {
      const keys = templateVariables(toComponents(completed(galleryState(g, "en")))).map(
        (v) => v.key,
      );
      for (const k of Object.keys(g.variableMap)) expect(keys).toContain(k);
    });
  }

  it("refuses to submit while placeholders remain", () => {
    const directions = galleryState(galleryEntry("clinic_directions")!, "en");
    const paths = validateBuilder({ ...directions }).map((i) => i.path);
    expect(paths).toContain("buttons.0.url");
    expect(paths).toContain("buttons.1.phone_number");
    const media = galleryState(galleryEntry("health_checkup_offer")!, "en");
    expect(validateBuilder(media).map((i) => i.path)).toContain("header.media");
  });

  it("contains no personal data or real contact details", () => {
    const text = JSON.stringify(GALLERY);
    expect(text).not.toMatch(/\+?\d{9,}/); // phone-like
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i); // e-mail
    expect(text).not.toMatch(/https?:\/\/(?!placeholder\.invalid)/i); // only placeholder links
  });
});
