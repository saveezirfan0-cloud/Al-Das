/**
 * Step 4: enquiries (per-pipeline or all-pipelines exports; several files may be passed).
 *
 * Each row is keyed by its Sanoflow enquiry id in external_refs. The patient is found through the
 * Sanoflow contact id (refs written by the contact import) and then the phone; the assignee by
 * e-mail among active members. Rows are written straight to `enquiries` with the service role, so
 * no domain event, flow, notification or SLA timer fires for history (sla_due_at stays empty).
 * A re-run updates rows whose Sanoflow values changed unless --mode=skip.
 */
import { coerceCustomValue, type CustomFieldDef } from "@/lib/contacts/custom-values";
import type { ParsedCsv } from "@/lib/csv";

import { cell, mapHeaders } from "./mapping";
import { PipelineResolver } from "./run-config";
import {
  newRun,
  problem,
  resolveContact,
  unmatchedName,
  warn,
  type EntityRun,
  type RunContext,
} from "./run";
import { RefResolver } from "./refs";
import { sameValue } from "../store";
import { mapLostReason, mapStatus, parseLocalDateTime, parseMoney } from "./values";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const COMPARED = [
  "pipeline_id",
  "stage_id",
  "status",
  "lost_reason",
  "contact_id",
  "title",
  "source",
  "assignee_id",
  "est_value",
  "location_id",
  "specialist_id",
  "service_id",
  "appt_date",
  "custom",
] as const;

