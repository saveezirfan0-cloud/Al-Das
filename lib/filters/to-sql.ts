/**
 * Compiles a Filter AST into a parameterised SQL predicate over `public.contacts c`.
 *
 * Values never enter the SQL text: every value is appended to `params` and
 * referenced as `($1 -> i)` / `($1 ->> i)`, where `$1` is the whole params
 * array bound as one jsonb value (see contacts_search / contacts_count in the
 * CRM migration). Identifiers come only from the field registry.
 */
import {
  type Condition,
  type ConditionValue,
  type Filter,
  type FilterNode,
  type Group,
  type Operator,
  type RangeValue,
  countConditions,
} from "@/lib/filters/ast";
import {
  InvalidOperatorError,
  operatorAllowed,
  type FieldDef,
  type FieldRegistry,
  type RelationDef,
  type SqlType,
} from "@/lib/filters/field-registry";

export type CompileOptions = {
  /** Alias of the contacts table in the outer query. Default `c`. */
  alias?: string;
  /** IANA timezone used for date-only comparisons on timestamps. Default UTC. */
  timezone?: string;
  /** Index of the jsonb params argument. Default 1 (`$1`). */
  paramsArg?: number;
};

export type CompiledSql = {
  /** A boolean SQL expression, or 'true' when the filter is empty. */
  sql: string;
  /** The params array to bind as a single jsonb argument. */
  params: unknown[];
};

export class ParamBag {
  readonly params: unknown[] = [];
  constructor(private readonly arg: number = 1) {}
  /** Appends a value and returns its jsonb accessor as SQL text. */
  text(value: unknown): string {
    this.params.push(value);
    return `($${this.arg} ->> ${this.params.length - 1})`;
  }
  json(value: unknown): string {
    this.params.push(value);
    return `($${this.arg} -> ${this.params.length - 1})`;
  }
}

export class FilterCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterCompileError";
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new FilterCompileError(`invalid identifier ${name}`);
  return name;
}

/** Escapes LIKE wildcards in a user value; pair with `escape '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function asString(v: ConditionValue | undefined, field: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new FilterCompileError(`field ${field} needs a single value`);
}

function asNumber(v: ConditionValue | undefined, field: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n))
    throw new FilterCompileError(`field ${field} needs a numeric value`);
  return n;
}

function asDays(v: ConditionValue | undefined, field: string): number {
  const n = Math.floor(asNumber(v, field));
  if (n < 0 || n > 36500)
    throw new FilterCompileError(`field ${field} needs days between 0 and 36500`);
  return n;
}

function asList(v: ConditionValue | undefined, field: string): Array<string | number> {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" || typeof v === "number") return [v];
  throw new FilterCompileError(`field ${field} needs a list value`);
}

function asRange(v: ConditionValue | undefined, field: string): RangeValue {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  throw new FilterCompileError(`field ${field} needs a range value`);
}

function sqlTypeOf(field: FieldDef, relations: Readonly<Record<string, RelationDef>>): SqlType {
  const s = field.source;
  if (s.kind === "column") return s.sqlType;
  if (s.kind === "relation") {
    const t = relations[s.relation]?.columns[s.column];
    if (!t)
      throw new FilterCompileError(`relation column ${s.relation}.${s.column} is not registered`);
    return t;
  }
  if (s.kind === "count") return "integer";
  // custom
  switch (field.type) {
    case "number":
      return "numeric";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    default:
      return "text";
  }
}

function cast(accessor: string, type: SqlType): string {
  return type === "text" ? accessor : `${accessor}::${type}`;
}

/** SQL expression for a scalar field value on the given row alias. */
function valueExpr(field: FieldDef, alias: string, bag: ParamBag): string {
  const s = field.source;
  switch (s.kind) {
    case "column":
      return `${alias}.${ident(s.column)}`;
    case "relation":
      return `${alias}.${ident(s.column)}`;
    case "custom": {
      const key = bag.text(ident(s.key));
      switch (field.type) {
        case "number":
          return `(case when jsonb_typeof(${alias}.custom -> ${key}) = 'number' then (${alias}.custom ->> ${key})::numeric end)`;
        case "boolean":
          return `(case when jsonb_typeof(${alias}.custom -> ${key}) = 'boolean' then (${alias}.custom ->> ${key})::boolean end)`;
        case "date":
          return `(case when jsonb_typeof(${alias}.custom -> ${key}) = 'string' then nullif(${alias}.custom ->> ${key}, '')::date end)`;
        case "multi_select":
          return `(case when jsonb_typeof(${alias}.custom -> ${key}) = 'array' then ${alias}.custom -> ${key} else '[]'::jsonb end)`;
        default:
          return `(${alias}.custom ->> ${key})`;
      }
    }
    case "count":
      throw new FilterCompileError("count fields have no scalar expression");
  }
}

