/**
 * End of day per branch (Phase E, pure): how the day went at each branch, from today's board rows. Counts only, no
 * patient names. Waiting time is Arrived to With doctor; the median is over the patients who have both times.
 */
import { isCheckinState } from "@/lib/front-desk/checkin";

export type DayRow = {
  status: string;
  checkin_status: string | null;
  is_walk_in: boolean;
  arrived_at: string | null;
  with_doctor_at: string | null;
  location_id: string | null;
  location_name: string | null;
};

export type BranchDay = {
  location_id: string | null;
  location_name: string;
  booked: number;
  seen: number;
  noShows: number;
  cancelled: number;
  walkIns: number;
  /** Arrived but not yet with the doctor at the time of the summary. */
  stillWaiting: number;
  /** Median minutes from Arrived to With doctor; null when nobody has both times. */
  medianWaitMin: number | null;
  /** How many waits the median is taken over. */
  waits: number;
};

/** Median of a list (the mean of the middle two for an even count), rounded to whole minutes; null for none. */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

/** A visit that happened: the doctor saw the patient (With doctor, Done, Checked out) or the booking was completed. */
export function wasSeen(r: Pick<DayRow, "status" | "checkin_status">): boolean {
  const s = isCheckinState(r.checkin_status) ? r.checkin_status : null;
  return s === "with_doctor" || s === "done" || s === "checked_out" || r.status === "completed";
}

/** Minutes from Arrived to With doctor, or null when either is missing or the order is impossible. */
export function waitMinutes(r: Pick<DayRow, "arrived_at" | "with_doctor_at">): number | null {
  if (!r.arrived_at || !r.with_doctor_at) return null;
  const ms = new Date(r.with_doctor_at).getTime() - new Date(r.arrived_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 60_000;
}

const NO_BRANCH = "No branch";

/** One line per branch (named branches first, alphabetically; rows with no branch last), plus the total. */
export function summariseDayByBranch(rows: readonly DayRow[]): {
  branches: BranchDay[];
  total: BranchDay;
} {
  const groups = new Map<string, { id: string | null; name: string; rows: DayRow[] }>();
  for (const r of rows) {
    const key = r.location_id ?? "";
    const g = groups.get(key) ?? {
      id: r.location_id,
      name: r.location_id ? (r.location_name ?? "Unnamed branch") : NO_BRANCH,
      rows: [],
    };
    g.rows.push(r);
    groups.set(key, g);
  }
  const branches = [...groups.values()]
    .map((g) => summarise(g.id, g.name, g.rows))
    .sort((a, b) =>
      a.location_id === null
        ? 1
        : b.location_id === null
          ? -1
          : a.location_name.localeCompare(b.location_name),
    );
  return { branches, total: summarise(null, "All branches", rows) };
}

function summarise(id: string | null, name: string, rows: readonly DayRow[]): BranchDay {
  const waits = rows.map(waitMinutes).filter((m): m is number => m !== null);
  let booked = 0;
  let seen = 0;
  let noShows = 0;
  let cancelled = 0;
  let walkIns = 0;
  let stillWaiting = 0;
  for (const r of rows) {
    if (r.status === "cancelled") {
      cancelled++;
      continue;
    }
    booked++;
    if (r.is_walk_in) walkIns++;
    if (r.status === "no_show") noShows++;
    else if (wasSeen(r)) seen++;
    else if (r.checkin_status === "arrived") stillWaiting++;
  }
  return {
    location_id: id,
    location_name: name,
    booked,
    seen,
    noShows,
    cancelled,
    walkIns,
    stillWaiting,
    medianWaitMin: median(waits),
    waits: waits.length,
  };
}

/**
 * The cash-up link for a branch: only when the member holds the cash-up permission and the branch has a finance code
 * (locations.branch_code). The cash-up page reads `branch` and `date`.
 */
export function cashupHref(
  branchCode: string | null | undefined,
  date: string,
  canCashup: boolean,
): string | null {
  if (!canCashup || !branchCode) return null;
  return `/finance/cashup?branch=${encodeURIComponent(branchCode)}&date=${encodeURIComponent(date)}`;
}
