/**
 * In-memory evaluator with the same semantics as to-sql.ts. Used to decide
 * which dynamic segments a single contact belongs to without a round trip,
 * and in tests to cross-check the SQL compiler.
 */
import type {
  Condition,
  ConditionValue,
  Filter,
  FilterNode,
  Group,
  Operator,
} from "@/lib/filters/ast";
import { countConditions } from "@/lib/filters/ast";
import {
  InvalidOperatorError,
  operatorAllowed,
  type FieldDef,
  type FieldRegistry,
  type RelationKey,
} from "@/lib/filters/field-registry";

/** A contact as the evaluator sees it. Column names match the contacts table. */
export type ContactRecord = {
  columns: Record<string, unknown>;
  custom?: Record<string, unknown> | null;
  /** Related rows keyed by relation, e.g. { contact_tags: [{ tag_id: '…' }] }. */
  relations?: Partial<Record<RelationKey, Array<Record<string, unknown>>>>;
};

export type EvaluateOptions = {
  now?: Date;
  /** IANA timezone for date-only comparisons. Default UTC. */
  timezone?: string;
};

const DAY_MS = 86_400_000;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** YYYY-MM-DD of a Date in the given timezone. */
export function localDateString(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** Parses a date-only value (YYYY-MM-DD) or a timestamp into a YYYY-MM-DD string in tz. */
function toDay(v: unknown, timezone: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return localDateString(v, timezone);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : localDateString(d, timezone);
}

function toTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.getTime();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function dayToTime(day: string): number {
  return new Date(`${day}T00:00:00Z`).getTime();
}

function addDays(day: string, n: number): string {
  return new Date(dayToTime(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Mirrors app.next_anniversary. */
export function nextAnniversary(dob: string, today: string): string {
  const [, m, d] = dob.split("-").map(Number);
  const [ty] = today.split("-").map(Number);
  const build = (year: number) => {
    const dim = new Date(Date.UTC(year, m, 0)).getUTCDate(); // days in month m
    const dd = Math.min(d, dim);
    return `${year}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  const thisYear = build(ty);
  return thisYear >= today ? thisYear : build(ty + 1);
}

function asList(v: ConditionValue | undefined): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  return [];
}

function likeMatch(hay: unknown, needle: string, mode: "contains" | "starts" | "ends"): boolean {
  if (isBlank(hay)) return false;
  const h = str(hay).toLowerCase();
  const n = needle.toLowerCase();
  if (mode === "contains") return h.includes(n);
  if (mode === "starts") return h.startsWith(n);
  return h.endsWith(n);
}

function scalarMatches(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  raw: unknown,
  opts: Required<EvaluateOptions>,
): boolean {
  const textual = field.type === "text";
  const isDate = field.type === "date" || field.type === "datetime";
  const isTs = field.type === "datetime";
  const tz = opts.timezone;
  const nowMs = opts.now.getTime();
  const today = localDateString(opts.now, tz);

  switch (op) {
    case "is_empty":
      return isBlank(raw);
    case "is_not_empty":
      return !isBlank(raw);
    case "is_true":
      return raw === true;
    case "is_false":
      return raw !== true;
    case "eq": {
      if (isBlank(raw)) return false;
      if (field.type === "number" || field.type === "count") return num(raw) === num(value);
      if (textual) return str(raw).toLowerCase() === str(value).toLowerCase();
      return str(raw) === str(value);
    }
    case "neq": {
      if (isBlank(raw)) return true;
      if (field.type === "number" || field.type === "count") return num(raw) !== num(value);
      if (textual) return str(raw).toLowerCase() !== str(value).toLowerCase();
      return str(raw) !== str(value);
    }
    case "contains":
      return likeMatch(raw, str(value), "contains");
    case "not_contains":
      return isBlank(raw) || !likeMatch(raw, str(value), "contains");
    case "starts_with":
      return likeMatch(raw, str(value), "starts");
    case "ends_with":
      return likeMatch(raw, str(value), "ends");
    case "in": {
      if (isBlank(raw)) return false;
      const list = asList(value).map((x) => (textual ? x.toLowerCase() : x));
      return list.includes(textual ? str(raw).toLowerCase() : str(raw));
    }
    case "not_in": {
      if (isBlank(raw)) return true;
      const list = asList(value).map((x) => (textual ? x.toLowerCase() : x));
      return !list.includes(textual ? str(raw).toLowerCase() : str(raw));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = num(raw);
      const b = num(value);
      if (a === null || b === null) return false;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    case "between": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      if (isDate) {
        const day = toDay(raw, tz);
        if (!day) return false;
        if (value.from != null && value.from !== "" && day < String(value.from)) return false;
        if (value.to != null && value.to !== "" && day > String(value.to)) return false;
        return true;
      }
      const a = num(raw);
      if (a === null) return false;
      if (value.from != null && value.from !== "" && a < Number(value.from)) return false;
      if (value.to != null && value.to !== "" && a > Number(value.to)) return false;
      return true;
    }
    case "on":
    case "before":
    case "after": {
      const day = toDay(raw, tz);
      if (!day) return false;
      const target = str(value);
      return op === "on" ? day === target : op === "before" ? day < target : day > target;
    }
    case "within_last": {
      const n = num(value) ?? 0;
      if (isTs) {
        const t = toTime(raw);
        return t !== null && t >= nowMs - n * DAY_MS;
      }
      const day = toDay(raw, tz);
      return day !== null && day >= addDays(today, -n) && day <= today;
    }
    case "not_within_last": {
      const n = num(value) ?? 0;
      if (isTs) {
        const t = toTime(raw);
        return t === null || t < nowMs - n * DAY_MS;
      }
      const day = toDay(raw, tz);
      return day === null || day < addDays(today, -n);
    }
    case "older_than": {
      const n = num(value) ?? 0;
      if (isTs) {
        const t = toTime(raw);
        return t !== null && t < nowMs - n * DAY_MS;
      }
      const day = toDay(raw, tz);
      return day !== null && day < addDays(today, -n);
    }
    case "within_next": {
      const n = num(value) ?? 0;
      if (isTs) {
        const t = toTime(raw);
        return t !== null && t >= nowMs && t <= nowMs + n * DAY_MS;
      }
      const day = toDay(raw, tz);
      return day !== null && day >= today && day <= addDays(today, n);
    }
    default:
      throw new InvalidOperatorError(field.key, op);
  }
}

function anniversaryMatches(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  raw: unknown,
  opts: Required<EvaluateOptions>,
): boolean {
  const dob = toDay(raw, opts.timezone);
  if (op === "is_empty") return dob === null;
  if (op === "is_not_empty") return dob !== null;
  if (dob === null) return false;
  const today = localDateString(opts.now, opts.timezone);
  switch (op) {
    case "is_today":
      return nextAnniversary(dob, today) === today;
    case "within_next":
      return nextAnniversary(dob, today) <= addDays(today, num(value) ?? 0);
    case "month_is":
      return Number(dob.slice(5, 7)) === num(value);
    default:
      throw new InvalidOperatorError(field.key, op);
  }
}

function setMatches(op: Operator, value: ConditionValue | undefined, have: string[]): boolean {
  const want = asList(value);
  switch (op) {
    case "is_empty":
      return have.length === 0;
    case "is_not_empty":
      return have.length > 0;
    case "has_any":
      return want.some((w) => have.includes(w));
    case "has_none":
      return !want.some((w) => have.includes(w));
    case "has_all":
      return want.every((w) => have.includes(w));
    default:
      return false;
  }
}

const NEGATED: Partial<Record<Operator, Operator>> = {
  neq: "eq",
  not_in: "in",
  not_contains: "contains",
  is_empty: "is_not_empty",
  not_within_last: "within_last",
  is_false: "is_true",
};

export function evaluateCondition(
  c: Condition,
  registry: FieldRegistry,
  record: ContactRecord,
  opts: Required<EvaluateOptions>,
): boolean {
  const field = registry.require(c.field);
  if (!operatorAllowed(field, c.op)) throw new InvalidOperatorError(c.field, c.op);
  const s = field.source;

  if (s.kind === "count") {
    const rows = record.relations?.[s.relation] ?? [];
    const rel = registry.relations[s.relation];
    const n = rel.extraWhere ? rows.filter((r) => r.done !== true).length : rows.length;
    return scalarMatches(field, c.op, c.value, n, opts);
  }

  if (s.kind === "relation") {
    const rel = registry.relations[s.relation];
    let rows = record.relations?.[s.relation] ?? [];
    if (rel.extraWhere) rows = rows.filter((r) => r.done !== true);
    if (field.type === "set") {
      const have = rows.map((r) => str(r[s.column])).filter((v) => v !== "");
      return setMatches(c.op, c.value, [...new Set(have)]);
    }
    const positive = NEGATED[c.op];
    if (positive)
      return !rows.some((r) => scalarMatches(field, positive, c.value, r[s.column], opts));
    return rows.some((r) => scalarMatches(field, c.op, c.value, r[s.column], opts));
  }

  const raw = s.kind === "custom" ? (record.custom ?? {})[s.key] : record.columns[s.column];

  if (field.type === "anniversary") return anniversaryMatches(field, c.op, c.value, raw, opts);
  if (field.type === "multi_select") {
    const have = Array.isArray(raw) ? raw.map(String) : [];
    return setMatches(c.op, c.value, have);
  }
  if (s.kind === "custom") {
    // Mirror the jsonb_typeof guards in to-sql.ts: wrongly typed values read as empty.
    if (field.type === "number" && typeof raw !== "number")
      return scalarMatches(field, c.op, c.value, null, opts);
    if (field.type === "boolean" && typeof raw !== "boolean")
      return scalarMatches(field, c.op, c.value, null, opts);
    if (field.type === "date" && typeof raw !== "string")
      return scalarMatches(field, c.op, c.value, null, opts);
  }
  return scalarMatches(field, c.op, c.value, raw, opts);
}

export function evaluateGroup(
  g: Group,
  registry: FieldRegistry,
  record: ContactRecord,
  opts: Required<EvaluateOptions>,
): boolean {
  const children = g.children.filter((n: FilterNode) => countConditions(n) > 0);
  if (children.length === 0) return true;
  const test = (n: FilterNode) =>
    n.type === "condition"
      ? evaluateCondition(n, registry, record, opts)
      : evaluateGroup(n, registry, record, opts);
  return g.logic === "and" ? children.every(test) : children.some(test);
}

/** True when the record matches `include` and not `exclude`. Empty filters match everything. */
export function evaluateFilter(
  filter: Filter | null | undefined,
  registry: FieldRegistry,
  record: ContactRecord,
  options: EvaluateOptions = {},
): boolean {
  const opts = { now: options.now ?? new Date(), timezone: options.timezone ?? "UTC" };
  if (!filter) return true;
  const inc = countConditions(filter.include)
    ? evaluateGroup(filter.include, registry, record, opts)
    : true;
  if (!inc) return false;
  const exc =
    filter.exclude && countConditions(filter.exclude)
      ? evaluateGroup(filter.exclude, registry, record, opts)
      : false;
  return !exc;
}
