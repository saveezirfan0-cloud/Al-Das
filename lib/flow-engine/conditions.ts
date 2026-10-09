/**
 * Two small condition languages:
 *  - trigger conditions (Source / Keyword / Ad, equals / not equals / contains / not contains)
 *  - branch conditions (any value in the run scope against a literal)
 * Both are pure and case-insensitive for text.
 */
import { getPath, interpolate, type InterpolateScope } from "@/lib/flow-engine/interpolate";
import type { TriggerConditions } from "@/lib/flow-engine/types";

export type TriggerFacts = { source?: string | null; keyword?: string | null; ad?: string | null };

function textTest(
  op: "equals" | "not_equals" | "contains" | "not_contains",
  actual: string,
  expected: string,
): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  switch (op) {
    case "equals":
      return a === e;
    case "not_equals":
      return a !== e;
    case "contains":
      return e === "" ? true : a.includes(e);
    case "not_contains":
      return e === "" ? true : !a.includes(e);
  }
}

/** Empty condition list always matches. */
export function matchTriggerConditions(
  cond: TriggerConditions | null | undefined,
  facts: TriggerFacts,
): boolean {
  if (!cond || cond.conditions.length === 0) return true;
  const results = cond.conditions.map((c) =>
    textTest(c.op, String(facts[c.category] ?? ""), c.value),
  );
  return cond.logic === "or" ? results.some(Boolean) : results.every(Boolean);
}

export const BRANCH_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_empty",
  "is_not_empty",
  "in",
] as const;
export type BranchOp = (typeof BRANCH_OPS)[number];

export type BranchCondition = { left: string; op: BranchOp; right?: string };
export type BranchRule = { logic: "and" | "or"; conditions: BranchCondition[] };

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function evaluateBranch(rule: BranchRule, scope: InterpolateScope): boolean {
  if (rule.conditions.length === 0) return false; // fail closed: an empty branch never says "true"
  const results = rule.conditions.map((c) => {
    // `left` is a scope path ("vars.age") or an interpolated string ("{contact.first_name}").
    const leftVal = c.left.includes("{") ? interpolate(c.left, scope).text : getPath(scope, c.left);
    const right = interpolate(c.right ?? "", scope).text;
    switch (c.op) {
      case "is_empty":
        return isBlank(leftVal);
      case "is_not_empty":
        return !isBlank(leftVal);
      case "eq":
        return (
          String(leftVal ?? "")
            .trim()
            .toLowerCase() === right.trim().toLowerCase()
        );
      case "neq":
        return (
          String(leftVal ?? "")
            .trim()
            .toLowerCase() !== right.trim().toLowerCase()
        );
      case "contains":
        return String(leftVal ?? "")
          .toLowerCase()
          .includes(right.toLowerCase());
      case "not_contains":
        return !String(leftVal ?? "")
          .toLowerCase()
          .includes(right.toLowerCase());
      case "in":
        return right
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .includes(
            String(leftVal ?? "")
              .trim()
              .toLowerCase(),
          );
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (isBlank(leftVal) || isBlank(right)) return false; // unknown data fails closed
        const l = Number(leftVal);
        const r = Number(right);
        if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
        return c.op === "gt" ? l > r : c.op === "gte" ? l >= r : c.op === "lt" ? l < r : l <= r;
      }
    }
  });
  return rule.logic === "or" ? results.some(Boolean) : results.every(Boolean);
}
