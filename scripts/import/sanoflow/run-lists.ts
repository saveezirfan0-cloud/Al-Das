/**
 * Step 2: contact tags, conversation labels, conversation categories and quick replies.
 * Keyed in external_refs by the Sanoflow id when the export has one, otherwise by the lower-cased
 * name. An existing Pulse row with the same name (shortcut for quick replies) is adopted.
 */
import { TAG_COLORS } from "@/lib/contacts/format";
import type { ParsedCsv } from "@/lib/csv";

import { cell, mapHeaders } from "./mapping";
import { newRun, problem, warn, type EntityRun, type RunContext } from "./run";
import { nameKey, toShortcut } from "./values";

type ListKind = "tag" | "label" | "conv_category";

const LIST_TARGET: Record<ListKind, { table: string; label: string; scope?: string }> = {
  tag: { table: "tags", label: "Contact tags", scope: "contact" },
  label: { table: "tags", label: "Conversation labels", scope: "conversation" },
  conv_category: { table: "conv_categories", label: "Conversation categories" },
};

const COLORS = new Set<string>(TAG_COLORS);

export async function runList(
  ctx: RunContext,
  kind: ListKind,
  csv: ParsedCsv,
  file: string,
  override?: Record<string, string | null>,
): Promise<EntityRun> {
  const t = LIST_TARGET[kind];
  const run = newRun(kind, t.label, file);
  const h = mapHeaders(kind, csv.headers, { override });
  run.unknownHeaders = h.unknown;
  if (h.missing.length) {
    run.fatal = `missing column: ${h.missing.join(", ")}`;
    return run;
  }
  const seen = new Set<string>();
  let sort = await ctx.ports.countRows(t.table);
  for (const [i, row] of csv.rows.entries()) {
    const line = i + 1;
    run.counters.read++;
    const name = cell(row, h.index, "name").slice(0, 60);
    if (!name) {
      run.counters.invalid++;
      problem(run, line, "no_name");
      continue;
    }
    const ext = cell(row, h.index, "id") || nameKey(name);
    if (seen.has(nameKey(name))) {
      run.counters.duplicates++;
      continue;
    }
    seen.add(nameKey(name));
    const ref = await ctx.ports.findRef(kind, ext);
    if (ref && (await ctx.ports.getRow(t.table, ref.localId))) {
      run.counters.unchanged++;
      continue;
    }
    const match: Record<string, unknown> = { name };
    if (t.scope) match.scope = t.scope;
    const existing = await ctx.ports.findOne(t.table, match);
    let id: string;
    if (existing) {
      id = existing.id;
      run.counters.adopted++;
    } else {
      const color = cell(row, h.index, "color").toLowerCase();
      const values: Record<string, unknown> = { ...match };
      if (t.table === "tags" && COLORS.has(color)) values.color = color;
      if (t.table === "conv_categories") values.sort = sort++;
      const res = await ctx.ports.insertRow(t.table, values);
      if ("error" in res) {
        run.counters.failed++;
        problem(run, line, res.error);
        continue;
      }
      id = res.id;
      run.counters.created++;
    }
    await ctx.ports.upsertRef({ entity: kind, externalId: ext, localTable: t.table, localId: id });
  }
  return run;
}

export async function runQuickReplies(
  ctx: RunContext,
  csv: ParsedCsv,
  file: string,
  override?: Record<string, string | null>,
): Promise<EntityRun> {
  const run = newRun("quick_reply", "Quick replies", file);
  const h = mapHeaders("quick_reply", csv.headers, { override });
  run.unknownHeaders = h.unknown;
  if (h.missing.length) {
    run.fatal = `missing column: ${h.missing.join(", ")}`;
    return run;
  }
  const used = new Set<string>();
  for (const [i, row] of csv.rows.entries()) {
    const line = i + 1;
    run.counters.read++;
    const text = cell(row, h.index, "text");
    const textAr = cell(row, h.index, "text_ar");
    const name = cell(row, h.index, "name");
    const base = toShortcut(cell(row, h.index, "shortcut") || name);
    if (!text || !base || text.length > 4096 || textAr.length > 4096) {
      run.counters.invalid++;
      problem(run, line, !text ? "no_text" : !base ? "no_shortcut" : "text_too_long");
      continue;
    }
    const ext = cell(row, h.index, "id") || base;
    const values = {
      text,
      text_ar: textAr || null,
      label: name ? name.slice(0, 80) : null,
    };
    const ref = await ctx.ports.findRef("quick_reply", ext);
    const current = ref ? await ctx.ports.getRow("quick_replies", ref.localId) : null;
    if (current) {
      used.add(String(current.shortcut));
      const changed = current.text !== values.text || (current.text_ar ?? null) !== values.text_ar;
      if (!changed || ctx.mode === "skip") {
        run.counters.unchanged++;
        continue;
      }
      const res = await ctx.ports.updateRow("quick_replies", current.id, values);
      if (res.error) {
        run.counters.failed++;
        problem(run, line, res.error);
      } else run.counters.updated++;
      continue;
    }
    // A Pulse quick reply with the same shortcut and text is the same reply: adopt it. Same shortcut,
    // different text: keep both, the imported one gets a numbered shortcut.
    let shortcut = base;
    for (let n = 2; ; n++) {
      if (used.has(shortcut)) {
        shortcut = `${base.slice(0, 36)}-${n}`;
        continue;
      }
      const clash = await ctx.ports.findOne("quick_replies", { shortcut });
      if (!clash) break;
      if (clash.text === text) {
        used.add(shortcut);
        await ctx.ports.upsertRef({
          entity: "quick_reply",
          externalId: ext,
          localTable: "quick_replies",
          localId: clash.id,
        });
        run.counters.adopted++;
        shortcut = "";
        break;
      }
      shortcut = `${base.slice(0, 36)}-${n}`;
    }
    if (!shortcut) continue;
    if (shortcut !== base) warn(run, "shortcut_renamed");
    used.add(shortcut);
    const res = await ctx.ports.insertRow("quick_replies", { shortcut, ...values });
    if ("error" in res) {
      run.counters.failed++;
      problem(run, line, res.error);
      continue;
    }
    run.counters.created++;
    await ctx.ports.upsertRef({
      entity: "quick_reply",
      externalId: ext,
      localTable: "quick_replies",
      localId: res.id,
    });
  }
  return run;
}
