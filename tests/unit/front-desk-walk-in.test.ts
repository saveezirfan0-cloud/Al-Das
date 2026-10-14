import { describe, expect, it } from "vitest";

import {
  splitName,
  storedLanguage,
  walkInConsentPlan,
  walkInPhone,
  walkInPhoneDecision,
  walkInSchema,
} from "@/lib/front-desk/walk-in";

// Synthetic numbers only: UAE 050 000 0xxx, the UK drama range +44 7700 900xxx and ACMA's fictional +61 491 570 xxx.
describe("walk-in registration form", () => {
  const ok = {
    phone: "050 000 0123",
    name: "Layla Example",
    language: "ar",
    consent_contact: true,
  };

  it("accepts a complete form and defaults the optional boxes to off", () => {
    const r = walkInSchema.safeParse(ok);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.consent_promotions).toBe(false);
      expect(r.data.add_to_today).toBe(false);
    }
  });

  it("Phase E: the WhatsApp tick is a choice, off unless ticked", () => {
    const r = walkInSchema.safeParse({ ...ok, consent_contact: undefined });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.consent_contact).toBe(false);
    expect(walkInSchema.safeParse({ ...ok, consent_contact: false }).success).toBe(true);
  });

  it("Phase E: the phone may be left out; a name and a known language are still needed", () => {
    expect(walkInSchema.safeParse({ ...ok, phone: "" }).success).toBe(true);
    expect(walkInSchema.safeParse({ ...ok, phone: undefined }).success).toBe(true);
    expect(walkInSchema.safeParse({ ...ok, name: "L" }).success).toBe(false);
    expect(walkInSchema.safeParse({ ...ok, language: "fr" }).success).toBe(false);
  });

  it("normalises the phone to E.164 and rejects numbers that cannot exist", () => {
    expect(walkInPhone("050 000 0123")).toBe("+971500000123");
    expect(walkInPhone("+971 50 000 0123")).toBe("+971500000123");
    expect(walkInPhone("12")).toBeNull();
  });

  it("splits names and stores the language the desk picked", () => {
    expect(splitName("Layla Al Example")).toEqual({ first: "Layla", last: "Al Example" });
    expect(splitName("  Omar ")).toEqual({ first: "Omar", last: "" });
    expect(storedLanguage("ar")).toBe("ar");
    expect(storedLanguage("other")).toBeNull();
  });
});

describe("Phase E: walk-in phone rule", () => {
  it("allows no phone", () => {
    expect(walkInPhoneDecision("")).toEqual({ ok: true, e164: null });
    expect(walkInPhoneDecision("   ")).toEqual({ ok: true, e164: null });
    expect(walkInPhoneDecision(null)).toEqual({ ok: true, e164: null });
  });

  it("accepts UAE mobiles in any common spelling", () => {
    for (const raw of ["050 000 0123", "+971500000123", "00971500000123", "971500000123"])
      expect(walkInPhoneDecision(raw)).toMatchObject({
        ok: true,
        e164: "+971500000123",
        uaeMobile: true,
      });
    expect(walkInPhoneDecision("058 000 0123")).toMatchObject({ ok: true, uaeMobile: true });
  });

  it("refuses a UAE landline or an unknown mobile prefix", () => {
    expect(walkInPhoneDecision("04 000 0000")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a UAE mobile/),
    });
    expect(walkInPhoneDecision("+97151 000 0123")).toMatchObject({ ok: false });
  });

  it("accepts another country's valid number typed with its country code", () => {
    // The training workspace's reserved range must work at the desk too.
    expect(walkInPhoneDecision("+44 7700 900123")).toMatchObject({
      ok: true,
      e164: "+447700900123",
      uaeMobile: false,
    });
    expect(walkInPhoneDecision("0044 7700 900123")).toMatchObject({
      ok: true,
      e164: "+447700900123",
    });
    // A fictional Australian mobile (ACMA reserved range) keeps its country.
    expect(walkInPhoneDecision("+61 491 570 156")).toMatchObject({
      ok: true,
      e164: "+61491570156",
      country: "AU",
    });
  });

  it("refuses garbage and impossible numbers with a hint about the country code", () => {
    expect(walkInPhoneDecision("12")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/country code/),
    });
    expect(walkInPhoneDecision("+44 12")).toMatchObject({ ok: false });
    expect(walkInPhoneDecision("abc")).toMatchObject({ ok: false });
  });
});

describe("Phase E: what the walk-in form changes about messaging", () => {
  const plan = (o: Partial<Parameters<typeof walkInConsentPlan>[0]>) =>
    walkInConsentPlan({
      created: true,
      hasPhone: true,
      consentContact: false,
      consentPromotions: false,
      ...o,
    });

  it("marks a NEW record with a number and no tick as 'no WhatsApp'", () => {
    expect(plan({})).toEqual({
      declineWhatsApp: true,
      recordWhatsAppConsent: false,
      promotions: false,
    });
  });

  it("never treats an empty box as an existing patient withdrawing", () => {
    expect(plan({ created: false })).toEqual({
      declineWhatsApp: false,
      recordWhatsAppConsent: false,
      promotions: false,
    });
  });

  it("records the agreement (and promotions only with it)", () => {
    expect(plan({ consentContact: true, consentPromotions: true })).toEqual({
      declineWhatsApp: false,
      recordWhatsAppConsent: true,
      promotions: true,
    });
    expect(plan({ consentContact: false, consentPromotions: true }).promotions).toBe(false);
    expect(plan({ created: false, consentContact: true }).recordWhatsAppConsent).toBe(true);
  });

  it("without a phone there is nothing to agree or decline", () => {
    expect(plan({ hasPhone: false, consentContact: true, consentPromotions: true })).toEqual({
      declineWhatsApp: false,
      recordWhatsAppConsent: false,
      promotions: false,
    });
  });
});
