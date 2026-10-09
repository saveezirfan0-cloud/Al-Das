import { toCsv } from "@/lib/csv";
import type { ReportResult, TableColumn } from "@/lib/reports/types";

/**
 * CSV for a report's table. Machine-friendly: durations in seconds, percentages as 0-100, so a
 * spreadsheet can sort and sum them. lib/csv neutralises formula injection in text cells.
 */

function header(c: TableColumn): string {
  if (c.format === "duration") return `${c.label} (seconds)`;
  if (c.format === "percent") return `${c.label} (%)`;
  return c.label;
}

function cell(value: string | number | null, c: TableColumn): unknown {
  if (value === null || value === undefined) return "";
  if (c.format === "percent") return Math.round(Number(value) * 1000) / 10;
  return value;
}

export function reportToCsv(result: ReportResult): string {
  const cols = result.table.columns;
  return toCsv(
    cols.map(header),
    result.table.rows.map((row) => cols.map((c) => cell(row[c.key] ?? null, c))),
  );
}

export function reportFilename(key: string, fromDay: string, toDay: string): string {
  return `pulse-${key}-${fromDay}_${toDay}.csv`;
}
