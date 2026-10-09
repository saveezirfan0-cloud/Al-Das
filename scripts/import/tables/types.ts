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
  /** Replaces the generic writer (clinical_settings has sign-off rules). */
  writer?: "clinical_settings";
};

export type EnrichContext = {
  values: Record<string, unknown>;
  raw: Record<string, unknown>;
  recordId: string;
  /** Link field id → local ids the links resolved to (only fully/partially resolved ones). */
  resolved: Record<string, string[]>;
  store: import("../store").ImportStore;
  warn: (code: string) => void;
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
