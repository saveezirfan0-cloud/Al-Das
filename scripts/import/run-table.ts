/**
 * Generic table importer: Airtable records → mapRecord → link resolution → store writes.
 * Two passes happen implicitly: tables run in dependency order, so by the time a table with
 * links runs, its targets already have external_refs; links that still do not resolve are
 * reported, never guessed.
 */
import { slug } from "./convert";
import { mapperFieldIds, entityOf, mapRecord } from "./tables/map";
import type { MappedRow, TableMapper } from "./tables/types";
import {
  emptyResult,
  judge,
  type AirtableSource,
  type TableResult,
  type UnmatchedLink,
} from "./results";
import { sameValue, type ImportStore, type StoreRow } from "./store";

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
const SAMPLE = 20;

export type RunContext = {
  store: ImportStore;
  source: AirtableSource;
  /** Mapper key → Airtable entity ("<baseId>.<tableId>") for link targets. */
  entityOf(key: string): string | undefined;
  dryRun: boolean;
  includeTest: boolean;
  since?: string;
  auditedCounts?: Record<string, number>;
  log?: (line: string) => void;
};

function addWarning(map: Record<string, number>, code: string) {
  map[code] = (map[code] ?? 0) + 1;
}

function addUnmatched(list: UnmatchedLink[], label: string, recordId: string) {
  let u = list.find((x) => x.label === label);
  if (!u) list.push((u = { label, count: 0, sample: [] }));
  u.count++;
  if (u.sample.length < SAMPLE) u.sample.push(recordId);
}

/** Columns that differ between the mapped values and an existing row. */
export function changedColumns(
  mapper: TableMapper,
  existing: StoreRow,
  values: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const [col, v] of Object.entries(values)) {
    if (
      mapper.fillBlankOnly?.includes(col) &&
      existing[col] !== null &&
      existing[col] !== undefined &&
      existing[col] !== ""
    )
      continue;
    // A blank source never erases a value that is already there (the portal may have edited it).
    if (v === null && existing[col] !== null && existing[col] !== undefined) continue;
    if (!sameValue(existing[col], v)) out.push(col);
  }
  return out;
}

async function resolveLinks(
  mapper: TableMapper,
  mapped: MappedRow,
  ctx: RunContext,
  result: TableResult,
): Promise<void> {
  for (const link of mapper.links ?? []) {
    if (link.kind === "record") {
      const ids = mapped.links[link.fieldId];
      if (!ids?.length) continue;
      const entity = ctx.entityOf(link.target);
      let first: string | null = null;
      let all = true;
      for (const id of ids) {
        const ref = entity ? await ctx.store.findRef(entity, id) : null;
        if (ref) first ??= ref.localId;
        else all = false;
      }
      if (!all) addUnmatched(result.unmatched, `${mapper.key} · ${link.label}`, mapped.recordId);
      else result.linksResolved++;
      if (link.column && first) {
        mapped.values[link.column] = first;
        if (ids.length > 1) addWarning(result.warnings, `multiple_links_first_used:${link.label}`);
      }
    } else {
      const text = mapped.lookups[link.fieldId];
      if (!text) continue;
      const hit = await ctx.store.findOne(link.table, { [link.matchColumn]: text });
      if (hit) {
        mapped.values[link.column] = hit.id;
        result.linksResolved++;
      } else {
        addUnmatched(result.unmatched, `${mapper.key} · ${link.label}`, mapped.recordId);
      }
    }
  }
}

type WriteOutcome = "created" | "updated" | "unchanged" | "adopted" | "duplicate" | "failed";

