/**
 * Touch-gesture rules, pure so they are unit-tested (a real finger is not available in CI).
 * Components feed in coordinates; these decide what the gesture means.
 */

export type SwipeIntent = "none" | "pending" | "horizontal" | "vertical";

/** Decide whether a drag is a horizontal swipe (ours) or a vertical scroll (the browser's), once it has moved a little. */
export function swipeIntent(dx: number, dy: number, slop = 8): SwipeIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return "pending";
  // A clearly vertical drag stays a scroll; the swipe has to be mostly sideways.
  return ax > ay * 1.5 ? "horizontal" : "vertical";
}

export type SwipeAction = "right" | "left" | null;

/** A swipe commits once it travelled far enough (px) in one direction. */
export function swipeCommit(dx: number, threshold = 96): SwipeAction {
  if (dx >= threshold) return "right";
  if (dx <= -threshold) return "left";
  return null;
}

/** Rubber-band the visual drag so the row follows the finger but resists past the threshold. */
export function swipeOffset(dx: number, max = 140): number {
  const sign = dx < 0 ? -1 : 1;
  const abs = Math.abs(dx);
  return sign * (abs <= max ? abs : max + (abs - max) * 0.2);
}

export type PullState = { distance: number; ready: boolean };

/**
 * Pull to refresh: only counts when the list is scrolled to the very top and the finger moves down.
 * `distance` is the damped indicator offset in px (the finger moves twice as far); `ready` means releasing
 * now will refresh.
 */
export function pullState(input: {
  startY: number;
  currentY: number;
  scrollTop: number;
  threshold?: number;
  maxPull?: number;
}): PullState {
  const threshold = input.threshold ?? 48;
  const maxPull = input.maxPull ?? 96;
  if (input.scrollTop > 0) return { distance: 0, ready: false };
  const raw = input.currentY - input.startY;
  if (raw <= 0) return { distance: 0, ready: false };
  const distance = Math.min(maxPull, raw * 0.5);
  return { distance, ready: distance >= threshold };
}
