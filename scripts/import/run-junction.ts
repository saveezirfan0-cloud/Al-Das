/**
 * Junction importer (Phase 21): one local row per (Airtable record, linked record) pair of a link field,
 * e.g. Medical Records Data → Diagnosis becomes visit_diagnoses, Unite patient → Chronic Diagnosis becomes
 * contact_chronic_conditions.
 *
 * Idempotent through external_refs(entity "<baseId>.<tableId>#<suffix>", external_id "<recordId>:<linkedId>"),
 * with the mapper's natural key as the adopt-on-match guard (a row the Unite ingest wrote for the same visit and
 * code is adopted, not duplicated). Counters are per pair, so the reconciliation identity (refs = read − skipped −
 * invalid − review) holds. A dry run goes through the DryRunStore overlay and writes nothing. Record contents are
 * never logged: warnings are codes and unmatched samples are Airtable record ids.
 */
import { addWarningCode, changedColumns, type RunContext } from "./run-table";
import { emptyResult, judge, type TableResult, type UnmatchedLink } from "./results";
import type { StoreRow } from "./store";
import { entityOf } from "./tables/map";
import type { TableMapper } from "./tables/types";

const SAMPLE = 20;

function linkIds(cell: unknown): string[] {
  return Array.isArray(cell) ? cell.filter((x): x is string => typeof x === "string") : [];
}

function addUnmatched(list: UnmatchedLink[], label: string, recordId: string) {
  let u = list.find((x) => x.label === label);
  if (!u) list.push((u = { label, count: 0, sample: [] }));
  u.count++;
  if (u.sample.length < SAMPLE && !u.sample.includes(recordId)) u.sample.push(recordId);
}

export async function runJunction(mapper: TableMapper, ctx: RunContext): Promise<TableResult> {
  const spec = mapper.junction;
  if (!spec) throw new Error(`${mapper.key} is not a junction mapper`);
  const entity = entityOf(mapper);
  const result = emptyResult({
    key: mapper.key,
    name: mapper.name,
    entity,
    target: mapper.target,
    outcome: mapper.status === "pending" ? "validated" : "imported",
  });
  const c = result.counters;
  const parentEntity = ctx.entityOf(spec.parent.mapper);
  const childEntity = ctx.entityOf(spec.link.target);
  if (!parentEntity || !childEntity)
    throw new Error(`${mapper.key}: unknown parent or link target mapper`);

  for await (const record of ctx.source.records(mapper.baseId, mapper.tableId, {
    since: ctx.since,
  })) {
    const flagged = new Set(spec.flagLink ? linkIds(record.fields[spec.flagLink.fieldId]) : []);
    const pairs = [...new Set([...linkIds(record.fields[spec.link.fieldId]), ...flagged])];
    if (pairs.length === 0) continue; // nothing linked: no junction row to account for
    const isTest = !!mapper.testFlagFieldId && record.fields[mapper.testFlagFieldId] === true;
    if (isTest && !ctx.includeTest) {
      c.read += pairs.length;
      c.skipped += pairs.length;
      continue;
    }

    const parentRef = await ctx.store.findRef(parentEntity, record.id);
    let parent: StoreRow | null = parentRef
      ? await ctx.store.getRow(spec.parent.table, parentRef.localId)
      : null;
    // A dry run can resolve to a parent the overlay only knows by id (patients matched, not yet written).
    if (!parent && parentRef && ctx.dryRun) parent = { id: parentRef.localId };

    for (const linked of pairs) {
      c.read++;
      if (!parent) {
        c.invalid++;
        addUnmatched(result.unmatched, `${mapper.key} · parent (${spec.parent.mapper})`, record.id);
        continue;
      }
      const childRef = await ctx.store.findRef(childEntity, linked);
      const child = childRef ? await ctx.store.getRow(spec.link.table, childRef.localId) : null;
      if (!child) {
        c.invalid++;
        addUnmatched(result.unmatched, `${mapper.key} · ${spec.link.label}`, record.id);
        continue;
      }
      result.linksResolved++;

      const built = spec.build({ parent, child, flagged: flagged.has(linked) });
      if (typeof built === "string") {
        c.skipped++;
        addWarningCode(result.warnings, built);
        continue;
      }
      const externalId = `${record.id}:${linked}`;

      if (mapper.status === "pending") {
        await ctx.store.upsertRef({
          entity,
          externalId,
          localTable: mapper.target,
          localId: `validated-${mapper.key}-${externalId}`,
        });
        c.created++;
        continue;
      }

      try {
        const ref = await ctx.store.findRef(entity, externalId);
        let existing = ref ? await ctx.store.getRow(mapper.target, ref.localId) : null;
        let adopted = false;
        if (!existing && mapper.naturalKey.length) {
          const match = Object.fromEntries(mapper.naturalKey.map((k) => [k, built[k] ?? null]));
          if (Object.values(match).every((v) => v !== null)) {
            existing = await ctx.store.findOne(mapper.target, match);
            adopted = !!existing;
          }
        }
        if (existing) {
          const cols = mapper.createOnly ? [] : changedColumns(mapper, existing, built);
          if (cols.length) {
            const res = await ctx.store.updateRow(
              mapper.target,
              existing.id,
              Object.fromEntries(cols.map((k) => [k, built[k]])),
            );
            if (res.error) {
              c.failed++;
              result.failures.push([record.id, res.error]);
              continue;
            }
          }
          if (adopted) c.adopted++;
          else if (cols.length) c.updated++;
          else c.unchanged++;
          await ctx.store.upsertRef({
            entity,
            externalId,
            localTable: mapper.target,
            localId: existing.id,
          });
          continue;
        }
        const insert = Object.fromEntries(Object.entries(built).filter(([, v]) => v !== null));
        const ins = await ctx.store.insertRow(mapper.target, insert);
        if ("error" in ins) {
          c.failed++;
          result.failures.push([record.id, ins.error]);
          continue;
        }
        await ctx.store.upsertRef({
          entity,
          externalId,
          localTable: mapper.target,
          localId: ins.id,
        });
        c.created++;
      } catch (e) {
        c.failed++;
        result.failures.push([record.id, `write threw: ${(e as Error).message}`]);
      }
    }
    if (c.read > 0 && c.read % 1000 === 0) ctx.log?.(`  ${mapper.name}: ${c.read} pairs read`);
  }

  result.refsAfter = await ctx.store.countRefs(entity);
  result.rowsAfter = mapper.status === "ready" ? await ctx.store.countRows(mapper.target) : null;
  result.verdict = judge(result, !ctx.since);
  result.note =
    "Counted per link: one row per (record, linked record) pair; records with no link are not counted.";
  return result;
}
