/**
 * Cost inputs arrive as plain CSV that Finance fills in. All-or-nothing: one bad row rejects the file, so a half-loaded
 * cost table can never skew a profit figure. Header names are fixed and documented (docs/finance/cost-csv.md); an unknown
 * header is an error, never silently ignored. No patient data is expected in these files.
 */

export type CostKind = "services" | "compensation" | "overheads";

export type ServiceCostRow = {
  item_code: string;
  effective_from: string;
  unit_cost: number;
  note: string | null;
};
export type CompensationRow = {
  month: string;
  doctor_dha_id: string;
  amount: number;
  note: string | null;
};
export type OverheadCostRow = {
  month: string;
  branch_code: string | null;
  pool: string;
  amount: number;
  basis: "revenue" | "invoices" | "equal";
  note: string | null;
};

export type ParseResult<T> = { ok: true; rows: T[] } | { ok: false; errors: string[] };

export const MAX_COST_ROWS = 5000;

const HEADERS: Record<CostKind, { required: string[]; optional: string[] }> = {
  services: { required: ["item_code", "effective_from", "unit_cost"], optional: ["note"] },
  compensation: { required: ["month", "doctor_dha_id", "amount"], optional: ["note"] },
  overheads: { required: ["month", "pool", "amount"], optional: ["branch", "basis", "note"] },
};
export const COST_TEMPLATES: Record<CostKind, string> = {
  services: "item_code,effective_from,unit_cost,note\n",
  compensation: "month,doctor_dha_id,amount,note\n",
  overheads: "month,branch,pool,amount,basis,note\n",
};

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, and a leading BOM. */
export function readCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** "1,234.50" -> 1234.5; anything else (blank, text, negative, absurd) -> null. */
export function parseAmount(v: string): number | null {
  const t = v.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n < 1e12 ? n : null;
}

function realDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
export function parseDate(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  return m && realDate(+m[1], +m[2], +m[3]) ? v.trim() : null;
}
/** yyyy-mm or yyyy-mm-01 -> yyyy-mm-01; any other day of the month is refused. */
export function parseMonth(v: string): string | null {
  const t = v.trim();
  const a = /^(\d{4})-(\d{2})$/.exec(t);
  if (a && +a[2] >= 1 && +a[2] <= 12) return `${a[1]}-${a[2]}-01`;
  const b = /^(\d{4})-(\d{2})-01$/.exec(t);
  return b && +b[2] >= 1 && +b[2] <= 12 ? t : null;
}

function table(text: string, kind: CostKind): { rows: Record<string, string>[]; errors: string[] } {
  const raw = readCsv(text);
  const errors: string[] = [];
  if (raw.length === 0) return { rows: [], errors: ["The file is empty."] };
  const header = raw[0].map((h) => h.trim().toLowerCase());
  const spec = HEADERS[kind];
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const h of header)
    if (!allowed.has(h))
      errors.push(
        `Unknown column "${h}". Expected: ${[...spec.required, ...spec.optional].join(", ")}.`,
      );
  for (const h of spec.required) if (!header.includes(h)) errors.push(`Missing column "${h}".`);
  if (new Set(header).size !== header.length) errors.push("A column name appears twice.");
  if (errors.length) return { rows: [], errors };
  if (raw.length - 1 > MAX_COST_ROWS)
    return { rows: [], errors: [`Too many rows (the limit is ${MAX_COST_ROWS}).`] };
  const rows = raw
    .slice(1)
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()])));
  return { rows, errors };
}

const note = (v: string | undefined) => (v && v.trim() ? v.trim().slice(0, 300) : null);

