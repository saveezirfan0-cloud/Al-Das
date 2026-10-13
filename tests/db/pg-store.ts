/**
 * ImportStore over a raw pg connection, so the importer can be tested against the real schema
 * (column names, enums, unique keys, check constraints) without PostgREST.
 */
import pg from "pg";

import type { CustomFieldDef } from "@/lib/contacts/custom-values";

import type {
  BookInput,
  ContactMatch,
  RefTable,
  SanoflowPorts,
} from "../../scripts/import/sanoflow/ports";
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
    protected readonly c: pg.Client,
    readonly orgId: string,
    protected readonly source: "airtable" | "sanoflow" = "airtable",
  ) {}

  async findRef(entity: string, externalId: string): Promise<RefTarget | null> {
    const { rows } = await this.c.query(
      "select local_id, local_table from public.external_refs where org_id=$1 and source=$4 and entity=$2 and external_id=$3",
      [this.orgId, entity, externalId, this.source],
    );
    return rows[0] ? { localId: rows[0].local_id, localTable: rows[0].local_table } : null;
  }
  async upsertRef(r: { entity: string; externalId: string; localTable: string; localId: string }) {
    await this.c.query(
      `insert into public.external_refs (org_id, source, entity, external_id, local_table, local_id)
       values ($1,$6,$2,$3,$4,$5)
       on conflict (org_id, source, entity, external_id) do update set local_table=excluded.local_table, local_id=excluded.local_id`,
      [this.orgId, r.entity, r.externalId, r.localTable, r.localId, this.source],
    );
  }
  async countRefs(entity: string) {
    const { rows } = await this.c.query(
      "select count(*)::int n from public.external_refs where org_id=$1 and source=$3 and entity=$2",
      [this.orgId, entity, this.source],
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

// ---------------------------------------------------------------------------
// Sanoflow ports over raw pg (Phase 20a): the same SQL shapes the Supabase ports send.
// ---------------------------------------------------------------------------

export class PgSanoflowPorts extends PgStore implements SanoflowPorts {
  constructor(c: pg.Client, orgId: string) {
    super(c, orgId, "sanoflow");
  }
  async liveContact(id: string) {
    let cur: string | null = id;
    for (let hop = 0; cur && hop < 5; hop++) {
      const { rows } = await this.c.query(
        "select id, deleted_at, merged_into_id from public.contacts where org_id=$1 and id=$2",
        [this.orgId, cur],
      );
      if (!rows[0]) return null;
      if (!rows[0].deleted_at) return rows[0].id as string;
      cur = rows[0].merged_into_id as string | null;
    }
    return null;
  }
  async matchContactByPhone(e164: string): Promise<ContactMatch> {
    const { rows } = await this.c.query(
      "select id from public.contacts where org_id=$1 and phone_e164=$2 and deleted_at is null limit 2",
      [this.orgId, e164],
    );
    if (rows.length === 1) return { kind: "match", id: rows[0].id };
    if (rows.length > 1)
      return {
        kind: "ambiguous",
        candidates: rows.map((r) => ({ contact_id: r.id, matched_on: "phone" })),
      };
    return { kind: "none" };
  }
  async memberIdByEmail(email: string) {
    const { rows } = await this.c.query(
      `select p.id from public.profiles p join public.memberships m on m.user_id = p.id
        where m.org_id=$1 and m.status='active' and lower(p.email)=lower($2) limit 2`,
      [this.orgId, email.trim()],
    );
    return rows.length === 1 ? (rows[0].id as string) : null;
  }
  async findByName(table: RefTable, name: string) {
    const cols =
      table === "services"
        ? "id, name, department_id, duration_min"
        : table === "specialists"
          ? "id, name, department_id, null::int as duration_min"
          : "id, name, null::uuid as department_id, null::int as duration_min";
    const { rows } = await this.c.query(
      `select ${cols} from public.${table} where org_id=$1 and lower(name)=lower($2) limit 2`,
      [this.orgId, name.trim()],
    );
    return rows.length === 1 ? rows[0] : null;
  }
  async hasSegmentMember(segmentId: string, contactId: string) {
    const { rowCount } = await this.c.query(
      "select 1 from public.segment_members where org_id=$1 and segment_id=$2 and contact_id=$3",
      [this.orgId, segmentId, contactId],
    );
    return (rowCount ?? 0) > 0;
  }
  async addSegmentMember(segmentId: string, contactId: string) {
    try {
      await this.c.query(
        "insert into public.segment_members (org_id, segment_id, contact_id) values ($1,$2,$3) on conflict do nothing",
        [this.orgId, segmentId, contactId],
      );
      return {};
    } catch (e) {
      return { error: `db ${(e as { code?: string }).code ?? "error"}` };
    }
  }
  async refreshSegmentCount(segmentId: string) {
    await this.c.query(
      `update public.segments set member_count = (select count(*) from public.segment_members where segment_id=$2),
         count_refreshed_at = now() where org_id=$1 and id=$2`,
      [this.orgId, segmentId],
    );
  }
  async findAppointment(m: { contactId: string; specialistId: string; startsAt: string }) {
    const { rows } = await this.c.query(
      `select id from public.appointments where org_id=$1 and contact_id=$2 and specialist_id=$3
         and starts_at=$4 and status <> 'cancelled' limit 1`,
      [this.orgId, m.contactId, m.specialistId, m.startsAt],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }
  async bookAppointment(b: BookInput) {
    try {
      const { rows } = await this.c.query(
        `select (public.book_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'import',null,true)).id`,
        [
          this.orgId,
          b.contactId,
          b.locationId,
          b.specialistId,
          b.serviceId,
          b.departmentId,
          b.startsAt,
          b.endsAt,
          b.status,
          b.notes,
        ],
      );
      return { id: rows[0].id as string };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        error: msg.includes("slot_taken")
          ? "slot_taken"
          : `db ${(e as { code?: string }).code ?? "error"}`,
      };
    }
  }
  async queueReview(r: {
    entity: string;
    externalId: string;
    reason: string;
    candidates?: unknown[];
  }) {
    await this.c.query(
      `insert into public.sync_reviews (org_id, source, entity, external_id, reason, candidates, status)
       values ($1,'sanoflow',$2,$3,$4,$5::jsonb,'open')
       on conflict (org_id, source, entity, external_id) do update set reason=excluded.reason, status='open'`,
      [this.orgId, r.entity, r.externalId, r.reason, JSON.stringify(r.candidates ?? [])],
    );
  }
  async resolveReview(entity: string, externalId: string) {
    await this.c.query(
      `update public.sync_reviews set status='resolved', resolved_at=now()
        where org_id=$1 and source='sanoflow' and entity=$2 and external_id=$3 and status='open'`,
      [this.orgId, entity, externalId],
    );
  }
  async customFieldDefs(entity: "contact" | "enquiry"): Promise<CustomFieldDef[]> {
    const { rows } = await this.c.query(
      "select key, label, type, options, required from public.custom_fields where org_id=$1 and entity=$2 order by sort",
      [this.orgId, entity],
    );
    return rows as CustomFieldDef[];
  }
  async enquirySources() {
    const { rows } = await this.c.query("select settings from public.orgs where id=$1", [
      this.orgId,
    ]);
    return (
      (rows[0]?.settings?.enquiries?.sources as string[] | undefined) ?? ["WhatsApp"]
    ).slice();
  }
  async setEnquirySources(sources: string[]) {
    await this.c.query(
      `update public.orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{enquiries}',
         coalesce(settings->'enquiries','{}'::jsonb) || jsonb_build_object('sources', $2::jsonb)) where id=$1`,
      [this.orgId, JSON.stringify(sources)],
    );
    return {};
  }
}
