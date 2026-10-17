import {
  APPOINTMENT_FIELDS,
  APPOINTMENT_FIELD_KEYS,
  HEADER_SCAN_ROWS,
  headerToken,
  MAX_APPOINTMENT_ROWS,
  MAX_SPAN_DAYS,
  STATUS_WORDS,
  type AppointmentField,
  type AppointmentStatus,
} from "@/lib/finance/appointment-mapping";
import { readImportFile } from "@/lib/finance/parse-import";
import {
  cleanText,
  NO_DOCTOR_KEY,
  NO_DOCTOR_NAME,
  normaliseDoctorKey,
  titleDate,
} from "@/lib/finance/unite-report-mapping";
import { buildUploadPreview, type UploadPreview } from "@/lib/upload/preview";

/**
 * The Unite appointment export -> sanitised appointment rows (W2). Pure apart from reading the file. Column names come
 * only from appointment-mapping.ts; only the mapped columns are read. Anything unexpected refuses the whole file with a
 * fixed sentence that carries row numbers, field names and counts, never a cell value (the one exception: unrecognised
 * status WORDS, which are Unite's own vocabulary, are listed so they can be decided on).
 */

export type AppointmentRow = {
  /** 1-based position among the data rows below the header. */
  row_no: number;
  appointment_id: string;
  appt_date: string;
  /** Minutes after midnight, clinic wall clock; null when the file does not say. */
  start_min: number | null;
  duration_min: number | null;
  status: AppointmentStatus;
  patient_pin: string | null;
  doctor_name: string;
  doctor_key: string;
  clinic_name: string | null;
  room: string | null;
};

export type ParsedAppointments =
  | {
      ok: true;
      rows: AppointmentRow[];
      fromDate: string;
      toDate: string;
      /** Blank rows (and total lines) left out. */
      skipped: number;
      /** Which optional fields the file has, so the page can say what it can and cannot do. */
      has: { pin: boolean; clinic: boolean; room: boolean; duration: boolean };
    }
  | { ok: false; errors: string[]; missing: string[]; unrecognised: string[] };

type Table = ReadonlyArray<ReadonlyArray<unknown>>;
type Located = Partial<Record<AppointmentField, { idx: number; header: string }>>;

const MAX_ERRORS = 10;
const MAX_UNRECOGNISED = 30;

const cellText = (v: unknown): string =>
  typeof v === "string" ? v : v == null ? "" : v instanceof Date ? "" : String(v);
const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const TOKEN_TO_FIELD = new Map<string, AppointmentField>();
for (const key of APPOINTMENT_FIELD_KEYS)
  for (const alias of APPOINTMENT_FIELDS[key].aliases) TOKEN_TO_FIELD.set(headerToken(alias), key);

// ---- the header row ----------------------------------------------------------------------------------------------

type Scan = {
  located: Located;
  /** Fields matched by two different columns. */
  clashes: AppointmentField[];
  found: number;
  row: number;
};

function scanRow(cells: ReadonlyArray<unknown>, row: number): Scan {
  const located: Located = {};
  const clashes = new Set<AppointmentField>();
  cells.forEach((c, idx) => {
    const text = cellText(c).trim();
    if (!text) return;
    const field = TOKEN_TO_FIELD.get(headerToken(text));
    if (!field) return;
    if (located[field]) clashes.add(field);
    else located[field] = { idx, header: text };
  });
  const found = APPOINTMENT_FIELD_KEYS.filter(
    (k) => APPOINTMENT_FIELDS[k].required && located[k],
  ).length;
  return { located, clashes: [...clashes], found, row };
}

/** The header row: the first row (of the first 30) with every required field; else the closest one, for the message. */
function findHeader(table: Table): { best: Scan; complete: boolean } {
  let best: Scan = { located: {}, clashes: [], found: -1, row: -1 };
  const required = APPOINTMENT_FIELD_KEYS.filter((k) => APPOINTMENT_FIELDS[k].required).length;
  for (let r = 0; r < Math.min(table.length, HEADER_SCAN_ROWS); r++) {
    const s = scanRow(table[r] ?? [], r);
    if (s.found > best.found) best = s;
    if (s.found === required) return { best: s, complete: true };
  }
  if (best.row < 0) {
    const first = table.findIndex((r) => r.some((c) => !isBlank(c)));
    best = { located: {}, clashes: [], found: 0, row: first < 0 ? 0 : first };
  }
  return { best, complete: false };
}

