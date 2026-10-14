/**
 * The branch week (Phase E, pure): every doctor of one branch down the side, Monday to Sunday across, each cell the
 * doctor's appointments that day in time order.
 */
import { formatInTimeZone } from "date-fns-tz";

/** Monday to Sunday of the week that holds `date` (YYYY-MM-DD, calendar arithmetic in UTC so no timezone shifts it). */
export function weekDates(date: string): string[] {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(base.getTime())) return [];
  const isoDay = base.getUTCDay() === 0 ? 7 : base.getUTCDay(); // Monday 1 … Sunday 7
  const monday = Date.UTC(y, m - 1, d - (isoDay - 1));
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday + i * 86_400_000).toISOString().slice(0, 10),
  );
}

export type WeekAppt = {
  id: string;
  starts_at: string;
  specialist_id: string | null;
  status: string;
};

export type WeekRow<A extends WeekAppt> = {
  specialist_id: string | null;
  name: string;
  /** One list per day of `days`, in time order. */
  cells: A[][];
  count: number;
};

/**
 * Rows for the doctors given (in their order), then one "Other" row for bookings with a doctor not in the list or with
 * none, shown only when it has something. Cancelled bookings are left out.
 */
export function weekGrid<A extends WeekAppt>(
  appts: readonly A[],
  doctors: ReadonlyArray<{ id: string; name: string }>,
  days: readonly string[],
  timezone: string,
): WeekRow<A>[] {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const known = new Set(doctors.map((d) => d.id));
  const rows: WeekRow<A>[] = doctors.map((d) => ({
    specialist_id: d.id,
    name: d.name,
    cells: days.map(() => []),
    count: 0,
  }));
  const other: WeekRow<A> = {
    specialist_id: null,
    name: "Other",
    cells: days.map(() => []),
    count: 0,
  };
  const byId = new Map(rows.map((r) => [r.specialist_id, r]));
  const sorted = [...appts]
    .filter((a) => a.status !== "cancelled")
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  for (const a of sorted) {
    const i = dayIndex.get(formatInTimeZone(new Date(a.starts_at), timezone, "yyyy-MM-dd"));
    if (i === undefined) continue;
    const row = a.specialist_id && known.has(a.specialist_id) ? byId.get(a.specialist_id)! : other;
    row.cells[i].push(a);
    row.count++;
  }
  return other.count > 0 ? [...rows, other] : rows;
}
