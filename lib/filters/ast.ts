/**
 * Filter AST shared by the UI (filter builder), the SQL compiler and the
 * in-memory evaluator. Framework-free; validated with Zod at every boundary.
 *
 *   Filter = { include: Group, exclude?: Group }
 *   Group  = { type: 'group', logic: 'and' | 'or', children: (Group | Condition)[] }
 *   Condition = { type: 'condition', field, op, value? }
 *
 * `exclude` is the "Exclusion filters" group: a contact matches when it
 * matches `include` AND does NOT match `exclude`.
 */
import { z } from "zod";

export const OPERATORS = [
  // text / select
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
  // numbers / counts
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  // dates
  "on",
  "before",
  "after",
  "within_last", // n days, includes now
  "not_within_last", // n days (null counts as "not within")
  "older_than", // n days (null excluded)
  "within_next", // n days from now
  // booleans
  "is_true",
  "is_false",
  // sets (tags, segments, multi-select custom fields)
  "has_any",
  "has_all",
  "has_none",
  // anniversaries (birthday)
  "is_today",
  "month_is",
] as const;

export type Operator = (typeof OPERATORS)[number];

/** Operators that take no value. */
export const UNARY_OPERATORS: ReadonlySet<Operator> = new Set<Operator>([
  "is_empty",
  "is_not_empty",
  "is_true",
  "is_false",
  "is_today",
]);

/** Operators whose value is a list. */
export const LIST_OPERATORS: ReadonlySet<Operator> = new Set<Operator>([
  "in",
  "not_in",
  "has_any",
  "has_all",
  "has_none",
]);

/** Operators whose value is a number of days. */
export const DAYS_OPERATORS: ReadonlySet<Operator> = new Set<Operator>([
  "within_last",
  "not_within_last",
  "older_than",
  "within_next",
]);

export const rangeValue = z
  .object({
    from: z.union([z.string(), z.number()]).nullable().optional(),
    to: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .strict();
export type RangeValue = z.infer<typeof rangeValue>;

export const conditionValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  rangeValue,
  z.null(),
]);
export type ConditionValue = z.infer<typeof conditionValue>;

export type Condition = {
  type: "condition";
  field: string;
  op: Operator;
  value?: ConditionValue;
};

export type Group = {
  type: "group";
  logic: "and" | "or";
  children: FilterNode[];
};

export type FilterNode = Condition | Group;

export type Filter = {
  include: Group;
  exclude?: Group | null;
};

export const conditionSchema: z.ZodType<Condition> = z.object({
  type: z.literal("condition"),
  field: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9_.]*$/, "invalid field key"),
  op: z.enum(OPERATORS),
  value: conditionValue.optional(),
});

export const groupSchema: z.ZodType<Group> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    logic: z.enum(["and", "or"]),
    children: z.array(z.union([conditionSchema, groupSchema])).max(200),
  }),
);

export const filterSchema: z.ZodType<Filter> = z.object({
  include: groupSchema,
  exclude: groupSchema.nullable().optional(),
});

export function emptyGroup(logic: "and" | "or" = "and"): Group {
  return { type: "group", logic, children: [] };
}

export function emptyFilter(): Filter {
  return { include: emptyGroup("and"), exclude: null };
}

/** True when the filter has no conditions at all. */
export function isEmptyFilter(filter: Filter | null | undefined): boolean {
  if (!filter) return true;
  return countConditions(filter.include) === 0 && countConditions(filter.exclude ?? null) === 0;
}

export function countConditions(node: FilterNode | null | undefined): number {
  if (!node) return 0;
  if (node.type === "condition") return 1;
  return node.children.reduce((n, c) => n + countConditions(c), 0);
}

/** Parse untrusted JSON into a Filter, or throw a ZodError. */
export function parseFilter(input: unknown): Filter {
  return filterSchema.parse(input);
}

export function safeParseFilter(input: unknown): Filter | null {
  const res = filterSchema.safeParse(input);
  return res.success ? res.data : null;
}

export function and(...children: FilterNode[]): Group {
  return { type: "group", logic: "and", children };
}

export function or(...children: FilterNode[]): Group {
  return { type: "group", logic: "or", children };
}

export function cond(field: string, op: Operator, value?: ConditionValue): Condition {
  return value === undefined
    ? { type: "condition", field, op }
    : { type: "condition", field, op, value };
}
