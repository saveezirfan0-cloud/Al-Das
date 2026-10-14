import { toWinAnsi } from "@/lib/finance/close-pdf";

/**
 * Receivables documents as PDF (pdf-lib, built-in Helvetica, like the voucher certificate): the tax invoice / tax credit
 * note, the customer statement and the balance-confirmation letter. Rendered from stored data only. English only: the
 * built-in fonts have no Arabic glyphs (a bilingual heading needs an embedded Arabic font, not added). Layout checked as
 * "readable and paginated", not against a printed sample.
 */

export const PAGE_W = 595.28;
const PAGE_H = 841.89;
export const MARGIN = 40;

const fmt = (n: number) =>
  n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type Col = { label: string; width: number; align?: "left" | "right" };

export async function makeDoc(title: string, when: Date) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(toWinAnsi(title));
  doc.setCreator("Pulse");
  doc.setProducer("Pulse");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const ink = rgb(0.1, 0.1, 0.1);
  const grey = rgb(0.4, 0.4, 0.4);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  type F = typeof font;
  const width = (s: string, size: number, f: F = font) => f.widthOfTextAtSize(toWinAnsi(s), size);
  const wrap = (s: string, size: number, maxW: number, f: F = font): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of toWinAnsi(s).split(/\s+/)) {
      let w = word;
      while (width(w, size, f) > maxW && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && width(w.slice(0, cut), size, f) > maxW) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (width(next, size, f) > maxW && line) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };
  const api = {
    doc,
    font,
    bold,
    mono,
    ink,
    grey,
    get y() {
      return y;
    },
    set y(v: number) {
      y = v;
    },
    need(h: number) {
      if (y - h < MARGIN + 20) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
    },
    text(s: string, x: number, size = 9, f: F = font, color = ink) {
      page.drawText(toWinAnsi(s), { x, y, size, font: f, color });
    },
    right(s: string, xRight: number, size = 9, f: F = font, color = ink) {
      page.drawText(toWinAnsi(s), { x: xRight - width(s, size, f), y, size, font: f, color });
    },
    para(s: string, size = 9, f: F = font, color = ink, x = MARGIN, maxW = PAGE_W - MARGIN - x) {
      for (const l of wrap(s, size, maxW, f)) {
        api.need(size + 4);
        page.drawText(l, { x, y, size, font: f, color });
        y -= size + 3;
      }
    },
    rule() {
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 0.5,
        color: rgb(0.6, 0.6, 0.6),
      });
    },
    heading(s: string) {
      api.need(30);
      y -= 8;
      page.drawText(toWinAnsi(s), { x: MARGIN, y, size: 11, font: bold, color: ink });
      y -= 6;
      api.rule();
      y -= 13;
    },
    /** A table: header once (and again on a new page), each row's text cells wrapped in their column. */
    table(cols: Col[], rows: string[][], boldLast = false) {
      const xs: number[] = [];
      let x = MARGIN;
      for (const c of cols) {
        xs.push(x);
        x += c.width;
      }
      const head = () => {
        api.need(16);
        cols.forEach((c, i) =>
          c.align === "right"
            ? api.right(c.label, xs[i] + c.width - 2, 8, bold, grey)
            : api.text(c.label, xs[i], 8, bold, grey),
        );
        y -= 4;
        api.rule();
        y -= 11;
      };
      head();
      rows.forEach((r, ri) => {
        const cells = r.map((v, i) =>
          cols[i].align === "right" ? [toWinAnsi(v)] : wrap(v, 8.5, cols[i].width - 4),
        );
        const h = Math.max(...cells.map((c) => c.length)) * 11;
        if (y - h < MARGIN + 20) {
          api.need(h + 30);
          head();
        }
        const f = boldLast && ri === rows.length - 1 ? bold : font;
        cells.forEach((lines, i) =>
          lines.forEach((l, li) => {
            const yy = y - li * 11;
            if (cols[i].align === "right")
              page.drawText(l, { x: xs[i] + cols[i].width - 2 - width(l, 8.5, f), y: yy, size: 8.5, font: f, color: ink });
            else page.drawText(l, { x: xs[i], y: yy, size: 8.5, font: f, color: ink });
          }),
        );
        y -= h + 2;
      });
    },
    footer(label: string) {
      const pages = doc.getPages();
      pages.forEach((p, i) =>
        p.drawText(toWinAnsi(`${label}   page ${i + 1} of ${pages.length}`), {
          x: MARGIN,
          y: MARGIN - 16,
          size: 7.5,
          font,
          color: grey,
        }),
      );
    },
  };
  return api;
}

