import { describe, expect, it } from "vitest";

import { and, cond, or, type Filter } from "@/lib/filters/ast";
import { matchesConditions } from "@/lib/flow-engine/conditions";

const scope = {
  message: { text: "Hello, I want to BOOK a check-up", button_id: "confirm" },
  event: { ad: true, source: "whatsapp_ad" },
  contact: { first_name: "Sara", language: "ar" },
  vars: { score: 7, tags: "a,b" },
  enquiry: { created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
};
const f = (include = and(), exclude?: ReturnType<typeof and>): Filter => ({
  include,
  exclude: exclude ?? null,
});

describe("flow conditions", () => {
  it("empty or missing conditions match", () => {
    expect(matchesConditions(null, scope)).toBe(true);
    expect(matchesConditions(f(), scope)).toBe(true);
  });

  it("keyword contains is case-insensitive", () => {
    expect(matchesConditions(f(and(cond("message.text", "contains", "book"))), scope)).toBe(true);
    expect(matchesConditions(f(and(cond("message.text", "contains", "cancel"))), scope)).toBe(
      false,
    );
    expect(matchesConditions(f(and(cond("message.text", "contains", ""))), scope)).toBe(false);
  });

  it("AND / OR / exclude", () => {
    const inc = and(
      cond("event.ad", "is_true"),
      or(cond("contact.language", "eq", "ar"), cond("contact.language", "eq", "en")),
    );
    expect(matchesConditions(f(inc), scope)).toBe(true);
    expect(matchesConditions(f(inc, and(cond("message.button_id", "eq", "confirm"))), scope)).toBe(
      false,
    );
    expect(matchesConditions(f(and(cond("contact.language", "eq", "fr"))), scope)).toBe(false);
  });

  it("numbers compare numerically and fail closed on blanks", () => {
    expect(matchesConditions(f(and(cond("vars.score", "gt", 5))), scope)).toBe(true);
    expect(matchesConditions(f(and(cond("vars.score", "lt", 5))), scope)).toBe(false);
    expect(matchesConditions(f(and(cond("vars.missing", "gt", 1))), scope)).toBe(false);
    expect(
      matchesConditions(f(and(cond("vars.score", "between", { from: 5, to: 9 }))), scope),
    ).toBe(true);
  });

  it("in / not_in / has_any / is_empty", () => {
    expect(matchesConditions(f(and(cond("contact.language", "in", "ar, en"))), scope)).toBe(true);
    expect(matchesConditions(f(and(cond("contact.language", "not_in", "ar"))), scope)).toBe(false);
    expect(matchesConditions(f(and(cond("vars.tags", "has_any", "z,b"))), scope)).toBe(true);
    expect(matchesConditions(f(and(cond("vars.nothing", "is_empty"))), scope)).toBe(true);
    expect(matchesConditions(f(and(cond("contact.first_name", "is_not_empty"))), scope)).toBe(true);
  });

  it("date windows use the supplied clock", () => {
    expect(matchesConditions(f(and(cond("enquiry.created_at", "within_last", 3))), scope)).toBe(
      true,
    );
    expect(matchesConditions(f(and(cond("enquiry.created_at", "older_than", 1))), scope)).toBe(
      true,
    );
    expect(matchesConditions(f(and(cond("enquiry.created_at", "within_last", 1))), scope)).toBe(
      false,
    );
    expect(matchesConditions(f(and(cond("enquiry.nope", "within_last", 1))), scope)).toBe(false);
  });

  it("operators flows do not support fail closed", () => {
    expect(matchesConditions(f(and(cond("contact.first_name", "is_today"))), scope)).toBe(false);
  });
});
