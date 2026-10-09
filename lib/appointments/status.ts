/**
 * Appointment statuses and which moves staff (or a patient button reply) may make.
 * Unite is the source of truth for source='unite' rows, so the sync bypasses these rules.
 */
export const APPOINTMENT_STATUSES = [
  "awaiting",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  awaiting: "Awaiting",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
};

const TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  awaiting: ["confirmed", "cancelled", "completed", "no_show"],
  confirmed: ["awaiting", "cancelled", "completed", "no_show"],
  cancelled: ["awaiting", "confirmed"], // re-open
  completed: ["no_show"], // correction
  no_show: ["awaiting", "confirmed", "completed"],
};

export function isAppointmentStatus(v: unknown): v is AppointmentStatus {
  return typeof v === "string" && (APPOINTMENT_STATUSES as readonly string[]).includes(v);
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return from !== to && TRANSITIONS[from].includes(to);
}

/** Statuses whose pending reminders must be cancelled. */
export function isInactive(status: AppointmentStatus): boolean {
  return status === "cancelled" || status === "no_show" || status === "completed";
}

/** Status → which notification template (settings.templates key) to offer. */
export function notificationKeyFor(
  to: AppointmentStatus,
): "confirmed" | "cancelled" | "rescheduled" | null {
  if (to === "confirmed") return "confirmed";
  if (to === "cancelled") return "cancelled";
  return null;
}
