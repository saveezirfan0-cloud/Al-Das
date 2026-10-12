/**
 * Persistence seam for the importer. The runner talks to an ImportStore, so the same code runs
 * against Supabase (real runs), an overlay that records "would write" without touching the
 * database (dry runs) and an in-memory map (unit tests).
 */
import { findExternalRef, upsertExternalRef } from "@/lib/contacts/import-writer";
import type { AdminClient } from "@/lib/supabase/admin";

export type StoreRow = { id: string } & Record<string, unknown>;
export type RefTarget = { localId: string; localTable: string };

export interface ImportStore {
  readonly orgId: string;
  findRef(entity: string, externalId: string): Promise<RefTarget | null>;
  upsertRef(r: {
    entity: string;
    externalId: string;
    localTable: string;
    localId: string;
  }): Promise<void>;
  countRefs(entity: string): Promise<number>;
  getRow(table: string, id: string): Promise<StoreRow | null>;
  /** First row of the org whose columns equal `match` (null-safe). */
  findOne(table: string, match: Record<string, unknown>): Promise<StoreRow | null>;
  insertRow(
    table: string,
    values: Record<string, unknown>,
  ): Promise<{ id: string } | { error: string }>;
  updateRow(
    table: string,
    id: string,
    values: Record<string, unknown>,
  ): Promise<{ error?: string }>;
  countRows(table: string): Promise<number>;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Equality used to decide "unchanged": tolerant of PostgREST's string numerics and timestamp formats. */
export function sameValue(a: unknown, b: unknown): boolean {
  const na = a instanceof Date ? a.toISOString() : a === undefined ? null : a;
  const nb = b instanceof Date ? b.toISOString() : b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  // Arrays and jsonb objects: compare canonically (Postgres returns jsonb keys in its own order).
  if (typeof na === "object" || typeof nb === "object") return canonical(na) === canonical(nb);
  if (typeof na === "boolean" || typeof nb === "boolean") return na === nb;
  const sa = String(na);
  const sb = String(nb);
  if (sa === sb) return true;
  if (/^-?\d+(\.\d+)?$/.test(sa) && /^-?\d+(\.\d+)?$/.test(sb)) return Number(sa) === Number(sb);
  if (sa.includes("T") && sb.includes("T")) {
    const ta = Date.parse(sa);
    const tb = Date.parse(sb);
    return !Number.isNaN(ta) && ta === tb;
  }
  return false;
}

export function rowMatches(row: Record<string, unknown>, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(([k, v]) => sameValue(row[k], v));
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export class SupabaseStore implements ImportStore {
  constructor(
    private readonly admin: AdminClient,
    readonly orgId: string,
  ) {}
  private get db(): any {
    return this.admin as any;
  }

  async findRef(entity: string, externalId: string) {
    const r = await findExternalRef(this.admin, {
      orgId: this.orgId,
      source: "airtable",
      entity,
      externalId,
    });
    if (!r) return null;
    const { data } = await this.db
      .from("external_refs")
      .select("local_table")
      .eq("org_id", this.orgId)
      .eq("source", "airtable")
      .eq("entity", entity)
      .eq("external_id", externalId)
      .maybeSingle();
    return { localId: r.localId, localTable: (data?.local_table as string) ?? "" };
  }

  async upsertRef(r: { entity: string; externalId: string; localTable: string; localId: string }) {
    await upsertExternalRef(this.admin, { orgId: this.orgId, source: "airtable", ...r });
  }

  async countRefs(entity: string) {
    const { count } = await this.db
      .from("external_refs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", this.orgId)
      .eq("source", "airtable")
      .eq("entity", entity);
    return count ?? 0;
  }

  async getRow(table: string, id: string) {
    const { data } = await this.db
      .from(table)
      .select("*")
      .eq("org_id", this.orgId)
      .eq("id", id)
      .maybeSingle();
    return (data as StoreRow | null) ?? null;
  }

  async findOne(table: string, match: Record<string, unknown>) {
    let q = this.db.from(table).select("*").eq("org_id", this.orgId);
    for (const [k, v] of Object.entries(match)) q = v === null ? q.is(k, null) : q.eq(k, v);
    const { data } = await q.limit(1);
    return ((data as StoreRow[] | null) ?? [])[0] ?? null;
  }

  async insertRow(table: string, values: Record<string, unknown>) {
    const { data, error } = await this.db
      .from(table)
      .insert({ ...values, org_id: this.orgId })
      .select("id")
      .single();
    if (error || !data) return { error: error?.code ? `db ${error.code}` : "insert failed" };
    return { id: data.id as string };
  }

  async updateRow(table: string, id: string, values: Record<string, unknown>) {
    const { error } = await this.db
      .from(table)
      .update(values)
      .eq("org_id", this.orgId)
      .eq("id", id);
    return error ? { error: error.code ? `db ${error.code}` : "update failed" } : {};
  }

  async countRows(table: string) {
    const { count } = await this.db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", this.orgId);
    return count ?? 0;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// In-memory (tests) and dry-run overlay
// ---------------------------------------------------------------------------

export class MemoryStore implements ImportStore {
  refs = new Map<string, RefTarget>();
  tables = new Map<string, StoreRow[]>();
  private seq = 0;
  /** Inserts that should fail, to exercise failure accounting: table → reason. */
  failInsert = new Map<string, string>();
  constructor(readonly orgId = "org-test") {}

  private key(entity: string, externalId: string) {
    return `${entity}|${externalId}`;
  }
  rows(table: string): StoreRow[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }
  async findRef(entity: string, externalId: string) {
    return this.refs.get(this.key(entity, externalId)) ?? null;
  }
  async upsertRef(r: { entity: string; externalId: string; localTable: string; localId: string }) {
    this.refs.set(this.key(r.entity, r.externalId), {
      localId: r.localId,
      localTable: r.localTable,
    });
  }
  async countRefs(entity: string) {
    return [...this.refs.keys()].filter((k) => k.startsWith(`${entity}|`)).length;
  }
  async getRow(table: string, id: string) {
    return this.rows(table).find((r) => r.id === id) ?? null;
  }
  async findOne(table: string, match: Record<string, unknown>) {
    return this.rows(table).find((r) => rowMatches(r, match)) ?? null;
  }
  async insertRow(table: string, values: Record<string, unknown>) {
    const reason = this.failInsert.get(table);
    if (reason) return { error: reason };
    // unique natural keys are the caller's job here; ids are deterministic for assertions
    const id = `${table}-${++this.seq}`;
    this.rows(table).push({ ...values, id, org_id: this.orgId });
    return { id };
  }
  async updateRow(table: string, id: string, values: Record<string, unknown>) {
    const row = this.rows(table).find((r) => r.id === id);
    if (!row) return { error: "not found" };
    Object.assign(row, values);
    return {};
  }
  async countRows(table: string) {
    return this.rows(table).length;
  }
}

/**
 * Wraps a store so nothing is written: inserts, updates and refs land in an overlay that later
 * lookups (link resolution, adopt-on-match, counts) see. A dry run therefore reports what a real
 * run would create, update, link and leave unmatched.
 */
export class DryRunStore implements ImportStore {
  private overlayRefs = new Map<string, RefTarget>();
  private overlayRows = new Map<string, StoreRow[]>();
  private patched = new Map<string, Record<string, unknown>>(); // `${table}|${id}` → merged values
  private seq = 0;
  constructor(private readonly inner: ImportStore) {}
  get orgId() {
    return this.inner.orgId;
  }
  private key(entity: string, externalId: string) {
    return `${entity}|${externalId}`;
  }
  private over(table: string): StoreRow[] {
    let t = this.overlayRows.get(table);
    if (!t) this.overlayRows.set(table, (t = []));
    return t;
  }
  async findRef(entity: string, externalId: string) {
    return (
      this.overlayRefs.get(this.key(entity, externalId)) ??
      (await this.inner.findRef(entity, externalId))
    );
  }
  async upsertRef(r: { entity: string; externalId: string; localTable: string; localId: string }) {
    this.overlayRefs.set(this.key(r.entity, r.externalId), {
      localId: r.localId,
      localTable: r.localTable,
    });
  }
  async countRefs(entity: string) {
    const real = await this.inner.countRefs(entity);
    let added = 0;
    for (const k of this.overlayRefs.keys()) {
      if (!k.startsWith(`${entity}|`)) continue;
      const ext = k.slice(entity.length + 1);
      if (!(await this.inner.findRef(entity, ext))) added++;
    }
    return real + added;
  }
  async getRow(table: string, id: string) {
    const base = this.over(table).find((r) => r.id === id) ?? (await this.inner.getRow(table, id));
    if (!base) return null;
    return { ...base, ...(this.patched.get(`${table}|${id}`) ?? {}) };
  }
  async findOne(table: string, match: Record<string, unknown>) {
    const hit = this.over(table).find((r) => rowMatches(r, match));
    if (hit) return hit;
    const real = await this.inner.findOne(table, match);
    return real ? { ...real, ...(this.patched.get(`${table}|${real.id}`) ?? {}) } : null;
  }
  async insertRow(table: string, values: Record<string, unknown>) {
    const id = `dry-${table}-${++this.seq}`;
    this.over(table).push({ ...values, id, org_id: this.orgId });
    return { id };
  }
  async updateRow(table: string, id: string, values: Record<string, unknown>) {
    const o = this.over(table).find((r) => r.id === id);
    if (o) Object.assign(o, values);
    else
      this.patched.set(`${table}|${id}`, {
        ...(this.patched.get(`${table}|${id}`) ?? {}),
        ...values,
      });
    return {};
  }
  async countRows(table: string) {
    return (await this.inner.countRows(table)) + this.over(table).length;
  }
}