export type PartyBlock = {
  name: string;
  trn: string | null;
  addressLines: string[];
};

export type TaxInvoicePdfInput = {
  kind: "invoice" | "credit_note";
  form: "full" | "simplified" | null;
  status: string;
  number: string;
  date: string;
  supplyDate: string | null;
  dueDate: string | null;
  reference: string | null;
  seller: PartyBlock;
  customer: PartyBlock;
  original: { number: string | null; date: string } | null;
  creditReason: string | null;
  eventDate: string | null;
  lines: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    net: number;
    vatRate: number;
    vat: number;
    total: number;
  }>;
  totals: {
    subtotal: number;
    discount: number;
    net: number;
    vat: number;
    total: number;
    byRate: Array<{ rate: number; net: number; vat: number }>;
  };
  notes: string | null;
  paymentInstructions: string | null;
  sha256: string | null;
  issuedAt: string | null;
};

/**
 * The tax invoice (Executive Regulation Art. 59): the words "Tax Invoice", the supplier's name, address and TRN, the
 * recipient's name, address and TRN when registered (full form), a sequential number, the date (and the date of supply when
 * different), each line's description, quantity, unit price, discount, VAT rate and VAT in AED, and the totals. A credit
 * note says "Tax Credit Note" and names the invoice it credits.
 */
export async function taxInvoicePdf(i: TaxInvoicePdfInput): Promise<Buffer> {
  const credit = i.kind === "credit_note";
  const heading = credit ? "Tax Credit Note" : i.form === "simplified" ? "Tax Invoice (simplified)" : "Tax Invoice";
  const p = await makeDoc(`${heading} ${i.number}`, new Date(i.issuedAt ?? `${i.date}T00:00:00Z`));
  const top = p.y;
  p.text(i.seller.name, MARGIN, 12, p.bold);
  p.y -= 14;
  for (const l of i.seller.addressLines) {
    p.text(l, MARGIN, 9);
    p.y -= 11;
  }
  if (i.seller.trn) {
    p.text(`TRN ${i.seller.trn}`, MARGIN, 9, p.bold);
    p.y -= 11;
  }
  const leftEnd = p.y;
  p.y = top;
  p.right(heading, PAGE_W - MARGIN, 16, p.bold);
  p.y -= 20;
  const meta: Array<[string, string]> = [
    ["Number", i.number],
    ["Date", i.date],
  ];
  if (i.supplyDate && i.supplyDate !== i.date) meta.push(["Date of supply", i.supplyDate]);
  if (!credit && i.dueDate) meta.push(["Due", i.dueDate]);
  if (i.reference) meta.push(["Your reference", i.reference]);
  meta.push(["Currency", "AED"]);
  for (const [k, v] of meta) {
    p.right(`${k}: ${v}`, PAGE_W - MARGIN, 9);
    p.y -= 12;
  }
  p.y = Math.min(p.y, leftEnd) - 10;
  if (i.status === "void") {
    p.para("VOID: this invoice was cancelled by a credit note in full.", 10, p.bold);
    p.y -= 4;
  }

  p.heading(credit ? "Credited to" : "Bill to");
  p.para(i.customer.name, 10, p.bold);
  for (const l of i.customer.addressLines) p.para(l);
  if (i.customer.trn) p.para(`TRN ${i.customer.trn}`, 9, p.bold);
  if (credit && i.original) {
    p.y -= 4;
    p.para(`This credit note adjusts tax invoice ${i.original.number ?? "-"} dated ${i.original.date}.`);
    if (i.creditReason) p.para(`Reason: ${i.creditReason}`);
    if (i.eventDate) p.para(`Date of the event: ${i.eventDate}`);
  }

  p.heading("Details");
  p.table(
    [
      { label: "#", width: 18 },
      { label: "Description", width: 150 },
      { label: "Qty", width: 40, align: "right" },
      { label: "Unit price", width: 58, align: "right" },
      { label: "Discount", width: 50, align: "right" },
      { label: "Net", width: 58, align: "right" },
      { label: "VAT %", width: 34, align: "right" },
      { label: "VAT AED", width: 50, align: "right" },
      { label: "Total", width: 57.28, align: "right" },
    ],
    i.lines.map((l, n) => [
      String(n + 1),
      l.description,
      String(l.quantity),
      fmt(l.unitPrice),
      l.discount ? fmt(l.discount) : "",
      fmt(l.net),
      `${l.vatRate}%`,
      fmt(l.vat),
      fmt(l.total),
    ]),
  );

  p.y -= 6;
  const totals: Array<[string, string, boolean]> = [["Subtotal", fmt(i.totals.subtotal), false]];
  if (i.totals.discount) totals.push(["Discount", `-${fmt(i.totals.discount)}`, false]);
  totals.push(["Total excluding VAT", fmt(i.totals.net), false]);
  for (const r of i.totals.byRate)
    totals.push([`VAT at ${r.rate}% on ${fmt(r.net)}`, fmt(r.vat), false]);
  totals.push(["Total VAT (AED)", fmt(i.totals.vat), false]);
  totals.push([credit ? "Total credited (AED)" : "Total due (AED)", fmt(i.totals.total), true]);
  for (const [k, v, b] of totals) {
    p.need(14);
    p.right(k, PAGE_W - MARGIN - 90, 9, b ? p.bold : p.font);
    p.right(v, PAGE_W - MARGIN, 9, b ? p.bold : p.font);
    p.y -= 13;
  }

  if (i.notes) {
    p.heading("Notes");
    p.para(i.notes);
  }
  if (!credit && i.paymentInstructions) {
    p.heading("How to pay");
    p.para(i.paymentInstructions);
  }
  if (i.sha256) {
    p.y -= 10;
    p.para(`Issued by Pulse. Content sha256 ${i.sha256}`, 7, p.mono, p.grey);
  }
  p.footer(`${heading} ${i.number}`);
  return Buffer.from(await p.doc.save());
}

