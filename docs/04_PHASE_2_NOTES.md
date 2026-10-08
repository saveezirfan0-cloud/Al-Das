# Phase 2 — Patient CRM, filters and data import: what was built and how to use it

## Scope delivered

- **Migration** `20261008000700_crm.sql`: `contacts` (E.164 phone, WhatsApp BSUID, Unite PIN in `external_id`, opt-in / stop-marketing, `custom` jsonb, soft delete + `merged_into_id`), `contact_phones`, `tags` + `contact_tags`, `custom_fields`, `segments` (static / dynamic) + `segment_members`, `timeline_events`, `user_grid_prefs`, `external_refs` (import dedupe map), `sync_reviews` (ambiguous matches), and a minimal `mentions` table (Phase 3 adds the message/conversation FKs). RLS on every table: `contacts.view` reads, `contacts.manage` writes, `settings.manage` for custom fields and import bookkeeping, own-rows-only for grid prefs and mentions. Same-org triggers on every child table. Unique per org: phone, BSUID, external id (partial, so soft-deleted rows free the identifier).
- **RPCs** (service role only): `contacts_search` / `contacts_count` / `contacts_ids` run a compiled WHERE fragment with values bound through one jsonb parameter; `merge_contacts` (transactional merge: fields, phones, tags, segments, timeline, refs; opt-outs always win); `contact_duplicate_candidates` (same email, same name + DOB, shared phone); `app.next_anniversary` for birthday filters.
- **`lib/filters`**: JSON AST (`include` group + optional `exclude` group, nested AND/OR, Zod-validated), a field registry (contact columns, `custom.<key>` fields, related-entity fields for tags / segments / mentions / alternate phones now and conversations / enquiries / appointments / campaigns / tasks once those tables exist — they are registered but hidden until then), a parameterised SQL compiler, an in-memory evaluator with identical semantics, and ORDER BY compilation. 78 unit tests plus a DB suite that runs 52 filters through Postgres and checks the compiler and evaluator agree.
- **`lib/contacts`**: phone normalisation (`971-5…`, `00971…`, `050…` → E.164), a CSV parser/serialiser, CSV → contact preparation (header auto-mapping, validation, in-file dedupe), custom-value coercion (blank never becomes 0 / false), merge resolution, export rows, built-in views, the query layer over the RPCs, and the shared import writer + matcher (Unite PIN → phone incl. alternates → name + DOB; several candidates → `sync_reviews`, never auto-merged).
- **Contacts screen** (`/contacts`): views rail (All, Last interacted < 7 / < 30 / > 30 days, Mentions, Duplicates), static and dynamic segments with counts; virtualised DataGrid (TanStack Table + Virtual) with sortable headers, resizable columns, a column chooser with ordering, and page size, all persisted per user in `user_grid_prefs`; search over name / phone / email / external id; a filter side panel with AND/OR groups, the exclusion-filters toggle, live match count and "Save as segment"; bulk bar (tags, static segments, owner / assignee, bulk edit incl. custom fields, delete, "select all N matching"); CSV import wizard (upload → map → review → chunked import, skip-or-update existing); CSV export (current view or all) through `POST /api/contacts/export` for members with `contacts.export`; merge dialog with per-field picks; a contact drawer with editable details, alternate phones (add / remove / make primary), opt-in flags, tags (creatable inline), custom fields, segments, and tabs Timeline (with notes) / Inbox / Enquiries / Appointments / Campaigns (the last four are placeholders until their phase). URL state: `?view=…&segment=…&contact=…&dupes=1`.
- **Settings → Custom fields** (admin): typed fields (text, number, date, yes/no, single / multi select, URL, email, phone), options, required flag, ordering. **Settings → Tags** (contacts.manage): names, colours, usage counts.
- **Importers** (`scripts/import-sanoflow.ts`, `scripts/import-airtable.ts`): see below. Both are idempotent via `external_refs`, support `--dry-run`, and write a markdown report with counts and ids only.
- **Tests**: 179 vitest tests in total (unit suites for filters, phone, CSV, import preparation, custom values, merge, mappers; DB suites for CRM RLS / RPCs, filter parity and the supabase-js paths), plus two Playwright smoke tests.

## Importers

