/**
 * Portal object model. Column definitions live in code (lib/portal/objects/*) and are the single
 * source for the grid, filter registry, drawer, create/edit form and Zod validation. The
 * portal_objects table only says which objects are enabled per org and with which permissions.
 * Framework-free: shared by server, client and tests.
 */

export type PortalFieldType =
  | "text"
  | "long_text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "multi_select"
  | "url"
  | "email"
  | "link";

export type PortalOption = { value: string; label: string };

export type PortalColumn = {
  /** Column name in the backing table (snake_case, doubles as the field key). */
  key: string;
  label: string;
  type: PortalFieldType;
  /** Must be non-empty on create / edit. */
  required?: boolean;
  /** Shown but never written through the portal (ids, timestamps, import provenance). */
  readOnly?: boolean;
  /** Writable on create only (natural keys). */
  createOnly?: boolean;
  /** Hidden in the grid until the user shows it from the column chooser. */
  defaultHidden?: boolean;
  options?: PortalOption[];
  /** For type 'link': the portal object whose rows this column points at (uuid FK). */
  link?: { object: string };
  /** Integer-only numbers. */
  integer?: boolean;
  maxLength?: number;
  group?: string;
  description?: string;
};

export type PortalSort = { field: string; dir: "asc" | "desc" };

export type PortalObjectDef = {
  key: string;
  label: string;
  icon: string;
  description: string;
  /** Backing table in the public schema. */
  table: string;
  /** Column used as the record's display name (drawer title, link pickers). */
  titleColumn: string;
  /** '<baseId>.<tableId>' of the Airtable table this came from (provenance). */
  sourceAirtable: string | null;
  readPerm: string;
  /** null = not editable through the portal (importer / engine owned). */
  writePerm: string | null;
  sort: number;
  columns: PortalColumn[];
  defaultSort: PortalSort[];
  /** Text columns searched by the free-text box. */
  searchColumns: string[];
  /** Whether the portal may create / delete rows (config tables yes, engine-owned no). */
  allowCreate: boolean;
  allowDelete: boolean;
};

/** Columns every portal table carries; appended to each object's grid as read-only. */
export const SYSTEM_COLUMNS: PortalColumn[] = [
  { key: "created_at", label: "Created", type: "datetime", readOnly: true, defaultHidden: true },
  { key: "updated_at", label: "Updated", type: "datetime", readOnly: true, defaultHidden: true },
];

/** A row as returned by portal_search: column → value (jsonb). */
export type PortalRow = { id: string } & Record<string, unknown>;
