# Phase 9 — Back-office portal: what was built and how to use it

## Scope delivered

- **Migrations** (after Phase 6 / Finance / hardening, which landed on `main` first):
  - `20261010000400_portal_ref_tables.sql` — `ref_condition_groups`, `ref_diagnoses`, `ref_medications`, `ref_items` and `seed_condition_groups()`, promoted from draft `0100`. The helpers (`app.has_perm_wild`, `app.add_tenant_rls`), `clinical_settings` and `ref_medication_classes` already come from Phase 6 (`…0900`, `…0950`) and are not repeated.
  - `20261010000500_portal_framework.sql` — `portal_objects` (which objects an org exposes + their read/write permission keys), `saved_views` (private / shared with everyone or teams), `portal_record_events` (generic timeline), `portal_comments` (with mentioned users), `portal_attachments` + private bucket `portal-files`, `website_entry_points`, `app.portal_can_read()` (RLS for comments / timeline / files / views follows each object's own read key), `seed_portal_objects(org)`, and the service-role-only RPCs `portal_search` / `portal_count` / `portal_ids`. The table comes from `portal_objects` (org-scoped, name-validated, existence-checked) — never from the caller; the WHERE text is the same parameterised `lib/filters` output `contacts_search` uses and ORDER BY is allow-listed.
- **`lib/portal`** — object definitions in code (`objects/*`: typed columns, links, permissions, Airtable provenance; one file per group), `field-types.ts` (Zod per column type, blank → NULL, create-only and read-only columns, friendly DB errors), `filter-registry.ts` (column-backed `FieldRegistry`, so the existing compiler and `FilterPanel` work unchanged), `query.ts` (list / count / ids / rows), `service.ts` (**the only write path**: `can()` → Zod → write → audit → timeline event → `emit('portal.record_*')`; also the programmatic API the Phase 8 “Create/Update Portal Record” flow node will call), `export.ts`, `permissions.ts`, `server.ts` (bootstrap helpers, saved-view visibility).
- **Registered objects** (6): Diagnoses, Condition groups, Medications, Items & tests, Medication classes, Website entry points. **Clinical settings, the Follow-Up Queue and Sync Review are Phase 6's dedicated screens** and are not duplicated; `/portal` shows both kinds side by side. Medication classes read with the same `portal.clinical_visits.read` key its table's RLS uses and write with `portal.medication_classes.write`.
- **UI** (`/portal`, `/portal/[object]`): index of the objects you may read; per object the DataGrid (server-side paging and sort, column chooser, resize, reorder; layout saved per user as `portal_<object>`), search, the shared filter builder with live count, **saved views** (save current filters + sort + columns, update, share with everyone, delete own, `?view=` links), CSV export (view or all, visible columns, audited), “New” dialog (Zod errors per field), and the **record drawer**: typed fields with link pickers, linked-record panel, record info, Timeline (field-level diffs), Comments (`@` mentions → notifications, only members who can read the object), Files (signed upload, 25 MB, 5-minute signed download links).
- **Permissions** — `portal.<object>.read|write` per object (plus the existing `portal.*` and `portal.*.read`), `clinical.settings.manage` added to the catalogue. Roles can hold per-object keys (role editor lists them; the action accepts the pattern). Nav shows Portal only to members who can read at least one object.
- **Importer** (`pnpm import:airtable`): rewritten around a registry. See below.
- **Tests** — unit: portal object registry (incl. a check that `seed_portal_objects` matches the code registry), field types / Zod, filter registry + SQL compilation, permissions, CSV export, the service (fake client: denies without permission, validates, org-scoped, audit/event/emit, no-op update, delete limits, comments); importer: converters, every mapper (field ids checked against the committed schema exports), registry coverage of every audited table, orchestration, idempotency, dry-run overlay, sign-off rules, report content. DB (against plain Postgres): `portal-rls.test.ts` (17: wildcard permissions in SQL, tenant isolation on every new table, write limits, saved-view sharing, RPC safety) and `airtable-import.test.ts` (the importer against the real schema: dry run changes nothing, real run, idempotent re-run, cross-org isolation, sign-off protection). E2E: signed-out redirects for `/portal/*` and the export route.

## Importer

```bash
pnpm import:airtable --list                        # every table: ready / pending / skipped (+ reason)
pnpm import:airtable --dry-run --org=al-das        # map + resolve links for everything, write nothing
pnpm import:airtable --org=al-das                  # import every ready table, dependency order
pnpm import:airtable --only=unite.diagnosis,unite.items
pnpm import:airtable --since=2026-10-01T00:00:00Z  # delta (no full-table reconciliation)
```

- **Ready** (written now): Diagnosis, Medication, Items, CPT Master (merged into `ref_items`, fill-blank-only for description/type), Medication Reference, Settings, Website, and the two patient tables (Phase 2 logic, unchanged).
- **Clinical tables, written against the real Phase 6 schema** (follow-up to Phase 9): Doctors → `specialists`; Unite Medical Records → `visits`; Acute Visits (adopts the same rows, adds pap result / department); Acute Prescriptions → `prescriptions`; Acute Follow-Up Queue → `clinical_followups`; Acute Feedback → `clinical_feedback`; Acute Message Log → `clinical_message_log`; Acute `FU_*` Message Templates → `clinical_call_scripts`. Safety rules:
  - Imported visits are `source='airtable'`; **the clinical engine only evaluates `source='unite'` visits**, so Airtable history is never re-evaluated into new follow-ups.
  - Prescriptions, follow-ups, feedback and the message log are **create-only**: a later run never overwrites work staff did in Pulse.
  - Medication class always comes from `ref_medication_classes` by code (R-05); an unknown code is `unclassified` (fail closed), never Airtable's text.
  - Follow-ups are `source='airtable_acute'` with the engine's dedupe key `<visit external_id>-<category>`. Only rows still _pending_ (and not test) are imported **open**; everything else is closed with `closed_reason='airtable_history'`. Open imports are reported (`followup_imported_open`) so a human can review the queue.
  - Message-log rows are terminal history (`sent`/`delivered`/`cancelled`), never `scheduled`; test rows are `send_mode='test'`. Nothing in an import notifies anyone or schedules a send.
  - Call scripts: only `FU_*` templates; an Airtable “Approved” is not imported — scripts stay _awaiting_ until approved in Pulse (so they do not show in the follow-up drawer until then).
  - Select labels were inferred (the schema export has no choice labels): mappers match by meaning and an unrecognised value becomes null plus a warning code, never a guess.
- **Still pending** (validated by `--dry-run`, skipped by a real run with the reason shown): Appointment Messages (needs the appointments/reminders writer and safe-status rules), Birthday and Chronic Recall (need rewriting against `recall_programmes`/`recall_sends`), non-`FU_` WhatsApp templates (`wa_templates` lacks the clinical columns).
- **Skipped by design** (reason in the report): Test Plan, PTF Patients, Laboratory & Diagnostic Test, PTF Prescriptions / Feedback / WhatsApp log / Patient Visits and CFU Follow-Up Queue (prototype bases, confirmed mostly test data), the 7 PTF DRAFT tables. A test fails if an audited table is neither mapped nor listed here.
- **Idempotency** — every record gets `external_refs(source='airtable', entity='<base>.<table>', external_id=<recId>)`; a re-run finds the row, compares, and reports _unchanged_. A row that already exists under the table's natural key (e.g. an item imported from Unite and CPT Master) is _adopted_, not duplicated; two records mapping to one row count as _duplicates_. A blank source never erases an existing value.
- **Links** — tables run in dependency order, so link targets already have refs; a link that still does not resolve is left unset and reported with record ids (never guessed). Lookups (Diagnosis → condition group by name) work the same way.
- **Clinical settings are governed**: sign-off is a Pulse workflow (`clinical.settings.manage`, confirm phrase, history trigger), so the importer **never imports an approval** — an “Approved” status, approved value or signature in Airtable is ignored with a warning and the setting stays _awaiting_ until a clinical lead signs it in Pulse. Signed-off rows are never touched; unknown categories fail closed.
- **Reconciliation report** (`docs/audit/import-report-airtable-<ts>.md`, gitignored): overall PASS / PASS WITH WARNINGS / FAIL; per table Airtable read, importable, created / updated / unchanged / adopted, skipped, review, failed, `external_refs` after, rows after, the audit-time count from `counts.json`; unmatched links by label with record ids; mapper warnings; mapping coverage (unmapped non-computed field ids); failures by record id. Counts, ids and field ids only — no cell values. FAIL = failed writes, or fewer refs than importable records. The CLI exits 2 on FAIL.

## Local happy path

```bash
pnpm db:reset                      # migrations + seed (fake reference rows, a shared “Chronic only” view)
pnpm dev                           # sign in as admin@pulse.local → Portal → Diagnoses
pnpm import:airtable --list
pnpm import:airtable --dry-run     # needs AIRTABLE_PAT; nothing is written
pnpm test:db                       # RLS + importer-against-schema tests (supabase/test/README.md)
```

## Decisions and assumptions

- **Written before Phase 6 landed, then reconciled with it.** The first draft promoted drafts 0100/0101 itself; after merging Phase 6 those were removed. The clinical mappers were initially validated only against Airtable field ids and the draft SQL, which does not match the final Phase 6 columns; they were rewritten against the real tables and are now covered by `tests/db/airtable-import-clinical.test.ts` (schema-drift guard: every mapped column exists, every enum value is a real label; whole chain run, idempotent re-run, dry run, staff-work protection).
- **Column definitions live in code, not in `portal_objects.columns`.** One source of truth for grid, filters, drawer, form and Zod (and unit-testable); the table only says “enabled here, with these permission keys” (and carries per-org `config` for future overrides).
- **No change to `lib/filters/to-sql.ts`.** Portal registries are column-only, so the contacts compiler works as is (all portal tables have `created_at` for the default order).
- **Portal objects register themselves.** Orgs created through the onboarding RPC have no `portal_objects` rows; `ensurePortalObjects()` calls the idempotent `seed_portal_objects()` the first time an object is opened or the index is loaded (it never re-enables an object an admin turned off). Condition groups and clinical settings are seeded by the importer (`seed_condition_groups`, `seed_clinical_settings`), not on org creation.
- **Read = list + drawer + export.** There is no separate export permission for portal objects; exports are audited (`portal.exported`) and the data is reference/config, not patient data.
- **`pnpm reconcile` compatibility.** The importer writes `docs/audit/import-summary-airtable-<ts>.json` (Phase 11 contract). `unchanged` and `adopted` rows are folded into `updated` there so `created + updated + skipped + invalid + duplicates + review + failed = read`.
- **Patient re-runs report “updated”, not “unchanged”**: the Phase 2 contact writer re-applies values; it is idempotent but does not diff.
- **Not verified in a browser against a live Supabase session.** The Next build, typecheck, lint, unit, DB and signed-out e2e tests pass; the authenticated portal screens were not clicked through here (no Supabase Auth in the sandbox). Run the demo checklist once on a real stack.

## Demo checklist

- [ ] Sign in as the seeded admin → **Portal** lists 7 objects → open **Diagnoses**: 3 fake rows.
- [ ] Sort by Code; hide/show/reorder/resize columns; reload — the layout is remembered.
- [ ] Filters → _Chronic is yes_ shows a live count → Apply. Save as a view (shared) → leave the view → re-open it from **Views** and via the `?view=` URL.
- [ ] **Export view** downloads a CSV with the visible columns and link titles; `=` / `+` cells are neutralised.
- [ ] Open a row: change _Short description_, Save; Timeline shows the field diff; reload.
- [ ] Comment with a `@mention`; the mentioned colleague gets a notification; attach a file; download it; remove it.
- [ ] **Website entry points** → New with a missing Section shows the field error; create one; delete it.
- [ ] A role with only `portal.*.read` (Agent): rows open read-only, no New / Save / Delete, no sharing of views; Manager can edit but **cannot** edit Clinical settings; Admin can.
- [ ] Settings → Roles → a role can be given `portal.ref_items.read` only → Portal shows just _Items & tests_.
- [ ] `pnpm import:airtable --dry-run` produces a report with every table, `PENDING` rows validated, and no cell values.

## Open questions / follow-ups

- **OQ-46** (final permission catalogue) stays open; per-object keys are pattern-validated meanwhile.
- **OQ-47** is resolved for the portal by `app.has_perm_wild`. Phase 1's `app.has_perm` is unchanged; make it wildcard-aware if other modules need it.
- **OQ-49** (UAE residency) and **OQ-50** (`AIRTABLE_PAT`, Supabase project) gate any run against real data; this phase ships dry-run-verified tooling only.
- Condition-group informational columns (`follow_up_interval_days`, medication/lab examples) are not enriched from the Diagnosis rows yet; the groups come from `seed_condition_groups()`.
- **Future Unite visit sync:** imported `visits.external_id` holds the Airtable Medical Records record id, not the Unite visit id. The sync must adopt by contact + date (or map ids) before it is switched on, or duplicate visits appear.
- **Doctor names** match exact-case when adopting a specialist; make it case-insensitive before the Unite doctor sync runs.
- **Not imported on purpose:** `visit_rule_evaluations` (engine-owned), `prescription_sequences`, visit diagnosis/medication/item links (junction tables are drafts; `primary_diagnosis_code` is kept), doctor branch.
- **Next importer PRs:** recall (`chronic_recall`, `birthday`), appointment-message history (past appointments only, reminder status `sent`, OQ-23), `wa_templates` clinical columns.
- Portal bulk edit, per-object custom fields and tags are not built (tags/custom fields have contact/enquiry/appointment CHECK scopes).
