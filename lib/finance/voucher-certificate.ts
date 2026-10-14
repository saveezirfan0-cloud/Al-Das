import { toWinAnsi } from "@/lib/finance/close-pdf";
import { signingLines, type SigningSection } from "@/lib/signing/pdf-text";
import {
  approvalRoute,
  EVENT_LABEL,
  METHOD_LABEL,
  SPECIAL_LABEL,
  STATUS_LABEL,
  type PaymentMethod,
  type SpecialCategory,
  type VoucherStatus,
} from "@/lib/finance/vouchers";

/**
 * The approval certificate of one payment voucher (pdf-lib, built-in Helvetica), rendered from the stored voucher and its
 * append-only trail. Attachments appear by kind, size and sha256 (no file names). It records approvals made in Pulse; it is
 * not a DSC signature (OQ-91). Phase 22C adds the "Digital signatures" section (personal certificate signatures and the
 * seal line); the organisation seal itself is applied afterwards by lib/signing/pades.ts (lib/finance/signed-pdfs-server.ts).
 * Layout has not been checked in a PDF viewer beyond "readable and paginated".
 */

export type CertificateEvent = {
  at: string;
  action: string;
  actor: string;
  fromStatus: string | null;
  toStatus: string | null;
  remarks: string | null;
  hash: string | null;
};

