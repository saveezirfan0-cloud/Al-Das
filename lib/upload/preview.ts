/**
 * The one upload component's rules (Phase G, pure; components/shell/file-upload.tsx shows them). Two halves:
 *
 * - In the browser, before anything is sent: is this file of an allowed type and size (`fileProblem`)?
 * - On the server, after the import's own reader turned the file into rows: a preview (`buildUploadPreview`) of the
 *   header row and the first data rows of the MAPPED columns only, the names of columns the layout does not map (they
 *   will be ignored; their values are never read or shown), and the mapped columns the file is missing.
 *
 * Nothing here stores or logs a value. The import itself still runs through its own parser, mapping and the
 * delete-original-at-once rule; the preview only tells the person what will be read before they confirm.
 */

export type UploadLimits = {
  /** Lower-case extensions with the dot, e.g. [".csv", ".xlsx"]. */
  extensions: readonly string[];
  maxBytes: number;
};

/**
 * The generic finance import engine's limits (bank, settlement, lab and provider files): the same as MAX_IMPORT_BYTES in
 * lib/finance/parse-import.ts, which the server checks again (a test keeps them equal).
 */
export const FINANCE_IMPORT_LIMITS: UploadLimits = {
  extensions: [".csv", ".xlsx"],
  maxBytes: 5 * 1024 * 1024,
};

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Why this file cannot be used, or null. The file name is only looked at for its extension. */
export function fileProblem(
  file: { name: string; size: number },
  limits: UploadLimits,
): string | null {
  const ext = /\.[A-Za-z0-9]+$/.exec(file.name)?.[0]?.toLowerCase() ?? "";
  if (!limits.extensions.includes(ext))
    return `Choose a ${limits.extensions.join(" or ")} file.`;
  if (file.size === 0) return "That file is empty.";
  if (file.size > limits.maxBytes)
    return `That file is ${formatSize(file.size)}; the limit is ${formatSize(limits.maxBytes)}.`;
  return null;
}

/** A column the import reads: the field it fills, its label, and the header the layout maps to it. */
export type WantedColumn = { field: string; label: string; header: string };

export type UploadPreview = {
  /** 1-based row of the header in the file, or null when no row holds any mapped header. */
  headerRow: number | null;
  /** The mapped columns found, in file order. */
  columns: Array<{ field: string; label: string; header: string }>;
  /** The first data rows, mapped columns only, as text. */
  rows: string[][];
  /** Header names in the file that the layout does not map (ignored by the import). Names only. */
  unknown: string[];
  /** How many more unknown columns there are beyond the list. */
  unknownMore: number;
  /** Mapped headers the file does not have, as "header (label)". */
  missing: string[];
  /** Non-blank rows below the header. */
  dataRows: number;
};

export const PREVIEW_ROWS = 5;
const HEADER_SCAN_ROWS = 30;
const MAX_UNKNOWN = 30;
const MAX_NAME = 60;
const MAX_CELL = 80;

const defaultKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v);
};

const isBlankRow = (r: ReadonlyArray<unknown> | undefined) =>
  !r || r.every((c) => cellText(c).trim() === "");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The preview of a table read from an uploaded file. The header row is found the way the importers find it: the row
 * among the first 30 holding the most mapped headers. `format` turns a mapped cell into display text (the importer's own
 * cleaning, e.g. redacting statement text); unknown columns never reach it.
 */
export function buildUploadPreview(
  table: ReadonlyArray<ReadonlyArray<unknown>>,
  wanted: readonly WantedColumn[],
  opts: {
    maxRows?: number;
    key?: (s: string) => string;
    format?: (field: string, value: unknown) => string;
  } = {},
): UploadPreview {
  const key = opts.key ?? defaultKey;
  const maxRows = opts.maxRows ?? PREVIEW_ROWS;
  const wantedKeys = wanted.map((w) => ({ ...w, k: key(w.header) }));
  let best = { row: -1, found: 0 };
  for (let r = 0; r < Math.min(table.length, HEADER_SCAN_ROWS); r++) {
    const keys = new Set((table[r] ?? []).map((c) => key(cellText(c))));
    const found = wantedKeys.filter((w) => keys.has(w.k)).length;
    if (found > best.found) best = { row: r, found };
    if (found === wantedKeys.length && found > 0) break;
  }
  if (best.row < 0)
    return {
      headerRow: null,
      columns: [],
      rows: [],
      unknown: [],
      unknownMore: 0,
      missing: wanted.map((w) => `${w.header} (${w.label})`),
      dataRows: 0,
    };

  const header = (table[best.row] ?? []).map((c) => cellText(c).trim());
  const headerKeys = header.map((h) => key(h));
  const columns = wantedKeys
    .map((w) => ({ w, idx: headerKeys.indexOf(w.k) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);
  const missing = wantedKeys
    .filter((w) => !headerKeys.includes(w.k))
    .map((w) => `${w.header} (${w.label})`);
  const known = new Set(wantedKeys.map((w) => w.k));
  const unknownAll: string[] = [];
  for (let i = 0; i < header.length; i++) {
    if (!header[i] || known.has(headerKeys[i])) continue;
    const name = clip(header[i].replace(/\s+/g, " "), MAX_NAME);
    if (!unknownAll.includes(name)) unknownAll.push(name);
  }
  const body = table.slice(best.row + 1).filter((r) => !isBlankRow(r));
  const format = opts.format ?? ((_f: string, v: unknown) => cellText(v));
  return {
    headerRow: best.row + 1,
    columns: columns.map(({ w }) => ({ field: w.field, label: w.label, header: w.header })),
    rows: body
      .slice(0, maxRows)
      .map((r) => columns.map(({ w, idx }) => clip(format(w.field, r[idx]).trim(), MAX_CELL))),
    unknown: unknownAll.slice(0, MAX_UNKNOWN),
    unknownMore: Math.max(0, unknownAll.length - MAX_UNKNOWN),
    missing,
    dataRows: body.length,
  };
}