function unrecognisedNames(header: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  for (const c of header) {
    const t = cellText(c).replace(/\s+/g, " ").trim();
    if (!t || TOKEN_TO_FIELD.has(headerToken(t))) continue;
    const name = clip(t, 60);
    if (!out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_UNRECOGNISED);
}

// ---- values ------------------------------------------------------------------------------------------------------

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const pad = (n: number) => String(n).padStart(2, "0");

function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "14-Oct-2026", "14/10/2026" (day first, as in the UAE) or "2026-10-14" -> "2026-10-14"; null when it is not a date. */
function datePart(s: string): string | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return ymd(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]+(\d{4})$/.exec(s);
  if (m) {
    const word = m[2].toLowerCase();
    const known = MONTH_NAMES.findIndex(
      (n) => word === n || word === n.slice(0, 3) || (n === "september" && word === "sept"),
    );
    return known < 0 ? null : titleDate(m[1], MONTH_NAMES[known].slice(0, 3), m[3]);
  }
  return null;
}

/** "09:30", "9:30:00", "9:30 AM" -> minutes after midnight; null when it is not a time. */
function timePart(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + min;
}

/** An Excel cell holding a date (exceljs puts the wall clock in the UTC fields) or a time of day. */
const dateCellMinutes = (d: Date): number | null => {
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min === 0 ? null : min;
};

/** The date column: a date, optionally with a time ("14-Oct-2026 09:30"). null = blank, "invalid" = unreadable. */
export function readApptDate(
  v: unknown,
): { date: string; minutes: number | null } | null | "invalid" {
  if (isBlank(v)) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "invalid";
    return {
      date: ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) ?? "",
      minutes: dateCellMinutes(v),
    };
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 20_000 || v > 80_000) return "invalid"; // an Excel serial date
    return readApptDate(new Date(Math.round((v - 25_569) * 86_400_000)));
  }
  if (typeof v !== "string") return "invalid";
  const s = v.trim().replace(/\s+/g, " ");
  const m = /^(.*?)(?: |T)(\d{1,2}:\d{2}(?::\d{2})?(?: ?[AaPp][Mm])?)$/.exec(s);
  const date = datePart(m ? m[1] : s);
  if (!date) return "invalid";
  if (!m) return { date, minutes: null };
  const minutes = timePart(m[2]);
  return minutes === null ? "invalid" : { date, minutes };
}

/** A start or end time column. null = blank, "invalid" = unreadable. */
export function readApptTime(v: unknown): number | null | "invalid" {
  if (isBlank(v)) return null;
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? "invalid" : v.getUTCHours() * 60 + v.getUTCMinutes();
  if (typeof v === "number") return v >= 0 && v < 1 ? Math.round(v * 1440) % 1440 : "invalid"; // fraction of a day
  if (typeof v !== "string") return "invalid";
  const t = timePart(v);
  if (t !== null) return t;
  const dt = readApptDate(v); // "14-Oct-2026 09:30" in a time column
  return dt && dt !== "invalid" && dt.minutes !== null ? dt.minutes : "invalid";
}

/** A duration in whole minutes: 30, "30", "30 min". null = blank, "invalid" = unreadable. */
export function readDuration(v: unknown): number | null | "invalid" {
  if (isBlank(v)) return null;
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 1440 ? v : "invalid";
  if (typeof v !== "string") return "invalid";
  const m = /^(\d{1,4})(?:\s*(?:min|mins|minutes?))?$/i.exec(v.trim());
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 1440 ? n : "invalid";
}

/** Unite's appointment status word. */
export function readStatus(v: unknown): AppointmentStatus | null | "invalid" {
  const s = cleanText(v);
  if (s === null) return null;
  return STATUS_WORDS[s.toLowerCase().replace(/[\s._-]+/g, "")] ?? "invalid";
}

