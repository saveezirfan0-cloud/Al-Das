import { describe, expect, it } from "vitest";

import { formatPhone, isE164, maskPhone, normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it("normalises UAE numbers in every shape Unite / Sanoflow / humans produce", () => {
    const want = { e164: "+971501234567", country: "AE" };
    expect(normalizePhone("971-501234567")).toEqual(want);
    expect(normalizePhone("+971 50 123 4567")).toEqual(want);
    expect(normalizePhone("00971501234567")).toEqual(want);
    expect(normalizePhone("0501234567")).toEqual(want);
    expect(normalizePhone("971501234567")).toEqual(want);
    expect(normalizePhone("'971501234567")).toEqual(want);
    expect(normalizePhone("(050) 123-4567")).toEqual(want);
  });

  it("keeps other countries and uses the default country for national numbers", () => {
    expect(normalizePhone("+44 7911 123456")?.e164).toBe("+447911123456");
    expect(normalizePhone("07911 123456", "GB")?.e164).toBe("+447911123456");
    expect(normalizePhone("966501234567")).toEqual({ e164: "+966501234567", country: "SA" });
  });

  it("rejects junk", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("+971 5")).toBeNull();
  });

  it("validates, masks and formats E.164", () => {
    expect(isE164("+971501234567")).toBe(true);
    expect(isE164("971501234567")).toBe(false);
    expect(isE164("+0123")).toBe(false);
    expect(maskPhone("+971501234567")).toBe("+971*******67");
    expect(maskPhone(null)).toBe("");
    expect(formatPhone("+971501234567")).toBe("+971 50 123 4567");
  });
});
