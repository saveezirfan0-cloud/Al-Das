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
    }
  | {
      kind: "lookup";
      /** Airtable field id holding the value to look up (select / text). */
      fieldId: string;
      label: string;
      column: string;
      table: string;
      matchColumn: string;
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
   * ready          → written by this phase.
   * pending_phase6 → mapped and validated (dry-run), but the target table is created in Phase 6
   *                  (supabase/drafts); a real run skips it and says so in the report.
   */
  status: "ready" | "pending_phase6";
  fields: FieldSpec[];
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
  ) => void;
  /** Replaces the generic writer (clinical_settings has sign-off rules). */
  writer?: "clinical_settings";
};

export type MappedRow = {
  recordId: string;
  values: Record<string, unknown>;
  /** Link field id → Airtable record ids. */
  links: Record<string, string[]>;
  /** Lookup field id → raw text to look up. */
  lookups: Record<string, string>;
  warnings: string[];
  isTest: boolean;
  /** Set when the record cannot be imported (missing required value). */
  invalid?: string;
};

export type SourceRecord = Pick<AirtableRecord, "id" | "fields">;
