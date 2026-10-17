import { REASON_LABEL, STATUS_LABEL, VERDICT_LABEL } from "@/lib/finance/appointment-billing";
import type { ApptLine, AppointmentBilling } from "@/lib/finance/appointment-billing-server";
import { monthTitle } from "@/lib/finance/flash-xlsx";

/**
 * Appointments <-> invoices as an .xlsx workbook: "Summary", "Seen not billed", "Billed not seen", "Review", "Doctors",
 * "Rooms" (only when the file has a room column) and "Definitions". Plain values, no formulas. Appointment ids, invoice
 * numbers, dates, doctor names, room names and counts only: no PIN, no patient data.
 */

export type AppointmentWorkbookInput = {
  org: string;
  report: AppointmentBilling;
  branchLabel: string;
  /** Finance branch code -> name. */
  branchNames: Record<string, string>;
  builtAt: string;
};

export const APPOINTMENT_DEFINITIONS: readonly (readonly [string, string])[] = [
  [
    "Source",
    "The Unite appointment export (current rows) for the month, matched to the Unite invoices Pulse holds.",
  ],
  [
    "Seen, not billed",
    "Honoured, no invoice found, and the day is inside the dates the invoices cover.",
  ],
  [
    "Billed, not seen",
    "An invoice is tied to the appointment but the appointment is not Honoured (Cancelled, Confirmed or Awaiting confirmation).",
  ],
  [
    "Cancelled, no invoice",
    "Cancelled with no invoice: nothing to do. It is never counted as Seen, not billed.",
  ],
  ["Still open", "Confirmed or Awaiting confirmation with no invoice yet: nothing to do yet."],
  [
    "Seen, no invoice data for that day",
    "Honoured with no invoice, but the invoices Pulse holds do not cover that day, so billing cannot be judged.",
  ],
  ["Matched by appointment id", "The invoice carries the Unite appointment id."],
  [
    "Matched by PIN, doctor and day",
    "Only for an appointment with no invoice by id: a direct invoice (no appointment id) for the same Unite PIN, the same doctor and the same day, when exactly one appointment that is not cancelled has that PIN, doctor and day.",
  ],
  [
    "Needs review",
    "The appointment id appears more than once in the file, or several appointments share the PIN, doctor and day so an invoice cannot be tied to one. Never guessed.",
  ],
  [
    "Invoice's appointment not in the file",
    "An invoice dated in the month names an appointment id that no uploaded appointment file holds. An invoice with no appointment id (a direct invoice) is valid and is not listed.",
  ],
  ["Booked", "Appointments that are not cancelled."],
  ["Seen", "Appointments that are Honoured."],
  [
    "Utilisation",
    "Booked (or seen) hours divided by available hours. Booked hours are the appointments' durations in the file (end minus start, else the duration column). Blank when any booked appointment has no duration, when the doctor is not linked to a Pulse doctor (Doctors page), or when the room is not in Settings, Rooms.",
  ],
  [
    "Doctor available hours",
    "Working hours on open days minus blocks and leave, as on the Capacity page.",
  ],
  ["Room open hours", "Open days times the room opening hours set on the Capacity page."],
  ["Review signals", "These lists are prompts to check Unite, never proof of an error."],
];

const statusText = (l: ApptLine) => STATUS_LABEL[l.status];

