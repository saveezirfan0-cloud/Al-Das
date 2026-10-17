# Phase P0 notes: migration control centre

`/settings/migration` (`settings.manage`) is a read-only list of every Airtable table and Make scenario with its Pulse
equivalent, a state and a link. No new tables, no migration, no mutation.

- **Registry and rules:** `lib/migration/status.ts` (static registry from `docs/audit`, `deriveState`, `detailFor`);
  tests in `tests/unit/migration-status.test.ts`. To add a row, add an entry; its evidence is one of `refs`
  (Airtable `<base>.<table>[#suffix]` entity, same string the importer writes to `external_refs`), `scenario`
  (a `parallel_run_scenarios.scenario_key`), `programmes` (recall programme keys) or `none`.
- **Loader:** `lib/migration/status-server.ts`, service role after `requirePerm`. Reads `reconcile_snapshot` (the
  `external_refs` counts per entity), `parallel_run_scenarios` flags, `parallel_run_diffs` head counts of unexplained
  rows and `recall_programmes.status`. Counts and flags only; nothing is logged.
- **States, fail closed:** no facts means Not started. Imported needs linked records. For a Make scenario: Native needs
  `native_built`; Parallel run adds `parallel_started_on`; Retired needs `make_off`, `diffs_explained` and no unexplained
  differences. A screening group is Native only when every programme in it is `active`. Rows with no evidence source
  (labs, dropped scenarios, prototype tables) stay Not started with a note saying why.
- **Follow-up 17 Oct 2026:** Sanoflow, a real "last import" (`import_runs`), a registry tie test and the message-log importers are done, see `docs/45_PHASE_P_FOLLOWUP_NOTES.md`.
- **Was not covered:** the importers' dry-run reports are files, not tables, so "last import" means rows actually linked.
  Sanoflow tables are out of scope here (their own import notes: `docs/22_PHASE_20A_NOTES.md`).
