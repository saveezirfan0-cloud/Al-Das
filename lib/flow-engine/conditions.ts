/**
 * Trigger / branch conditions over a flat event context. Uses the same AST as the segment
 * filter builder (lib/filters/ast) so the builder UI and stored shapes are shared, but fields are
 * dotted context paths (`message.text`, `contact.source`, `event.ad`, `vars.score`) rather than
 * contact columns.
 */
import {
  countConditions,
  type Condition,
  type Filter,
  type FilterNode,
  type Group,
} from "@/lib/filters/ast";
import { getPath, stringify, type Scope } from "@/lib/flow-engine/interpolate";

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const norm = (v: unknown) => stringify(v).trim().toLowerCase();

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (typeof v === "string")
    return v
      .split(",")
      .map((x) => norm(x))
      .filter(Boolean);
  return [];
}

export function evaluateCondition(c: Condition, scope: Scope, now: Date = new Date()): boolean {
  const raw = getPath(scope, c.field);
  const value = c.value as unknown;
  switch (c.op) {
    case "eq":
      return norm(raw) === norm(value);
    case "neq":
      return norm(raw) !== norm(value);
    case "contains":
      return norm(value) !== "" && norm(raw).includes(norm(value));
    case "not_contains":
      return !norm(raw).includes(norm(value));
    case "starts_with":
      return norm(raw).startsWith(norm(value));
    case "ends_with":
      return norm(raw).endsWith(norm(value));
    case "in":
      return asList(value).includes(norm(raw));
    case "not_in":
      return !asList(value).includes(norm(raw));
    case "is_empty":
      return norm(raw) === "" || (Array.isArray(raw) && raw.length === 0);
    case "is_not_empty":
      return !(norm(raw) === "" || (Array.isArray(raw) && raw.length === 0));
    case "is_true":
      return raw === true || norm(raw) === "true" || norm(raw) === "yes";
    case "is_false":
      return !(raw === true || norm(raw) === "true" || norm(raw) === "yes");
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNum(raw);
      const b = toNum(value);
      if (a === null || b === null) return false;
      return c.op === "gt" ? a > b : c.op === "gte" ? a >= b : c.op === "lt" ? a < b : a <= b;
    }
    case "between": {
      const a = toNum(raw);
      const range = value as
        { min?: unknown; max?: unknown; from?: unknown; to?: unknown } | undefined;
      const lo = toNum(range?.min ?? range?.from);
      const hi = toNum(range?.max ?? range?.to);
      return a !== null && lo !== null && hi !== null && a >= lo && a <= hi;
    }
    case "has_any": {
      const have = asList(raw);
      return asList(value).some((x) => have.includes(x));
    }
    case "has_all": {
      const have = asList(raw);
      return asList(value).every((x) => have.includes(x));
    }
    case "has_none": {
      const have = asList(raw);
      return !asList(value).some((x) => have.includes(x));
    }
    case "within_last":
    case "older_than":
    case "not_within_last": {
      const t = raw ? new Date(stringify(raw)).getTime() : NaN;
      const days = toNum(value);
      if (Number.isNaN(t) || days === null) return c.op === "not_within_last";
      const age = (now.getTime() - t) / 86_400_000;
      return c.op === "within_last"
        ? age >= 0 && age <= days
        : c.op === "older_than"
          ? age > days
          : !(age >= 0 && age <= days);
    }
    default:
      // Unsupported operator for flows (anniversaries, calendar dates): fail closed.
      return false;
  }
}

function evaluateNode(n: FilterNode, scope: Scope, now: Date): boolean {
  return n.type === "condition" ? evaluateCondition(n, scope, now) : evaluateGroup(n, scope, now);
}

export function evaluateGroup(g: Group, scope: Scope, now: Date = new Date()): boolean {
  const children = g.children.filter((n) => countConditions(n) > 0);
  if (children.length === 0) return true;
  return g.logic === "and"
    ? children.every((n) => evaluateNode(n, scope, now))
    : children.some((n) => evaluateNode(n, scope, now));
}

/** Empty / missing conditions match everything; `exclude` removes matches. */
export function matchesConditions(
  filter: Filter | null | undefined,
  scope: Scope,
  now: Date = new Date(),
): boolean {
  if (!filter) return true;
  if (countConditions(filter.include) > 0 && !evaluateGroup(filter.include, scope, now))
    return false;
  if (
    filter.exclude &&
    countConditions(filter.exclude) > 0 &&
    evaluateGroup(filter.exclude, scope, now)
  )
    return false;
  return true;
}

/** Fields the builder offers for trigger conditions and Branch nodes. */
export const CONDITION_FIELDS: Array<{
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "date";
}> = [
  { key: "message.text", label: "Message text (keyword)", type: "text" },
  { key: "message.button_id", label: "Button id", type: "text" },
  { key: "message.button_title", label: "Button text", type: "text" },
  { key: "event.source", label: "Source", type: "text" },
  { key: "event.ad", label: "Came from an ad", type: "boolean" },
  { key: "event.ad_headline", label: "Ad headline", type: "text" },
  { key: "contact.first_name", label: "Contact first name", type: "text" },
  { key: "contact.language", label: "Contact language", type: "text" },
  { key: "contact.gender", label: "Contact gender", type: "text" },
  { key: "contact.source", label: "Contact source", type: "text" },
  { key: "contact.promotions_opt_in", label: "Contact opted in to promotions", type: "boolean" },
  { key: "conversation.status", label: "Conversation status", type: "text" },
  { key: "enquiry.status", label: "Enquiry status", type: "text" },
  { key: "enquiry.stage", label: "Enquiry stage", type: "text" },
  { key: "enquiry.source", label: "Enquiry source", type: "text" },
  { key: "appointment.status", label: "Appointment status", type: "text" },
  { key: "appointment.location", label: "Appointment location", type: "text" },
];
