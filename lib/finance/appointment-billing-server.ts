import "server-only";

import { createHash } from "node:crypto";

import type { Capacity, CapacityScope } from "@/lib/capacity/server";
import {
  branchOfClinic,
  branchVisible,
  countVerdicts,
  doctorUtilisation,
  matchAppointments,
  mergeRanges,
  roomKey,
  roomUtilisation,
  type ApptIn,
  type ApptResult,
  type ApptStatus,
  type BranchScope,
  type Counts,
  type InvoiceIn,
  type RoomUtilisation,
  type Utilisation,
} from "@/lib/finance/appointment-billing";
import { coverageOf, monthEnd, type Coverage } from "@/lib/finance/doctor-performance";
import { parseAppointmentFile } from "@/lib/finance/parse-appointments";
import { normaliseDoctorKey } from "@/lib/finance/unite-report-mapping";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { Json } from "@/lib/supabase/types";

/**
 * Appointments <-> invoices (W2). Service role only: every caller has already checked finance.revenue.view (reading) or
 * finance.revenue.import (importing). Nothing here writes to fin_invoices or Unite; the PIN is used to match and is never
 * returned.
 */

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportSummary = {
  uploadId: string;
  existing: boolean;
  rows: number;
  superseded: number;
  fromDate: string;
  toDate: string;
  skipped: number;
  has: { pin: boolean; clinic: boolean; room: boolean; duration: boolean };
  /** Unite clinic names in the file that are not mapped to a branch (names of clinics, not people). */
  unmappedClinics: string[];
};

export type ImportOutcome =
  | { ok: true; summary: ImportSummary }
  | { ok: false; errors: string[]; missing: string[]; unrecognised: string[] };

const DB_ERRORS: Record<string, string> = {
  appt_bad_input: "The file could not be read.",
  appt_rows_out_of_range: "Some appointments are dated outside the file's own date range.",
};

export class AppointmentImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppointmentImportError";
  }
}

/** The branches an appointment file's clinics are mapped through. */
export async function loadBranchNames(admin: AdminClient, orgId: string) {
  const { data, error } = await admin
    .from("fin_ref_branches")
    .select("code, name, unite_clinic_long_name, unite_clinic_aliases")
    .eq("org_id", orgId);
  if (error) throw new Error("Could not load the branches.");
  return data ?? [];
}

/** Parses the file (nothing is kept) and stores the sanitised rows in one transaction. */
export async function importAppointmentFile(
  admin: AdminClient,
  input: { orgId: string; userId: string; buffer: Buffer },
): Promise<ImportOutcome> {
  const parsed = await parseAppointmentFile(input.buffer);
  if (!parsed.ok) return parsed;
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const { data, error } = await admin.rpc("fin_appt_import", {
    p_org_id: input.orgId,
    p_user_id: input.userId,
    p_meta: { file_sha256: sha256, from_date: parsed.fromDate, to_date: parsed.toDate },
    p_rows: parsed.rows as unknown as Json,
  });
  if (error || !data)
    throw new AppointmentImportError(
      DB_ERRORS[error?.message ?? ""] ?? "The database refused the import.",
    );
  const o = data as Record<string, unknown>;
  const branches = await loadBranchNames(admin, input.orgId);
  const unmapped = new Set<string>();
  for (const r of parsed.rows)
    if (r.clinic_name && branchOfClinic(r.clinic_name, branches) === null)
      unmapped.add(r.clinic_name);
  return {
    ok: true,
    summary: {
      uploadId: String(o.upload_id),
      existing: o.existing === true,
      rows: Number(o.rows ?? 0),
      superseded: Number(o.superseded ?? 0),
      fromDate: parsed.fromDate,
      toDate: parsed.toDate,
      skipped: parsed.skipped,
      has: parsed.has,
      unmappedClinics: [...unmapped].sort().slice(0, 10),
    },
  };
}

