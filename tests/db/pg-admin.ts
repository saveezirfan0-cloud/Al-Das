import type { Client } from "pg";

/**
 * A small stand-in for the service-role supabase-js client that runs against a plain Postgres (there is no PostgREST in
 * the DB test setup). It supports exactly what the matching loader and actions use: select with eq / neq / gt / gte /
 * lte / is / in / order / range / limit / maybeSingle / single, insert, update, upsert (onConflict, ignoreDuplicates),
 * `.select()` after a write, and rpc of a function returning jsonb. Rows come back as JSON (dates as 'YYYY-MM-DD'
 * strings, numerics as numbers), like PostgREST. Statements run as the connection's role (the test's superuser), so RLS
 * is bypassed exactly like the service role; triggers and constraints still apply.
 *
 * Embedded selects are supported for one many-to-one embed only (`fin_bank_lines(value_date, amount)` on decisions).
 */

type Filter = { col: string; op: string; val: unknown };
type Err = { code?: string; message: string };
type Res = { data: unknown; error: Err | null };

/** One statement at a time per connection (the loader asks for several tables at once; pg would warn about queueing). */
const tails = new WeakMap<Client, Promise<unknown>>();
function serial<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(c) ?? Promise.resolve()).then(fn, fn);
  tails.set(c, run.catch(() => undefined));
  return run;
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};

class Query implements PromiseLike<Res> {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private filters: Filter[] = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private from = 0;
  private to: number | null = null;
  private max: number | null = null;
  private payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
  private returning = false;
  private selectCols = "*";
  private mode: "many" | "maybe" | "one" = "many";
  private opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  constructor(
    private c: Client,
    private table: string,
  ) {}

  select(cols = "*") {
    if (this.op === "select") this.selectCols = cols;
    else this.returning = true;
    return this;
  }
  insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = "update";
    this.payload = values;
    return this;
  }
  upsert(rows: Record<string, unknown> | Array<Record<string, unknown>>, opts: Query["opts"] = {}) {
    this.op = "upsert";
    this.payload = rows;
    this.opts = opts;
    return this;
  }
  private f(col: string, op: string, val: unknown) {
    this.filters.push({ col, op, val });
    return this;
  }
  eq(col: string, val: unknown) {
    return this.f(col, "=", val);
  }
  neq(col: string, val: unknown) {
    return this.f(col, "<>", val);
  }
  gt(col: string, val: unknown) {
    return this.f(col, ">", val);
  }
  gte(col: string, val: unknown) {
    return this.f(col, ">=", val);
  }
  lte(col: string, val: unknown) {
    return this.f(col, "<=", val);
  }
  is(col: string, val: null) {
    return this.f(col, "is", val);
  }
  in(col: string, val: unknown[]) {
    return this.f(col, "in", val);
  }
  order(col: string, o: { ascending?: boolean } = {}) {
    this.orders.push({ col, asc: o.ascending !== false });
    return this;
  }
  range(a: number, b: number) {
    this.from = a;
    this.to = b;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "one";
    return this;
  }

  private where(params: unknown[]) {
    if (this.filters.length === 0) return "";
    const parts = this.filters.map(({ col, op, val }) => {
      const k = `t.${ident(col)}`;
      if (op === "is") return `${k} is null`;
      if (op === "in") {
        params.push(val);
        return `${k} = any($${params.length})`;
      }
      params.push(val);
      return `${k} ${op} $${params.length}`;
    });
    return ` where ${parts.join(" and ")}`;
  }

  private async run(): Promise<Res> {
    const t = ident(this.table);
    const params: unknown[] = [];
    let sql: string;
    if (this.op === "select") {
      const w = this.where(params);
      const ord = this.orders.length
        ? ` order by ${this.orders.map((o) => `t.${ident(o.col)} ${o.asc ? "asc" : "desc"}`).join(", ")}`
        : "";
      let lim = "";
      if (this.to !== null) lim = ` limit ${this.to - this.from + 1} offset ${this.from}`;
      else if (this.max !== null) lim = ` limit ${this.max}`;
      sql = `select to_jsonb(t) as j from public.${t} t${w}${ord}${lim}`;
    } else if (this.op === "update") {
      const values = this.payload as Record<string, unknown>;
      const sets = Object.entries(values).map(([k, v]) => {
        params.push(v);
        return `${ident(k)} = $${params.length}`;
      });
      sql = `update public.${t} as t set ${sets.join(", ")}${this.where(params)} returning to_jsonb(t) as j`;
    } else {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Record<string, unknown>];
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident);
      params.push(JSON.stringify(rows));
      let conflict = "";
      if (this.op === "upsert") {
        const target = (this.opts.onConflict ?? "").split(",").map((s) => ident(s.trim()));
        const setCols = cols.filter((x) => !target.includes(x));
        conflict =
          this.opts.ignoreDuplicates || setCols.length === 0
            ? ` on conflict (${target.join(", ")}) do nothing`
            : ` on conflict (${target.join(", ")}) do update set ${setCols.map((x) => `${x} = excluded.${x}`).join(", ")}`;
      }
      sql = `insert into public.${t} as t (${cols.join(", ")}) select ${cols.join(", ")} from jsonb_populate_recordset(null::public.${t}, $1::jsonb)${conflict} returning to_jsonb(t) as j`;
    }
    let rows: Array<Record<string, unknown>>;
    try {
      const r = await serial(this.c, () => this.c.query<{ j: Record<string, unknown> }>(sql, params));
      rows = r.rows.map((x) => x.j);
    } catch (e) {
      const err = e as { code?: string; message: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
    if (this.op === "select" && /fin_bank_lines\(/.test(this.selectCols)) {
      const ids = [...new Set(rows.map((r) => r.bank_line_id as string))];
      const lines = ids.length
        ? (
            await serial(this.c, () =>
              this.c.query<{ id: string; value_date: string; amount: number }>(
                "select id, to_char(value_date, 'YYYY-MM-DD') as value_date, amount::float8 as amount from public.fin_bank_lines where id = any($1)",
                [ids],
              ),
            )
          ).rows
        : [];
      const by = new Map(lines.map((l) => [l.id, l]));
      for (const r of rows) {
        const l = by.get(r.bank_line_id as string);
        r.fin_bank_lines = l ? { value_date: l.value_date, amount: l.amount } : null;
      }
    }
    if (this.op !== "select" && !this.returning) return { data: null, error: null };
    if (this.mode === "many") return { data: rows, error: null };
    if (rows.length > 1 && this.mode === "one") return { data: null, error: { code: "PGRST116", message: "many rows" } };
    return { data: rows[0] ?? null, error: null };
  }

  then<R1 = Res, R2 = never>(
    onfulfilled?: ((value: Res) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

export function createPgAdmin(c: Client) {
  return {
    from: (table: string) => new Query(c, table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args).map(ident);
      try {
        const r = await serial(c, () =>
          c.query<{ j: unknown }>(
            `select public.${ident(fn)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as j`,
            keys.map((k) => args[k]),
          ),
        );
        return { data: r.rows[0]?.j ?? null, error: null };
      } catch (e) {
        const err = e as { code?: string; message: string };
        return { data: null, error: { code: err.code, message: err.message } };
      }
    },
  };
}