export async function appointmentBillingWorkbook(input: AppointmentWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;
  const r = input.report;
  const month = monthTitle(r.month);
  const branch = (code: string | null) =>
    code === null ? "Unknown branch" : (input.branchNames[code] ?? code);

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  const header = (ws: Sheet, cells: string[]) => {
    const row = ws.addRow(cells);
    row.font = { bold: true };
    row.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
    });
  };
  const heading = (ws: Sheet, what: string) => {
    ws.addRow([`${input.org}: ${what}, ${month}`]).font = { bold: true, size: 13 };
    ws.addRow([`Branch: ${input.branchLabel}. Appointment dates covered: ${r.coverage.label}.`]);
    ws.addRow([]);
  };

  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ width: 44 }, { width: 12 }];
  heading(summary, "appointments and invoices");
  header(summary, ["Measure", "Appointments"]);
  for (const k of [
    "seen_billed",
    "seen_not_billed",
    "billed_not_seen",
    "review",
    "cancelled",
    "open",
    "not_judged",
  ] as const)
    summary.addRow([VERDICT_LABEL[k], r.counts[k]]);
  summary.addRow(["Total appointments", r.counts.total]).font = { bold: true };
  summary.addRow([`Invoices not tied to an appointment in the file`, r.invoicesNotInFile.length]);
  summary.addRow([]);
  summary.addRow([
    r.invoiceWindow
      ? `Invoices in Pulse cover ${r.invoiceWindow.from} to ${r.invoiceWindow.to} (${r.invoiceCount} invoices).`
      : "No invoices in Pulse for this month: billing cannot be judged.",
  ]);

  const list = (name: string, lines: ApptLine[], withInvoice: boolean) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { width: 16 },
      { width: 12 },
      { width: 22 },
      { width: 30 },
      { width: 22 },
      { width: 14 },
      { width: 44 },
      { width: 26 },
    ];
    heading(ws, name.toLowerCase());
    header(ws, [
      "Appointment ID",
      "Date",
      "Status",
      "Doctor",
      "Branch",
      "Room",
      withInvoice ? "Invoice(s)" : "Why",
      "Matched by",
    ]);
    for (const l of lines)
      ws.addRow([
        l.appointmentId,
        l.date,
        statusText(l),
        l.doctorName,
        branch(l.branch),
        l.room ?? "",
        withInvoice ? l.invoiceNos.join(", ") : l.reason ? REASON_LABEL[l.reason] : "",
        l.basis === "appointment_id"
          ? "Appointment id"
          : l.basis === "pin_doctor_day"
            ? "PIN, doctor and day"
            : "",
      ]);
    return ws;
  };
  list("Seen not billed", r.seenNotBilled, true);
  list("Billed not seen", r.billedNotSeen, true);
  const review = list("Review", r.review, false);
  if (r.invoicesNotInFile.length > 0) {
    review.addRow([]);
    header(review, ["Invoice", "Date", "Appointment ID named by the invoice", "", "Branch"]);
    for (const i of r.invoicesNotInFile)
      review.addRow([i.invoiceNo, i.date, i.appointmentId, "", branch(i.branch)]);
  }

  const hrs = (v: number | null) => (v === null ? "" : v);
  const util = (name: string, firstCols: string[], rows: (string | number)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [
      ...firstCols.map(() => ({ width: 28 })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(() => ({ width: 16 })),
    ];
    heading(ws, `${name.toLowerCase()} utilisation`);
    header(ws, [
      ...firstCols,
      "Booked",
      "Seen",
      "Cancelled",
      "Booked hours",
      "Seen hours",
      "Available hours",
      "Booked %",
      "Seen %",
    ]);
    for (const row of rows) ws.addRow(row);
  };
  util(
    "Doctors",
    ["Doctor"],
    r.doctors.map((d) => [
      d.name,
      d.booked,
      d.seen,
      d.cancelled,
      hrs(d.bookedHours),
      hrs(d.seenHours),
      hrs(d.availableHours),
      hrs(d.bookedPct),
      hrs(d.seenPct),
    ]),
  );
  if (r.hasRooms)
    util(
      "Rooms",
      ["Room", "Branch"],
      r.rooms.map((d) => [
        d.room,
        branch(d.branch),
        d.booked,
        d.seen,
        d.cancelled,
        hrs(d.bookedHours),
        hrs(d.seenHours),
        hrs(d.availableHours),
        hrs(d.bookedPct),
        hrs(d.seenPct),
      ]),
    );

  const defs = wb.addWorksheet("Definitions");
  defs.columns = [{ width: 40 }, { width: 120 }];
  defs.addRow(["Definitions"]).font = { bold: true, size: 13 };
  header(defs, ["Measure", "Definition"]);
  for (const [k, v] of APPOINTMENT_DEFINITIONS) defs.addRow([k, v]);
  defs.addRow([]);
  defs.addRow(["Built", input.builtAt]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
