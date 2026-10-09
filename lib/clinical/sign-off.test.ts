import { describe, expect, it } from "vitest";

import { isGuardedKey, normaliseApprovedValue } from "@/lib/clinical/sign-off";

describe("normaliseApprovedValue", () => {
  it("accepts only numbers for number settings", () => {
    expect(normaliseApprovedValue("number", " 39.5 ")).toEqual({ ok: true, value: "39.5" });
    expect(normaliseApprovedValue("number", "39,5").ok).toBe(false);
    expect(normaliseApprovedValue("number", "").ok).toBe(false);
  });
  it("accepts only true/false for booleans (case-insensitive)", () => {
    expect(normaliseApprovedValue("boolean", "TRUE")).toEqual({ ok: true, value: "true" });
    expect(normaliseApprovedValue("boolean", "yes").ok).toBe(false);
  });
  it("stores lists as a JSON array from lines, commas or JSON", () => {
    expect(normaliseApprovedValue("list", "rash\nswelling, vomiting\n")).toEqual({
      ok: true,
      value: '["rash","swelling","vomiting"]',
    });
    expect(normaliseApprovedValue("list", '["a","b"]')).toEqual({ ok: true, value: '["a","b"]' });
    expect(normaliseApprovedValue("list", "[1,2]").ok).toBe(false);
    expect(normaliseApprovedValue("list", "[").ok).toBe(false);
    expect(normaliseApprovedValue("list", " , \n").ok).toBe(false);
  });
  it("rejects invalid json", () => {
    expect(normaliseApprovedValue("json", "{}").ok).toBe(true);
    expect(normaliseApprovedValue("json", "{").ok).toBe(false);
  });
  it("flags the two guarded keys", () => {
    expect(isGuardedKey("clinical_messaging_enabled")).toBe(true);
    expect(isGuardedKey("allow_unsigned_defaults")).toBe(true);
    expect(isGuardedKey("adult_fever_temp_c")).toBe(false);
  });
});
