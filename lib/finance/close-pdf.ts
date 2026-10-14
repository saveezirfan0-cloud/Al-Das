import {
  CONTROLS_SCOPE,
  controlSections,
  NOT_CAPTURED,
  readControls,
} from "@/lib/finance/close-controls";
import { monthLabel, type ClosePack } from "@/lib/finance/close-pack";
import type { SignOff } from "@/lib/finance/close-xlsx";
import { signingLines, type SigningSection } from "@/lib/signing/pdf-text";

/**
 * The close pack as a PDF (pdf-lib: pure JavaScript, no native code or fonts to ship), rendered from the FROZEN snapshot.
 * Text uses the built-in Helvetica, which covers Latin only; any other character (for example an Arabic doctor name) is
 * replaced with "?" rather than failing, and the XLSX carries the exact text. Layout fidelity beyond "readable, paginated,
 * with the sign-off and fingerprint on the last page" has not been checked in a PDF viewer.
 */

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 40;

/** Helvetica can draw WinAnsi only; keep printable ASCII and a few common Latin-1 characters. */
export function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "?");
}

const fmt = (n: number) =>
  n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function closePackPdf(
  pack: ClosePack,
  sign: SignOff,
  /** Phase 22C: personal signatures and the seal line (the seal itself is applied afterwards to the rendered bytes). */
  signing?: SigningSection,
): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const when = new Date(pack.built_at);
  doc.setTitle(toWinAnsi(`${pack.org} month-end close ${monthLabel(pack.month)}`));
  doc.setCreator("Pulse");
  doc.setProducer("Pulse");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const status = sign.lockedAt ? "LOCKED" : sign.financeAt ? "SIGNED BY FINANCE" : "NOT SIGNED";

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const need = (h: number) => {
    if (y - h < MARGIN + 24) newPage();
  };
  const text = (s: string, x: number, size = 9, f = font, color = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(toWinAnsi(s), { x, y, size, font: f, color });
  const widthOf = (s: string, size: number, f = font) => f.widthOfTextAtSize(toWinAnsi(s), size);
  const heading = (s: string) => {
    need(34);
    y -= 12;
    text(s, MARGIN, 12, bold);
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 12;
  };
  const para = (s: string, size = 9) => {
    const maxW = PAGE_W - 2 * MARGIN;
    let line = "";
    for (const word of toWinAnsi(s).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size) > maxW && line) {
        need(size + 4);
        text(line, MARGIN, size);
        y -= size + 3;
        line = word;
      } else line = next;
    }
    if (line) {
      need(size + 4);
      text(line, MARGIN, size);
      y -= size + 3;
    }
  };
  /** A table: the first column is text, the rest are right-aligned numbers (strings already formatted). */
  const table = (head: string[], rows: string[][], widths: number[]) => {
    const x0 = MARGIN;
    const drawRow = (cells: string[], f = font) => {
      need(14);
      let x = x0;
      cells.forEach((c, i) => {
        let s = toWinAnsi(c);
        while (s.length > 1 && widthOf(s, 8.5, f) > widths[i] - 6) s = s.slice(0, -2) + "~";
        if (i === 0) page.drawText(s, { x, y, size: 8.5, font: f, color: rgb(0.1, 0.1, 0.1) });
        else
          page.drawText(s, {
            x: x + widths[i] - 4 - widthOf(s, 8.5, f),
            y,
            size: 8.5,
            font: f,
            color: rgb(0.1, 0.1, 0.1),
          });
        x += widths[i];
      });
      y -= 12;
    };
    drawRow(head, bold);
    page.drawLine({
      start: { x: MARGIN, y: y + 9 },
      end: { x: MARGIN + widths.reduce((a, b) => a + b, 0), y: y + 9 },
      thickness: 0.3,
      color: rgb(0.7, 0.7, 0.7),
    });
    if (rows.length === 0) drawRow(["(none)", ...head.slice(1).map(() => "")]);
    for (const r of rows) drawRow(r);
    y -= 4;
  };

  // title block
  text(`${pack.org}`, MARGIN, 10, font, rgb(0.35, 0.35, 0.35));
  y -= 20;
  text(`Month-end close: ${monthLabel(pack.month)}`, MARGIN, 18, bold);
  y -= 18;
  text(`Status: ${status}    Built ${pack.built_at}    Currency ${pack.currency}`, MARGIN, 9);
  y -= 12;
  if (sign.hash) {
    text(`Fingerprint (sha256): ${sign.hash}`, MARGIN, 7);
    y -= 10;
  }

  heading("Summary");
  const t = pack.totals;
  table(
    ["Measure", "AED"],
    [
      ["Invoiced (net)", fmt(t.generated)],
      ["Revenue (line net)", fmt(t.revenue_net)],
      ["Claimed", fmt(t.claimed)],
      ["Remitted", fmt(t.remitted)],
      ["Rejected", fmt(t.rejected)],
      ["Outstanding (as of build date)", fmt(t.outstanding)],
      ["Self-pay collected", fmt(t.self_pay_collected)],
      ["Collected, all payments", fmt(t.collected)],
      ["Refunds", fmt(t.refunds)],
      ["Write-offs on invoices", fmt(pack.adjustments.write_off)],
      ["Credit notes", fmt(pack.adjustments.credit_note)],
    ],
    [330, 120],
  );

  heading("Matters needing attention");
  const controls = readControls(pack.controls);
  if (!controls) para(NOT_CAPTURED);
  else {
    const matters = Array.isArray(pack.matters) ? pack.matters : [];
    if (matters.length === 0) para("None found by the checks in Controls.");
    for (const m of matters) para(`- ${m.text}`);
  }

  heading("Controls");
  if (!controls) para(NOT_CAPTURED);
  else {
    para(
      `Ages and workflow states as at ${controls.as_of}; payables as at ${controls.month_end}.`,
      8,
    );
    for (const sec of controlSections(controls)) {
      need(30);
      y -= 2;
      text(sec.title, MARGIN, 9.5, bold);
      y -= 13;
      for (const [k, v] of sec.rows) {
        need(14);
        let label = toWinAnsi(k);
        while (label.length > 1 && widthOf(label, 8.5) > 290) label = label.slice(0, -2) + "~";
        text(label, MARGIN, 8.5);
        const value = toWinAnsi(v);
        text(value, PAGE_W - MARGIN - widthOf(value, 8.5), 8.5);
        y -= 12;
      }
      y -= 4;
    }
  }
  for (const n of CONTROLS_SCOPE) para(n, 8);

  heading("By branch");
  table(
    ["Branch", "Invoiced", "Claimed", "Remitted", "Rejected", "Outstanding", "Self-pay"],
    pack.by_branch.map((b) => [
      b.branch,
      fmt(b.generated),
      fmt(b.claimed),
      fmt(b.remitted),
      fmt(b.rejected),
      fmt(b.outstanding),
      fmt(b.self_pay_collected),
    ]),
    [70, 80, 80, 80, 75, 80, 70],
  );

  heading("Revenue by category");
  table(
    ["Category", "Net revenue", "Invoices"],
    pack.revenue.by_category
      .slice(0, 20)
      .map((r) => [r.label ?? r.key, fmt(r.net), String(r.invoices)]),
    [300, 120, 80],
  );
  heading("Revenue by department");
  table(
    ["Department", "Net revenue", "Invoices"],
    pack.revenue.by_department
      .slice(0, 20)
      .map((r) => [r.label ?? r.key, fmt(r.net), String(r.invoices)]),
    [300, 120, 80],
  );
  heading("Revenue by doctor");
  table(
    ["Doctor", "Net revenue", "Invoices"],
    pack.revenue.by_doctor
      .slice(0, 25)
      .map((r) => [r.label ?? r.key, fmt(r.net), String(r.invoices)]),
    [300, 120, 80],
  );

  heading("Collections by payment mode");
  table(
    ["Mode", "Paid", "Refunds"],
    pack.collections.map((c) => [c.mode, fmt(c.paid), fmt(c.refunds)]),
    [260, 120, 120],
  );

  heading("Receivables ageing (as of build date)");
  table(
    ["Age (days)", "Claim activities", "Outstanding"],
    pack.ageing.map((a) => [a.bucket, String(a.claims), fmt(a.outstanding)]),
    [200, 120, 150],
  );

  heading("Denials and remittance");
  const dn = pack.denials;
  const rm = pack.remittance;
  para(
    `Denial cases opened in the month: ${dn.opened_in_month}. Still active: ${dn.active_now} (${fmt(dn.active_amount)}). Past their deadline: ${dn.past_deadline}. ` +
      `Remittance reconciled: ${rm.batches} advice(s), ${rm.lines} lines, ${rm.short_lines} short-paid line(s) totalling ${fmt(rm.short_amount)}.`,
  );
  table(
    ["Denial code", "Claims", "Amount"],
    pack.denial_reasons.map((r) => [
      `${r.reason_code}${r.description ? ` ${r.description}` : ""}`,
      String(r.claims),
      fmt(r.amount),
    ]),
    [320, 70, 110],
  );

  heading("Cash-up (submitted days)");
  table(
    ["Branch", "Days", "Expected", "Counted", "Variance"],
    pack.cashups.map((c) => [
      c.branch,
      String(c.days),
      fmt(c.expected),
      fmt(c.counted),
      fmt(c.variance),
    ]),
    [100, 70, 110, 110, 110],
  );

  heading("Sign-off");
  need(90);
  para(
    `Finance: ${sign.financeAt ? `${sign.financeBy ?? "unknown"} on ${sign.financeAt}` : "pending"}${sign.financeNote ? `. Note: ${sign.financeNote}` : ""}`,
  );
  para(
    `CEO: ${sign.ceoAt ? `${sign.ceoBy ?? "unknown"} on ${sign.ceoAt}` : "pending"}${sign.ceoNote ? `. Note: ${sign.ceoNote}` : ""}`,
  );
  para(
    sign.lockedAt
      ? `This month was locked on ${sign.lockedAt}. The figures above can no longer change.`
      : "This month is not locked yet; the figures may be rebuilt until both sign-offs are given.",
  );
  y -= 4;
  for (const n of pack.notes) para(n, 8);

  if (signing) {
    heading("Digital signatures");
    for (const l of signingLines(signing, (iso) => iso.replace("T", " ").slice(0, 16) + " UTC")) {
      if (l.style === "bold") {
        need(14);
        text(l.text.length > 110 ? `${l.text.slice(0, 108)}~` : l.text, MARGIN, 9, bold);
        y -= 12;
      } else if (l.style === "mono") {
        need(12);
        text(l.text, MARGIN + 12, 7);
        y -= 10;
      } else para(l.text, l.style === "grey" ? 8 : 9);
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(
      toWinAnsi(
        `${pack.org}  |  ${monthLabel(pack.month)}  |  ${status}  |  page ${i + 1} of ${pages.length}`,
      ),
      {
        x: MARGIN,
        y: 22,
        size: 7,
        font,
        color: rgb(0.45, 0.45, 0.45),
      },
    );
  });
  return Buffer.from(await doc.save());
}
