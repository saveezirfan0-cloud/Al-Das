/** Ordering helpers for the stage editor (drag to reorder). Pure. */

/** Moves `activeId` to the position of `overId` (dnd-kit's arrayMove by id). */
export function moveById<T extends string>(ids: readonly T[], activeId: T, overId: T): T[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Sort values for an ordered id list: spaced by 10 so single inserts stay cheap. */
export function sortValues<T extends string>(ids: readonly T[]): Array<{ id: T; sort: number }> {
  return ids.map((id, i) => ({ id, sort: (i + 1) * 10 }));
}

/** Next sort value after the current maximum. */
export function nextSort(existing: readonly number[]): number {
  return (existing.length ? Math.max(...existing) : 0) + 10;
}

/** True when two lists hold exactly the same ids (used to reject partial / foreign reorders). */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === a.length && b.every((x) => set.has(x));
}
