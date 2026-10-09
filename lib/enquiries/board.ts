/** Optimistic Kanban updates. Pure: the UI applies them before the server answers and rolls back on error. */
import type { BoardColumn, EnquiryRow } from "@/lib/enquiries/types";

export type StageInfo = { id: string; name: string; color: string };

/**
 * Moves one card to the top of another column and fixes the counts. Returns the same array
 * (by identity) when nothing changes, so callers can skip a state update.
 */
export function moveCard(
  columns: BoardColumn[],
  enquiryId: string,
  to: StageInfo,
  now: Date = new Date(),
): BoardColumn[] {
  const from = columns.find((c) => c.rows.some((r) => r.id === enquiryId));
  const target = columns.find((c) => c.stage_id === to.id);
  if (!from || !target || from.stage_id === to.id) return columns;
  const card = from.rows.find((r) => r.id === enquiryId)!;
  const moved: EnquiryRow = {
    ...card,
    stage_id: to.id,
    stage_name: to.name,
    stage_color: to.color,
    stage_entered_at: now.toISOString(),
  };
  return columns.map((c) => {
    if (c.stage_id === from.stage_id)
      return {
        ...c,
        total: Math.max(c.total - 1, 0),
        rows: c.rows.filter((r) => r.id !== enquiryId),
      };
    if (c.stage_id === to.id) return { ...c, total: c.total + 1, rows: [moved, ...c.rows] };
    return c;
  });
}

/** Appends a page of cards to a column (Show more), ignoring cards already present. */
export function appendRows(
  columns: BoardColumn[],
  stageId: string,
  rows: EnquiryRow[],
  total: number,
): BoardColumn[] {
  return columns.map((c) => {
    if (c.stage_id !== stageId) return c;
    const seen = new Set(c.rows.map((r) => r.id));
    return { ...c, total, rows: [...c.rows, ...rows.filter((r) => !seen.has(r.id))] };
  });
}