```bash
# Sanoflow contact export
pnpm import:sanoflow --file=exports/contacts.csv --org=al-das --dry-run
pnpm import:sanoflow --file=exports/contacts.csv --org=al-das            # update existing by default
pnpm import:sanoflow --file=... --mode=skip --map=my-mapping.json        # never touch existing / custom header mapping

# Airtable patients (Unite base "Unite" table + Acute "Patients" table)
pnpm import:airtable --org=al-das --dry-run                               # counts + mapping coverage
pnpm import:airtable --org=al-das
pnpm import:airtable --only=app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB --since=2026-10-01T00:00:00Z
```

- Needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and (Airtable) `AIRTABLE_PAT` with `data.records:read` in `.env.local`.
- Mappers are keyed by **field ID** (`scripts/import/mappers/*`), pulled from the live schema on 8 Oct 2026. Formulas, lookups, rollups and record links are skipped; the coverage section of the report lists any data field a mapper does not read.
- Visit-derived values on the Unite table (first / last visit, doctor, clinic, department) are stored as **provisional custom fields** (`last_visit_date`, …) until Phase 6 imports visits; recall / campaign send-state flags (birthday message, chronic recall sent on, …) are kept on `external_refs.meta` for the Phase 8 recall engine.
- Acute "Is Test Record" rows are skipped unless `--include-test-records`; when imported they carry `custom.is_test_record = true`.
- Ambiguous matches land in `sync_reviews` (status `open`). A review screen arrives with Portal → Sync Review in Phase 6; until then resolve them in SQL or by merging the candidates in the Contacts → Duplicates view and re-running the import.

## Dev / test notes

- `pnpm db:reset` seeds 25 fake contacts, 4 tags, 5 custom fields, a static and a dynamic segment, a duplicate pair and a mention (all synthetic).
- `pnpm test:db` needs the `pgmq` SQL (see `supabase/test/README.md`); the `pgmq.control` stand-in is now committed.
- The supabase-js suite (`tests/db/supabase-js.test.ts`) runs only when `TEST_POSTGREST_URL` and `TEST_SERVICE_JWT` are set; `supabase/test/README.md` explains the PostgREST + `rest-proxy.mjs` setup.
- `scripts/run-job.ts` (Phase 1) used top-level `await`, which tsx rejects in this CommonJS package; it now runs inside `main()`.

## Demo checklist

- [ ] `/contacts` lists the seeded contacts; sort by Name / Created; resize a column, hide one in **Columns**, reload: the layout sticks.
- [ ] Views: _Last interacted < 7 days_ shows 6 rows, _> 30 days_ shows the stale ones, _Mentions_ shows Bilal.
- [ ] Filters: `Tags has any Dermatology` AND (`Gender is Female` OR `Nationality contains india`), exclusion `Stop marketing is yes` → count preview updates; **Save as segment** creates a dynamic segment with the same count in the rail.
- [ ] Select rows → bulk **Tags → add**, **Segments → add to "Call list"**, **Assign**, **Bulk edit** a custom field; counts refresh.
- [ ] Import the sample CSV twice: second run reports _updated/skipped_, never duplicates; a row with `12` as phone is listed as invalid.
- [ ] Export view → CSV opens in a spreadsheet; a cell starting with `=` is escaped. An Agent (no `contacts.export`) does not see the export buttons and gets 403 from the endpoint.
- [ ] Duplicates view shows the seeded "Amina Sample" pair; merge keeps the chosen values, the losing phone becomes an alternate, the merged record disappears from lists.
- [ ] Drawer: edit a field → Save → timeline shows the change; add a note; add / make-primary an alternate phone.
- [ ] Settings → Custom fields: add a select field; it appears in the drawer, the filter panel ("Custom fields" group), the column chooser and the import mapping.
- [ ] `pnpm import:sanoflow --file=<synthetic csv> --dry-run` prints counts and writes `docs/audit/import-report-sanoflow-*.md` without names or phones.

## Open questions / follow-ups

- Sanoflow's export header names were not available offline; `scripts/import/mappers/sanoflow.contacts.ts` guesses from common names and `--map` overrides them. Confirm with a real export before cut-over.
- `last_interaction_at` is only set by the seed until Phase 3 writes it from inbound/outbound messages.
- Mentions are recorded from Phase 3 (inbox comments); the table and the view are in place.
- Dynamic segment counts refresh on save, on the rail's refresh button and on bulk changes; a nightly recount job can be added to the housekeeping cron when campaigns need fresh numbers.
- Enquiry / appointment / campaign filter fields and drawer tabs light up automatically when their relations are added to `AVAILABLE_RELATIONS` in `lib/filters/field-registry.ts`.