/** A short identifier (appointment id, PIN): numbers keep their digits. null = blank, false = unreadable. */
function idCell(v: unknown, max: number): string | null | false {
  if (isBlank(v)) return null;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : false;
  if (typeof v !== "string") return false;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? false : s;
}

// ---- the table ---------------------------------------------------------------------------------------------------

export function parseAppointmentTable(table: Table): ParsedAppointments {
  const { best, complete } = findHeader(table);
  const headerCells = table[best.row] ?? [];
  const missing = APPOINTMENT_FIELD_KEYS.filter(
    (k) => APPOINTMENT_FIELDS[k].required && !best.located[k],
  ).map(
    (k) =>
      `${APPOINTMENT_FIELDS[k].label} (expected a header such as "${APPOINTMENT_FIELDS[k].aliases[0]}")`,
  );
  if (!complete)
    return {
      ok: false,
      errors: [`The file is missing ${missing.length} required column(s).`],
      missing,
      unrecognised: unrecognisedNames(headerCells),
    };
  if (best.clashes.length > 0)
    return {
      ok: false,
      errors: best.clashes.map(
        (k) =>
          `More than one column could be the ${APPOINTMENT_FIELDS[k].label}. Remove the extra column or rename it.`,
      ),
      missing: [],
      unrecognised: unrecognisedNames(headerCells),
    };

  const col = best.located;
  const at = (row: ReadonlyArray<unknown>, f: AppointmentField) =>
    col[f] ? row[col[f]!.idx] : null;
  const errors: string[] = [];
  let errorTotal = 0;
  const unknownStatuses = new Set<string>();
  const fail = (msg: string) => {
    errorTotal++;
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  const rows: AppointmentRow[] = [];
  let skipped = 0;
  let rowNo = 0;
  for (let r = best.row + 1; r < table.length; r++) {
    const row = table[r] ?? [];
    const read = APPOINTMENT_FIELD_KEYS.filter((k) => col[k]).map((k) => at(row, k));
    if (read.every(isBlank)) {
      skipped++;
      continue;
    }
    rowNo++;
    const where = (f: AppointmentField) => `Row ${r + 1}: the ${APPOINTMENT_FIELDS[f].label}`;
    const id = idCell(at(row, "appointment_id"), 60);
    const dt = readApptDate(at(row, "date"));
    const statusCell = at(row, "status");
    const status = readStatus(statusCell);
    // a line where only the id cell is filled ("Total", a count) is a footer, not an appointment
    if (
      read.filter((c) => !isBlank(c)).length <= 1 &&
      isBlank(at(row, "date")) &&
      isBlank(statusCell)
    ) {
      skipped++;
      rowNo--;
      continue;
    }
    let bad = false;
    const need = (cond: boolean, msg: string) => {
      if (!cond) {
        fail(msg);
        bad = true;
      }
    };
    need(typeof id === "string", `${where("appointment_id")} is blank or not readable.`);
    need(
      dt !== null && dt !== "invalid" && dt.date !== "",
      `${where("date")} is blank or not a date.`,
    );
    if (status === "invalid") {
      unknownStatuses.add(clip(cleanText(statusCell) ?? "", 40));
      bad = true;
    } else need(status !== null, `${where("status")} is blank.`);

    const pin = col.patient_pin ? idCell(at(row, "patient_pin"), 40) : null;
    need(pin !== false, `${where("patient_pin")} is not readable.`);
    const startCol = col.start_time ? readApptTime(at(row, "start_time")) : null;
    need(startCol !== "invalid", `${where("start_time")} is not a time.`);
    const endCol = col.end_time ? readApptTime(at(row, "end_time")) : null;
    need(endCol !== "invalid", `${where("end_time")} is not a time.`);
    const durCol = col.duration ? readDuration(at(row, "duration")) : null;
    need(durCol !== "invalid", `${where("duration")} is not a number of minutes.`);
    const clinic = col.clinic ? cleanText(at(row, "clinic")) : null;
    need(clinic === null || clinic.length <= 200, `${where("clinic")} is too long.`);
    const roomText = col.room ? cleanText(at(row, "room")) : null;
    need(roomText === null || roomText.length <= 60, `${where("room")} is too long.`);
    if (bad) continue;

    const date = (dt as { date: string; minutes: number | null }).date;
    const start =
      typeof startCol === "number" ? startCol : (dt as { minutes: number | null }).minutes;
    let duration: number | null = typeof durCol === "number" ? durCol : null;
    if (typeof startCol === "number" && typeof endCol === "number") {
      if (endCol <= startCol) {
        fail(`Row ${r + 1}: the End time is not after the Start time.`);
        continue;
      }
      duration = endCol - startCol;
    }
    const doctor = cleanText(at(row, "doctor"));
    rows.push({
      row_no: rowNo,
      appointment_id: id as string,
      appt_date: date,
      start_min: start,
      duration_min: duration,
      status: status as AppointmentStatus,
      patient_pin: typeof pin === "string" ? pin : null,
      doctor_name: doctor ?? NO_DOCTOR_NAME,
      doctor_key: doctor ? normaliseDoctorKey(doctor) || NO_DOCTOR_KEY : NO_DOCTOR_KEY,
      clinic_name: clinic,
      room: roomText,
    });
    if (rows.length > MAX_APPOINTMENT_ROWS)
      return fileProblem(
        `The file has more than ${MAX_APPOINTMENT_ROWS} appointments. Export one month at a time.`,
      );
  }

  if (errorTotal > errors.length)
    errors.push(`...and ${errorTotal - errors.length} more row problem(s).`);
  if (unknownStatuses.size > 0) {
    const words = [...unknownStatuses].slice(0, 5).map((w) => `"${w}"`);
    errors.push(
      `The file has appointment statuses Pulse does not know (${words.join(", ")}${unknownStatuses.size > 5 ? ", ..." : ""}). Nothing was imported: a new Unite status has to be decided on first.`,
    );
  }
  if (errors.length > 0) return { ok: false, errors, missing: [], unrecognised: [] };
  if (rows.length === 0) return fileProblem("The file has a header row but no appointments.");

  const dates = rows.map((r) => r.appt_date).sort();
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];
  const span = (Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000;
  if (span > MAX_SPAN_DAYS)
    return fileProblem(
      `The appointment dates run from ${fromDate} to ${toDate}, more than ${MAX_SPAN_DAYS} days. Check the dates and export one month at a time.`,
    );
  return {
    ok: true,
    rows,
    fromDate,
    toDate,
    skipped,
    has: {
      pin: !!col.patient_pin && rows.some((r) => r.patient_pin !== null),
      clinic: !!col.clinic && rows.some((r) => r.clinic_name !== null),
      room: !!col.room && rows.some((r) => r.room !== null),
      duration: rows.some((r) => r.duration_min !== null),
    },
  };
}

const fileProblem = (message: string): ParsedAppointments => ({
  ok: false,
  errors: [message],
  missing: [],
  unrecognised: [],
});

/** Reads the uploaded .xlsx (first sheet) or .csv. Throws when the file cannot be opened at all. */
export async function parseAppointmentFile(buffer: Buffer): Promise<ParsedAppointments> {
  return parseAppointmentTable(await readImportFile(buffer));
}

// ---- the preview -------------------------------------------------------------------------------------------------

/**
 * The preview shown before the import: the first rows of the columns that will be read (a PIN masked), the names of the
 * columns that will be ignored (names only, never values) and the required columns the file lacks.
 */
export function previewAppointmentTable(table: Table): UploadPreview {
  const { best } = findHeader(table);
  const wanted = APPOINTMENT_FIELD_KEYS.flatMap((k) => {
    const spec = APPOINTMENT_FIELDS[k];
    const found = best.located[k];
    if (found) return [{ field: k, label: spec.label, header: found.header }];
    return spec.required ? [{ field: k, label: spec.label, header: spec.aliases[0] }] : [];
  });
  return buildUploadPreview(table, wanted, {
    key: headerToken,
    format: (field, value) => {
      if (value == null) return "";
      if (value instanceof Date)
        return Number.isNaN(value.getTime())
          ? ""
          : value.toISOString().slice(0, 16).replace("T", " ");
      const text = String(value);
      if (field === "patient_pin") {
        const t = text.trim();
        return t ? `•••${t.slice(-3)}` : "";
      }
      return text;
    },
  });
}
