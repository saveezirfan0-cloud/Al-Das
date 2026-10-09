/**
 * Unite payload → Pulse shapes (pure). Unite's date format and the patient/doctor payloads are
 * not fully documented, so every reader is tolerant (case-insensitive keys, several date layouts)
 * and anything it cannot read is reported, never guessed.
 */
import { fromZonedTime } from "date-fns-tz";

import { normalizePhone } from "@/lib/phone";

export type RawRecord = Record<string, unknown>;

/** First present, non-empty value among the candidate keys (case-insensitive). */
export function pick(rec: RawRecord, ...keys: string[]): string | null {
  const lower = new Map(Object.keys(rec).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const real = lower.get(key.toLowerCase());
    if (real === undefined) continue;
    const v = rec[real];
    if (v === null || v === undefined) continue;
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (s) return s;
  }
  return null;
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DMY =
  /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;

function valid(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Parses a Unite date-time as a clinic wall-clock time in `timezone` (an explicit offset or Z in
 * the string wins). Understands ISO 8601 and day-first DD-MM-YYYY / DD/MM/YYYY (optional AM/PM).
 * Returns null when it cannot be read — day-first is assumed, never month-first.
 */
export function parseUniteTime(input: string | null | undefined, timezone: string): Date | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  const iso = ISO.exec(s);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0", zone] = iso;
    if (!valid(+y, +mo, +d) || +h > 23 || +mi > 59 || +sec > 59) return null;
    if (zone) {
      const z =
        zone.toUpperCase() === "Z"
          ? "Z"
          : zone.length === 5
            ? `${zone.slice(0, 3)}:${zone.slice(3)}`
            : zone;
      const dt = new Date(`${y}-${mo}-${d}T${p2(+h)}:${p2(+mi)}:${p2(+sec)}${z}`);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
    return fromZonedTime(`${y}-${mo}-${d}T${p2(+h)}:${p2(+mi)}:${p2(+sec)}`, timezone);
  }

  const dmy = DMY.exec(s);
  if (dmy) {
    const [, d, mo, y, h = "0", mi = "0", sec = "0", ampm] = dmy;
    let hour = +h;
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (ampm.toUpperCase() === "PM" ? 12 : 0);
    }
    if (!valid(+y, +mo, +d) || hour > 23 || +mi > 59 || +sec > 59) return null;
    return fromZonedTime(`${y}-${p2(+mo)}-${p2(+d)}T${p2(hour)}:${p2(+mi)}:${p2(+sec)}`, timezone);
  }
  return null;
}

/** A date-only value (date of birth) as YYYY-MM-DD, or null. */
export function parseUniteDate(input: string | null | undefined, timezone = "UTC"): string | null {
  const d = parseUniteTime(input, timezone);
  if (!d) return null;
  const s = (input ?? "").trim();
  // Date-only strings carry no time zone ambiguity: read the calendar date literally.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${p2(+dmy[2])}-${p2(+dmy[1])}`;
  return d.toISOString().slice(0, 10);
}

export type MappedAppointment = {
  externalId: string;
  clinicId: string | null;
  startsAt: Date;
  endsAt: Date;
  doctorId: string | null;
  doctorName: string | null;
  statusCode: string | null;
  notes: string | null;
  createdBy: string | null;
  patient: {
    pin: string | null;
    name: string;
    phoneE164: string | null;
    nationality: string | null;
  };
};

export type MapFailure = "missing_id" | "unparseable_time" | "end_before_start";

const DEFAULT_DURATION_MS = 30 * 60_000;

export function mapAppointment(
  raw: RawRecord,
  opts: { timezone: string; clinicId?: string | null },
): { ok: true; value: MappedAppointment } | { ok: false; reason: MapFailure } {
  const externalId = pick(raw, "appointmentid", "appointment_id", "id");
  if (!externalId) return { ok: false, reason: "missing_id" };
  const startsAt = parseUniteTime(
    pick(raw, "appointmentstarttime", "starttime", "start"),
    opts.timezone,
  );
  if (!startsAt) return { ok: false, reason: "unparseable_time" };
  const endRaw = pick(raw, "appointmentendtime", "endtime", "end");
  const endsAt = endRaw
    ? parseUniteTime(endRaw, opts.timezone)
    : new Date(startsAt.getTime() + DEFAULT_DURATION_MS);
  if (!endsAt) return { ok: false, reason: "unparseable_time" };
  if (endsAt <= startsAt) return { ok: false, reason: "end_before_start" };

  const phoneRaw = pick(raw, "patientmobilephone", "mobilephone", "phone", "mobile");
  return {
    ok: true,
    value: {
      externalId,
      clinicId: pick(raw, "clinic_id", "clinicid") ?? opts.clinicId ?? null,
      startsAt,
      endsAt,
      doctorId: pick(raw, "doctor_id", "doctorid"),
      doctorName: pick(raw, "doctorname", "doctor_name"),
      statusCode: pick(raw, "status")?.toUpperCase() ?? null,
      notes: pick(raw, "remarks", "notes"),
      createdBy: pick(raw, "createdby", "created_by"),
      patient: {
        pin: pick(raw, "patientpin", "pin", "patient_pin"),
        name: pick(raw, "patientfullname", "patientname", "fullname") ?? "",
        phoneE164: phoneRaw ? (normalizePhone(phoneRaw, "AE")?.e164 ?? null) : null,
        nationality: pick(raw, "nationality"),
      },
    },
  };
}

export type MappedDoctor = { externalId: string; name: string; department: string | null };

export function mapDoctor(raw: RawRecord): MappedDoctor | null {
  const externalId = pick(raw, "doctor_id", "doctorid", "id", "code");
  const name = pick(raw, "doctor_name", "doctorname", "name", "fullname");
  if (!externalId || !name) return null;
  return {
    externalId,
    name,
    department: pick(raw, "department", "department_name", "speciality", "specialty"),
  };
}

export type MappedPatient = {
  pin: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phoneE164: string | null;
  email: string | null;
  dob: string | null;
  gender: "female" | "male" | "other" | "unknown" | null;
  nationality: string | null;
};

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function mapPatient(raw: RawRecord, opts: { timezone: string }): MappedPatient | null {
  const pin = pick(raw, "patientpin", "pin", "patient_pin", "mrn", "id");
  const full =
    pick(raw, "patientfullname", "fullname", "patientname", "name") ??
    [pick(raw, "firstname", "first_name"), pick(raw, "lastname", "last_name")]
      .filter(Boolean)
      .join(" ");
  if (!pin || !full) return null;
  const phone = pick(raw, "patientmobilephone", "mobilephone", "mobile", "phone");
  const g = pick(raw, "gender", "sex")?.toLowerCase();
  const { first, last } = splitName(full);
  return {
    pin,
    firstName: first,
    lastName: last,
    fullName: full,
    phoneE164: phone ? (normalizePhone(phone, "AE")?.e164 ?? null) : null,
    email: pick(raw, "email", "emailaddress"),
    dob: parseUniteDate(
      pick(raw, "dob", "dateofbirth", "birthdate", "date_of_birth"),
      opts.timezone,
    ),
    gender: !g
      ? null
      : /^f/.test(g)
        ? "female"
        : /^m/.test(g)
          ? "male"
          : /^o/.test(g)
            ? "other"
            : "unknown",
    nationality: pick(raw, "nationality"),
  };
}
