import { describe, expect, it } from "vitest";

import {
  and,
  cond,
  countConditions,
  emptyFilter,
  isEmptyFilter,
  or,
  parseFilter,
  safeParseFilter,
} from "@/lib/filters/ast";

describe("filter AST", () => {
  it("parses a valid nested filter with an exclusion group", () => {
    const f = parseFilter({
      include: {
        type: "group",
        logic: "and",
        children: [
          { type: "condition", field: "gender", op: "eq", value: "female" },
          {
            type: "group",
            logic: "or",
            children: [
              { type: "condition", field: "tags", op: "has_any", value: ["a", "b"] },
              {
                type: "condition",
                field: "dob",
                op: "between",
                value: { from: "1990-01-01", to: null },
              },
            ],
          },
        ],
      },
      exclude: {
        type: "group",
        logic: "and",
        children: [{ type: "condition", field: "stop_marketing", op: "is_true" }],
      },
    });
    expect(countConditions(f.include)).toBe(3);
    expect(countConditions(f.exclude)).toBe(1);
    expect(isEmptyFilter(f)).toBe(false);
  });

  it("rejects unknown operators, bad field keys and junk values", () => {
    expect(
      safeParseFilter({
        include: {
          type: "group",
          logic: "and",
          children: [{ type: "condition", field: "x", op: "like" }],
        },
      }),
    ).toBeNull();
    expect(
      safeParseFilter({
        include: {
          type: "group",
          logic: "and",
          children: [{ type: "condition", field: "x; drop", op: "eq", value: 1 }],
        },
      }),
    ).toBeNull();
    expect(safeParseFilter({ include: { type: "group", logic: "xor", children: [] } })).toBeNull();
    expect(
      safeParseFilter({
        include: {
          type: "group",
          logic: "and",
          children: [
            { type: "condition", field: "x", op: "eq", value: { nested: { deep: true } } },
          ],
        },
      }),
    ).toBeNull();
    expect(safeParseFilter(null)).toBeNull();
  });

  it("treats a filter with only empty groups as empty", () => {
    expect(isEmptyFilter(emptyFilter())).toBe(true);
    expect(isEmptyFilter({ include: and(or()), exclude: and() })).toBe(true);
    expect(isEmptyFilter(null)).toBe(true);
    expect(isEmptyFilter({ include: and(cond("gender", "eq", "male")) })).toBe(false);
  });
});
