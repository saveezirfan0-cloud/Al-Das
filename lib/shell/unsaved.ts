/**
 * Unsaved-changes rules for drawers (Phase D), pure so they can be unit-tested. The hook that uses them is
 * `useUnsavedGuard` in components/shell/drawer-footer.tsx.
 */

/** Deep equality for plain form values (strings, numbers, booleans, null, arrays and plain objects). */
export function sameValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameValues(v, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      sameValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Has the form moved away from what was loaded (or last saved)? No snapshot yet means nothing to lose. */
export function isDirty<T>(current: T, saved: T | null | undefined): boolean {
  if (saved === null || saved === undefined) return false;
  return !sameValues(current, saved);
}

/** The question asked before a drawer with unsaved changes closes. */
export const DISCARD_QUESTION = {
  title: "Discard your changes?",
  description: "You have changes that are not saved yet. Closing now loses them.",
  confirmLabel: "Discard",
  cancelLabel: "Keep editing",
  destructive: true,
} as const;
