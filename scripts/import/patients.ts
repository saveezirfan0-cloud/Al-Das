/**
 * Patient tables (Unite.Unite, Acute.Patients) → contacts. This is the Phase 2 loop, unchanged in
 * behaviour, wrapped to return the same TableResult the generic tables produce. Matching is
 * PIN → E.164 phone → name + DOB; ambiguous matches go to sync_reviews and are never auto-merged.
 */
import {
  findExternalRef,
  matchContact,
  queueSyncReview,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";
import type { AdminClient } from "@/lib/supabase/admin";

import type { AirtableSource } from "./results";
import type { ImportStore } from "./store";
import { emptyResult, judge, type TableResult } from "./results";
import { ensureCustomFields } from "./custom-fields";
import type { PatientMapper } from "./mappers/types";

const SKIP_FIELD_TYPES = new Set([
  "formula",
  "rollup",
  "lookup",
  "multipleLookupValues",
  "count",
  "createdTime",
  "lastModifiedTime",
  "autoNumber",
  "multipleRecordLinks",
]);

export type PatientContext = {
  admin: AdminClient;
  orgId: string;
  source: AirtableSource;
  /** Real store, or the dry-run overlay (so later tables can resolve links to patients). */
  store: ImportStore;
  dryRun: boolean;
  includeTest: boolean;
  since?: string;
  batch: string;
  tagIds: Map<string, string>;
  auditedCounts?: Record<string, number>;
  log?: (line: string) => void;
};

export async function runPatientTable(
  mapper: PatientMapper & { key: string },
  ctx: PatientContext,
): Promise<TableResult> {
  const { admin, orgId } = ctx;
  const entity = `${mapper.baseId}.${mapper.tableId}`;
  const result = emptyResult({
    key: mapper.key,
    name: mapper.name,
    entity,
    target: "contacts",
    auditedCount: ctx.auditedCounts?.[mapper.tableId] ?? null,
  });
  const c = result.counters;

  const { defs: customFields, created } = await ensureCustomFields(
    admin,
    orgId,
    mapper.customFields,
    ctx.dryRun,
  );
  result.createdCustomFields = created;
  const schema = await ctx.source.tableFields(mapper.baseId, mapper.tableId);
  result.unmappedFields = schema
    .filter((f) => !mapper.fieldIds.includes(f.id) && !SKIP_FIELD_TYPES.has(f.type))
    .map((f) => ({ id: f.id, name: f.name, type: f.type }));

  for await (const record of ctx.source.records(mapper.baseId, mapper.tableId, {
    since: ctx.since,
  })) {
    c.read++;
    let mapped;
    try {
      mapped = mapper.map(record);
    } catch (e) {
      c.failed++;
      result.failures.push([record.id, `mapper threw: ${(e as Error).message}`]);
      continue;
    }
    for (const w of mapped.warnings) result.warnings[w] = (result.warnings[w] ?? 0) + 1;
    if (mapped.isTestRecord && !ctx.includeTest) {
      c.skipped++;
      continue;
    }
    const ct = mapped.contact;
    if (!ct.phone_e164 && !ct.external_id && !(ct.first_name && ct.dob)) {
      c.invalid++; // nothing to identify the patient by
      continue;
    }

    // 1. Already imported? (idempotent re-run)
    let existingId: string | null = null;
    let existingCustom: Record<string, unknown> | null = null;
    const ref = await findExternalRef(admin, {
      orgId,
      source: "airtable",
      entity,
      externalId: record.id,
    });
    if (ref) {
      const { data } = await admin
        .from("contacts")
        .select("id, custom, merged_into_id")
        .eq("id", ref.localId)
        .maybeSingle();
      const target = data?.merged_into_id ?? data?.id ?? null;
      if (target) {
        const { data: live } = await admin
          .from("contacts")
          .select("id, custom")
          .eq("id", target)
          .is("deleted_at", null)
          .maybeSingle();
        if (live) {
          existingId = live.id;
          existingCustom = (live.custom as Record<string, unknown>) ?? {};
        }
      }
    }
    // 2. Match an existing patient: PIN → phone → name + DOB
    if (!existingId) {
      const m = await matchContact(admin, orgId, {
        externalId: ct.external_id,
        phone: ct.phone_e164,
        fullName: `${ct.first_name} ${ct.last_name}`.trim(),
        dob: ct.dob,
      });
      if (m.kind === "ambiguous") {
        c.review++;
        if (!ctx.dryRun)
          await queueSyncReview(admin, {
            orgId,
            source: "airtable",
            entity,
            externalId: record.id,
            reason: `multiple_${m.candidates[0]?.matched_on ?? "matches"}`,
            candidates: m.candidates,
          });
        continue;
      }
      if (m.kind === "match") {
        existingId = m.id;
        existingCustom = m.custom;
      }
    }

    const res = await writePreparedContact(admin, {
      orgId,
      existingId,
      existingCustom,
      contact: ct,
      defaultSource: "import_airtable",
      customFields,
      tagIds: ctx.tagIds,
      actorId: null,
      batch: ctx.batch,
      dryRun: ctx.dryRun,
    });
    if (!res.ok) {
      c.failed++;
      result.failures.push([record.id, res.error]);
      continue;
    }
    if (res.created) c.created++;
    else c.updated++;
    if (ctx.dryRun) {
      await ctx.store.upsertRef({
        entity,
        externalId: record.id,
        localTable: "contacts",
        localId: res.id,
      });
    } else {
      await upsertExternalRef(admin, {
        orgId,
        source: "airtable",
        entity,
        externalId: record.id,
        localTable: "contacts",
        localId: res.id,
        meta: mapped.meta,
      });
      for (const [source, externalId] of Object.entries(mapped.refs))
        await upsertExternalRef(admin, {
          orgId,
          source,
          entity: "contact",
          externalId,
          localTable: "contacts",
          localId: res.id,
        });
    }
    if (c.read % 500 === 0)
      ctx.log?.(`  ${mapper.name}: ${c.read} read, ${c.created} created, ${c.updated} updated`);
  }

  result.refsAfter = await ctx.store.countRefs(entity);
  result.rowsAfter = await ctx.store.countRows("contacts");
  result.verdict = judge(result, !ctx.since);
  result.note = ctx.dryRun
    ? "Dry run: contacts are matched against the current database; nothing is written."
    : "Re-runs update matched contacts in place (counted as updated).";
  return result;
}
