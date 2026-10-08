# Airtable schema snapshots (Phase 0)

Schema-only exports of the five Al Das bases, taken on 8 Oct 2026 through the Airtable connector because `scripts/export-airtable-schema.ts` had not yet been run (no `AIRTABLE_PAT` in this environment). **No patient records were read or written.** The only record-level reads were four configuration tables with no patient data (Settings, Test Plan, Message Templates, Website) and the 30 Top-30 rows of the ICD-10 reference table; their content is reflected in `clinical-rules.md`, `data-model-mapping.md` and the draft seeds.

| File | Base | Notes |
|---|---|---|
| `app7QJ2pvhADHQeBP.schema.json` | Unite | Patient master, visits, ICD/medication/item references. Generated from the connector's full field config (formulas verbatim). |
| `appkOnjPr1SMD83CP.schema.json` | Campaigns - Message Log | Appointment / birthday / chronic recall logs, website routing map, plus the interface inventory. |
| `appH2jHpsNR1nqEQ2.schema.json` | Acute Clinical Follow-Up Automation | Clinical rules engine. All TRIGGER / category / date formulas verbatim. |
| `appVsJVw5jjj5YiMp.schema.json` | Clinical Follow-Up & Care Automation | Superseded prototype, one table. |
| `appZbwlQvkuaUsF2l.schema.json` | Patient Treatment & Follow-Up System | Older design + 7 DRAFT tables. |
| `counts.json` | — | Record counts for sizing the import. |

Shape per field: `id`, `name`, `type`, optional `description`, and type-specific detail (`formula` + `resultType`, `choices` (names only), `linkedTableId`, lookup/rollup source fields, number/date options). Select-choice IDs and colours are omitted; the importer works on field IDs and choice **names**.

Re-generate with the real export (field IDs are stable, so these files stay valid as a reference):

```
pnpm tsx scripts/export-airtable-schema.ts --counts
```

Never add record exports to this folder. `*records*` is gitignored.
