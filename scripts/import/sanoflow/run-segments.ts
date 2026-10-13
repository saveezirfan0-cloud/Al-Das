/**
 * Step 3: static segments become Pulse static segments with the same members; dynamic segments are
 * NOT imported (their filters use Sanoflow fields): they are listed by name with their filter text in
 * the report so they can be rebuilt by hand in the Pulse filter builder.
 *
 * A membership is keyed in external_refs as "<segment key>|<contact key>" (local row: the segment).
 * Members are only ever added; a member removed in Pulse since an earlier run is added back only if
 * its ref is missing.
 */
import type { ParsedCsv } from "@/lib/csv";

import { cell, mapHeaders } from "./mapping";
import { newRun, problem, resolveContact, warn, type EntityRun, type RunContext } from "./run";
import { nameKey } from "./values";

export async function runStaticSegments(
  ctx: RunContext,
  files: Array<{ file: string; csv: ParsedCsv }>,
  override?: Record<string, string | null>,
): Promise<{ segments: EntityRun; members: EntityRun }> {
  const label = files.map((f) => f.file).join(", ") || null;
  const segments = newRun("segment", "Static segments", label);
  const members = newRun("segment_member", "Static segment members", label);
  const segmentIds = new Map<string, string | null>();
  const touched = new Set<string>();
  let line = 0;

  for (const { file, csv } of files) {
    const h = mapHeaders("segment_member", csv.headers, { override });
    for (const u of h.unknown)
      if (!members.unknownHeaders.includes(u)) members.unknownHeaders.push(u);
    if (h.missing.length) {
      members.fatal = `${file}: missing column ${h.missing.join(", ")}`;
      break;
    }
    // One file per segment is common ("segment-<name>.csv" with no segment column).
    const fileSegment = /^segment[-_ ](.+)\.csv$/i.exec(file)?.[1]?.replace(/[-_]+/g, " ") ?? "";
    const get = (row: string[], f: string) => cell(row, h.index, f);

    for (const row of csv.rows) {
      line++;
      members.counters.read++;
      const segName = (get(row, "segment") || fileSegment).slice(0, 120);
      const segKey = get(row, "segment_id") || nameKey(segName);
      if (!segKey || !segName) {
        members.counters.invalid++;
        problem(members, line, "no_segment");
        continue;
      }
      if (!segmentIds.has(segKey)) {
        segments.counters.read++;
        segmentIds.set(segKey, await ensureSegment(ctx, segments, segKey, segName));
      }
      const segmentId = segmentIds.get(segKey);
      if (!segmentId) {
        members.counters.invalid++;
        problem(members, line, "segment_not_created");
        continue;
      }
      const contactRaw = get(row, "contact_id");
      const phoneRaw = get(row, "phone");
      const contact = await resolveContact(ctx.ports, contactRaw, phoneRaw);
      if (contact.kind !== "match") {
        members.counters.invalid++;
        problem(members, line, contact.kind === "none" ? "contact_not_found" : "contact_ambiguous");
        continue;
      }
      const ext = `${segKey}|${contactRaw || contact.id}`;
      if (await ctx.ports.findRef("segment_member", ext)) {
        members.counters.unchanged++;
        continue;
      }
      if (await ctx.ports.hasSegmentMember(segmentId, contact.id)) {
        members.counters.adopted++;
      } else {
        const res = await ctx.ports.addSegmentMember(segmentId, contact.id);
        if (res.error) {
          members.counters.failed++;
          problem(members, line, res.error);
          continue;
        }
        members.counters.created++;
        touched.add(segmentId);
      }
      await ctx.ports.upsertRef({
        entity: "segment_member",
        externalId: ext,
        localTable: "segments",
        localId: segmentId,
      });
    }
  }
  for (const id of touched) await ctx.ports.refreshSegmentCount(id);
  return { segments, members };
}

async function ensureSegment(
  ctx: RunContext,
  run: EntityRun,
  key: string,
  name: string,
): Promise<string | null> {
  const ref = await ctx.ports.findRef("segment", key);
  if (ref && (await ctx.ports.getRow("segments", ref.localId))) {
    run.counters.unchanged++;
    return ref.localId;
  }
  const existing = await ctx.ports.findOne("segments", { name });
  if (existing) {
    if (existing.kind !== "static") {
      run.counters.invalid++;
      warn(run, "name_taken_by_dynamic_segment");
      return null;
    }
    run.counters.adopted++;
    await ctx.ports.upsertRef({
      entity: "segment",
      externalId: key,
      localTable: "segments",
      localId: existing.id,
    });
    return existing.id;
  }
  const res = await ctx.ports.insertRow("segments", { name, kind: "static", filter: null });
  if ("error" in res) {
    run.counters.failed++;
    return null;
  }
  run.counters.created++;
  await ctx.ports.upsertRef({
    entity: "segment",
    externalId: key,
    localTable: "segments",
    localId: res.id,
  });
  return res.id;
}

export type DynamicSegment = { name: string; filter: string };

/** Reads the dynamic-segment list for the report. Nothing is written. */
export function readDynamicSegments(
  csv: ParsedCsv,
  file: string,
  override?: Record<string, string | null>,
): { run: EntityRun; segments: DynamicSegment[] } {
  const run = newRun("segment_dynamic", "Dynamic segments (rebuild by hand)", file);
  run.skippedByDesign = true;
  const h = mapHeaders("segment_dynamic", csv.headers, { override });
  run.unknownHeaders = h.unknown;
  if (h.missing.length) {
    run.fatal = `missing column: ${h.missing.join(", ")}`;
    return { run, segments: [] };
  }
  const segments: DynamicSegment[] = [];
  for (const [i, row] of csv.rows.entries()) {
    run.counters.read++;
    const name = cell(row, h.index, "segment");
    if (!name) {
      run.counters.invalid++;
      problem(run, i + 1, "no_name");
      continue;
    }
    run.counters.skipped++;
    segments.push({
      name: name.slice(0, 120),
      filter: cell(row, h.index, "filter").slice(0, 2000),
    });
  }
  return { run, segments };
}