export type StatementPdfInput = {
  seller: PartyBlock;
  customer: PartyBlock;
  from: string;
  to: string;
  opening: number;
  rows: Array<{
    date: string;
    kind: "invoice" | "credit_note" | "receipt";
    number: string;
    reference: string | null;
    debit: number;
    credit: number;
    balance: number;
  }>;
  closing: number;
  paymentInstructions: string | null;
  builtAt: string;
};

const KIND = { invoice: "Invoice", credit_note: "Credit note", receipt: "Receipt" } as const;

export async function statementPdf(s: StatementPdfInput): Promise<Buffer> {
  const p = await makeDoc(`Statement of account ${s.customer.name}`, new Date(s.builtAt));
  p.text(s.seller.name, MARGIN, 12, p.bold);
  p.right("Statement of account", PAGE_W - MARGIN, 16, p.bold);
  p.y -= 16;
  for (const l of s.seller.addressLines) {
    p.text(l, MARGIN, 9);
    p.y -= 11;
  }
  if (s.seller.trn) {
    p.text(`TRN ${s.seller.trn}`, MARGIN, 9);
    p.y -= 11;
  }
  p.heading("Customer");
  p.para(s.customer.name, 10, p.bold);
  for (const l of s.customer.addressLines) p.para(l);
  if (s.customer.trn) p.para(`TRN ${s.customer.trn}`);
  p.para(`Period ${s.from} to ${s.to}. Amounts in AED.`, 9, p.font, p.grey);
  p.heading("Transactions");
  p.table(
    [
      { label: "Date", width: 62 },
      { label: "Document", width: 160 },
      { label: "Reference", width: 90 },
      { label: "Debit", width: 70, align: "right" },
      { label: "Credit", width: 70, align: "right" },
      { label: "Balance", width: 63.28, align: "right" },
    ],
    [
      [s.from, "Opening balance", "", "", "", fmt(s.opening)],
      ...s.rows.map((r) => [
        r.date,
        `${KIND[r.kind]} ${r.number}`,
        r.reference ?? "",
        r.debit ? fmt(r.debit) : "",
        r.credit ? fmt(r.credit) : "",
        fmt(r.balance),
      ]),
      [s.to, "Closing balance", "", "", "", fmt(s.closing)],
    ],
    true,
  );
  p.y -= 6;
  p.para(
    s.closing >= 0
      ? `Balance owed to ${s.seller.name} as at ${s.to}: AED ${fmt(s.closing)}.`
      : `Balance held for you as at ${s.to}: AED ${fmt(-s.closing)}.`,
    10,
    p.bold,
  );
  if (s.paymentInstructions) {
    p.heading("How to pay");
    p.para(s.paymentInstructions);
  }
  p.footer(`Statement ${s.customer.name} ${s.from} to ${s.to}`);
  return Buffer.from(await p.doc.save());
}

