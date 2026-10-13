/**
 * Step 5: enquiry activity → timeline entries on the enquiry (and its patient), type
 * `import.sanoflow_activity`, actor "system", at the original time. Rows without an id of their own
 * get a stable hash of (enquiry, time, kind, text), so a re-run never duplicates them. Existing
 * entries are never changed. The text is stored in the database only; reports carry counts.
 */
import type { ParsedCsv } from "@/lib/csv";

import { cell, mapHeaders } from "./mapping";
import { newRun, problem, warn, type EntityRun, type RunContext } from "./run";
import { parseLocalDateTime, stableId } from "./values";

export const ACTIVITY_EVENT_TYPE = "import.sanoflow_activity";
const MAX_TEXT = 2000;

export async function runActivity(
  ctx: RunContext,
  files: Array<{ file: string; csv: ParsedCsv }>,
  override?: Record<string, string | null>,
): Promise<EntityRun> {
  const run = newRun(
    "enquiry_activity",
    "Enquiry activity",
    files.map((f) => f.file).join(", ") || null,
  );
  const enquiries = new Map<string, { id: string; contact_id: string | null } | null>();
  const seen = new Set<string>();
  let line = 0;

  for (const { file, csv } of files) {
    const h = mapHeaders("enquiry_activity", csv.headers, { override });
    for (const u of h.unknown) if (!run.unknownHeaders.includes(u)) run.unknownHeaders.push(u);
    if (h.missing.length) {
      run.fatal = `${file}: missing column ${h.missing.join(", ")}`;
      return run;
    }
    const get = (row: string[], f: string) => cell(row, h.index, f);

    for (const row of csv.rows) {
      line++;
      run.counters.read++;
      const enquiryExt = get(row, "enquiry_id");
      const atRaw = get(row, "at");
      const kind = get(row, "kind").slice(0, 80);
      const text = get(row, "text");
      const at = parseLocalDateTime(atRaw, null, ctx.timezone, ctx.config.date_order);
      if (!enquiryExt || !at) {
        run.counters.invalid++;
        problem(run, line, !enquiryExt ? "no_enquiry_id" : "date_unreadable");
        continue;
      }
      const ext = get(row, "id") || stableId([enquiryExt, atRaw, kind, text]);
      if (seen.has(ext)) {
        run.counters.duplicates++;
        continue;
      }
      seen.add(ext);

      if (!enquiries.has(enquiryExt)) {
        const ref = await ctx.ports.findRef("enquiry", enquiryExt);
        const row = ref ? await ctx.ports.getRow("enquiries", ref.localId) : null;
        enquiries.set(
          enquiryExt,
          row ? { id: row.id, contact_id: (row.contact_id as string | null) ?? null } : null,
        );
      }
      const enquiry = enquiries.get(enquiryExt);
      if (!enquiry) {
        // the enquiry itself was not imported (invalid, or not in the enquiry export)
        run.counters.invalid++;
        problem(run, line, "enquiry_not_imported");
        continue;
      }
      if (await ctx.ports.findRef("enquiry_activity", ext)) {
        run.counters.unchanged++;
        continue;
      }
      if (text.length > MAX_TEXT) warn(run, "text_truncated");
      const res = await ctx.ports.insertRow("timeline_events", {
        contact_id: enquiry.contact_id,
        enquiry_id: enquiry.id,
        type: ACTIVITY_EVENT_TYPE,
        actor_type: "system",
        payload: {
          source: "sanoflow",
          kind: kind || null,
          text: text ? text.slice(0, MAX_TEXT) : null,
          by: get(row, "by").slice(0, 80) || null,
        },
        at: at.toISOString(),
      });
      if ("error" in res) {
        run.counters.failed++;
        problem(run, line, res.error);
        continue;
      }
      run.counters.created++;
      await ctx.ports.upsertRef({
        entity: "enquiry_activity",
        externalId: ext,
        localTable: "timeline_events",
        localId: res.id,
      });
    }
  }
  return run;
}