export type VoucherCertificate = {
  org: string;
  voucherNo: string;
  voucherDate: string;
  payeeName: string;
  supplierName: string | null;
  amount: number;
  currency: string;
  category: string;
  special: SpecialCategory;
  branchCode: string | null;
  costCentre: string | null;
  payFrom: string | null;
  paymentMethod: PaymentMethod;
  narration: string;
  status: VoucherStatus;
  route: "pulse" | "tally" | null;
  tier: string | null;
  needsDept: boolean;
  needsCeo: boolean;
  /** The hash every approval was bound to (null while a draft). */
  contentHash: string | null;
  /** The hash of the voucher as stored now (equal to contentHash unless something is wrong). */
  currentHash: string;
  invoices: Array<{ number: string; date: string; total: number }>;
  documents: Array<{ kind: string; sha256: string; sizeBytes: number }>;
  events: CertificateEvent[];
  payment: { date: string; reference: string } | null;
  timezone: string;
  /** Phase 22C: personal signatures and the organisation seal line (left out by callers before 22C). */
  signing?: SigningSection;
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;

const money = (n: number) =>
  n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function when(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export async function voucherCertificatePdf(c: VoucherCertificate): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const last = c.events.length ? new Date(c.events[c.events.length - 1].at) : new Date(0);
  doc.setTitle(toWinAnsi(`Payment voucher ${c.voucherNo} approval certificate`));
  doc.setCreator("Pulse");
  doc.setProducer("Pulse");
  doc.setCreationDate(last);
  doc.setModificationDate(last);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const need = (h: number) => {
    if (y - h < MARGIN + 20) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const ink = rgb(0.1, 0.1, 0.1);
  const grey = rgb(0.4, 0.4, 0.4);
  const width = (s: string, size: number, f = font) => f.widthOfTextAtSize(toWinAnsi(s), size);
  const wrap = (s: string, size: number, maxW: number, f = font): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of toWinAnsi(s).split(/\s+/)) {
      let w = word;
      while (width(w, size, f) > maxW && w.length > 1) {
        // break very long tokens (hashes) at the width
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
    return out;
  };
  const heading = (s: string) => {
    need(30);
    y -= 10;
    page.drawText(toWinAnsi(s), { x: MARGIN, y, size: 12, font: bold, color: ink });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= 14;
  };
  /** label: value, value wrapped in the right column */
  const field = (label: string, value: string, f = font) => {
    const lines = wrap(value || "-", 9, PAGE_W - 2 * MARGIN - 130, f);
    need(12 * lines.length + 2);
    page.drawText(toWinAnsi(label), { x: MARGIN, y, size: 9, font: bold, color: grey });
    for (const l of lines) {
      page.drawText(l, { x: MARGIN + 130, y, size: 9, font: f, color: ink });
      y -= 12;
    }
  };
  const para = (s: string, size = 9, f = font, color = ink, x = MARGIN) => {
    for (const l of wrap(s, size, PAGE_W - MARGIN - x, f)) {
      need(size + 4);
      page.drawText(l, { x, y, size, font: f, color });
      y -= size + 3;
    }
  };

  page.drawText(toWinAnsi(c.org), { x: MARGIN, y, size: 10, font, color: grey });
  y -= 22;
  page.drawText(toWinAnsi("Payment voucher approval certificate"), {
    x: MARGIN,
    y,
    size: 16,
    font: bold,
    color: ink,
  });
  y -= 18;
  para(`${c.voucherNo} - ${STATUS_LABEL[c.status]}`, 11, bold);
  y -= 4;

  heading("Voucher");
  field("Number", c.voucherNo);
  field("Date", c.voucherDate);
  field("Payee", c.payeeName);
  if (c.supplierName) field("Supplier", c.supplierName);
  field("Amount", `${c.currency} ${money(c.amount)}`);
  field("Category", c.category);
  field("Special category", SPECIAL_LABEL[c.special]);
  field("Branch / cost centre", [c.branchCode, c.costCentre].filter(Boolean).join(" / ") || "-");
  field("Paid from", `${c.payFrom ?? "-"} (${METHOD_LABEL[c.paymentMethod]})`);
  field("Narration", c.narration);
  field("Approval route", approvalRoute(c));
  if (c.payment) field("Payment", `${c.payment.date}, reference ${c.payment.reference}`);

  heading("Supplier invoices");
  if (c.invoices.length === 0) para("None linked.", 9, font, grey);
  for (const i of c.invoices) para(`${i.number}   ${i.date}   ${c.currency} ${money(i.total)}`);

  heading("Supporting documents (stored digitally in Pulse)");
  if (c.documents.length === 0) para("None.", 9, font, grey);
  for (const d of c.documents) {
    para(`${d.kind.replace(/_/g, " ")}, ${Math.max(1, Math.round(d.sizeBytes / 1024))} KB`);
    para(`sha256 ${d.sha256}`, 8, mono, grey, MARGIN + 12);
  }

  heading("Trail");
  for (const e of c.events) {
    need(40);
    para(`${when(e.at, c.timezone)}   ${EVENT_LABEL[e.action] ?? e.action}`, 9, bold);
    para(
      `By ${e.actor}${e.fromStatus || e.toStatus ? `   (${e.fromStatus ?? "-"} to ${e.toStatus ?? "-"})` : ""}`,
      9,
      font,
      ink,
      MARGIN + 12,
    );
    if (e.remarks) para(`Remarks: ${e.remarks}`, 9, font, ink, MARGIN + 12);
    if (e.hash) para(`content sha256 ${e.hash}`, 7.5, mono, grey, MARGIN + 12);
    y -= 3;
  }

  heading("Fingerprint");
  para(
    "Every approval above is bound to the content fingerprint below: the sha256 of the voucher's fields, its linked supplier invoices and the sha256 of every attachment. Any change after submission returns the voucher to draft and clears its approvals.",
  );
  y -= 2;
  para(`Approved content sha256: ${c.contentHash ?? "(not submitted)"}`, 8, mono);
  para(`Stored content sha256:   ${c.currentHash}`, 8, mono);
  if (c.contentHash && c.contentHash !== c.currentHash)
    para(
      "WARNING: the stored voucher no longer matches the approved content.",
      9,
      bold,
      rgb(0.7, 0.1, 0.1),
    );
  if (c.signing) {
    heading("Digital signatures");
    for (const l of signingLines(c.signing, (iso) => when(iso, c.timezone))) {
      const x = l.indent ? MARGIN + 12 : MARGIN;
      if (l.style === "bold") para(l.text, 9, bold, ink, x);
      else if (l.style === "mono") para(l.text, 7.5, mono, grey, x);
      else if (l.style === "grey") para(l.text, 8, font, grey, x);
      else para(l.text, 9, font, ink, x);
    }
  }
  y -= 6;
  para(
    c.signing
      ? "This certificate records approvals made in Pulse. A USB-token DSC cannot be used by a web application; where a DSC signature is required it is applied in Tally or through the e-signature provider (OQ-91, OQ-121)."
      : "This certificate records approvals made in Pulse. It is not a digital signature certificate (DSC); where a DSC signature is required it is applied in Tally or through the e-signature provider (OQ-91).",
    8,
    font,
    grey,
  );

  const pages = doc.getPages();
  pages.forEach((p, i) =>
    p.drawText(toWinAnsi(`${c.voucherNo}   page ${i + 1} of ${pages.length}`), {
      x: MARGIN,
      y: MARGIN - 16,
      size: 7.5,
      font,
      color: grey,
    }),
  );
  return Buffer.from(await doc.save());
}
