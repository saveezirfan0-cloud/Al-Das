import { textOrNull } from "../convert";
import type { MappedRow, SourceRecord, TableMapper } from "./types";

/** Pure: one Airtable record → column values, link ids and warnings. No I/O. */
export function mapRecord(mapper: TableMapper, record: SourceRecord): MappedRow {
  const warnings: string[] = [];
  const warn = (code: string) => warnings.push(code);
  const values: Record<string, unknown> = {};
  let invalid: string | undefined;

  for (const spec of mapper.fields) {
    const cell = record.fields[spec.id];
    const v = spec.convert ? spec.convert(cell, warn) : textOrNull(cell);
    values[spec.column] = v === undefined ? null : v;
    if (spec.required && (values[spec.column] === null || values[spec.column] === ""))
      invalid ??= `missing ${spec.column}`;
  }
  mapper.finalize?.(values, record.fields, warn, record.id);

  const links: Record<string, string[]> = {};
  const lookups: Record<string, string> = {};
  for (const link of mapper.links ?? []) {
    const cell = record.fields[link.fieldId];
    if (link.kind === "record") {
      const ids = Array.isArray(cell) ? cell.filter((x): x is string => typeof x === "string") : [];
      if (ids.length) links[link.fieldId] = ids;
    } else {
      const text = textOrNull(cell);
      if (text) lookups[link.fieldId] = text;
    }
  }

  return {
    recordId: record.id,
    values,
    links,
    lookups,
    warnings,
    isTest: !!mapper.testFlagFieldId && record.fields[mapper.testFlagFieldId] === true,
    invalid,
  };
}

/** Field ids the mapper reads, for the mapping-coverage report. */
export function mapperFieldIds(mapper: TableMapper): string[] {
  return [
    ...mapper.fields.map((f) => f.id),
    ...(mapper.links ?? []).map((l) => l.fieldId),
    ...(mapper.testFlagFieldId ? [mapper.testFlagFieldId] : []),
  ];
}

export function entityOf(m: { baseId: string; tableId: string }): string {
  return `${m.baseId}.${m.tableId}`;
}
