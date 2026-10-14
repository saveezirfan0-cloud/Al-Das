import { toWinAnsi } from "@/lib/finance/close-pdf";
import {
  formatValue,
  type ColumnFormat,
  type ReportDoc,
  type ReportTable,
} from "@/lib/accounting/statements/report";

/**
 * Excel (exceljs) and PDF (pdf-lib) from the same ReportDoc the page shows. Every Excel cell is a plain value (no
 * formulas), so nothing typed into Pulse runs in a spreadsheet and the totals are Pulse's own. The PDF uses the built-in
 * Helvetica (Latin only; other characters become "?", the workbook keeps the exact text). The Provisional and
 * working-paper labels are printed at the top of both.
 */

const MONEY = "#,##0.00;[Red](#,##0.00)";

export type ExportMeta = { org: string; builtAt: string };

function banner(doc: ReportDoc): string[] {
  const out: string[] = [];
  if (doc.provisional)
    out.push("PROVISIONAL: a period in this range is not closed yet; figures can still change.");
  if (doc.workingPaper) out.push(doc.workingPaper);
  return out;
}

const fmtOf = (t: ReportTable, i: number, rowFormat?: ColumnFormat): ColumnFormat =>
  rowFormat ?? t.formats?.[i] ?? "money";

export async function reportWorkbook(doc: ReportDoc, meta: ExportMeta): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(meta.builtAt);
  wb.creator = "Pulse";
  const used = new Set<string>();
  const sheetName = (t: ReportTable, i: number) => {
    const base = (t.title ?? (i === 0 ? doc.title : `Table ${i + 1}`))
      .replace(/[[\]*?/\\:]/g, " ")
      .slice(0, 28);
    let n = base;
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base.slice(0, 25)} ${k}`;
    used.add(n.toLowerCase());
    return n;
  };
  doc.tables.forEach((t, ti) => {
    const ws = wb.addWorksheet(sheetName(t, ti));
    ws.getColumn(1).width = 12;
    ws.getColumn(2).width = 52;
    for (let c = 0; c < t.columns.length; c++) ws.getColumn(c + 3).width = 18;
    ws.addRow([meta.org]).font = { bold: true };
    ws.addRow([doc.title]).font = { bold: true, size: 13 };
    ws.addRow([doc.subtitle]);
    for (const b of banner(doc)) ws.addRow([b]).font = { bold: true, color: { argb: "FFB45309" } };
    ws.addRow([`Built ${meta.builtAt.slice(0, 16).replace("T", " ")} UTC`]);
    if (t.title) ws.addRow([t.title]).font = { bold: true };
    ws.addRow([]);
    ws.addRow(["Code", t.labelHeader ?? "", ...t.columns]).font = { bold: true };
    if (t.rows.length === 0 && t.empty) ws.addRow(["", t.empty]);
    for (const r of t.rows) {
      const row = ws.addRow([
        r.code ?? "",
        `${"  ".repeat(r.depth)}${r.label}`,
        ...r.values.map((v, i) => {
          const f = fmtOf(t, i, r.format);
          if (v === null || v === undefined) return null;
          if (typeof v === "number" && f === "percent") return v / 100;
          return v;
        }),
      ]);
      if (r.kind !== "ledger" && r.kind !== "note") row.font = { bold: true };
      r.values.forEach((v, i) => {
        if (typeof v !== "number") return;
        const f = fmtOf(t, i, r.format);
        const cell = row.getCell(i + 3);
        cell.numFmt =
          f === "percent" ? "0.0%" : f === "number" ? "#,##0" : f === "ratio" ? "0.00" : MONEY;
      });
      if (r.flag)
        row.getCell(2).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: r.flag === "adverse" ? "FFFDE2E2" : "FFFEF3C7" },
        };
    }
    if (ti === doc.tables.length - 1 && doc.notes.length) {
      ws.addRow([]);
      for (const n of doc.notes) ws.addRow(["", n]);
    }
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function reportPdf(doc: ReportDoc, meta: ExportMeta): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const when = new Date(meta.builtAt);
  pdf.setTitle(toWinAnsi(`${meta.org} ${doc.title}`));
  pdf.setCreator("Pulse");
  pdf.setProducer("Pulse");
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const tables = doc.tables.filter((t) => t.pdf !== false);
  const maxCols = Math.max(1, ...tables.map((t) => t.columns.length));
  const landscape = maxCols > 3;
  const W = landscape ? 841.89 : 595.28;
  const H = landscape ? 595.28 : 841.89;
  const M = 36;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.1, 0.1);
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const need = (h: number) => {
    if (y - h < M + 20) newPage();
  };
  const widthOf = (s: string, size: number, f = font) => f.widthOfTextAtSize(toWinAnsi(s), size);
  const fit = (s: string, max: number, size: number, f = font) => {
    let t = toWinAnsi(s);
    while (t.length > 1 && widthOf(t, size, f) > max) t = `${t.slice(0, -2)}~`;
    return t;
  };
  const para = (s: string, size = 9, f = font, color = ink) => {
    const maxW = W - 2 * M;
    let line = "";
    const flush = () => {
      need(size + 4);
      page.drawText(line, { x: M, y, size, font: f, color });
      y -= size + 3;
    };
    for (const word of toWinAnsi(s).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, f) > maxW && line) {
        flush();
        line = word;
      } else line = next;
    }
    if (line) flush();
  };

  page.drawText(toWinAnsi(meta.org), { x: M, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
  y -= 20;
  page.drawText(toWinAnsi(doc.title), { x: M, y, size: 16, font: bold, color: ink });
  y -= 16;
  para(doc.subtitle);
  for (const b of banner(doc)) para(b, 9, bold, rgb(0.7, 0.33, 0.04));
  for (const w of doc.warnings) para(w, 9, bold, rgb(0.7, 0.1, 0.1));
  para(`Built ${meta.builtAt.slice(0, 16).replace("T", " ")} UTC`, 8);
  y -= 6;

  for (const t of tables) {
    const labelW = Math.max(160, W - 2 * M - t.columns.length * 78);
    const colW = t.columns.length ? (W - 2 * M - labelW) / t.columns.length : 0;
    need(40);
    if (t.title) {
      y -= 6;
      page.drawText(fit(t.title, W - 2 * M, 11, bold), {
        x: M,
        y,
        size: 11,
        font: bold,
        color: ink,
      });
      y -= 14;
    }
    const drawRow = (
      label: string,
      cells: string[],
      f = font,
      indent = 0,
      shade?: [number, number, number],
    ) => {
      need(13);
      if (shade)
        page.drawRectangle({ x: M, y: y - 3, width: W - 2 * M, height: 12, color: rgb(...shade) });
      page.drawText(fit(label, labelW - 6 - indent, 8, f), {
        x: M + indent,
        y,
        size: 8,
        font: f,
        color: ink,
      });
      cells.forEach((c, i) => {
        const s = fit(c, colW - 6, 8, f);
        page.drawText(s, {
          x: M + labelW + (i + 1) * colW - 4 - widthOf(s, 8, f),
          y,
          size: 8,
          font: f,
          color: ink,
        });
      });
      y -= 12;
    };
    drawRow(t.labelHeader ?? "", t.columns, bold);
    page.drawLine({
      start: { x: M, y: y + 9 },
      end: { x: W - M, y: y + 9 },
      thickness: 0.4,
      color: rgb(0.7, 0.7, 0.7),
    });
    if (t.rows.length === 0) drawRow(t.empty ?? "(none)", []);
    for (const r of t.rows) {
      const strong = r.kind !== "ledger" && r.kind !== "note";
      drawRow(
        r.code && r.kind !== "heading" ? `${r.code}  ${r.label}` : r.label,
        r.values.map((v, i) => formatValue(v, fmtOf(t, i, r.format))),
        strong ? bold : font,
        r.depth * 10,
        r.flag === "adverse"
          ? [0.99, 0.89, 0.89]
          : r.flag === "warning"
            ? [1, 0.95, 0.78]
            : undefined,
      );
    }
    y -= 6;
  }
  for (const n of doc.notes) para(n, 8);
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `${doc.provisional ? "PROVISIONAL - " : ""}${doc.title} - page ${i + 1} of ${pages.length}`;
    p.drawText(toWinAnsi(label), { x: M, y: 18, size: 7, font, color: rgb(0.45, 0.45, 0.45) });
  });
  return Buffer.from(await pdf.save());
}
