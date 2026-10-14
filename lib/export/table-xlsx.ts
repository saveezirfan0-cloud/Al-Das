/**
 * Lists as an .xlsx workbook (Phase G exports): per sheet a heading block (organisation, title, filters, when it was
 * built), one header row and plain-value cells. No formulas: a value that starts with "=" is stored as text, so nothing
 * typed into Pulse can run in a spreadsheet. Money columns get a number format; totals, when given, are Pulse's own.
 */

export type TableColumn = {
  header: string;
  width?: number;
  kind?: "text" | "money" | "number" | "date";
};

type Cell = string | number | null | undefined;

export type TableSheet = {
  sheet: string;
  title: string;
  /** Extra heading lines (the filters, "first 50,000 rows", a note). */
  lines?: readonly string[];
  columns: readonly TableColumn[];
  rows: ReadonlyArray<ReadonlyArray<Cell>>;
  /** A bold last row (labels and totals). */
  totals?: ReadonlyArray<Cell>;
};

export type TableWorkbookInput = TableSheet & { org: string; builtAt: string };

const MONEY = "#,##0.00;[Red](#,##0.00)";

/** Excel sheet names: at most 31 characters, none of []:*?/\ */
export function sheetName(s: string): string {
  return (
    s
      .replace(/[[\]:*?/\\]/g, " ")
      .trim()
      .slice(0, 31) || "Sheet1"
  );
}

/** A cell value as written: numbers stay numbers in number columns, everything else is text (never a formula). */
export function cellValue(v: Cell, kind: TableColumn["kind"]): string | number | null {
  if (v === null || v === undefined) return null;
  if (kind === "money" || kind === "number") {
    const n = typeof v === "number" ? v : Number(v);
    return v !== "" && Number.isFinite(n) ? n : String(v);
  }
  return typeof v === "number" ? v : String(v);
}

export async function tablesWorkbook(input: {
  org: string;
  builtAt: string;
  sheets: readonly TableSheet[];
}): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(input.builtAt);
  wb.creator = "Pulse";
  for (const s of input.sheets) {
    const ws = wb.addWorksheet(sheetName(s.sheet));
    ws.columns = s.columns.map((c) => ({
      width: c.width ?? (c.kind === "money" ? 16 : c.kind === "date" ? 12 : 22),
    }));
    ws.addRow([input.org]).font = { bold: true };
    ws.addRow([s.title]);
    for (const l of s.lines ?? []) ws.addRow([l]);
    ws.addRow([`Built ${input.builtAt.slice(0, 16).replace("T", " ")} UTC`]);
    ws.addRow([]);
    ws.addRow(s.columns.map((c) => c.header)).font = { bold: true };
    const add = (r: ReadonlyArray<Cell>) => {
      const row = ws.addRow(r.map((v, i) => cellValue(v, s.columns[i]?.kind)));
      s.columns.forEach((c, i) => {
        if (c.kind === "money") row.getCell(i + 1).numFmt = MONEY;
      });
      return row;
    };
    for (const r of s.rows) add(r);
    if (s.totals) add(s.totals).font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function tableWorkbook(input: TableWorkbookInput): Promise<Buffer> {
  const { org, builtAt, ...sheet } = input;
  return tablesWorkbook({ org, builtAt, sheets: [sheet] });
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A safe file name part: letters, digits, dashes. */
export function filePart(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "export"
  );
}

/** The response for a workbook download (never cached). */
export function xlsxResponseInit(filename: string): ResponseInit {
  return {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${filePart(filename.replace(/\.xlsx$/, ""))}.xlsx"`,
      "Cache-Control": "no-store",
    },
  };
}
