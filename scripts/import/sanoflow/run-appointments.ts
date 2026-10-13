/**
 * Step 6: FUTURE appointments only (past visits come from Unite). Each row is booked through
 * public.book_appointment, so the per-specialist advisory lock and the overlap check apply, with
 * source 'import' and notify_early off. Nothing is sent at import time.
 *
 * - A live appointment for the same patient, specialist and start (e.g. one the Unite sync already
 *   brought in) is adopted, never booked twice.
 * - A busy slot or an unknown patient goes to sync_reviews. A person books the visit by hand (or fixes
 *   the contact); the next run adopts that booking and marks the review resolved.
 * - A re-run never moves an appointment; a changed Sanoflow time is counted as a warning.
 *
 * Imported appointments are picked up by the reminder sweep like any other booking, so the real run
 * belongs on cut-over day, after Sanoflow's own reminders are switched off (the CLI enforces a flag).
 */
import type { ParsedCsv } from "@/lib/csv";

import { cell, mapHeaders } from "./mapping";
import { RefResolver } from "./refs";
import {
  newRun,
  problem,
  resolveContact,
  unmatchedName,
  warn,
  type EntityRun,
  type RunContext,
} from "./run";
import { mapAppointmentStatus, parseDurationMin, parseLocalDateTime } from "./values";

const DEFAULT_DURATION_MIN = 30;

export async function runAppointments(
  ctx: RunContext,
  files: Array<{ file: string; csv: ParsedCsv }>,
  override?: Record<string, string | null>,
): Promise<EntityRun> {
  const run = newRun(
    "appointment",
    "Future appointments",
    files.map((f) => f.file).join(", ") || null,
  );
  run.skippedByDesign = true;
  const refs = new RefResolver(ctx);
  const seen = new Set<string>();
  let line = 0;

  for (const { file, csv } of files) {
    const h = mapHeaders("appointment", csv.headers, { override });
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
        run.counters.duplicates++;
        continue;
      }
      seen.add(ext);

      const dateRaw = get(row, "date");
      const startRaw = get(row, "start");
      // "date" may carry the time too; "start" may be a full date-time on its own.
      const startsAt = dateRaw
        ? parseLocalDateTime(dateRaw, startRaw || null, ctx.timezone, ctx.config.date_order)
        : parseLocalDateTime(startRaw, null, ctx.timezone, ctx.config.date_order);
      if (!startsAt) {
        run.counters.invalid++;
        problem(run, line, "start_unreadable");
        continue;
      }
      if (startsAt.getTime() <= ctx.now.getTime()) {
        run.counters.skipped++; // past visits come from Unite
        warn(run, "skipped_past");
        continue;
      }
      const decision = mapAppointmentStatus(get(row, "status"));
      if (decision === null) {
        run.counters.invalid++;
        problem(run, line, "unknown_status");
        unmatchedName(run, "status", get(row, "status"));
        continue;
      }
      if (decision === "skip_cancelled" || decision === "skip_done") {
        run.counters.skipped++;
        warn(
          run,
          decision === "skip_cancelled" ? "skipped_cancelled" : "skipped_completed_in_future",
        );
        continue;
      }

      const location = await refs.get("locations", get(row, "location"));
      const specialist = await refs.get("specialists", get(row, "specialist"));
      const serviceRaw = get(row, "service");
      const service = serviceRaw ? await refs.get("services", serviceRaw) : null;
      if (!location || !specialist) {
        run.counters.invalid++;
        problem(run, line, !location ? "unknown_location" : "unknown_specialist");
        if (!location) unmatchedName(run, "location", get(row, "location"));
        if (!specialist) unmatchedName(run, "specialist", get(row, "specialist"));
        continue;
      }
      if (serviceRaw && !service) {
        warn(run, "service_not_found");
        unmatchedName(run, "service", serviceRaw);
      }

      let endsAt: Date | null = null;
      const endRaw = get(row, "end");
      if (endRaw) {
        endsAt = dateRaw
          ? parseLocalDateTime(dateRaw, endRaw, ctx.timezone, ctx.config.date_order)
          : parseLocalDateTime(endRaw, null, ctx.timezone, ctx.config.date_order);
        if (!endsAt) warn(run, "end_unreadable");
      }
      if (!endsAt || endsAt <= startsAt) {
        const minutes =
          parseDurationMin(get(row, "duration")) ?? service?.duration_min ?? DEFAULT_DURATION_MIN;
        endsAt = new Date(startsAt.getTime() + minutes * 60_000);
      }

      const ref = await ctx.ports.findRef("appointment", ext);
      const current = ref ? await ctx.ports.getRow("appointments", ref.localId) : null;
      if (current) {
        if (Date.parse(String(current.starts_at)) !== startsAt.getTime())
          warn(run, "time_changed_since_import");
        run.counters.unchanged++;
        continue;
      }

      const contact = await resolveContact(ctx.ports, get(row, "contact_id"), get(row, "phone"));
      if (contact.kind !== "match") {
        run.counters.review++;
        problem(run, line, contact.kind === "none" ? "contact_not_found" : "contact_ambiguous");
        await ctx.ports.queueReview({
          entity: "appointment",
          externalId: ext,
          reason: contact.kind === "none" ? "appointment_contact_not_found" : "multiple_matches",
          candidates: contact.kind === "ambiguous" ? contact.candidates : [],
        });
        continue;
      }

      const startIso = startsAt.toISOString();
      const existing = await ctx.ports.findAppointment({
        contactId: contact.id,
        specialistId: specialist.id,
        startsAt: startIso,
      });
      if (existing) {
        run.counters.adopted++;
        await ctx.ports.upsertRef({
          entity: "appointment",
          externalId: ext,
          localTable: "appointments",
          localId: existing,
        });
        await ctx.ports.resolveReview("appointment", ext);
        continue;
      }

      const notes = get(row, "notes");
      const res = await ctx.ports.bookAppointment({
        contactId: contact.id,
        locationId: location.id,
        specialistId: specialist.id,
        serviceId: service?.id ?? null,
        departmentId: service?.department_id ?? specialist.department_id ?? null,
        startsAt: startIso,
        endsAt: endsAt.toISOString(),
        status: decision,
        notes: notes ? notes.slice(0, 2000) : null,
      });
      if ("error" in res) {
        if (res.error === "slot_taken") {
          run.counters.review++;
          problem(run, line, "slot_taken");
          await ctx.ports.queueReview({
            entity: "appointment",
            externalId: ext,
            reason: "appointment_slot_taken",
          });
        } else {
          run.counters.failed++;
          problem(run, line, res.error);
        }
        continue;
      }
      run.counters.created++;
      await ctx.ports.upsertRef({
        entity: "appointment",
        externalId: ext,
        localTable: "appointments",
        localId: res.id,
      });
      await ctx.ports.resolveReview("appointment", ext);
    }
  }
  return run;
}
