# Phase 20a: Sanoflow migration completeness (G1)

Read with `docs/20_SANOFLOW_REA_PARITY.md` (gap matrix) and `docs/21_SANOFLOW_PARITY_PROMPTS.md` (the prompt). Before this phase `pnpm import:sanoflow` imported contacts only. A cut-over would have lost open enquiries, future appointments, segments and the settings lists staff rely on.

## What exists

One command imports a folder of Sanoflow exports in dependency order:

```bash
pnpm import:sanoflow:all --dir=exports/ --org=al-das --dry-run            # always first
pnpm import:sanoflow:all --dir=exports/ --org=al-das                      # everything except appointments
pnpm import:sanoflow:all --dir=exports/ --org=al-das --with-appointments  # cut-over day only
#   --mode=skip   never change a row an earlier run created
#   --only=config,lists,contacts,segments,enquiries,activity,appointments
```

| Step | File(s) in `--dir` | Writes | Keyed in `external_refs` (source `sanoflow`) by |
|---|---|---|---|
| 1 config | `sanoflow-config.json` (hand-filled; example in `docs/audit/`) | pipelines, stages, enquiry custom fields (UTM fields included), extra enquiry sources | Sanoflow pipeline name; `pipeline::stage` name |
| 2 lists | `tags*.csv`, `labels*.csv`, `conversation-categories*.csv`, `quick-replies*.csv` | `tags` (scope contact / conversation), `conv_categories`, `quick_replies` (English + Arabic text) | Sanoflow id, or the lower-cased name |
| 3 contacts | `contacts*.csv` | contacts (unchanged logic, now `scripts/import/sanoflow/contacts.ts`) | Sanoflow contact id |
| 4 segments | `segment-<name>.csv` or `segments-static*.csv`; `segments-dynamic*.csv` | static segments and their members; dynamic segments are **listed in the report only** | segment id or name; `segment|contact` |
| 5 enquiries | `enquiries*.csv` (per pipeline and/or all; overlaps are de-duplicated) | `enquiries` with stage, status, lost reason, value, source, assignee by e-mail, location / specialist / service, appointment date, UTM and custom fields | Sanoflow enquiry id |
| 6 activity | `enquiry-activity*.csv` | `timeline_events` type `import.sanoflow_activity` on the enquiry and its patient, at the original time (shown as "Sanoflow history") | activity id, or a SHA-256 of (enquiry, time, kind, text) |
| 7 appointments | `appointments*.csv` | **future** appointments through `public.book_appointment` (advisory lock and overlap check), `source = 'import'`, `notify_early` off | Sanoflow appointment id |

The other hand-filled file is `sanoflow-names.json`, which maps Sanoflow location, specialist and service names to Pulse names. Lookups are case-insensitive and match the exact name otherwise. To override a step's header mapping, put a file named `<step>.map.json` next to the exports, containing `{ "CSV header": "field" | null }`.

Every run writes the following to `docs/audit/`, all counts only:

- `import-report-sanoflow-all-<ts>.md`: the run report.
- `import-summary-sanoflow-all-<ts>.json`: read by `pnpm reconcile`.
- `sanoflow-source-counts-<ts>.json`: distinct records per entity in the export folder.

Then:

```bash
pnpm reconcile --org al-das --sanoflow-counts latest --freeze-at <iso>   # (merge with --source-counts a.json,b.json for Airtable)
pnpm cutover:preflight --org al-das --stage pre-cutover
```

### Rules the code keeps

- **Sanoflow column names live only in `scripts/import/sanoflow/mapping.ts`.** The contact export keeps its own in `scripts/import/mappers/sanoflow.contacts.ts`. Unknown columns are never read. They are listed by header name in the report.
- **Nothing fires for history.** Enquiries are written directly with the service role, so no domain event, flow, notification or SLA timer starts. `sla_due_at` stays empty. Activity is "system" timeline entries.
- **Appointments**
  - Only future, non-cancelled visits are imported. Past visits come from Unite.
  - A live booking for the same patient, specialist and start time is **adopted**, not booked twice (for example, one the Unite sync already brought in).
  - A busy slot or an unknown patient goes to `sync_reviews` (source `sanoflow`). After a person books the visit by hand or fixes the contact, the next run adopts the booking and marks the review resolved.
  - A re-run never moves an appointment. A changed Sanoflow time is counted as the warning `time_changed_since_import`.
- **Re-runs are safe.** Enquiries and quick replies update only when their Sanoflow values changed. A blank assignee or contact in the export never removes a link Pulse made. With `--mode=skip`, nothing an earlier run created is changed. Nothing is ever deleted.
- **Reports hold counts, reason codes, line numbers, header names and unmatched reference names** (pipeline, stage, location, specialist, service, status). They never hold a patient name, phone, e-mail or message text, and `findPii` runs before a report is written.
- **Dry runs** wrap the same steps in `DryRunPorts`: writes go to an overlay, and reads still hit the database. Appointment clashes are predicted from a read-only overlap check, plus the bookings the run itself would make.

