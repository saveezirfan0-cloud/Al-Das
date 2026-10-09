/**
 * ImportStore over a raw pg connection, so the importer can be tested against the real schema
 * (column names, enums, unique keys, check constraints) without PostgREST.
 */
import pg from "pg";

import type { ImportStore, RefTarget, StoreRow } from "../../scripts/import/store";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (n: string) => {
  if (!IDENT.test(n)) throw new Error(`bad identifier ${n}`);
  return `"${n}"`;
};

/** Parser set that keeps `date` columns as YYYY-MM-DD strings (the importer's representation). */
export const pgTypes = {
  getTypeParser: (oid: number, format?: string) =>
    oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, format as "text"),
};

export class PgStore implements ImportStore {
  constructor(
    private readonly c: pg.Client,
    readonly orgId: string,
  ) {}

  async findRef(entity: string, externalId: string): Promise<RefTarget | null> {
    const { rows } = await this.c.query(
      "select local_id, local_table from public.external_refs where org_id=$1 and source='airtable' and entity=$2 and external_id=$3",
      [this.orgId, entity, externalId],
    );
    return rows[0] ? { localId: rows[0].local_id, localTable: rows[0].local_table } : null;
  }
  async upsertRef(r: { entity: string; externalId: string; localTable: string; localId: string }) {
    await this.c.query(
      `insert into public.external_refs (org_id, source, entity, external_id, local_table, local_id)
       values ($1,'airtable',$2,$3,$4,$5)
       on conflict (org_id, source, entity, external_id) do update set local_table=excluded.local_table, local_id=excluded.local_id`,
      [this.orgId, r.entity, r.externalId, r.localTable, r.localId],
    );
  }
  async countRefs(entity: string) {
    const { rows } = await this.c.query(
      "select count(*)::int n from public.external_refs where org_id=$1 and source='airtable' and entity=$2",
      [this.orgId, entity],
    );
    return rows[0].n as number;
  }
  async getRow(table: string, id: string) {
    const { rows } = await this.c.query(
      `select * from public.${ident(table)} where org_id=$1 and id=$2`,
      [this.orgId, id],
    );
    return (rows[0] as StoreRow | undefined) ?? null;
  }
  async findOne(table: string, match: Record<string, unknown>) {
    const keys = Object.keys(match);
    const where = keys
      .map((k, i) => (match[k] === null ? `${ident(k)} is null` : `${ident(k)} = $${i + 2}`))
      .join(" and ");
    const params = [this.orgId, ...keys.filter((k) => match[k] !== null).map((k) => match[k])];
    // renumber placeholders after dropping null checks
    let n = 1;
    const sql = `select * from public.${ident(table)} where org_id=$1${keys.length ? ` and ${where.replace(/\$\d+/g, () => `$${++n}`)}` : ""} limit 1`;
    const { rows } = await this.c.query(sql, params);
    return (rows[0] as StoreRow | undefined) ?? null;
  }
  async insertRow(table: string, values: Record<string, unknown>) {
    const cols = Object.keys(values);
    try {
      const { rows } = await this.c.query(
        `insert into public.${ident(table)} (org_id, ${cols.map(ident).join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
        [this.orgId, ...cols.map((c) => values[c])],
      );
      return { id: rows[0].id as string };
    } catch (e) {
      return { error: `db ${(e as { code?: string }).code ?? "error"}` };
    }
  }
  async updateRow(table: string, id: string, values: Record<string, unknown>) {
    const cols = Object.keys(values);
    try {
      await this.c.query(
        `update public.${ident(table)} set ${cols.map((c, i) => `${ident(c)} = $${i + 3}`).join(", ")} where org_id=$1 and id=$2`,
        [this.orgId, id, ...cols.map((c) => values[c])],
      );
      return {};
    } catch (e) {
      return { error: `db ${(e as { code?: string }).code ?? "error"}` };
    }
  }
  async countRows(table: string) {
    const { rows } = await this.c.query(
      `select count(*)::int n from public.${ident(table)} where org_id=$1`,
      [this.orgId],
    );
    return rows[0].n as number;
  }
}