export function parseServiceCosts(text: string): ParseResult<ServiceCostRow> {
  const t = table(text, "services");
  if (t.errors.length) return { ok: false, errors: t.errors };
  const errors: string[] = [];
  const seen = new Set<string>();
  const rows: ServiceCostRow[] = [];
  t.rows.forEach((r, i) => {
    const line = i + 2;
    const code = r.item_code.toUpperCase();
    const from = parseDate(r.effective_from);
    const cost = parseAmount(r.unit_cost);
    if (!code) errors.push(`Row ${line}: item_code is blank.`);
    if (!from) errors.push(`Row ${line}: effective_from must be a real date like 2026-01-01.`);
    if (cost === null) errors.push(`Row ${line}: unit_cost must be an amount like 12.50.`);
    else if (cost <= 0)
      errors.push(
        `Row ${line}: unit_cost must be above 0 (0 would mean "no cost known", leave the row out instead).`,
      );
    const key = `${code}|${from}`;
    if (seen.has(key)) errors.push(`Row ${line}: ${code} appears twice for ${from}.`);
    seen.add(key);
    if (code && from && cost !== null && cost > 0)
      rows.push({ item_code: code, effective_from: from, unit_cost: cost, note: note(r.note) });
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, rows };
}

export function parseCompensation(text: string): ParseResult<CompensationRow> {
  const t = table(text, "compensation");
  if (t.errors.length) return { ok: false, errors: t.errors };
  const errors: string[] = [];
  const seen = new Set<string>();
  const rows: CompensationRow[] = [];
  t.rows.forEach((r, i) => {
    const line = i + 2;
    const month = parseMonth(r.month);
    const amount = parseAmount(r.amount);
    const doctor = r.doctor_dha_id.toUpperCase();
    if (!month) errors.push(`Row ${line}: month must look like 2026-09 (first day of the month).`);
    if (!doctor) errors.push(`Row ${line}: doctor_dha_id is blank.`);
    if (amount === null) errors.push(`Row ${line}: amount must be an amount like 18000.00.`);
    const key = `${month}|${doctor}`;
    if (seen.has(key)) errors.push(`Row ${line}: ${doctor} appears twice for ${month}.`);
    seen.add(key);
    if (month && doctor && amount !== null)
      rows.push({ month, doctor_dha_id: doctor, amount, note: note(r.note) });
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, rows };
}

export function parseOverheads(text: string): ParseResult<OverheadCostRow> {
  const t = table(text, "overheads");
  if (t.errors.length) return { ok: false, errors: t.errors };
  const errors: string[] = [];
  const seen = new Set<string>();
  const rows: OverheadCostRow[] = [];
  t.rows.forEach((r, i) => {
    const line = i + 2;
    const month = parseMonth(r.month);
    const amount = parseAmount(r.amount);
    const pool = (r.pool ?? "").trim().slice(0, 80);
    const branch = (r.branch ?? "").trim().toUpperCase();
    const basis = (r.basis ?? "").trim().toLowerCase() || "revenue";
    if (!month) errors.push(`Row ${line}: month must look like 2026-09.`);
    if (!pool) errors.push(`Row ${line}: pool is blank (for example Rent or Utilities).`);
    if (amount === null) errors.push(`Row ${line}: amount must be an amount like 45000.00.`);
    if (branch && !/^[A-Z0-9]{1,4}$/.test(branch))
      errors.push(`Row ${line}: branch must be a branch code such as P, M or G (blank = shared).`);
    if (!["revenue", "invoices", "equal"].includes(basis))
      errors.push(`Row ${line}: basis must be revenue, invoices or equal.`);
    if (branch && r.basis)
      errors.push(`Row ${line}: a branch-specific row does not use a basis; leave basis blank.`);
    const key = `${month}|${branch}|${pool.toLowerCase()}`;
    if (seen.has(key))
      errors.push(
        `Row ${line}: "${pool}" appears twice for ${month}${branch ? ` and branch ${branch}` : ""}.`,
      );
    seen.add(key);
    if (month && pool && amount !== null && ["revenue", "invoices", "equal"].includes(basis))
      rows.push({
        month,
        branch_code: branch || null,
        pool,
        amount,
        basis: basis as OverheadCostRow["basis"],
        note: note(r.note),
      });
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, rows };
}
