/**
 * Patient card shaping (pure). The card sits beside a conversation or under the lookup box on the desk and answers
 * the four questions reception asks first: when are they next here, when were they last here, is something open
 * with them, and is there anything I must not forget (flags).
 */
import { differenceInYears, parseISO } from "date-fns";

export type CardAppointment = {
  id: string;
  number: number;
  starts_at: string;
  status: string;
  checkin_status: string | null;
  specialist_name: string | null;
  service_name: string | null;
  location_name: string | null;
  /** Who the appointment belongs to when it is a dependant's (null = the card's own patient). */
  patient_name?: string | null;
  patient_id?: string | null;
};

export type CardFlag = { key: string; label: string; tone: "info" | "warn" | "alert" };

export type CardInput = {
  stop_marketing: boolean;
  has_phone: boolean;
  has_bsuid: boolean;
  dob: string | null;
  no_shows_12m: number;
  open_call_tasks: number;
  waitlist_entries: number;
  guardian: { id: string; name: string } | null;
  dependants: number;
  is_test_record?: boolean;
};

export function ageLabel(dob: string | null, now: Date): string | null {
  if (!dob) return null;
  const born = parseISO(dob);
  if (Number.isNaN(born.getTime())) return null;
  const years = differenceInYears(now, born);
  if (years < 0) return null;
  if (years >= 2) return `${years} y`;
  const months = Math.max(
    0,
    (now.getFullYear() - born.getFullYear()) * 12 + now.getMonth() - born.getMonth(),
  );
  return `${months} mo`;
}

export function cardFlags(c: CardInput): CardFlag[] {
  const flags: CardFlag[] = [];
  if (c.is_test_record) flags.push({ key: "test", label: "Test record", tone: "info" });
  if (c.stop_marketing)
    flags.push({ key: "stop_marketing", label: "No marketing messages", tone: "warn" });
  if (!c.has_phone && !c.has_bsuid && !c.guardian)
    flags.push({ key: "no_whatsapp", label: "No WhatsApp number", tone: "alert" });
  else if (!c.has_phone && c.has_bsuid)
    flags.push({ key: "username_only", label: "WhatsApp username only (no phone)", tone: "info" });
  if (c.no_shows_12m >= 2)
    flags.push({
      key: "no_shows",
      label: `${c.no_shows_12m} no-shows in 12 months`,
      tone: "alert",
    });
  else if (c.no_shows_12m === 1)
    flags.push({ key: "no_shows", label: "1 no-show in 12 months", tone: "warn" });
  if (c.open_call_tasks > 0)
    flags.push({
      key: "open_calls",
      label: `${c.open_call_tasks} open call task${c.open_call_tasks === 1 ? "" : "s"}`,
      tone: "warn",
    });
  if (c.waitlist_entries > 0)
    flags.push({ key: "waitlist", label: "On the waiting list", tone: "info" });
  if (c.guardian)
    flags.push({ key: "dependant", label: `Dependant of ${c.guardian.name}`, tone: "info" });
  if (c.dependants > 0)
    flags.push({
      key: "guardian",
      label: `Guardian of ${c.dependants} ${c.dependants === 1 ? "patient" : "patients"}`,
      tone: "info",
    });
  return flags;
}

/** The earliest upcoming appointment that is still live. */
export function pickNextAppointment<T extends Pick<CardAppointment, "starts_at" | "status">>(
  rows: readonly T[],
  now: Date,
): T | null {
  return (
    [...rows]
      .filter(
        (a) =>
          !["cancelled", "no_show", "completed"].includes(a.status) &&
          new Date(a.starts_at).getTime() >= now.getTime() - 60 * 60_000,
      )
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0] ?? null
  );
}

/** The most recent visit that actually happened (completed, or checked in/through at the desk). */
export function pickLastVisit<
  T extends Pick<CardAppointment, "starts_at" | "status" | "checkin_status">,
>(rows: readonly T[], now: Date): T | null {
  return (
    [...rows]
      .filter(
        (a) =>
          new Date(a.starts_at).getTime() < now.getTime() &&
          (a.status === "completed" ||
            ["with_doctor", "done", "checked_out"].includes(a.checkin_status ?? "")),
      )
      .sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())[0] ?? null
  );
}

/** The values the quick-reply variables use for this patient's next appointment. */
export function quickReplyAppointmentValues(
  next: Pick<CardAppointment, "starts_at" | "specialist_name" | "location_name"> | null,
  format: (iso: string) => { date: string; time: string },
): {
  doctor: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  location: string | null;
} {
  if (!next)
    return { doctor: null, appointment_date: null, appointment_time: null, location: null };
  const f = format(next.starts_at);
  return {
    doctor: next.specialist_name,
    appointment_date: f.date,
    appointment_time: f.time,
    location: next.location_name,
  };
}
