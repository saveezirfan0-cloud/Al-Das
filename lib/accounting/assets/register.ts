import { monthStart } from "./depreciation";
import type { AssetStatus, PostedLine, ScheduleStatus } from "./runs";
import { scheduleLastMonth, type ScheduleKind } from "./schedules";

/**
 * The fixed asset register and the schedule status at a date (Phase 22H), pure. Figures are the BOOKS: accumulated
 * depreciation is what posted runs charged for months up to the date (a run is dated the last day of its month), not
 * the theoretical schedule. An asset appears once acquired and until its posted disposal date.
 */

export type RegisterAsset = {
  id: string;
  code: string;
  description: string;
  classId: string;
  className: string;
  branchCode: string | null;
  acquisitionDate: string;
  inServiceDate: string;
  cost: number;
  residual: number;
  status: AssetStatus;
  disposalDate: string | null;
  /** Depreciation already in the books before Pulse (the Tally opening balance). */
  openingAccumulated?: number;
};

export type RegisterLine = RegisterAsset & { accumulated: number; nbv: number };
export type RegisterTotal = {
  key: string;
  label: string;
  count: number;
  cost: number;
  accumulated: number;
  nbv: number;
};
export type Register = {
  asOf: string;
  lines: RegisterLine[];
  byClass: RegisterTotal[];
  byBranch: RegisterTotal[];
  total: RegisterTotal;
};

const toFils = (n: number) => Math.round(Number((n * 100).toPrecision(15)));

export function registerAt(
  assets: readonly RegisterAsset[],
  posted: readonly PostedLine[],
  asOf: string,
): Register {
  const asOfMonth = monthStart(asOf)!;
  // a run is dated the last day of its month: it counts once the date reaches that month's end
  const monthDone = (m: string) => monthStart(m)! < asOfMonth || isMonthEnd(asOf, m);
  const accum = new Map<string, number>();
  for (const l of posted)
    if (monthDone(l.month)) accum.set(l.ref, (accum.get(l.ref) ?? 0) + toFils(l.amount));
  const lines: RegisterLine[] = assets
    .filter(
      (a) =>
        a.acquisitionDate <= asOf &&
        !(a.status === "disposed" && a.disposalDate !== null && a.disposalDate <= asOf),
    )
    .map((a) => {
      const acc = (accum.get(a.id) ?? 0) + toFils(a.openingAccumulated ?? 0);
      return { ...a, accumulated: acc / 100, nbv: (toFils(a.cost) - acc) / 100 };
    })
    .sort((x, y) => x.code.localeCompare(y.code));
  const group = (key: (l: RegisterLine) => string, label: (l: RegisterLine) => string) => {
    const m = new Map<string, RegisterTotal>();
    for (const l of lines) {
      const k = key(l);
      const t = m.get(k) ?? { key: k, label: label(l), count: 0, cost: 0, accumulated: 0, nbv: 0 };
      t.count++;
      t.cost = (toFils(t.cost) + toFils(l.cost)) / 100;
      t.accumulated = (toFils(t.accumulated) + toFils(l.accumulated)) / 100;
      t.nbv = (toFils(t.nbv) + toFils(l.nbv)) / 100;
      m.set(k, t);
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  };
  const byClass = group(
    (l) => l.classId,
    (l) => l.className,
  );
  const byBranch = group(
    (l) => l.branchCode ?? "",
    (l) => l.branchCode ?? "No branch",
  );
  const total = lines.reduce<RegisterTotal>(
    (t, l) => ({
      ...t,
      count: t.count + 1,
      cost: (toFils(t.cost) + toFils(l.cost)) / 100,
      accumulated: (toFils(t.accumulated) + toFils(l.accumulated)) / 100,
      nbv: (toFils(t.nbv) + toFils(l.nbv)) / 100,
    }),
    { key: "total", label: "Total", count: 0, cost: 0, accumulated: 0, nbv: 0 },
  );
  return { asOf, lines, byClass, byBranch, total };
}

function isMonthEnd(date: string, month: string): boolean {
  if (monthStart(date) !== monthStart(month)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDate() === 1;
}

export type ScheduleRow = {
  id: string;
  kind: ScheduleKind;
  description: string;
  total: number;
  months: number;
  startMonth: string;
  autoReverse: boolean;
  status: ScheduleStatus;
  branchCode: string | null;
};

export type ScheduleStatusRow = ScheduleRow & {
  released: number;
  remaining: number;
  lastMonth: string;
  monthsPosted: number;
};

/** Released so far (posted), what remains and the last month, per schedule. */
export function scheduleStatus(
  schedules: readonly ScheduleRow[],
  posted: readonly PostedLine[],
): ScheduleStatusRow[] {
  const released = new Map<string, number>();
  const months = new Map<string, number>();
  for (const l of posted) {
    released.set(l.ref, (released.get(l.ref) ?? 0) + toFils(l.amount));
    months.set(l.ref, (months.get(l.ref) ?? 0) + 1);
  }
  return schedules.map((s) => {
    const r = released.get(s.id) ?? 0;
    return {
      ...s,
      released: r / 100,
      remaining: s.autoReverse ? 0 : Math.max(0, toFils(s.total) - r) / 100,
      lastMonth: scheduleLastMonth(s),
      monthsPosted: months.get(s.id) ?? 0,
    };
  });
}