### Other changes

- Migration `20261020000100_sanoflow_import.sql`:
  - `appointments.source` allows `'import'`. The appointments list filter has an "Imported" option.
  - `reconcile_snapshot` adds `orphan_refs_other`: refs whose enquiry, appointment, segment, timeline entry or settings row is gone.
- `lib/migration/reconcile.ts`:
  - `ImportSummary.skippedByDesign`: past and cancelled appointments count as accounted for.
  - A warning check `orphan-refs-other`.
  - The "test skipped" column is relabelled "test / by-design skipped".
- `scripts/reconcile.ts`: `--sanoflow-counts <file|latest>`, and `--source-counts` takes several files.
- `lib/cutover/preflight.ts`: once Sanoflow contacts exist, warns until Sanoflow enquiries and future appointments have refs. Also warns on orphan refs.
- `scripts/import/store.ts` (`SupabaseStore`) and `tests/db/pg-store.ts` (`PgStore`) take the `external_refs.source` as a parameter (default `airtable`).
- `docs/audit/sanoflow-flow-inventory.md`: a template table to fill from the Sanoflow flow list.
- `tools/rea-sanoflow.mjs`: the local REA capture script (docs/20 §6). Hardened so its committed summary cannot carry live data.

## How it was verified

- `tests/unit/sanoflow-import.test.ts` (27 tests) uses synthetic CSVs and an in-memory store, with numbers only in the reserved `+44 7700 900xxx` range. It covers:
  - Date, time, money, status and shortcut parsing, including UTC+4.
  - Header priority, unknown and missing columns, custom-field matching and overrides.
  - Strict config validation and that the shipped examples are valid.
  - File discovery, and source counts with overlapping exports.
  - Each step's create / adopt / unchanged / update / skip paths.
  - Appointment past / cancelled / clash / unknown-patient routing, adopt-and-resolve, and a dry run that writes nothing.
  - That the report carries no values.
  - Reconcile accounting with by-design skips, and the preflight warnings.
- `tests/db/sanoflow-import.test.ts` (4 tests) runs against the real schema on plain Postgres. It covers:
  - Check constraints on enquiry status and reason, per-org enquiry numbering, and created dates that survive.
  - `book_appointment` with `source 'import'` and its overlap guard.
  - Reviews, segment counts, `reconcile_snapshot.orphan_refs_other`, and no rows in a second org.
  - It found a real bug: `locations` has no `department_id`, and the Supabase name lookup selected it. Fixed.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:db` all pass (see the pull request for counts).

## What was NOT verified

- **Real Sanoflow export files.** No export was available to this session, and none may enter the repo. The column aliases in `mapping.ts` come from Sanoflow's form field names and export screens (`docs/audit/sanoflow-surface.json`), not from a real CSV. Run with `--dry-run` first. If the report lists "Ignored columns" that hold data you need, add a `<step>.map.json` override, or add the alias to `mapping.ts`.
- **The Supabase/PostgREST ports themselves.** `SupabasePorts` was type-checked, and its SQL shapes are mirrored by the pg ports in the DB test, but it was not run through PostgREST. The supabase-js harness in `supabase/test/README.md` can do that.
- **The date format of the exports.** Day-first is assumed (`date_order: "dmy"`); set `"mdy"` if the exports differ. Times without an offset are read in the org's timezone.
- **Campaign report export:** not imported. Campaign history stays in Sanoflow's downloadable reports (see open questions).

## Open questions for you

1. **Reminders on cut-over day.** Imported appointments get Pulse reminders from the 5-minute sweep, like any booking. That is why `--with-appointments` is separate. Run it only after Sanoflow's own reminders are off, or patients get two. Is that the order you want, or should imported appointments skip the first reminder?
2. **Lost reasons.** Pulse stores free text, and Sanoflow has a pick-list. `lost_reasons` in the config renames them. Do you want a Pulse pick-list (a small G10 item), or is free text fine?
3. **Sync-review screen.** `Portal → Sync review` lists Unite reviews only. Sanoflow reviews (ambiguous contacts, appointment clashes) are settled by fixing the data and re-running. A review for a visit booked at a *different* time stays open and blocks `pnpm reconcile`. Should the screen also show Sanoflow reviews, with a "dismiss" action?
4. **Enquiry tags.** Pulse enquiries have no tags (only contacts and conversations do), so an enquiry export's tag column is ignored. Is that acceptable?
5. **Campaign history.** Should past campaign recipients and results come over? They are not needed to operate. Pulse's campaign tables expect Pulse templates.
6. **Flow inventory.** `docs/audit/sanoflow-flow-inventory.md` is ready for you to fill. Note G0: Pulse's CRM flow nodes are not wired yet (fix planned first in 20b).
