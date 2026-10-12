# Airtable → Supabase record import (spec for Claude Code)

`scripts/import-airtable.ts` was started in **Phase 2** (patients) and finished in **Phase 9** (every importable table; see `docs/06_PHASE_9_NOTES.md`). Layout: `scripts/import/registry.ts` (order, dependencies, skip reasons), `scripts/import/tables/*` (declarative field maps), `scripts/import/mappers/*` (patients), `run-table.ts` / `orchestrator.ts` / `store.ts` (runner, ordering, store + dry-run overlay), `report.ts`. Rules:

1. **Auth:** `AIRTABLE_PAT` with `schema.bases:read` + `data.records:read`, scoped to the 5 Al Das bases only. Store it in `.env.local`, never in git.
2. **Read:** paginate `GET https://api.airtable.com/v0/{baseId}/{tableId}?pageSize=100&returnFieldsByFieldId=true`. Respect 5 req/s per base (sleep ~220 ms, back off 30 s on 429).
3. **Mapping:** one mapper per table in `scripts/import/mappers/<base>.<table>.ts`, keyed by **field ID** (names change; IDs don't). Field-by-field targets are in `docs/audit/data-model-mapping.md`.
4. **Idempotency:** every row upserts through `external_refs(source='airtable', entity='<baseId>.<tableId>', external_id=<recId>)`. Re-runs update, never duplicate; an unchanged row is reported as *unchanged*, a row matched on its natural key is *adopted*.
5. **Links:** tables run in dependency order, so a link target already has its `external_refs` when the linking table runs; `multipleRecordLinks` and select lookups resolve through them. Unresolved links stay unset and go to the reconciliation report (record ids only).
6. **Patients:** match to existing contacts by Unite PIN → E.164 phone → name + DOB. Ambiguous matches go to the `sync_review` queue, never auto-merged.
7. **Parsing:** normalise phones (`971-5xxxxxxx` → `+9715xxxxxxx`) and split BP `"92/61"` into numbers. Blank stays NULL (never 0). Convert dates from Asia/Dubai to UTC.
8. **Skip:** formula / lookup / rollup / count fields. Recompute them as SQL views or generated columns.
9. **Test records:** keep `Is Test Record` as a boolean column. Exclude these from reports.
10. **Modes:**
    - `--dry-run` writes nothing (an overlay records what would be created and linked) and prints counts per table plus a mapping-coverage report (unmapped field IDs). Tables marked `pending` (recall, appointment messages — see `--list` for the reason) are read and validated in a dry run, skipped in a real run. The clinical tables (visits, prescriptions, follow-ups, feedback, message log, call scripts, doctors) are written for real: imported visits are `source=airtable` and never evaluated by the clinical engine; prescriptions/follow-ups/feedback/message log are create-only; medication class comes from `ref_medication_classes`; Airtable approvals are never imported. PTF and CFU prototype tables are skipped by design.
    - `--only=<key|baseId.tableId>[,…]` imports the named tables (`--list` shows the keys).
    - `--list` prints every table with its status.
    - `--since=<ISO>` does a delta import for the final pre-cut-over sync.
11. **Output:** `docs/audit/import-report-airtable-<timestamp>.md` (gitignored) with counts (Airtable vs Supabase), unmatched links, a PASS / FAIL verdict and review-queue size; exit code 2 on FAIL. **The report must never contain patient names or phones**; use IDs only.
12. **Never** write back to Airtable. **Never** log record contents.
