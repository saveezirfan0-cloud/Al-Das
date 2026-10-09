import { describe, expect, it } from "vitest";

import {
  componentsToDraft,
  draftToComponents,
  VARIABLE_SOURCES,
  variableNumbers,
} from "@/lib/whatsapp/template-draft";
import { cloneGalleryDraft, GALLERY, galleryEntry } from "@/lib/whatsapp/template-gallery";
import { LIMITS, validateDraft } from "@/lib/whatsapp/template-validate";

describe("starter gallery", () => {
  it("ships about 20+ templates, English and Arabic in pairs", () => {
    expect(GALLERY.length).toBeGreaterThanOrEqual(20);
    const byConcept = new Map<string, string[]>();
    for (const g of GALLERY)
      byConcept.set(g.conceptKey, [...(byConcept.get(g.conceptKey) ?? []), g.language]);
    for (const [, langs] of byConcept) expect(langs.sort()).toEqual(["ar", "en"]);
  });

  it("has unique keys and unique (name, language) pairs", () => {
    expect(new Set(GALLERY.map((g) => g.key)).size).toBe(GALLERY.length);
    expect(new Set(GALLERY.map((g) => `${g.draft.name}:${g.draft.language}`)).size).toBe(
      GALLERY.length,
    );
  });

  it.each(GALLERY.map((g) => [g.key, g] as const))("%s passes Meta's rules", (_k, g) => {
    const r = validateDraft(g.draft);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });

  it("keeps variable counts, mapping keys and button shapes identical across languages", () => {
    for (const en of GALLERY.filter((g) => g.language === "en")) {
      const ar = GALLERY.find((g) => g.conceptKey === en.conceptKey && g.language === "ar")!;
      expect(variableNumbers(ar.draft.body)).toEqual(variableNumbers(en.draft.body));
      expect(ar.draft.variableMap).toEqual(en.draft.variableMap);
      expect(ar.draft.category).toBe(en.draft.category);
      expect(ar.draft.buttons.map((b) => b.type)).toEqual(en.draft.buttons.map((b) => b.type));
    }
  });

  it("maps every body variable to a known source", () => {
    const allowed = new Set<string>(VARIABLE_SOURCES.map((s) => s.key));
    for (const g of GALLERY) {
      for (const n of variableNumbers(g.draft.body)) {
        const src = g.draft.variableMap[`body.${n}`];
        expect(src, `${g.key} body.${n}`).toBeTruthy();
        expect(allowed.has(src)).toBe(true);
      }
    }
  });

  it("marks Arabic as needing review and English as reviewed", () => {
    expect(GALLERY.filter((g) => g.language === "ar").every((g) => !g.reviewed)).toBe(true);
    expect(GALLERY.filter((g) => g.language === "en").every((g) => g.reviewed)).toBe(true);
  });

  it("gives every marketing template an opt-out line", () => {
    for (const g of GALLERY.filter((x) => x.draft.category === "MARKETING"))
      expect(`${g.draft.body} ${g.draft.footer}`, g.key).toMatch(/STOP|إيقاف/);
  });

  it("carries no clinical content, results, dosing or identifiers (CLAUDE.md 10, 12)", () => {
    const banned =
      /\b(diagnos|prescri|dose|dosage|mg\b|ml\b|tablet|result(s)? (show|are)|positive|negative|cancer|HIV|pregnan|Emirates ID|passport|insurance number)/i;
    for (const g of GALLERY) {
      const text = `${g.draft.body} ${g.draft.footer} ${g.title}`;
      expect(text, g.key).not.toMatch(banned);
      expect(text, g.key).not.toMatch(/\d{9,}/);
    }
  });

  it("uses Arabic script in Arabic variants and Latin in English variants", () => {
    for (const g of GALLERY) {
      const arabic = /[؀-ۿ]/.test(g.draft.body);
      expect(arabic, g.key).toBe(g.language === "ar");
    }
  });

  it("stays well inside the length limits so editing has headroom", () => {
    for (const g of GALLERY) expect(g.draft.body.length, g.key).toBeLessThan(LIMITS.bodyMax * 0.5);
  });

  it("survives the round trip through Meta components", () => {
    for (const g of GALLERY) {
      const back = componentsToDraft(draftToComponents(g.draft), {
        name: g.draft.name,
        language: g.draft.language,
        category: g.draft.category,
        variableMap: g.draft.variableMap,
      });
      expect(back.body).toBe(g.draft.body);
      expect(back.bodyExamples).toEqual(g.draft.bodyExamples);
      expect(back.buttons).toEqual(
        g.draft.buttons.map((b) => (b.type === "URL" ? { ...b, example: undefined } : b)),
      );
    }
  });

  it("hands out independent copies", () => {
    const a = cloneGalleryDraft("appointment_reminder:en")!;
    a.body = "changed";
    expect(galleryEntry("appointment_reminder:en")!.draft.body).not.toBe("changed");
    expect(cloneGalleryDraft("nope:en")).toBeNull();
  });
});
