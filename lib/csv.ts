/**
 * Small RFC 4180 CSV parser/serialiser (quotes, embedded newlines, CRLF, BOM).
 * Framework-free. Used by the contact importer/exporter and the import scripts.
 */

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
};

export function parseCsv(text: string, delimiter = ","): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
  };

  while (i < n) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Last record (no trailing newline)
  if (field !== "" || row.length > 0) endRow();

  // Drop fully empty trailing rows
  while (records.length && records[records.length - 1].every((c) => c.trim() === "")) records.pop();

  const headers = (records.shift() ?? []).map((h) => h.trim());
  return { headers, rows: records };
}

/** Rows as objects keyed by header; missing cells become "". */
export function csvToObjects(csv: ParsedCsv): Array<Record<string, string>> {
  return csv.rows.map((r) => {
    const o: Record<string, string> = {};
    csv.headers.forEach((h, i) => {
      o[h] = r[i] ?? "";
    });
    return o;
  });
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s =
    typeof value === "string" ? value : Array.isArray(value) ? value.join("; ") : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