function listSubquery(bag: ParamBag, values: Array<string | number>, type: SqlType): string {
  const j = bag.json(values.map((v) => String(v)));
  return `(select ${cast("x", type)} from jsonb_array_elements_text(${j}) as x)`;
}

/** Compiles a scalar comparison; `expr` is the SQL for the field value. */
function scalarPredicate(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  expr: string,
  type: SqlType,
  bag: ParamBag,
  tz: string,
): string {
  const key = field.key;
  const isTs = type === "timestamptz";
  let dayCache: string | null = null;
  const day = () => (dayCache ??= isTs ? `(${expr} at time zone ${bag.text(tz)})::date` : expr);

  switch (op) {
    case "is_empty":
      return type === "text" ? `nullif(${expr}, '') is null` : `${expr} is null`;
    case "is_not_empty":
      return type === "text" ? `nullif(${expr}, '') is not null` : `${expr} is not null`;
    case "is_true":
      return `${expr} is true`;
    case "is_false":
      return `${expr} is not true`;
    case "eq":
      if (type === "text" && field.type === "text")
        return `lower(${expr}) = lower(${bag.text(asString(value, key))})`;
      return `${expr} = ${cast(bag.text(asString(value, key)), type)}`;
    case "neq":
      if (type === "text" && field.type === "text")
        return `lower(${expr}) is distinct from lower(${bag.text(asString(value, key))})`;
      return `${expr} is distinct from ${cast(bag.text(asString(value, key)), type)}`;
    case "contains":
      return `${expr} ilike ${bag.text(`%${escapeLike(asString(value, key))}%`)} escape '\\'`;
    case "not_contains":
      return `(${expr} is null or ${expr} not ilike ${bag.text(`%${escapeLike(asString(value, key))}%`)} escape '\\')`;
    case "starts_with":
      return `${expr} ilike ${bag.text(`${escapeLike(asString(value, key))}%`)} escape '\\'`;
    case "ends_with":
      return `${expr} ilike ${bag.text(`%${escapeLike(asString(value, key))}`)} escape '\\'`;
    case "in":
      if (type === "text" && field.type === "text")
        return `lower(${expr}) in (select lower(x) from jsonb_array_elements_text(${bag.json(asList(value, key).map(String))}) as x)`;
      return `${expr} in ${listSubquery(bag, asList(value, key), type)}`;
    case "not_in":
      if (type === "text" && field.type === "text")
        return `(${expr} is null or lower(${expr}) not in (select lower(x) from jsonb_array_elements_text(${bag.json(asList(value, key).map(String))}) as x))`;
      return `(${expr} is null or ${expr} not in ${listSubquery(bag, asList(value, key), type)})`;
    case "gt":
      return `${expr} > ${cast(bag.text(String(asNumber(value, key))), type)}`;
    case "gte":
      return `${expr} >= ${cast(bag.text(String(asNumber(value, key))), type)}`;
    case "lt":
      return `${expr} < ${cast(bag.text(String(asNumber(value, key))), type)}`;
    case "lte":
      return `${expr} <= ${cast(bag.text(String(asNumber(value, key))), type)}`;
    case "between": {
      const r = asRange(value, key);
      const parts: string[] = [];
      if (type === "date" || isTs) {
        if (r.from != null && r.from !== "")
          parts.push(`${day()} >= ${bag.text(String(r.from))}::date`);
        if (r.to != null && r.to !== "") parts.push(`${day()} <= ${bag.text(String(r.to))}::date`);
      } else {
        if (r.from != null && r.from !== "")
          parts.push(`${expr} >= ${cast(bag.text(String(asNumber(r.from, key))), type)}`);
        if (r.to != null && r.to !== "")
          parts.push(`${expr} <= ${cast(bag.text(String(asNumber(r.to, key))), type)}`);
      }
      if (parts.length === 0) throw new FilterCompileError(`field ${key} needs a from or to value`);
      return `(${parts.join(" and ")})`;
    }
    case "on":
      return `${day()} = ${bag.text(asString(value, key))}::date`;
    case "before":
      return `${day()} < ${bag.text(asString(value, key))}::date`;
    case "after":
      return `${day()} > ${bag.text(asString(value, key))}::date`;
    case "within_last": {
      const d = bag.text(String(asDays(value, key)));
      return isTs
        ? `${expr} >= now() - make_interval(days => ${d}::int)`
        : `(${expr} >= current_date - ${d}::int and ${expr} <= current_date)`;
    }
    case "not_within_last": {
      const d = bag.text(String(asDays(value, key)));
      return isTs
        ? `(${expr} is null or ${expr} < now() - make_interval(days => ${d}::int))`
        : `(${expr} is null or ${expr} < current_date - ${d}::int)`;
    }
    case "older_than": {
      const d = bag.text(String(asDays(value, key)));
      return isTs
        ? `${expr} < now() - make_interval(days => ${d}::int)`
        : `${expr} < current_date - ${d}::int`;
    }
    case "within_next": {
      const d = bag.text(String(asDays(value, key)));
      return isTs
        ? `(${expr} >= now() and ${expr} <= now() + make_interval(days => ${d}::int))`
        : `(${expr} >= current_date and ${expr} <= current_date + ${d}::int)`;
    }
    default:
      throw new InvalidOperatorError(key, op);
  }
}