async function writeGeneric(
  mapper: TableMapper,
  mapped: MappedRow,
  ctx: RunContext,
  seenLocal: Set<string>,
  entity: string,
): Promise<{ outcome: WriteOutcome; id?: string; error?: string }> {
  const { store } = ctx;
  const values = { ...mapped.values };
  const ref = await store.findRef(entity, mapped.recordId);
  let existing: StoreRow | null = ref ? await store.getRow(mapper.target, ref.localId) : null;
  let adopted = false;

  if (!existing) {
    const keyMatch = Object.fromEntries(mapper.naturalKey.map((c) => [c, values[c] ?? null]));
    if (mapper.naturalKey.length && Object.values(keyMatch).every((v) => v !== null))
      existing = await store.findOne(mapper.target, keyMatch);
    adopted = !!existing;
  }

  if (existing) {
    // A second Airtable record that maps to a row another record already claimed in this run.
    const duplicate = seenLocal.has(existing.id) && !ref;
    seenLocal.add(existing.id);
    const cols = changedColumns(mapper, existing, values);
    let outcome: WriteOutcome = duplicate ? "duplicate" : adopted ? "adopted" : "unchanged";
    if (cols.length > 0 && !duplicate) {
      const res = await store.updateRow(
        mapper.target,
        existing.id,
        Object.fromEntries(cols.map((c) => [c, values[c]])),
      );
      if (res.error) return { outcome: "failed", error: res.error };
      outcome = adopted ? "adopted" : "updated";
    }
    await store.upsertRef({
      entity,
      externalId: mapped.recordId,
      localTable: mapper.target,
      localId: existing.id,
    });
    return { outcome, id: existing.id };
  }

  const ins = await store.insertRow(mapper.target, values);
  if ("error" in ins) return { outcome: "failed", error: ins.error };
  seenLocal.add(ins.id);
  await store.upsertRef({
    entity,
    externalId: mapped.recordId,
    localTable: mapper.target,
    localId: ins.id,
  });
  return { outcome: "created", id: ins.id };
}

// ---------------------------------------------------------------------------
// clinical_settings: sign-off rules
// ---------------------------------------------------------------------------

const SETTING_CATEGORIES = new Set([
  "paediatrics",
  "gp_adults",
  "gynaecology",
  "medication_sequence",
  "escalation",
  "operational",
  "recall",
  "engine",
]);
const SIGN_OFF = new Set(["blocking", "awaiting", "confirm_exclusion", "approved"]);

/**
 * Clinical settings are governed data: a signed-off row in Pulse is never overwritten, an
 * "approved" status only counts when an approved value, signer and date all exist, and Airtable
 * can never downgrade a sign-off. Unknown categories fail closed (row not imported).
 */
