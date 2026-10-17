/**
 * The entities a Sanoflow import reports. `EntityRun.entity` is the name on the status page and in `import_runs`; the
 * ones in SANOFLOW_REF_ENTITIES are also `external_refs.entity` (source 'sanoflow'), which is how the migration status
 * page counts linked records. tests/unit/migration-registry-tie.test.ts ties these lists to the importer's sources and to
 * lib/migration/status.ts, so a new step cannot be added in one place and forgotten in the other.
 */
export const SANOFLOW_REF_ENTITIES = [
  "contact",
  "tag",
  "label",
  "conv_category",
  "quick_reply",
  "segment",
  "segment_member",
  "pipeline",
  "stage",
  "enquiry",
  "enquiry_activity",
  "campaign",
  "campaign_recipient",
  "appointment",
] as const;

/** Steps that link no records (settings, report-only): their evidence is the run itself. */
export const SANOFLOW_RUN_ONLY_ENTITIES = [
  "enquiry_field",
  "enquiry_source",
  "lost_reason",
  "segment_dynamic",
] as const;

export const SANOFLOW_RUN_ENTITIES = [
  ...SANOFLOW_REF_ENTITIES,
  ...SANOFLOW_RUN_ONLY_ENTITIES,
] as const;