export function safeImportMessage(err: unknown): string {
  return err instanceof AppointmentImportError
    ? err.message
    : "The file could not be processed. Check that it is the Unite appointment export (.xlsx or .csv).";
}

// ---------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------

/** A line of a list on the page or in the workbook: no PIN, no name. */
export type ApptLine = {
  appointmentId: string;
  date: string;
  status: ApptStatus;
  doctorName: string;
  branch: string | null;
  room: string | null;
  verdict: ApptResult["verdict"];
  basis: ApptResult["basis"];
  reason: ApptResult["reason"];
  invoiceNos: string[];
};
export type InvoiceLine = {
  invoiceNo: string;
  date: string;
  branch: string | null;
  appointmentId: string;
};

export type AppointmentBilling = {
  month: string;
  hasAppointments: boolean;
  coverage: Coverage;
  /** The first and last day the invoices of the month cover; null = no invoices at all. */
  invoiceWindow: { from: string; to: string } | null;
  invoiceCount: number;
  counts: Counts;
  /** Appointments the member may see whose clinic is not mapped to a branch (only an unrestricted member sees them). */
  unknownBranchRows: number;
  seenNotBilled: ApptLine[];
  billedNotSeen: ApptLine[];
  review: ApptLine[];
  invoicesNotInFile: InvoiceLine[];
  doctors: Utilisation[];
  rooms: RoomUtilisation[];
  hasRooms: boolean;
  /** Booked appointments with no duration in the file (utilisation cannot be worked out for them). */
  noDurationRows: number;
  /** Unite doctors with appointments but no available hours (no link to a Pulse doctor, or no working hours). */
  doctorsWithoutHours: number;
  /** True when truncated at the safety ceiling of the reads. */
  truncated: boolean;
};

const CHUNK = 250;
const MAX_ROWS = 60_000;

const need = <T>(r: { data: T | null; error: unknown }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`Could not load ${what}.`);
  return r.data;
};

const toLine = (r: ApptResult): ApptLine => ({
  appointmentId: r.appointmentId,
  date: r.date,
  status: r.status,
  doctorName: r.doctorName,
  branch: r.branch,
  room: r.room,
  verdict: r.verdict,
  basis: r.basis,
  reason: r.reason,
  invoiceNos: r.invoiceNos,
});

export function branchScopeOf(
  scope: Pick<CapacityScope, "allowedCodes" | "revenueBranch" | "revenueAvailable" | "chosen">,
): BranchScope {
  return {
    allowed: scope.allowedCodes,
    branch: scope.chosen ? scope.revenueBranch : null,
    available: scope.revenueAvailable,
  };
}