async function writeSetting(
  mapped: MappedRow,
  ctx: RunContext,
  entity: string,
  result: TableResult,
): Promise<{ outcome: WriteOutcome; id?: string; error?: string }> {
  const { store } = ctx;
  const v = mapped.values;
  const ref = await store.findRef(entity, mapped.recordId);
  let existing: StoreRow | null = ref ? await store.getRow("clinical_settings", ref.localId) : null;
  existing ??= await store.findOne("clinical_settings", { airtable_record_id: mapped.recordId });
  existing ??= await store.findOne("clinical_settings", { label: v.label });

  const signed = !!(v.approved_value && v.signed_by && v.signed_at);
  let status =
    typeof v.sign_off_status === "string" && SIGN_OFF.has(v.sign_off_status)
      ? v.sign_off_status
      : null;
  if (v.sign_off_status && !status) addWarning(result.warnings, "unknown_sign_off_status");
  if (status === "approved" && !signed) {
    addWarning(result.warnings, "approved_without_signature");
    status = null; // never trust an unsigned "approved"
  }

  if (!existing) {
    const category = typeof v.category === "string" ? v.category : "";
    if (!SETTING_CATEGORIES.has(category)) return { outcome: "failed", error: "unknown_category" };
    const row = {
      key: slug(v.label).slice(0, 80),
      label: v.label,
      category,
      value_type: "text",
      proposed_value: v.proposed_value,
      approved_value: signed ? v.approved_value : null,
      sign_off_status: status ?? "awaiting",
      owner: v.owner,
      notes: v.notes,
      signed_by: signed ? v.signed_by : null,
      signed_at: signed ? v.signed_at : null,
      source: "airtable",
      airtable_record_id: mapped.recordId,
    };
    const ins = await store.insertRow("clinical_settings", row);
    if ("error" in ins) return { outcome: "failed", error: ins.error };
    await store.upsertRef({
      entity,
      externalId: mapped.recordId,
      localTable: "clinical_settings",
      localId: ins.id,
    });
    return { outcome: "created", id: ins.id };
  }

  const patch: Record<string, unknown> = {};
  const keepSigned = existing.sign_off_status === "approved";
  if (keepSigned) {
    addWarning(result.warnings, "kept_signed_off_setting");
  } else {
    for (const col of ["proposed_value", "owner", "notes"] as const) {
      if (v[col] !== null && !sameValue(existing[col], v[col])) patch[col] = v[col];
    }
    if (signed) {
      for (const col of ["approved_value", "signed_by", "signed_at"] as const)
        if (!sameValue(existing[col], v[col])) patch[col] = v[col];
      if (existing.sign_off_status !== "approved") patch.sign_off_status = "approved";
    } else if (
      status &&
      status !== "approved" &&
      existing.sign_off_status !== status &&
      existing.sign_off_status === "awaiting"
    ) {
      patch.sign_off_status = status; // only moves out of the default 'awaiting'
    }
    if (!existing.airtable_record_id) patch.airtable_record_id = mapped.recordId;
  }
  if (Object.keys(patch).length > 0) {
    const res = await store.updateRow("clinical_settings", existing.id, patch);
    if (res.error) return { outcome: "failed", error: res.error };
  }
  await store.upsertRef({
    entity,
    externalId: mapped.recordId,
    localTable: "clinical_settings",
    localId: existing.id,
  });
  return { outcome: Object.keys(patch).length ? "updated" : "unchanged", id: existing.id };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export async function runTable(mapper: TableMapper, ctx: RunContext): Promise<TableResult> {
  const entity = entityOf(mapper);
  const result = emptyResult({
    key: mapper.key,
    name: mapper.name,
    entity,
    target: mapper.target,
    outcome: mapper.status === "pending_phase6" ? "validated" : "imported",
    auditedCount: ctx.auditedCounts?.[mapper.tableId] ?? null,
  });
  const c = result.counters;
  const seenLocal = new Set<string>();
  const known = new Set(mapperFieldIds(mapper));

  const schema = await ctx.source.tableFields(mapper.baseId, mapper.tableId);
  result.unmappedFields = schema
    .filter((f) => !known.has(f.id) && !SKIP_FIELD_TYPES.has(f.type))
    .map((f) => ({ id: f.id, name: f.name, type: f.type }));

  for await (const record of ctx.source.records(mapper.baseId, mapper.tableId, {
    since: ctx.since,
  })) {
    c.read++;
    let mapped: MappedRow;
    try {
      mapped = mapRecord(mapper, record);
    } catch (e) {
      c.failed++;
      result.failures.push([record.id, `mapper threw: ${(e as Error).message}`]);
      continue;
    }
    for (const w of mapped.warnings) addWarning(result.warnings, w);
    if (mapped.isTest && !ctx.includeTest) {
      c.skipped++;
      continue;
    }
    if (mapped.invalid) {
      c.invalid++;
      continue;
    }

    try {
      await resolveLinks(mapper, mapped, ctx, result);
      // "Validated" tables (target not migrated) only record an overlay ref so later tables'
      // links resolve in a dry run; nothing is written.
      if (mapper.status === "pending_phase6") {
        await ctx.store.upsertRef({
          entity,
          externalId: mapped.recordId,
          localTable: mapper.target,
          localId: `validated-${mapper.key}-${record.id}`,
        });
        c.created++; // "would create" in the validated summary
        continue;
      }
      const res =
        mapper.writer === "clinical_settings"
          ? await writeSetting(mapped, ctx, entity, result)
          : await writeGeneric(mapper, mapped, ctx, seenLocal, entity);
      switch (res.outcome) {
        case "created":
          c.created++;
          break;
        case "updated":
          c.updated++;
          break;
        case "unchanged":
          c.unchanged++;
          break;
        case "adopted":
          c.adopted++;
          break;
        case "duplicate":
          c.duplicates++;
          break;
        case "failed":
          c.failed++;
          result.failures.push([record.id, res.error ?? "write failed"]);
          break;
      }
    } catch (e) {
      c.failed++;
      result.failures.push([record.id, `write threw: ${(e as Error).message}`]);
    }
    if (c.read % 1000 === 0) ctx.log?.(`  ${mapper.name}: ${c.read} read`);
  }

  result.refsAfter = await ctx.store.countRefs(entity);
  result.rowsAfter = mapper.status === "ready" ? await ctx.store.countRows(mapper.target) : null;
  result.verdict = judge(result, !ctx.since);
  return result;
}
