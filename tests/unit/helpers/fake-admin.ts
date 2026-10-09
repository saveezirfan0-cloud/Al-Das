/**
 * Tiny in-memory stand-in for the supabase-js admin client: just enough of the query builder for
 * the template service (select / insert / update / delete with eq, neq, is, not, gte, in, filter,
 * single / maybeSingle, head counts) plus Storage. Unique constraints are declared per table.
 */
type Row = Record<string, unknown>;
type Result = {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
};

export type FakeDb = {
  tables: Record<string, Row[]>;
  files: Map<string, Uint8Array>;
  uniques: Record<string, string[][]>;
  audit: Row[];
};

export function fakeDb(
  seed: Record<string, Row[]> = {},
  uniques: Record<string, string[][]> = {},
): FakeDb {
  return { tables: JSON.parse(JSON.stringify(seed)), files: new Map(), uniques, audit: [] };
}

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function get(row: Row, path: string): unknown {
  // supports "payload->send->>template_id"
  const parts = path.split(/->>?/);
  let cur: unknown = row;
  for (const p of parts) cur = cur && typeof cur === "object" ? (cur as Row)[p] : undefined;
  return cur;
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | null = null;
  private wantRows = false;
  private head = false;
  private count = false;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: "exact"; head?: boolean }) {
    this.wantRows = true;
    if (opts?.count) this.count = true;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => get(r, c) === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => get(r, c) !== v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (v === null ? get(r, c) == null : get(r, c) === v));
    return this;
  }
  not(c: string, op: string, v: unknown) {
    if (op === "is") this.filters.push((r) => (v === null ? get(r, c) != null : get(r, c) !== v));
    return this;
  }
  gte(c: string, v: unknown) {
    this.filters.push((r) => String(get(r, c)) >= String(v));
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(get(r, c)));
    return this;
  }
  filter(c: string, op: string, v: unknown) {
    if (op === "eq") this.filters.push((r) => get(r, c) === v);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }

  private run(): Result {
    const rows = (this.db.tables[this.table] ??= []);
    const match = () => rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "insert") {
      const row: Row = { id: uuid(), created_at: new Date().toISOString(), ...this.payload! };
      for (const cols of this.db.uniques[this.table] ?? [])
        if (rows.some((r) => cols.every((c) => r[c] === row[c])))
          return { data: null, error: { code: "23505", message: "duplicate key" } };
      rows.push(row);
      return { data: this.wantRows ? [{ ...row }] : null, error: null };
    }
    if (this.op === "update") {
      const hit = match();
      for (const cols of this.db.uniques[this.table] ?? []) {
        for (const r of hit) {
          const next = { ...r, ...this.payload };
          if (rows.some((o) => o !== r && cols.every((c) => o[c] === next[c])))
            return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
      }
      hit.forEach((r) => Object.assign(r, this.payload));
      return { data: this.wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === "delete") {
      const hit = match();
      this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
      return { data: this.wantRows ? hit : null, error: null };
    }
    const hit = match();
    return {
      data: this.head ? null : hit.map((r) => ({ ...r })),
      error: null,
      count: this.count ? hit.length : null,
    };
  }

  single() {
    return this.then((r) => ({
      ...r,
      data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
      error:
        r.error ?? (Array.isArray(r.data) && r.data.length === 0 ? { message: "no rows" } : null),
    }));
  }
  maybeSingle() {
    return this.then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
  }
  then<T>(f: (r: Result) => T): Promise<T> {
    return Promise.resolve(f(this.run()));
  }
}

export function fakeAdmin(db: FakeDb) {
  const admin = {
    from(table: string) {
      if (table === "audit_log") {
        return {
          insert: async (row: Row) => {
            db.audit.push(row);
            return { error: null };
          },
        };
      }
      return new Query(db, table);
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, data: Uint8Array) {
            db.files.set(`${bucket}/${path}`, data);
            return { error: null };
          },
          async download(path: string) {
            const f = db.files.get(`${bucket}/${path}`);
            return f
              ? { data: new Blob([new Uint8Array(f)]), error: null }
              : { data: null, error: { message: "not found" } };
          },
          async remove(paths: string[]) {
            paths.forEach((p) => db.files.delete(`${bucket}/${p}`));
            return { error: null };
          },
        };
      },
    },
  };
  return admin as never;
}