export type BalanceConfirmationInput = {
  seller: PartyBlock;
  customer: PartyBlock;
  asOf: string;
  balance: number;
  invoices: Array<{ number: string; date: string; due: string | null; open: number }>;
  onAccount: Array<{ number: string; date: string; amount: number }>;
  builtAt: string;
};

/** A balance-confirmation letter for the auditors: the balance per Pulse's books and the items that make it up. */
export async function balanceConfirmationPdf(b: BalanceConfirmationInput): Promise<Buffer> {
  const p = await makeDoc(`Balance confirmation ${b.customer.name} ${b.asOf}`, new Date(b.builtAt));
  p.text(b.seller.name, MARGIN, 12, p.bold);
  p.y -= 14;
  for (const l of b.seller.addressLines) {
    p.text(l, MARGIN, 9);
    p.y -= 11;
  }
  if (b.seller.trn) {
    p.text(`TRN ${b.seller.trn}`, MARGIN, 9);
    p.y -= 11;
  }
  p.y -= 14;
  p.para(`Date: ${b.builtAt.slice(0, 10)}`);
  p.y -= 6;
  p.para(b.customer.name, 10, p.bold);
  for (const l of b.customer.addressLines) p.para(l);
  p.y -= 10;
  p.para(`Confirmation of balance as at ${b.asOf}`, 12, p.bold);
  p.y -= 4;
  p.para(
    `For the audit of our accounts, please confirm the balance below as shown in your books as at ${b.asOf}. ` +
      `If it agrees, sign and return this letter. If it does not, please list the differences. Please reply directly to our auditors when they ask you to.`,
  );
  p.y -= 6;
  p.para(
    b.balance >= 0
      ? `Balance owed by you to ${b.seller.name}: AED ${fmt(b.balance)}`
      : `Balance held by ${b.seller.name} for you: AED ${fmt(-b.balance)}`,
    11,
    p.bold,
  );
  if (b.invoices.length) {
    p.heading("Open invoices");
    p.table(
      [
        { label: "Invoice", width: 160 },
        { label: "Date", width: 90 },
        { label: "Due", width: 90 },
        { label: "Open (AED)", width: 175.28, align: "right" },
      ],
      b.invoices.map((i) => [i.number, i.date, i.due ?? "", fmt(i.open)]),
    );
  }
  if (b.onAccount.length) {
    p.heading("Payments received not yet matched to an invoice");
    p.table(
      [
        { label: "Receipt", width: 160 },
        { label: "Date", width: 180 },
        { label: "Amount (AED)", width: 175.28, align: "right" },
      ],
      b.onAccount.map((r) => [r.number, r.date, fmt(r.amount)]),
    );
  }
  p.y -= 20;
  p.para("We confirm the balance above as correct / not correct (delete as appropriate).");
  p.y -= 24;
  p.para("Signature and company stamp: ______________________________");
  p.y -= 10;
  p.para("Name and position: ______________________________   Date: ______________");
  p.footer(`Balance confirmation ${b.customer.name} ${b.asOf}`);
  return Buffer.from(await p.doc.save());
}
