/**
 * The Today board (pure): how an appointment is classified for the desk and how the day is summarised.
 * "Confirmed" comes from the appointment status, which the patient's Confirm button on the reminder (or staff)
 * sets; "unconfirmed" is everything still awaiting. The reminder state tells the desk whether to ring.
 */
import { formatInTimeZone } from "date-fns-tz";

import { isCheckinState, type CheckinState } from "@/lib/front-desk/checkin";

export type ReminderState = "sent" | "scheduled" | "failed" | "excluded" | "cancelled" | null;

export type BoardAppointment = {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
  status: string;
  checkin_status: string | null;
  arrived_at: string | null;
  is_walk_in: boolean;
  source: string;
  contact_id: string | null;
  specialist_id: string | null;
  reminder: ReminderState;
};

/** Minutes after the start time before a patient who has not arrived is flagged as late. */
export const DEFAULT_LATE_GRACE_MIN = 15;

export type BoardSection =
  | "cancelled"
  | "no_show"
  | "waiting"
  | "with_doctor"
  | "done"
  | "checked_out"
  | "late"
  | "expected";

export function boardSection(
  a: Pick<BoardAppointment, "status" | "checkin_status" | "starts_at">,
  now: Date,
  graceMin = DEFAULT_LATE_GRACE_MIN,
): BoardSection {
  if (a.status === "cancelled") return "cancelled";
  if (a.status === "no_show") return "no_show";
  const state: CheckinState | null = isCheckinState(a.checkin_status) ? a.checkin_status : null;
  if (state === "arrived") return "waiting";
  if (state === "with_doctor") return "with_doctor";
  if (state === "done") return "done";
  if (state === "checked_out") return "checked_out";
  // Completed in the EMR (Unite) without anyone tapping through the desk states.
  if (a.status === "completed") return "done";
  const lateAt = new Date(a.starts_at).getTime() + graceMin * 60_000;
  return now.getTime() <= lateAt ? "expected" : "late";
}

export type Confirmation = "confirmed" | "unconfirmed";

export function confirmation(a: Pick<BoardAppointment, "status">): Confirmation {
  return a.status === "confirmed" || a.status === "completed" ? "confirmed" : "unconfirmed";
}

/** What the desk should do about an unconfirmed appointment, from the reminder's fate. */
export function reminderHint(
  a: Pick<BoardAppointment, "status" | "reminder">,
): "none" | "call" | "waiting_reply" | "not_sent_yet" {
  if (confirmation(a) === "confirmed") return "none";
  switch (a.reminder) {
    case "failed":
      return "call";
    case "sent":
      return "waiting_reply";
    case "scheduled":
      return "not_sent_yet";
    default:
      return "call"; // excluded / cancelled / never planned: nobody has asked the patient yet
  }
}

export type BoardSummary = {
  expected: number;
  waiting: number;
  withDoctor: number;
  done: number;
  checkedOut: number;
  late: number;
  noShow: number;
  cancelled: number;
  walkIns: number;
  confirmed: number;
  unconfirmed: number;
  /** Everything that is not cancelled. */
  total: number;
};

export function summariseBoard(
  rows: readonly BoardAppointment[],
  now: Date,
  graceMin = DEFAULT_LATE_GRACE_MIN,
): BoardSummary {
  const out: BoardSummary = {
    expected: 0,
    waiting: 0,
    withDoctor: 0,
    done: 0,
    checkedOut: 0,
    late: 0,
    noShow: 0,
    cancelled: 0,
    walkIns: 0,
    confirmed: 0,
    unconfirmed: 0,
    total: 0,
  };
  for (const r of rows) {
    const section = boardSection(r, now, graceMin);
    if (section === "cancelled") {
      out.cancelled++;
      continue;
    }
    out.total++;
    if (r.is_walk_in) out.walkIns++;
    switch (section) {
      case "expected":
        out.expected++;
        break;
      case "late":
        out.late++;
        break;
      case "waiting":
        out.waiting++;
        break;
      case "with_doctor":
        out.withDoctor++;
        break;
      case "done":
        out.done++;
        break;
      case "checked_out":
        out.checkedOut++;
        break;
      case "no_show":
        out.noShow++;
        break;
    }
    // Confirmation matters for people who are still to come.
    if (section === "expected" || section === "late") {
      if (confirmation(r) === "confirmed") out.confirmed++;
      else out.unconfirmed++;
    }
  }
  return out;
}

/** Groups rows by the local hour of their start, ordered by time ("09:00" -> rows). */
export function groupByHour<T extends Pick<BoardAppointment, "starts_at">>(
  rows: readonly T[],
  timezone: string,
): Array<{ hour: string; rows: T[] }> {
  const groups = new Map<string, T[]>();
  const sorted = [...rows].sort(
    (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  );
  for (const r of sorted) {
    const hour = formatInTimeZone(new Date(r.starts_at), timezone, "HH:00");
    const list = groups.get(hour) ?? [];
    list.push(r);
    groups.set(hour, list);
  }
  return [...groups.entries()].map(([hour, rows]) => ({ hour, rows }));
}

/** Waiting time in minutes for a patient who has arrived and is not yet with the doctor. */
export function waitingMinutes(
  a: Pick<BoardAppointment, "checkin_status" | "arrived_at">,
  now: Date,
): number | null {
  if (a.checkin_status !== "arrived" || !a.arrived_at) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(a.arrived_at).getTime()) / 60_000));
}
