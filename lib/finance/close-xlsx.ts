import {
  CONTROLS_SCOPE,
  controlSections,
  NOT_CAPTURED,
  readControls,
} from "@/lib/finance/close-controls";
import { monthLabel, type ClosePack } from "@/lib/finance/close-pack";

/**
 * The close pack as an .xlsx workbook, rendered from the FROZEN snapshot (never from live data). Deterministic: the
 * workbook's own timestamps are set to the build time, so the same snapshot yields the same content. Every cell is a plain
 * value (no formulas), so nothing a person typed can be executed by a spreadsheet.
 */

export type SignOff = {
  financeBy: string | null;
  financeAt: string | null;
  financeNote: string | null;
  ceoBy: string | null;
  ceoAt: string | null;
  ceoNote: string | null;
  lockedAt: string | null;
  hash: string | null;
};

export async function closePackXlsx(pack: ClosePack, sign: SignOff): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(pack.built_at);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;

  const money = "#,##0.00;[Red]-#,##0.00";
  const addTable = (
    name: string,
    cols: Array<{ header: string; key: string; width: number; numeric?: boolean }>,
    rows: Array<Record<string, string | number | null>>,
  ) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    cols.forEach((c, i) => {
      if (c.numeric) ws.getColumn(i + 1).numFmt = money;
    });
    return ws;
  };

  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ width: 34 }, { width: 60 }];
  const kv = (k: string, v: string | number | null) => summary.addRow([k, v ?? ""]);
  summary.addRow([`${pack.org}: month-end close, ${monthLabel(pack.month)}`]).font = {
    bold: true,
    size: 14,
  };
  summary.addRow([]);
  kv(
    "Status",
    sign.lockedAt
      ? "LOCKED (both sign-offs done)"
      : sign.financeAt
        ? "Signed by finance, waiting for the CEO"
        : "Not signed off",
  );
  kv("Pack built at", pack.built_at);
  kv("Pack fingerprint (sha256)", sign.hash ?? "");
  kv("Currency", pack.currency);
  summary.addRow([]);
  const t = pack.totals;
  for (const [label, value] of [
    ["Invoiced (net)", t.generated],
    ["Revenue (line net)", t.revenue_net],
    ["Claimed", t.claimed],
    ["Remitted", t.remitted],
    ["Rejected", t.rejected],
    ["Outstanding (as of build date)", t.outstanding],
    ["Self-pay collected", t.self_pay_collected],
    ["Collected, all payments", t.collected],
    ["Refunds", t.refunds],
    ["Write-offs on invoices", pack.adjustments.write_off],
    ["Credit notes", pack.adjustments.credit_note],
  ] as Array<[string, number]>) {
    const row = summary.addRow([label, value]);
    row.getCell(2).numFmt = money;
  }
  summary.addRow([]);
  kv("Open exceptions at build time", pack.open_exceptions);
  kv("Last Unite capture", pack.freshness.last_capture_at);
  kv("Last Diligence import", pack.freshness.last_import_at);
  summary.addRow([]);
  summary.addRow(["Sign-off"]).font = { bold: true };
  kv("Finance", sign.financeAt ? `${sign.financeBy ?? "unknown"} on ${sign.financeAt}` : "pending");
  if (sign.financeNote) kv("Finance note", sign.financeNote);
  kv("CEO", sign.ceoAt ? `${sign.ceoBy ?? "unknown"} on ${sign.ceoAt}` : "pending");
  if (sign.ceoNote) kv("CEO note", sign.ceoNote);
  summary.addRow([]);
  for (const n of pack.notes) summary.addRow([n]);

  // Controls and matters needing attention (frozen with the pack; text values only)
  const controls = readControls(pack.controls);
  const cs = wb.addWorksheet("Controls");
  cs.columns = [{ width: 52 }, { width: 70 }];
  cs.addRow(["Matters needing attention"]).font = { bold: true, size: 12 };
  if (!controls) cs.addRow([NOT_CAPTURED]);
  else {
    const matters = Array.isArray(pack.matters) ? pack.matters : [];
    if (matters.length === 0) cs.addRow(["None found by the checks below."]);
    for (const m of matters) cs.addRow([m.text]);
    cs.addRow([]);
    cs.addRow([
      `Ages and workflow states as at ${controls.as_of}; payables as at ${controls.month_end}.`,
    ]);
    for (const sec of controlSections(controls)) {
      cs.addRow([]);
      cs.addRow([sec.title]).font = { bold: true };
      for (const [k, v] of sec.rows) cs.addRow([k, v]);
    }
  }
  cs.addRow([]);
  for (const n of CONTROLS_SCOPE) cs.addRow([n]);

  addTable(
    "By branch",
    [
      { header: "Branch", key: "branch", width: 14 },
      { header: "Invoiced (net)", key: "generated", width: 18, numeric: true },
      { header: "Invoices", key: "invoices", width: 10 },
      { header: "Claimed", key: "claimed", width: 16, numeric: true },
      { header: "Remitted", key: "remitted", width: 16, numeric: true },
      { header: "Rejected", key: "rejected", width: 16, numeric: true },
      { header: "Outstanding", key: "outstanding", width: 16, numeric: true },
      { header: "Claim activities", key: "claims", width: 16 },
      { header: "Self-pay collected", key: "self_pay_collected", width: 18, numeric: true },
    ],
    pack.by_branch.map((b) => ({ ...b })),
  );
  const rev = (key: keyof ClosePack["revenue"], title: string) =>
    addTable(
      title,
      [
        { header: "Key", key: "key", width: 28 },
        { header: "Name", key: "label", width: 34 },
        { header: "Net revenue", key: "net", width: 18, numeric: true },
        { header: "Invoices", key: "invoices", width: 10 },
      ],
      pack.revenue[key].map((r) => ({
        key: r.key,
        label: r.label ?? "",
        net: r.net,
        invoices: r.invoices,
      })),
    );
  rev("by_category", "Revenue by category");
  rev("by_department", "Revenue by department");
  rev("by_doctor", "Revenue by doctor");
  addTable(
    "Collections",
    [
      { header: "Payment mode", key: "mode", width: 24 },
      { header: "Paid", key: "paid", width: 18, numeric: true },
      { header: "Refunds", key: "refunds", width: 18, numeric: true },
    ],
    pack.collections.map((c) => ({ ...c })),
  );
  addTable(
    "Receivables ageing",
    [
      { header: "Age (days)", key: "bucket", width: 14 },
      { header: "Claim activities", key: "claims", width: 18 },
      { header: "Outstanding", key: "outstanding", width: 18, numeric: true },
    ],
    pack.ageing.map((a) => ({ ...a })),
  );
  addTable(
    "Denials",
    [
      { header: "Denial code", key: "reason_code", width: 18 },
      { header: "Meaning", key: "description", width: 50 },
      { header: "Claim activities", key: "claims", width: 16 },
      { header: "Amount", key: "amount", width: 18, numeric: true },
    ],
    pack.denial_reasons.map((r) => ({ ...r, description: r.description ?? "" })),
  );
  const rm = pack.remittance;
  const dn = pack.denials;
  const rec = wb.worksheets.find((w) => w.name === "Denials")!;
  rec.addRow([]);
  rec.addRow(["Denial cases opened in the month", dn.opened_in_month]);
  rec.addRow(["Cases still active", dn.active_now]);
  rec.addRow(["Active amount", dn.active_amount]).getCell(2).numFmt = money;
  rec.addRow(["Open cases past their deadline", dn.past_deadline]);
  rec.addRow([]);
  rec.addRow(["Remittance batches reconciled", rm.batches]);
  rec.addRow(["Remittance lines", rm.lines]);
  rec.addRow(["Short-paid lines", rm.short_lines]);
  rec.addRow(["Short-paid amount", rm.short_amount]).getCell(2).numFmt = money;
  addTable(
    "Cash-up",
    [
      { header: "Branch", key: "branch", width: 14 },
      { header: "Days submitted", key: "days", width: 16 },
      { header: "Expected", key: "expected", width: 16, numeric: true },
      { header: "Counted", key: "counted", width: 16, numeric: true },
      { header: "Variance", key: "variance", width: 16, numeric: true },
    ],
    pack.cashups.map((c) => ({ ...c })),
  );

  return Buffer.from(await wb.xlsx.writeBuffer());
}