export async function loadAppointmentBilling(
  admin: AdminClient,
  orgId: string,
  scope: CapacityScope,
  month: string,
  capacity: Capacity,
): Promise<AppointmentBilling> {
  const start = `${month.slice(0, 7)}-01`;
  const nextDate = new Date(`${start}T00:00:00Z`);
  nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
  const next = nextDate.toISOString().slice(0, 10);
  const view = branchScopeOf(scope);

  const [branches, apptR, invR, specialistsR, roomsR] = await Promise.all([
    loadBranchNames(admin, orgId),
    fetchAll(
      (lo, hi) =>
        admin
          .from("fin_appt_rows")
          .select(
            "id, upload_id, appointment_id, appt_date, status, patient_pin, doctor_key, doctor_name, clinic_name, room, duration_min",
          )
          .eq("org_id", orgId)
          .eq("is_current", true)
          .gte("appt_date", start)
          .lt("appt_date", next)
          .order("id")
          .range(lo, hi),
      { max: MAX_ROWS },
    ),
    fetchAll(
      (lo, hi) =>
        admin
          .from("fin_invoices")
          .select(
            "id, inv_display_number, appointment_id, patient_pin, doctor_name, transaction_date, branch_code, net",
          )
          .eq("org_id", orgId)
          .eq("is_deleted", false)
          .gte("transaction_date", start)
          .lt("transaction_date", next)
          .order("id")
          .range(lo, hi),
      { max: MAX_ROWS },
    ),
    admin
      .from("specialists")
      .select("id, report_doctor_key")
      .eq("org_id", orgId)
      .not("report_doctor_key", "is", null),
    scope.scopeIds.length > 0
      ? admin
          .from("rooms")
          .select("id, name, location_id")
          .eq("org_id", orgId)
          .eq("active", true)
          .in("location_id", scope.scopeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const apptRows = need(apptR, "the appointments");
  const monthInvoices = need(invR, "the invoices");
  const specialists = need(specialistsR, "the doctors");
  const rooms = need(roomsR, "the rooms");

  // Invoices dated in the month, then the ones outside it that name one of the month's appointments (an appointment on
  // the 30th can be invoiced on the 1st). A credit note (negative net) is not a bill and is left out.
  const invoiceRows = new Map<string, (typeof monthInvoices)[number]>();
  for (const i of monthInvoices) invoiceRows.set(i.id, i);
  const known = new Set(monthInvoices.map((i) => (i.appointment_id ?? "").trim()).filter(Boolean));
  const wanted = [...new Set(apptRows.map((a) => a.appointment_id.trim()))].filter(
    (id) => !known.has(id),
  );
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const { data, error } = await admin
      .from("fin_invoices")
      .select(
        "id, inv_display_number, appointment_id, patient_pin, doctor_name, transaction_date, branch_code, net",
      )
      .eq("org_id", orgId)
      .eq("is_deleted", false)
      .in("appointment_id", wanted.slice(i, i + CHUNK));
    if (error) throw new Error("Could not load the invoices.");
    for (const inv of data ?? []) invoiceRows.set(inv.id, inv);
  }
  const invoices: InvoiceIn[] = [...invoiceRows.values()]
    .filter((i) => i.transaction_date !== null && !(i.net !== null && Number(i.net) < 0))
    .map((i) => ({
      id: i.id,
      invoiceNo: i.inv_display_number,
      appointmentId: i.appointment_id,
      pin: i.patient_pin,
      doctorKey: i.doctor_name ? normaliseDoctorKey(i.doctor_name) : "",
      date: i.transaction_date as string,
      branch: i.branch_code,
    }));

  // the days the invoice data covers: judged only inside them
  const monthDates = monthInvoices
    .map((i) => i.transaction_date)
    .filter((d): d is string => !!d)
    .sort();
  const invoiceWindow =
    monthDates.length > 0 ? { from: monthDates[0], to: monthDates[monthDates.length - 1] } : null;

  const appts: ApptIn[] = apptRows.map((a) => ({
    id: a.id,
    appointmentId: a.appointment_id,
    date: a.appt_date,
    status: a.status as ApptStatus,
    pin: a.patient_pin,
    doctorKey: a.doctor_key,
    doctorName: a.doctor_name,
    branch: branchOfClinic(a.clinic_name, branches),
    room: a.room,
    minutes: a.duration_min,
  }));

  // match over everything the month holds, then show only what the member may see
  const matched = matchAppointments(appts, invoices, invoiceWindow);

  // an invoice that names an appointment the month does not hold may belong to another month's file: not "missing" then
  let notInFile = matched.invoicesNotInFile.filter((i) => i.date >= start && i.date < next);
  if (notInFile.length > 0) {
    const ids = [...new Set(notInFile.map((i) => (i.appointmentId ?? "").trim()))];
    const elsewhere = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await admin
        .from("fin_appt_rows")
        .select("appointment_id")
        .eq("org_id", orgId)
        .eq("is_current", true)
        .in("appointment_id", ids.slice(i, i + CHUNK));
      if (error) throw new Error("Could not load the appointments.");
      for (const r of data ?? []) elsewhere.add(r.appointment_id.trim());
    }
    notInFile = notInFile.filter((i) => !elsewhere.has((i.appointmentId ?? "").trim()));
  }

  const visible = matched.appointments.filter((r) => branchVisible(view, r.branch));
  const visibleAppts = visible.map(
    ({ id, appointmentId, date, status, pin, doctorKey, doctorName, branch, room, minutes }) => ({
      id,
      appointmentId,
      date,
      status,
      pin,
      doctorKey,
      doctorName,
      branch,
      room,
      minutes,
    }),
  );

  // coverage: the dates of the uploads that still hold current rows in this month
  const uploadIds = [...new Set(apptRows.map((a) => a.upload_id))];
  const ranges = [];
  if (uploadIds.length > 0) {
    const { data, error } = await admin
      .from("fin_appt_uploads")
      .select("from_date, to_date")
      .in("id", uploadIds);
    if (error) throw new Error("Could not load the uploads.");
    for (const u of data ?? [])
      ranges.push({
        from: u.from_date < start ? start : u.from_date,
        to: u.to_date > monthEnd(month) ? monthEnd(month) : u.to_date,
      });
  }

  // utilisation: available hours come from the Capacity page's own numbers through the one doctor link
  const linkOf = new Map(
    specialists.flatMap((s) => (s.report_doctor_key ? [[s.report_doctor_key, s.id] as const] : [])),
  );
  const hoursOf = new Map(capacity.report.doctors.map((d) => [d.specialistId, d.availableHours]));
  const doctors = doctorUtilisation(visibleAppts, (key) => {
    const specialist = linkOf.get(key);
    return specialist ? (hoursOf.get(specialist) ?? null) : null;
  });
  const openHours = capacity.openDays * capacity.openHoursPerDay;
  const codeOfLocation = new Map(scope.locations.map((l) => [l.id, l.branchCode]));
  const roomOpen = new Map(
    rooms.flatMap((r) => {
      const code = codeOfLocation.get(r.location_id);
      return code ? [[`${code}|${roomKey(r.name)}`, openHours] as const] : [];
    }),
  );
  const roomList = roomUtilisation(visibleAppts, (branch, key) =>
    branch ? (roomOpen.get(`${branch}|${key}`) ?? null) : null,
  );

  const lines = (verdict: ApptResult["verdict"]) =>
    visible.filter((r) => r.verdict === verdict).map(toLine);
  return {
    month,
    hasAppointments: apptRows.length > 0,
    coverage: coverageOf(month, mergeRanges(ranges)),
    invoiceWindow,
    invoiceCount: monthInvoices.length,
    counts: countVerdicts(visible),
    unknownBranchRows: visible.filter((r) => r.branch === null).length,
    seenNotBilled: lines("seen_not_billed"),
    billedNotSeen: lines("billed_not_seen"),
    review: lines("review"),
    invoicesNotInFile: notInFile
      .filter((i) => branchVisible(view, i.branch))
      .map((i) => ({
        invoiceNo: i.invoiceNo,
        date: i.date,
        branch: i.branch,
        appointmentId: (i.appointmentId ?? "").trim(),
      })),
    doctors,
    rooms: roomList,
    hasRooms: visibleAppts.some((a) => a.room !== null),
    noDurationRows: visibleAppts.filter((a) => a.status !== "cancelled" && a.minutes === null)
      .length,
    doctorsWithoutHours: doctors.filter((d) => d.availableHours === null).length,
    truncated: !!(apptR.truncated || invR.truncated),
  };
}

/** The month (yyyy-mm-01) of the latest current appointment, or null when nothing has been uploaded. */
export async function latestAppointmentMonth(
  admin: AdminClient,
  orgId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("fin_appt_rows")
    .select("appt_date")
    .eq("org_id", orgId)
    .eq("is_current", true)
    .order("appt_date", { ascending: false })
    .limit(1);
  if (error) throw new Error("Could not read the appointment months.");
  const d = data?.[0]?.appt_date;
  return d ? `${d.slice(0, 7)}-01` : null;
}
