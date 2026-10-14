import { MARGIN, makeDoc, PAGE_W } from "@/lib/accounting/sales-pdf";
import type { InvoicePdfData } from "@/lib/finance/invoice-server";

/**
 * The internal copy of a Unite invoice as PDF (Phase G): for finance files and audits, NOT a tax invoice (Unite issues
 * the patient's invoice). Every page says so in its heading and footer. Ids, codes and amounts; the patient appears as
 * the Unite PIN only, as on the invoice page. pdf-lib with the built-in fonts, like the other finance documents.
 */

export const INTERNAL_COPY = "Internal copy - not a tax invoice";

const n2 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "-"
    : v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const t = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : String(v));

export async function internalInvoicePdf(
  d: InvoicePdfData,
  meta: { orgName: string; builtAt: string },
): Promise<Buffer> {
  const p = await makeDoc(`Invoice ${d.number} (internal copy)`, new Date(meta.builtAt));
  p.text(meta.orgName || "Pulse", MARGIN, 12, p.bold);
  p.right(`Invoice ${d.number}`, PAGE_W - MARGIN, 16, p.bold);
  p.y -= 18;
  p.right(INTERNAL_COPY, PAGE_W - MARGIN, 10, p.bold);
  p.y -= 16;
  p.para(
    "Printed from Pulse for finance use. The patient's invoice is the one Unite issued; this copy is not a tax invoice and must not be sent to a patient or payer as one.",
    8.5,
    p.font,
    p.grey,
  );
  if (d.deleted) p.para("This invoice was deleted in Unite.", 10, p.bold);

  p.heading("Invoice");
  p.table(
    [
      { label: "Date", width: 70 },
      { label: "Type", width: 90 },
      { label: "Branch", width: 55 },
      { label: "Department", width: 110 },
      { label: "Doctor", width: 120 },
      { label: "Version", width: 70.28, align: "right" },
    ],
    [[t(d.date), t(d.invType), t(d.branch), t(d.department), t(d.doctor), String(d.version)]],
  );
  p.para(`Patient PIN: ${t(d.patientPin)}`, 9);

  p.heading("Amounts (AED)");
  p.table(
    [
      { label: "", width: 200 },
      { label: "Amount", width: 100, align: "right" },
    ],
    d.amounts.map(([label, v]) => [label, n2(v)]),
  );

  p.heading("Lines");
  p.table(
    [
      { label: "#", width: 28 },
      { label: "Item", width: 237 },
      { label: "CPT", width: 70 },
      { label: "Qty", width: 50, align: "right" },
      { label: "Net", width: 80, align: "right" },
      { label: "", width: 50.28 },
    ],
    d.lines.length
      ? d.lines.map((l) => [
          t(l.position),
          `${l.code ?? ""} ${l.description ?? ""}`.trim() || "-",
          t(l.cpt),
          t(l.qty),
          n2(l.net),
          l.removed ? "removed" : "",
        ])
      : [["", "No lines", "", "", "", ""]],
  );

  if (d.shares) {
    const s = d.shares;
    const main = s.mainParty === "corporate" ? "Company" : "Patient";
    p.heading("Who pays (AED)");
    const rows: string[][] = [];
    if (s.payerKind === "insurance") {
      for (const i of s.insurers)
        rows.push([
          `Insurer: ${i.payerId ? (d.payerNames.get(i.payerId) ?? i.payerId) : "not known yet"}`,
          n2(i.share),
          n2(i.remitted),
          n2(i.outstanding),
        ]);
    }
    rows.push([`${main} share`, n2(s.patientShare), n2(s.patientPaid), n2(s.balanceDue)]);
    p.table(
      [
        { label: "", width: 215 },
        { label: "Share", width: 100, align: "right" },
        { label: "Received", width: 100, align: "right" },
        { label: "Outstanding", width: 100.28, align: "right" },
      ],
      rows,
    );
    if (s.claimsPending)
      p.para("No claim is matched yet: the whole total waits on the insurer.", 8.5, p.font, p.grey);
    if (s.claimsExceed) p.para("The matched claims exceed the invoice total.", 8.5, p.bold);
  }

  p.heading("Payments");
  p.table(
    [
      { label: "Date", width: 80 },
      { label: "Mode", width: 120 },
      { label: "Receipt", width: 115 },
      { label: "Paid", width: 100, align: "right" },
      { label: "Refund", width: 100.28, align: "right" },
    ],
    d.payments.length
      ? d.payments.map((x) => [t(x.date), t(x.mode), t(x.receipt), n2(x.paid), n2(x.refund)])
      : [["", "No payments recorded", "", "", ""]],
  );
  p.y -= 6;
  p.para(`Printed ${meta.builtAt.slice(0, 16).replace("T", " ")} UTC.`, 8, p.font, p.grey);
  p.footer(`Invoice ${d.number} - ${INTERNAL_COPY}`);
  return Buffer.from(await p.doc.save());
}