function anniversaryPredicate(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  expr: string,
  bag: ParamBag,
  tz: string,
): string {
  const today = `(now() at time zone ${bag.text(tz)})::date`;
  switch (op) {
    case "is_empty":
      return `${expr} is null`;
    case "is_not_empty":
      return `${expr} is not null`;
    case "is_today":
      return `app.next_anniversary(${expr}, ${today}) = ${today}`;
    case "within_next": {
      const d = bag.text(String(asDays(value, field.key)));
      return `app.next_anniversary(${expr}, ${today}) <= ${today} + ${d}::int`;
    }
    case "month_is": {
      const m = Math.floor(asNumber(value, field.key));
      if (m < 1 || m > 12) throw new FilterCompileError(`field ${field.key} needs a month 1-12`);
      return `extract(month from ${expr}) = ${bag.text(String(m))}::int`;
    }
    default:
      throw new InvalidOperatorError(field.key, op);
  }
}

function multiSelectPredicate(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  expr: string,
  bag: ParamBag,
): string {
  switch (op) {
    case "is_empty":
      return `jsonb_array_length(${expr}) = 0`;
    case "is_not_empty":
      return `jsonb_array_length(${expr}) > 0`;
    case "has_any":
      return `exists (select 1 from jsonb_array_elements_text(${expr}) as v where v in (select x from jsonb_array_elements_text(${bag.json(asList(value, field.key).map(String))}) as x))`;
    case "has_none":
      return `not exists (select 1 from jsonb_array_elements_text(${expr}) as v where v in (select x from jsonb_array_elements_text(${bag.json(asList(value, field.key).map(String))}) as x))`;
    case "has_all":
      return `${expr} @> ${bag.json(asList(value, field.key).map(String))}`;
    default:
      throw new InvalidOperatorError(field.key, op);
  }
}

function relationBase(rel: RelationDef, alias: string): string {
  const base = `from ${rel.table} r where r.${ident(rel.contactColumn)} = ${alias}.id`;
  return rel.extraWhere ? `${base} and ${rel.extraWhere}` : base;
}

function relationPredicate(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  rel: RelationDef,
  column: string,
  alias: string,
  bag: ParamBag,
  tz: string,
): string {
  const type = rel.columns[column];
  if (!type) throw new FilterCompileError(`relation column ${rel.key}.${column} is not registered`);
  const base = relationBase(rel, alias);
  const col = `r.${ident(column)}`;

  if (field.type === "set") {
    switch (op) {
      case "is_empty":
        return `not exists (select 1 ${base})`;
      case "is_not_empty":
        return `exists (select 1 ${base})`;
      case "has_any":
        return `exists (select 1 ${base} and ${col} in ${listSubquery(bag, asList(value, field.key), type)})`;
      case "has_none":
        return `not exists (select 1 ${base} and ${col} in ${listSubquery(bag, asList(value, field.key), type)})`;
      case "has_all": {
        const list = asList(value, field.key);
        const sub = listSubquery(bag, list, type);
        return `(select count(distinct ${col}) ${base} and ${col} in ${sub}) = ${bag.text(String(new Set(list.map(String)).size))}::int`;
      }
      default:
        throw new InvalidOperatorError(field.key, op);
    }
  }

  // Scalar related column: "some related row matches"; negated operators mean
  // "no related row matches the positive form" so the two are complements.
  const NEGATED: Partial<Record<Operator, Operator>> = {
    neq: "eq",
    not_in: "in",
    not_contains: "contains",
    is_empty: "is_not_empty",
    not_within_last: "within_last",
    is_false: "is_true",
  };
  const positive = NEGATED[op];
  if (positive) {
    const inner = scalarPredicate(field, positive, value, col, type, bag, tz);
    return `not exists (select 1 ${base} and ${inner})`;
  }
  const inner = scalarPredicate(field, op, value, col, type, bag, tz);
  return `exists (select 1 ${base} and ${inner})`;
}

