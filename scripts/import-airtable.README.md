# Airtable → Supabase record import (spec for Claude Code)

Build `scripts/import-airtable.ts` in **Phase 2** (patients + reference tables) and finish it in **Phase 9** (portal objects). Rules:

1. **Auth:** `AIRTABLE_PAT` with `schema.bases:read` + `data.records:read`, scoped to the 5 Al Das bases only. Store it in `.env.local`, never in git.
2. **Read:** paginate `GET https://api.airtable.com/v0/{baseId}/{tableId}?pageSize=100&returnFieldsByFieldId=true`. Respect 5 req/s per base (sleep ~220 ms, back off 30 s on 429).
3. **Mapping:** one mapper per table in `scripts/import/mappers/<base>.<table>.ts`, keyed by **field ID** (names change; IDs don't). Mapping targets are listed in `docs/audit/airtable-schema.md §5`.
4. **Idempotency:** every row upserts through `external_refs(source='airtable', entity='<baseId>.<tableId>', external_id=<recId>)`. Re-runs update, never duplicate.
5. **Links:** two passes. Pass 1 creates rows; pass 2 resolves `multipleRecordLinks` via `external_refs`. Unresolved links go to the reconciliation report.
6. **Patients:** match to existing contacts by Unite PIN → E.164 phone → name + DOB. Ambiguous matches go to the `sync_review` queue, never auto-merged.
7. **Parsing:** normalise phones (`971-5xxxxxxx` → `+9715xxxxxxx`) and split BP `"92/61"` into numbers. Blank stays NULL (never 0). Convert dates from Asia/Dubai to UTC.
8. **Skip:** formula / lookup / rollup / count fields. Recompute them as SQL views or generated columns.
9. **Test records:** keep `Is Test Record` as a boolean column. Exclude these from reports.
10. **Modes:**
    - `--dry-run` writes nothing and prints counts per table plus a mapping-coverage report (unmapped field IDs).
    - `--only=<baseId>.<tableId>` imports a single table.
    - `--since=<ISO>` does a delta import for the final pre-cut-over sync.
11. **Output:** `docs/audit/import-report-<timestamp>.md` with counts (Airtable vs Supabase), unmatched links and review-queue size. **The report must never contain patient names or phones**; use IDs only.
12. **Never** write back to Airtable. **Never** log record contents.
