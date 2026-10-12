/**
 * Check-in on the front desk board (pure). The four states live on the appointment in Pulse only: Unite is
 * the EMR of record and stays read-only, so nothing here is ever sent to it.
 *
 *   (not arrived) -> Arrived -> With doctor -> Done -> Checked out
 *
 * Moves go forward one step at a time, may skip a step the desk forgot (Arrived straight to Done is a quick
 * visit), and may go back exactly one step to undo a mis-tap. Each state keeps the time it was reached.
 */
export const CHECKIN_STATES = ["arrived", "with_doctor", "done", "checked_out"] as const;
export type CheckinState = (typeof CHECKIN_STATES)[number];

export const CHECKIN_LABELS: Record<CheckinState, string> = {
  arrived: "Arrived",
  with_doctor: "With doctor",
  done: "Done",
  checked_out: "Checked out",
};

export function isCheckinState(v: unknown): v is CheckinState {
  return typeof v === "string" && (CHECKIN_STATES as readonly string[]).includes(v);
}

export type CheckinFields = {
  checkin_status: CheckinState | null;
  arrived_at: string | null;
  with_doctor_at: string | null;
  done_at: string | null;
  checked_out_at: string | null;
};

type TimeColumn = "arrived_at" | "with_doctor_at" | "done_at" | "checked_out_at";

const TIME_COLUMN: Record<CheckinState, TimeColumn> = {
  arrived: "arrived_at",
  with_doctor: "with_doctor_at",
  done: "done_at",
  checked_out: "checked_out_at",
};

function rank(state: CheckinState | null): number {
  return state === null ? -1 : CHECKIN_STATES.indexOf(state);
}

/** The next button the desk should see for an appointment in this state. */
export function nextCheckinState(current: CheckinState | null): CheckinState | null {
  const next = CHECKIN_STATES[rank(current) + 1];
  return next ?? null;
}

export type CheckinMove = { ok: true } | { ok: false; error: string };

/** May the desk move from one state to another? `null` means "not arrived". */
export function canMoveCheckin(from: CheckinState | null, to: CheckinState | null): CheckinMove {
  if (from === to) return { ok: false, error: "Already in that state." };
  const a = rank(from);
  const b = rank(to);
  if (b > a) return { ok: true };
  if (b === a - 1) return { ok: true }; // undo one step (to === null undoes Arrived)
  return { ok: false, error: "Check-in can only step back one state." };
}

/**
 * The columns to write for a move. Going forward stamps the new state's time (keeping an earlier time if the
 * desk skipped a step: skipped steps stay empty). Going back clears the state that is being left.
 */
export function checkinPatch(
  from: CheckinState | null,
  to: CheckinState | null,
  now: Date,
): Partial<CheckinFields> | null {
  const move = canMoveCheckin(from, to);
  if (!move.ok) return null;
  const patch: Partial<CheckinFields> = { checkin_status: to };
  if (to !== null && rank(to) > rank(from)) {
    patch[TIME_COLUMN[to]] = now.toISOString();
  } else if (from !== null) {
    patch[TIME_COLUMN[from]] = null;
  }
  return patch;
}

/** Minutes between two ISO times, rounded down; null when either is missing. */
export function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : null;
}
