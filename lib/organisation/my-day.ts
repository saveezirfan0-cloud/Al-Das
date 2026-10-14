/**
 * "My day" for a doctor (Phase C): pure helpers over today's appointments. The check-in state lives on the
 * appointment in Pulse only (lib/front-desk/checkin.ts); nothing here writes anything.
 */
import { isCheckinState, type CheckinState } from "@/lib/front-desk/checkin";

export type DayAppointment = {
  id: string;
  starts_at: string;
  status: string;
  checkin_status: string | null;
};

export type DaySummary = {
  total: number;
  /** Booked and not yet arrived (not cancelled, not a no-show). */
  expected: number;
  /** Arrived and waiting for the doctor. */
  waiting: number;
  withDoctor: number;
  /** Done or checked out, or marked completed. */
  seen: number;
  noShow: number;
};

/** Where an appointment stands for the doctor: the check-in state, or the booking status when there is none. */
export function dayState(
  a: Pick<DayAppointment, "status" | "checkin_status">,
): CheckinState | "expected" | "no_show" | "cancelled" {
  if (a.status === "cancelled") return "cancelled";
  if (a.status === "no_show") return "no_show";
  if (isCheckinState(a.checkin_status)) return a.checkin_status;
  if (a.status === "completed") return "done";
  return "expected";
}

export function summariseDay(appts: readonly DayAppointment[]): DaySummary {
  const s: DaySummary = { total: 0, expected: 0, waiting: 0, withDoctor: 0, seen: 0, noShow: 0 };
  for (const a of appts) {
    const state = dayState(a);
    if (state === "cancelled") continue;
    s.total++;
    if (state === "expected") s.expected++;
    else if (state === "arrived") s.waiting++;
    else if (state === "with_doctor") s.withDoctor++;
    else if (state === "done" || state === "checked_out") s.seen++;
    else if (state === "no_show") s.noShow++;
  }
  return s;
}

/** The next patient to see: the first one waiting (arrived), else the next expected one from now. */
export function nextUp<T extends DayAppointment>(appts: readonly T[], now: Date): T | null {
  const sorted = [...appts].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return (
    sorted.find((a) => dayState(a) === "arrived") ??
    sorted.find(
      (a) => dayState(a) === "expected" && Date.parse(a.starts_at) >= now.getTime() - 15 * 60_000,
    ) ??
    null
  );
}
