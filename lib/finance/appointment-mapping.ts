/**
 * The ONLY place that knows the column names of the Unite appointment export (.xlsx or .csv), W2
 * (docs/47_W2_APPOINTMENTS_INVOICES_NOTES.md).
 *
 * The real export was only seen as a one-day sample that is not in the repository, so every alias below is an
 * ASSUMPTION. When the first real file is refused, the message names the fields that were not found and lists the file's
 * headers it did not recognise (names only, never values); add the real header to the right list and nothing else changes.
 *
 * - A header matches an alias ignoring case, spaces, dots, underscores and dashes. Aliases are listed in priority order.
 * - A header that appears twice in the header row, or two different headers that match the same field, refuse the
 *   file (which one to read would be a guess).
 * - A column that is not listed here is NEVER read: patient name, date of birth, Emirates ID, phone and insurance member
 *   id can never reach Pulse because no field exists for them.
 */

export type AppointmentField =
  | "appointment_id"
  | "date"
  | "status"
  | "doctor"
  | "patient_pin"
  | "clinic"
  | "room"
  | "start_time"
  | "end_time"
  | "duration";

export const APPOINTMENT_FIELDS: Record<
  AppointmentField,
  { label: string; aliases: readonly string[]; required: boolean }
> = {
  appointment_id: {
    label: "Appointment ID",
    aliases: ["Appointment ID", "Appointment No", "Appointment Number", "Appt ID", "Appt No"],
    required: true,
  },
  date: {
    label: "Appointment date",
    aliases: ["Appointment Date", "Appt Date", "Appointment Date Time"],
    required: true,
  },
  status: {
    label: "Appointment status",
    aliases: ["Appointment Status", "Appt Status", "Status"],
    required: true,
  },
  doctor: {
    label: "Doctor",
    aliases: ["Doctor Name", "Doctor", "Consultant Name", "Consultant"],
    required: true,
  },
  patient_pin: {
    label: "Unite PIN",
    aliases: ["PIN", "PIN No", "Patient PIN", "UHID"],
    required: false,
  },
  clinic: {
    label: "Clinic",
    aliases: ["Clinic Name", "Clinic", "Branch"],
    required: false,
  },
  room: {
    label: "Room",
    aliases: ["Room", "Room Name", "Room No", "Consultation Room"],
    required: false,
  },
  start_time: {
    label: "Start time",
    aliases: ["Start Time", "From Time", "Appointment Time", "Slot Time"],
    required: false,
  },
  end_time: {
    label: "End time",
    aliases: ["End Time", "To Time"],
    required: false,
  },
  duration: {
    label: "Duration (minutes)",
    aliases: [
      "Duration",
      "Duration (Min)",
      "Duration (Mins)",
      "Duration In Minutes",
      "Slot Duration",
    ],
    required: false,
  },
};

export const APPOINTMENT_FIELD_KEYS = Object.keys(APPOINTMENT_FIELDS) as AppointmentField[];

/** How far down the sheet the header row is looked for (exports often start with a title line). */
export const HEADER_SCAN_ROWS = 30;
export const MAX_APPOINTMENT_ROWS = 30_000;
export const MAX_APPOINTMENT_BYTES = 10 * 1024 * 1024;
/** One file may not span more than this many days (a slip of the year would otherwise supersede a lot). */
export const MAX_SPAN_DAYS = 400;

/** Header text compared by this key. */
export const headerToken = (s: string): string => s.toLowerCase().replace(/[\s._\-()]+/g, "");

export type AppointmentStatus = "awaiting" | "confirmed" | "honoured" | "cancelled";

/**
 * Unite's appointment statuses seen so far (docs/41): Awaiting Confirmation, Confirmed, Honoured, Cancelled. Compared
 * ignoring case and spacing. Anything else refuses the file (a new Unite status must be decided on, not guessed).
 */
export const STATUS_WORDS: Record<string, AppointmentStatus> = {
  awaitingconfirmation: "awaiting",
  confirmed: "confirmed",
  honoured: "honoured",
  honored: "honoured",
  cancelled: "cancelled",
  canceled: "cancelled",
};