function countPredicate(
  field: FieldDef,
  op: Operator,
  value: ConditionValue | undefined,
  rel: RelationDef,
  alias: string,
  bag: ParamBag,
): string {
  const expr = `(select count(*) ${relationBase(rel, alias)})`;
  return scalarPredicate(field, op, value, expr, "integer", bag, "UTC");
}

export function compileCondition(
  c: Condition,
  registry: FieldRegistry,
  bag: ParamBag,
  opts: Required<Pick<CompileOptions, "alias" | "timezone">>,
): string {
  const field = registry.require(c.field);
  if (!operatorAllowed(field, c.op)) throw new InvalidOperatorError(c.field, c.op);
  const { alias, timezone } = opts;
  const s = field.source;

  if (s.kind === "count") {
    return countPredicate(field, c.op, c.value, registry.relations[s.relation], alias, bag);
  }
  if (s.kind === "relation") {
    return relationPredicate(
      field,
      c.op,
      c.value,
      registry.relations[s.relation],
      s.column,
      alias,
      bag,
      timezone,
    );
  }
  const expr = valueExpr(field, alias, bag);
  if (field.type === "anniversary")
    return anniversaryPredicate(field, c.op, c.value, expr, bag, timezone);
  if (field.type === "multi_select") return multiSelectPredicate(field, c.op, c.value, expr, bag);
  return scalarPredicate(
    field,
    c.op,
    c.value,
    expr,
    sqlTypeOf(field, registry.relations),
    bag,
    timezone,
  );
}

export function compileGroup(
  g: Group,
  registry: FieldRegistry,
  bag: ParamBag,
  opts: Required<Pick<CompileOptions, "alias" | "timezone">>,
): string {
  const parts = g.children
    .map((n: FilterNode) =>
      n.type === "condition"
        ? compileCondition(n, registry, bag, opts)
        : compileGroup(n, registry, bag, opts),
    )
    .filter((p) => p !== "");
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `(${parts.join(g.logic === "and" ? " and " : " or ")})`;
}

/** Compiles the whole filter. An empty filter compiles to `true`. */
export function compileFilter(
  filter: Filter | null | undefined,
  registry: FieldRegistry,
  options: CompileOptions = {},
  bag: ParamBag = new ParamBag(options.paramsArg ?? 1),
): CompiledSql {
  const opts = { alias: ident(options.alias ?? "c"), timezone: options.timezone ?? "UTC" };
  if (!filter) return { sql: "true", params: bag.params };
  const include = countConditions(filter.include)
    ? compileGroup(filter.include, registry, bag, opts)
    : "";
  const exclude =
    filter.exclude && countConditions(filter.exclude)
      ? compileGroup(filter.exclude, registry, bag, opts)
      : "";
  const parts: string[] = [];
  if (include) parts.push(include);
  if (exclude) parts.push(`not (${exclude})`);
  return { sql: parts.length ? parts.join(" and ") : "true", params: bag.params };
}

export type SortSpec = { field: string; dir: "asc" | "desc" };

/**
 * ORDER BY for sortable fields. Only identifiers from the registry are used;
 * the output matches the allow-list regex enforced by contacts_search.
 */
export function compileOrderBy(
  sort: SortSpec[] | null | undefined,
  registry: FieldRegistry,
  options: CompileOptions = {},
): string {
  const alias = ident(options.alias ?? "c");
  const parts: string[] = [];
  for (const s of sort ?? []) {
    const field = registry.require(s.field);
    if (!field.sortable) throw new FilterCompileError(`field ${s.field} is not sortable`);
    const dir = s.dir === "asc" ? "asc" : "desc";
    const src = field.source;
    let expr: string;
    if (src.kind === "column") expr = `${alias}.${ident(src.column)}`;
    else if (src.kind === "custom") {
      const key = ident(src.key);
      expr =
        field.type === "number"
          ? `(case when jsonb_typeof(${alias}.custom -> '${key}') = 'number' then (${alias}.custom ->> '${key}')::numeric end)`
          : `(${alias}.custom ->> '${key}')`;
    } else if (src.kind === "count") {
      const rel = registry.relations[src.relation];
      expr = `(select count(*) ${relationBase(rel, alias)})`;
    } else throw new FilterCompileError(`field ${s.field} is not sortable`);
    parts.push(`${expr} ${dir} nulls last`);
  }
  if (parts.length === 0) parts.push(`${alias}.created_at desc`);
  return parts.join(", ");
}
