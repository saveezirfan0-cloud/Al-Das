/** Framework-free helpers for the clinic lists (safe to import from client components). */

/**
 * The entries to offer in a picker: active ones, plus the currently selected one even if it has
 * since been deactivated (so an old enquiry keeps showing what it was booked with).
 */
export function pickable<T extends { id: string; active: boolean }>(
  list: readonly T[],
  selectedId?: string | null,
): T[] {
  return list.filter((x) => x.active || x.id === selectedId);
}
