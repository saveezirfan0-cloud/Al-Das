import { describe, expect, it } from "vitest";

import {
  REF_KEY_FIXTURES,
  aliasInText,
  findKeys,
  normalizeAlias,
  normalizeText,
  proposeAlias,
  refKey,
} from "@/lib/finance/match-keys";

describe("refKey", () => {
  it.each(REF_KEY_FIXTURES)("%j -> %j", (input, expected) => {
    expect(refKey(input)).toBe(expected);
  });
  it("is stable when applied twice", () => {
    for (const [input] of REF_KEY_FIXTURES) {
      const k = refKey(input);
      expect(refKey(k)).toBe(k);
    }
  });
});

describe("normalizeText", () => {
  it("keeps upper-case letters and digits only", () => {
    expect(normalizeText("Ins/2026 - 0045")).toBe("INS20260045");
    expect(normalizeText("")).toBe("");
  });
});

describe("findKeys", () => {
  it("finds a key and returns distinct keys in input order", () => {
    expect(findKeys("PAY RA-0002 AND RA-0001 RA-0001", ["RA0001", "RA0002", "RA0003"], 4)).toEqual(["RA0001", "RA0002"]);
  });
  it("does not match a key inside a longer number", () => {
    expect(findKeys("REF 912345", ["12345"], 4)).toEqual([]);
    expect(findKeys("REF 123456", ["12345"], 4)).toEqual([]);
    expect(findKeys("912345", ["12345"], 4)).toEqual([]);
    expect(findKeys("1012345", ["12345"], 4)).toEqual([]);
  });
  it("matches a key after leading zeros in the narrative", () => {
    expect(findKeys("0012345", ["12345"], 4)).toEqual(["12345"]);
    expect(findKeys("PAYMENT 0012345", ["12345"], 4)).toEqual(["12345"]);
  });
  it("matches a key that spans separators", () => {
    expect(findKeys("INS/2026/0045", ["INS20260045"], 4)).toEqual(["INS20260045"]);
    expect(findKeys("ins 2026 0045 thanks", ["INS20260045"], 4)).toEqual(["INS20260045"]);
  });
  it("treats a separator in the original text as a boundary", () => {
    expect(findKeys("PAYER-A RA-0004", ["RA0004"], 4)).toEqual(["RA0004"]);
    expect(findKeys("PAYERARA0004", ["RA0004"], 4)).toEqual([]);
  });
  it("tries every occurrence: a later valid one counts", () => {
    expect(findKeys("912345 AND 12345", ["12345"], 4)).toEqual(["12345"]);
  });
  it("ignores keys shorter than the minimum", () => {
    expect(findKeys("REF 123", ["123"], 4)).toEqual([]);
    expect(findKeys("REF 1234", ["1234"], 4)).toEqual(["1234"]);
  });
  it("checks the letter side too", () => {
    expect(findKeys("XABCD9", ["ABCD"], 4)).toEqual([]);
    expect(findKeys("ABCD9", ["ABCD"], 4)).toEqual(["ABCD"]);
    expect(findKeys("ABCDX", ["ABCD"], 4)).toEqual([]);
  });
});

describe("aliases", () => {
  it("normalises to upper-case words, 3 to 60 characters", () => {
    expect(normalizeAlias("  Acme   health-care ")).toBe("ACME HEALTH CARE");
    expect(normalizeAlias("ab")).toBeNull();
    expect(normalizeAlias("x".repeat(61))).toBeNull();
    expect(normalizeAlias("x".repeat(60))).toBe("X".repeat(60));
  });
  it("finds whole words in order only", () => {
    expect(aliasInText("TRANSFER FROM ACME HEALTH 77", "acme health")).toBe(true);
    expect(aliasInText("ACME-HEALTH", "ACME HEALTH")).toBe(true);
    expect(aliasInText("ACMEHEALTH", "ACME HEALTH")).toBe(false);
    expect(aliasInText("HEALTH ACME", "ACME HEALTH")).toBe(false);
    expect(aliasInText("ACME HEALTHY", "ACME HEALTH")).toBe(false);
    expect(aliasInText("anything", "ab")).toBe(false);
  });
});

describe("proposeAlias", () => {
  it("drops generic words and keeps the first three others", () => {
    expect(proposeAlias("INWARD TRANSFER FROM ACME HEALTH CARE LLC REF 99", 5)).toBe("ACME HEALTH CARE");
  });
  it("is null when too short or nothing is left", () => {
    expect(proposeAlias("CREDIT ADVICE REF 12345", 5)).toBeNull();
    expect(proposeAlias("AB CD", 3)).toBeNull();
  });
  it("is deterministic", () => {
    expect(proposeAlias("acme health", 5)).toBe(proposeAlias("ACME HEALTH", 5));
  });
});
