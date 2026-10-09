/**
 * A tiny in-memory stand-in for the supabase-js admin client, enough for unit-testing code that does
 * simple table reads and writes. It implements the chain methods the app uses (select / insert /
 * update / delete / upsert + eq / neq / is / in / lt / gte / order / limit / maybeSingle / single),
 * unique constraints (error code 23505) and rpc stubs. It is NOT a SQL engine: anything
 * query-shaped (joins, or(), ilike) belongs in the real-Postgres tests under tests/db.
 */
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;
type DbError = { code: string; message: string } | null;

export type FakeAdminOptions = {
  /** table → list of column sets that must be unique together (nulls never conflict, like Postgres). */
  unique?: Record<string, string[][]>;
  /** column defaults applied on insert, per table. */
  defaults?: Record<string, () => Row>;
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>;
};

export function createFakeAdmin(seed: Record<string, Row[]> = {}, options: FakeAdminOptions = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];
  const rows = (t: string) => (tables[t] ??= []);

  function conflicts(table: string, candidate: Row, ignoreId?: unknown): boolean {
    return (options.unique?.[table] ?? []).some((cols) =>
      rows(table).some(
        (r) => r.id !== ignoreId && cols.every((c) => candidate[c] !== null && candidate[c] !== undefined && r[c] === candidate[c]),
      ),
    );
  }

  function from(table: string) {
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let wantRows = false;
    let limit: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let upsertIgnore = false;
    let upsertOn: string[] = [];
    let countMode = false;
    let headOnly = false;

    // Like the real client, results are copies: later writes must not change rows a caller already holds.
    function run(): { data: Row[] | null; error: DbError; count?: number } {
      const r = runRaw();
      return r.data ? { ...r, data: r.data.map((x) => ({ ...x })) } : r;
    }

    function runRaw(): { data: Row[] | null; error: DbError; count?: number } {
      calls.push({ table, op, payload: payload ?? undefined });
      const match = (r: Row) => filters.every((f) => f(r));
      if (op === "select") {
        let out = rows(table).filter(match);
        if (order) out = [...out].sort((a, b) => (String(a[order!.col]) < String(b[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1));
        const total = out.length;
        if (limit !== null) out = out.slice(0, limit);
        return { data: headOnly ? null : out, error: null, ...(countMode ? { count: total } : {}) };
      }
      if (op === "insert" || op === "upsert") {
        const input = Array.isArray(payload) ? payload : [payload as Row];
        const created: Row[] = [];
        for (const item of input) {
          const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(options.defaults?.[table]?.() ?? {}), ...item };
          if (op === "upsert" && upsertOn.length && rows(table).some((r) => upsertOn.every((c) => r[c] === row[c]))) {
            if (upsertIgnore) continue;
          } else if (conflicts(table, row)) {
            return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint on ${table}` } };
          }
          rows(table).push(row);
          created.push(row);
        }
        return { data: created, error: null };
      }
      if (op === "update") {
        const hit = rows(table).filter(match);
        for (const r of hit) {
          const next = { ...r, ...(payload as Row), updated_at: new Date().toISOString() };
          if (conflicts(table, next, r.id)) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        for (const r of hit) Object.assign(r, payload as Row, { updated_at: new Date().toISOString() });
        return { data: hit, error: null, count: hit.length };
      }
      const hit = rows(table).filter(match);
      tables[table] = rows(table).filter((r) => !hit.includes(r));
      return { data: hit, error: null, count: hit.length };
    }

    const builder: Record<string, unknown> = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op !== "select") wantRows = true;
        if (opts?.count) countMode = true;
        if (opts?.head) headOnly = true;
        return builder;
      },
      insert(p: Row | Row[]) {
        op = "insert";
        payload = p;
        return builder;
      },
      upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = "upsert";
        payload = p;
        upsertOn = o?.onConflict?.split(",").map((s) => s.trim()) ?? [];
        upsertIgnore = !!o?.ignoreDuplicates;
        return builder;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return builder;
      },
      delete(o?: { count?: string }) {
        op = "delete";
        if (o?.count) countMode = true;
        return builder;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return builder;
      },
      neq(c: string, v: unknown) {
        filters.push((r) => r[c] !== v);
        return builder;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v));
        return builder;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return builder;
      },
      lt(c: string, v: string) {
        filters.push((r) => String(r[c]) < v);
        return builder;
      },
      gte(c: string, v: string) {
        filters.push((r) => String(r[c]) >= v);
        return builder;
      },
      order(col: string, o?: { ascending?: boolean }) {
        order = { col, asc: o?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      maybeSingle() {
        const r = run();
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
      },
      single() {
        const r = run();
        if (!r.error && !r.data?.[0]) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } });
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        const r = run();
        const value = op === "select" || wantRows ? r : { data: null, error: r.error, count: r.count };
        return Promise.resolve(value).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ table: `rpc:${name}`, op: "rpc", payload: args });
      const fn = options.rpc?.[name];
      return { data: fn ? fn(args) : null, error: null };
    },
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: "n/a" } }) }) },
    /** Test access to the stored rows and the call log. */
    _rows: rows,
    _calls: calls,
  };
}

export type FakeAdmin = ReturnType<typeof createFakeAdmin>;
