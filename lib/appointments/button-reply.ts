/**
 * Template button replies on appointment reminders (Confirm / Reschedule / Cancel), pure.
 * The reply arrives as a `button` message (payload = the button payload) or an interactive
 * button_reply; either way we classify the id/title and decide what to do.
 */
import type { AppointmentStatus } from "@/lib/appointments/status";

export type ReplyAction = "confirm" | "reschedule" | "cancel" | "unknown";

export function classifyButtonReply(reply: {
  id?: string | null;
  title?: string | null;
}): ReplyAction {
  for (const raw of [reply.id, reply.title]) {
    const t = (raw ?? "").trim().toLowerCase();
    if (!t) continue;
    if (/^(confirm|yes\b)/.test(t)) return "confirm";
    if (/^(resched|change|move)/.test(t)) return "reschedule";
    if (/^(cancel|no\b)/.test(t)) return "cancel";
  }
  return "unknown";
}

export type ReplyDecision =
  | { kind: "set_status"; status: AppointmentStatus }
  | {
      kind: "notify_reception";
      reason: "reschedule_requested" | "reschedule_too_late" | "cancel_too_late";
    }
  | {
      kind: "ignore";
      reason: "unknown_button" | "already_applied" | "appointment_closed" | "past";
    };

/** What a reply should do given the appointment's state and the booking-rule cut-offs. */
export function decideReply(
  action: ReplyAction,
  appt: { status: AppointmentStatus; startsAt: Date },
  rules: { cancel_cutoff_minutes: number; reschedule_cutoff_minutes: number },
  now: Date,
): ReplyDecision {
  if (action === "unknown") return { kind: "ignore", reason: "unknown_button" };
  if (appt.status === "cancelled" || appt.status === "completed" || appt.status === "no_show")
    return { kind: "ignore", reason: "appointment_closed" };
  if (appt.startsAt.getTime() <= now.getTime()) return { kind: "ignore", reason: "past" };

  const minutesLeft = (appt.startsAt.getTime() - now.getTime()) / 60_000;
  switch (action) {
    case "confirm":
      return appt.status === "confirmed"
        ? { kind: "ignore", reason: "already_applied" }
        : { kind: "set_status", status: "confirmed" };
    case "cancel":
      return minutesLeft < rules.cancel_cutoff_minutes
        ? { kind: "notify_reception", reason: "cancel_too_late" }
        : { kind: "set_status", status: "cancelled" };
    case "reschedule":
      // Reception always re-books by hand; inside the cut-off they are told it is a late request.
      return {
        kind: "notify_reception",
        reason:
          minutesLeft < rules.reschedule_cutoff_minutes
            ? "reschedule_too_late"
            : "reschedule_requested",
      };
  }
}
