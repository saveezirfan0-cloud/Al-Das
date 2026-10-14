/**
 * Drag-and-drop moves in the diary (Phase E, pure). The drop only proposes a time: the move itself goes through
 * moveAppointment → rescheduleAppointment → public.move_appointment, which takes the per-doctor lock and applies the
 * capacity rule (app.slot_conflict / slotFits). Anything refused there is put back where it was, with the reason.
 */

export type DragAppt = {
  status: string;
  source: string;
  checkin_status: string | null;
  reminder: string | null;
  starts_at: string;
  specialist_id: string | null;
};

export type DragDecision =
  | { kind: "same" }
  | { kind: "refuse"; reason: string }
  | { kind: "confirm"; title: string; description: string }
  | { kind: "go" };

/**
 * What to do with a drop. `notify` is whether the patient will be told (the Rescheduled template is mapped and the
 * "tell the patient" switch is on). A confirmed booking whose reminder already went out asks first: the patient has
 * planned around the old time.
 */
export function dragMoveDecision(
  a: DragAppt,
  target: { startIso: string; specialistId: string },
  now: Date,
  notify: boolean,
): DragDecision {
  const same =
    new Date(a.starts_at).getTime() === new Date(target.startIso).getTime() &&
    a.specialist_id === target.specialistId;
  if (same) return { kind: "same" };
  if (a.source === "unite")
    return { kind: "refuse", reason: "This appointment is managed in Unite. Move it there." };
  if (a.status !== "awaiting" && a.status !== "confirmed")
    return { kind: "refuse", reason: "This appointment can no longer be moved." };
  if (a.checkin_status)
    return {
      kind: "refuse",
      reason: "The patient has already checked in. Open the appointment to change it.",
    };
  if (Number.isNaN(new Date(target.startIso).getTime()))
    return { kind: "refuse", reason: "That time could not be read." };
  if (new Date(target.startIso).getTime() < now.getTime())
    return { kind: "refuse", reason: "That time has already passed." };
  if (a.status === "confirmed" && a.reminder === "sent")
    return {
      kind: "confirm",
      title: "Move a confirmed appointment?",
      description: notify
        ? "The patient already had a reminder for the old time. The patient will be told about the new time, and it will need confirming again."
        : "The patient already had a reminder for the old time and will NOT be told about the new time (no Rescheduled message). It will need confirming again.",
    };
  return { kind: "go" };
}

/**
 * The minute (after local midnight) a dragged block lands on: rounded to the slot granularity and kept inside the
 * visible day so the whole visit fits.
 */
export function snapMinute(
  rawMinute: number,
  granularity: number,
  axisStart: number,
  axisEnd: number,
  durationMin: number,
): number {
  const step = Math.max(1, Math.round(granularity));
  const snapped = Math.round(rawMinute / step) * step;
  const latest = Math.max(axisStart, axisEnd - Math.max(0, durationMin));
  return Math.min(Math.max(snapped, axisStart), latest);
}

/** Below this many pixels a press is a click (open the appointment), not a drag. */
export const DRAG_THRESHOLD_PX = 5;