export async function runEnquiries(
  ctx: RunContext,
  files: Array<{ file: string; csv: ParsedCsv }>,
  override?: Record<string, string | null>,
): Promise<EntityRun> {
  const run = newRun("enquiry", "Enquiries", files.map((f) => f.file).join(", ") || null);
  const pipes = new PipelineResolver(ctx);
  const refs = new RefResolver(ctx);
  const stored = await ctx.ports.customFieldDefs("enquiry");
  const defs = new Map<string, CustomFieldDef>(stored.map((d) => [d.key, d]));
  for (const f of ctx.config.enquiry_custom_fields)
    if (!defs.has(f.key))
      defs.set(f.key, {
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options ?? [],
        required: false,
      });
  const seen = new Set<string>();
  const sources = new Set<string>();
  let line = 0;

  for (const { file, csv } of files) {
    const h = mapHeaders("enquiry", csv.headers, { override, customFields: [...defs.values()] });
    for (const u of h.unknown) if (!run.unknownHeaders.includes(u)) run.unknownHeaders.push(u);
    if (h.missing.length) {
      run.fatal = `${file}: missing column ${h.missing.join(", ")}`;
      return run;
    }
    const get = (row: string[], f: string) => cell(row, h.index, f);

    for (const row of csv.rows) {
      line++;
      run.counters.read++;
      const ext = get(row, "id");
      if (!ext) {
        run.counters.invalid++;
        problem(run, line, "no_id");
        continue;
      }
      if (seen.has(ext)) {
        // the same enquiry in the all-pipelines and a per-pipeline export
        run.counters.duplicates++;
        continue;
      }
      seen.add(ext);

      const pipelineRaw = get(row, "pipeline");
      const stageRaw = get(row, "stage");
      const pipelineId = await pipes.pipeline(pipelineRaw);
      if (!pipelineId) {
        run.counters.invalid++;
        problem(run, line, "unknown_pipeline");
        unmatchedName(run, "pipeline", pipelineRaw);
        continue;
      }
      const stageId = await pipes.stage(pipelineRaw, stageRaw);
      if (!stageId) {
        run.counters.invalid++;
        problem(run, line, "unknown_stage");
        unmatchedName(run, "stage", `${pipelineRaw} / ${stageRaw}`);
        continue;
      }
      const statusRaw = get(row, "status");
      const status = mapStatus(statusRaw, ctx.config);
      if (!status) {
        run.counters.invalid++;
        problem(run, line, "unknown_status");
        unmatchedName(run, "status", statusRaw);
        continue;
      }
      const value = parseMoney(get(row, "value"));
      if (value === undefined) warn(run, "value_unreadable");

      const contact = await resolveContact(ctx.ports, get(row, "contact_id"), get(row, "phone"));
      if (contact.kind === "none") warn(run, "contact_not_found");
      if (contact.kind === "ambiguous") warn(run, "contact_ambiguous");

      let assigneeId: string | null = null;
      const email = get(row, "assignee_email");
      if (email) {
        assigneeId = await ctx.ports.memberIdByEmail(email);
        if (!assigneeId) warn(run, "assignee_not_member");
      }

      const lookup = async (table: "locations" | "specialists" | "services", field: string) => {
        const raw = get(row, field);
        if (!raw) return null;
        const hit = await refs.get(table, raw);
        if (!hit) {
          warn(run, `${field}_not_found`);
          unmatchedName(run, field, raw);
        }
        return hit?.id ?? null;
      };

      const tz = ctx.timezone;
      const order = ctx.config.date_order;
      const createdAt = parseLocalDateTime(get(row, "created_at"), null, tz, order);
      if (get(row, "created_at") && !createdAt) warn(run, "created_at_unreadable");
      const closedAt = parseLocalDateTime(get(row, "closed_at"), null, tz, order);
      const apptRaw = get(row, "appt_date");
      const apptDate = apptRaw
        ? parseLocalDateTime(apptRaw, get(row, "appt_time") || null, tz, order)
        : null;
      if (apptRaw && !apptDate) warn(run, "appt_date_unreadable");

      const custom: Record<string, unknown> = {};
      for (const k of UTM_KEYS) {
        const v = get(row, k);
        if (!v) continue;
        const def = defs.get(k);
        if (!def) {
          warn(run, "utm_field_not_configured");
          continue;
        }
        const c = coerceCustomValue(def, v);
        if (c.ok && c.value !== null) custom[k] = c.value;
        else if (!c.ok) warn(run, "custom_value_invalid");
      }
      for (const [field] of Object.entries(h.index)) {
        if (!field.startsWith("custom.")) continue;
        const key = field.slice(7);
        const def = defs.get(key);
        const v = get(row, field);
        if (!def || !v) continue;
        const c = coerceCustomValue(def, v);
        if (c.ok && c.value !== null) custom[key] = c.value;
        else if (!c.ok) warn(run, "custom_value_invalid");
      }

      const source = get(row, "source").slice(0, 60) || null;
      if (source) sources.add(source);
      const title = (get(row, "title") || `Sanoflow enquiry ${ext}`).slice(0, 200);
      const values: Record<string, unknown> = {
        pipeline_id: pipelineId,
        stage_id: stageId,
        status,
        lost_reason:
          status === "lost" || status === "disqualified"
            ? mapLostReason(get(row, "lost_reason"), ctx.config)
            : null,
        contact_id: contact.kind === "match" ? contact.id : null,
        title,
        source,
        assignee_id: assigneeId,
        est_value: value ?? null,
        location_id: await lookup("locations", "location"),
        specialist_id: await lookup("specialists", "specialist"),
        service_id: await lookup("services", "service"),
        appt_date: apptDate ? apptDate.toISOString() : null,
        custom,
      };

      const ref = await ctx.ports.findRef("enquiry", ext);
      const current = ref ? await ctx.ports.getRow("enquiries", ref.localId) : null;
      if (current) {
        if (ctx.mode === "skip") {
          run.counters.unchanged++;
          continue;
        }
        const patch: Record<string, unknown> = {};
        for (const k of COMPARED) {
          // never drop a link Pulse made since: a blank in the export keeps what is there
          if (values[k] === null && (k === "contact_id" || k === "assignee_id")) continue;
          if (!sameValue(current[k], values[k])) patch[k] = values[k];
        }
        if ("custom" in patch)
          patch.custom = { ...((current.custom as Record<string, unknown>) ?? {}), ...custom };
        if (Object.keys(patch).length === 0) {
          run.counters.unchanged++;
          continue;
        }
        const res = await ctx.ports.updateRow("enquiries", current.id, patch);
        if (res.error) {
          run.counters.failed++;
          problem(run, line, res.error);
        } else run.counters.updated++;
        continue;
      }

      const insert: Record<string, unknown> = { ...values };
      if (createdAt) {
        insert.created_at = createdAt.toISOString();
        insert.stage_entered_at = createdAt.toISOString();
      }
      if (status !== "open") insert.closed_at = (closedAt ?? createdAt ?? ctx.now).toISOString();
      const res = await ctx.ports.insertRow("enquiries", insert);
      if ("error" in res) {
        run.counters.failed++;
        problem(run, line, res.error);
        continue;
      }
      run.counters.created++;
      await ctx.ports.upsertRef({
        entity: "enquiry",
        externalId: ext,
        localTable: "enquiries",
        localId: res.id,
      });
    }
  }

  // Sources seen in the export become pickable in Pulse (the list holds at most 50).
  if (sources.size) {
    const current = await ctx.ports.enquirySources();
    const have = new Set(current.map((s) => s.toLowerCase()));
    const add = [...sources].filter((s) => !have.has(s.toLowerCase()));
    if (add.length) {
      const next = [...current, ...add].slice(0, 50);
      if (next.length < current.length + add.length) warn(run, "sources_list_full");
      await ctx.ports.setEnquirySources(next);
      run.notes.push(
        `${Math.min(add.length, 50 - current.length)} new source value(s) added to Settings → Enquiries`,
      );
    }
  }
  return run;
}
