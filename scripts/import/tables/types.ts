import type { AirtableRecord } from "../airtable-client";

/** How one Airtable field becomes one column value. */
export type FieldSpec = {
  /** Airtable field id (fld…). */
  id: string;
  /** Target column. */
  column: string;
  /** Converter; receives the raw cell and a warning callback. Default: trimmed text or null. */
  convert?: (cell: unknown, warn: (code: string) => void) => unknown;
  /** The record is unusable (counted as invalid) when this converts to null. */
  required?: boolean;
};

/** A reference to another row, resolved after the target table was imported (pass 2). */
export type LinkSpec =
  | {
      kind: "record";
      /** Airtable field id of the multipleRecordLinks field. */
      fieldId: string;
      label: string;
      /** Mapper key of the table the links point at. */
      target: string;
      /** FK column set on this row from the first resolved link (omit for junction-style links). */
      column?: string;
      /** The record is unusable (counted as invalid) when no link target resolves. */
      required?: boolean;
    }
  | {
      kind: "lookup";
      /** Airtable field id holding the value to look up (select / text). */
      fieldId: string;
      label: string;
      column: string;
      table: string;
      matchColumn: string;
      /** The record is unusable (counted as invalid) when the value is blank or finds no row. */
      required?: boolean;
    };

export type TableMapper = {
  /** Stable key used by --only and dependsOn, e.g. "unite.diagnosis". */
  key: string;
  name: string;
  baseId: string;
  tableId: string;
  /** Local table rows are written to. */
  target: string;
  /**
   * ready   → written by a real run.
   * pending → mapped and validated by --dry-run only; a real run skips it and shows `pendingReason`.
   */
  status: "ready" | "pending";
  /** Why a pending table is not written yet (shown in the report and `--list`). */
  pendingReason?: string;
  fields: FieldSpec[];
  /** Field ids read inside `finalize` / `enrich` (so mapping coverage and schema checks see them). */
  extraFieldIds?: string[];
  /**
   * Rows are inserted once and never updated by a later run. For tables that staff work in Pulse
   * after cut-over (follow-ups, feedback, message log, prescriptions): a re-import must not
   * overwrite their work with the frozen Airtable copy.
   */
  createOnly?: boolean;
  /** Columns that identify a row independent of the Airtable id (adopt-on-match, secondary guard). */
  naturalKey: string[];
  links?: LinkSpec[];
  /** Columns that are only filled when blank on an existing row (merge sources such as CPT Master). */
  fillBlankOnly?: string[];
  /** Mapper keys that must run first. */
  dependsOn?: string[];
  /** Airtable checkbox that marks test rows; skipped unless --include-test-records. */
  testFlagFieldId?: string;
  /** Row-level adjustments after field conversion (derived columns, cross-field rules). */
  finalize?: (
    values: Record<string, unknown>,
    raw: Record<string, unknown>,
    warn: (c: string) => void,
    recordId: string,
    createdTime?: string,
  ) => void;
  /** Skip the record (counted as skipped) with a reason code; evaluated after `finalize`. */
  skip?: (values: Record<string, unknown>, raw: Record<string, unknown>) => string | null;
  /**
   * After links are resolved: derive values that need the database (dedupe keys from the linked
   * visit, medication class from the reference table). Never writes.
   */
  enrich?: (ctx: EnrichContext) => Promise<void>;
  /** Columns `enrich` sets (so the natural-key check knows they exist although `mapRecord` alone does not). */
  enrichedColumns?: string[];
  /**
   * Fields read only to find or derive other values (a PIN, a condition name, free text that is never stored). They are
   * mapped under these names and removed by `enrich` before the write, so the schema drift guard skips them.
   */
  helperColumns?: readonly string[];
  /** Replaces the generic writer (clinical_settings has sign-off rules). */
  writer?: "clinical_settings";
  /**
   * Junction table (Phase 21): one row per linked record of a multipleRecordLinks field instead of one row per
   * Airtable record (MRD → visit_diagnoses, patient → contact_chronic_conditions). Run by run-junction.ts.
   */
  junction?: JunctionSpec;
  /**
   * Appended to the entity ("<baseId>.<tableId>#<suffix>") so a junction mapper reading the same Airtable table
   * as another mapper keeps its own external_refs (external_id "<recordId>:<linkedRecordId>").
   */
  entitySuffix?: string;
};

export type JunctionSpec = {
  /** Mapper key whose external_refs resolve this Airtable record to the parent row, and the parent's table. */
  parent: { mapper: string; table: string };
  /** The link field: one junction row per linked record that resolves through `target`'s refs. */
  link: { fieldId: string; label: string; target: string; table: string };
  /** Optional second link field: records linked here mark the row (e.g. the primary diagnosis) and also count. */
  flagLink?: { fieldId: string; label: string };
  /** The column values to write, or a reason code to skip the pair (counted as skipped, reported). */
  build: (ctx: {
    parent: import("../store").StoreRow;
    child: import("../store").StoreRow;
    flagged: boolean;
  }) => Record<string, unknown> | string;
};

export type EnrichContext = {
  values: Record<string, unknown>;
  raw: Record<string, unknown>;
  recordId: string;
  /** Link field id → local ids the links resolved to (only fully/partially resolved ones). */
  resolved: Record<string, string[]>;
  store: import("../store").ImportStore;
  warn: (code: string) => void;
  /** The record is deliberately not imported (counted as skipped, reason code reported), e.g. its patient is not in Pulse. */
  skip: (reason: string) => void;
  /** The record cannot be imported (counted as invalid, reason code reported). */
  invalid: (reason: string) => void;
};

export type MappedRow = {
  recordId: string;
  values: Record<string, unknown>;
  /** Link field id → Airtable record ids. */
  links: Record<string, string[]>;
  /** Lookup field id → raw text to look up. */
  lookups: Record<string, string>;
  /** Link field id → local ids resolved by the runner (filled during link resolution). */
  resolved: Record<string, string[]>;
  warnings: string[];
  isTest: boolean;
  /** Set by `skip`: the record is deliberately not imported. */
  skipReason?: string;
  /** Set when the record cannot be imported (missing required value). */
  invalid?: string;
};

export type SourceRecord = Pick<AirtableRecord, "id" | "fields"> & { createdTime?: string };
