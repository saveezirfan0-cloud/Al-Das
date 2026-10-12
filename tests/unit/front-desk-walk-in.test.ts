import { describe, expect, it } from "vitest";

import { splitName, storedLanguage, walkInPhone, walkInSchema } from "@/lib/front-desk/walk-in";

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

  it("refuses to save without the consent tick", () => {
    expect(walkInSchema.safeParse({ ...ok, consent_contact: false }).success).toBe(false);
    expect(walkInSchema.safeParse({ ...ok, consent_contact: undefined }).success).toBe(false);
    const missing = walkInSchema.safeParse({ ...ok, consent_contact: false });
    expect(!missing.success && missing.error.issues[0].message).toMatch(/agree to be contacted/);
  });

  it("needs a phone, a name and a known language", () => {
    expect(walkInSchema.safeParse({ ...ok, phone: "" }).success).toBe(false);
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
