import { monthStart, runAmount, type DepreciationBasis } from "./depreciation";
import {
  scheduleMonthAmount,
  scheduleRunAmount,
  type ScheduleBasis,
  type ScheduleKind,
} from "./schedules";

/**
 * Monthly runs (Phase 22H), pure: which assets and schedules a month's run holds and for how much. The database derives
 * the accounts and dimensions, hashes the lines and posts one journal per run (acc_asset_run_prepare / _post).
 *
 * Inputs are the lines of the POSTED version of every run of the same kind (`posted`), keyed by asset or schedule id
 * and run month. A month's charge catches up on everything posted before it. A disposed asset or a cancelled schedule
 * gets nothing new; re-running a month it was already in keeps exactly what that month had posted (so the reversal and
 * the new version cancel out for it and the disposal journal stays right).
 */

export type RunKind = "depreciation" | "schedules" | "reversing_accruals";
export type RunStatus = "draft" | "posted" | "waiting_ledger_start";
export type AssetStatus = "active" | "disposed" | "fully_depreciated";
export type ScheduleStatus = "active" | "completed" | "cancelled";

export const RUN_KINDS: readonly RunKind[] = ["depreciation", "schedules", "reversing_accruals"];

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  depreciation: "Depreciation",
  schedules: "Prepayments, accruals and deferred revenue",
  reversing_accruals: "Reversing accruals",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: "Waiting to post",
  posted: "Posted",
  waiting_ledger_start: "Waiting for the ledger start date",
};

export type PostedLine = { ref: string; month: string; amount: number };
export type RunLine = { ref: string; amount: number };

const toFils = (n: number) => Math.round(Number((n * 100).toPrecision(15)));

/** Posted amounts per id for months strictly before `month`. */
export function postedBefore(lines: readonly PostedLine[], month: string): Map<string, number> {
  const m = monthStart(month)!;
  const out = new Map<string, number>();
  for (const l of lines) {
    const lm = monthStart(l.month)!;
    if (lm < m) out.set(l.ref, (out.get(l.ref) ?? 0) + toFils(l.amount));
  }
  return new Map([...out].map(([k, v]) => [k, v / 100]));
}

/** What the posted version of `month` itself holds per id. */
export function postedIn(lines: readonly PostedLine[], month: string): Map<string, number> {
  const m = monthStart(month)!;
  const out = new Map<string, number>();
  for (const l of lines)
    if (monthStart(l.month) === m) out.set(l.ref, (out.get(l.ref) ?? 0) + toFils(l.amount));
  return new Map([...out].map(([k, v]) => [k, v / 100]));
}

/** `openingAccumulated`: depreciation already in the books before Pulse (the Tally opening balance). */
export type PlanAsset = DepreciationBasis & {
  id: string;
  status: AssetStatus;
  openingAccumulated?: number;
};

export function planDepreciationRun(input: {
  month: string;
  assets: readonly PlanAsset[];
  posted: readonly PostedLine[];
}): RunLine[] {
  const month = monthStart(input.month)!;
  const before = postedBefore(input.posted, month);
  const same = postedIn(input.posted, month);
  const out: RunLine[] = [];
  for (const a of input.assets) {
    if (monthStart(a.inServiceDate)! > month) continue;
    const amount =
      a.status === "disposed"
        ? (same.get(a.id) ?? 0)
        : runAmount(a, month, (before.get(a.id) ?? 0) + (a.openingAccumulated ?? 0));
    if (amount > 0) out.push({ ref: a.id, amount });
  }
  return out.sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
}

export type PlanSchedule = ScheduleBasis & {
  id: string;
  kind: ScheduleKind;
  autoReverse: boolean;
  status: ScheduleStatus;
};

/** Does the schedule belong in this kind of run? */
export function scheduleRunKind(s: Pick<PlanSchedule, "kind" | "autoReverse">): RunKind {
  return s.kind === "accrual" && s.autoReverse ? "reversing_accruals" : "schedules";
}

export function planScheduleRun(input: {
  kind: "schedules" | "reversing_accruals";
  month: string;
  schedules: readonly PlanSchedule[];
  posted: readonly PostedLine[];
}): RunLine[] {
  const month = monthStart(input.month)!;
  const before = postedBefore(input.posted, month);
  const same = postedIn(input.posted, month);
  const out: RunLine[] = [];
  for (const s of input.schedules) {
    if (scheduleRunKind(s) !== input.kind || s.startMonth > month) continue;
    let amount: number;
    if (s.status === "cancelled") amount = same.get(s.id) ?? 0;
    else if (input.kind === "reversing_accruals") amount = scheduleMonthAmount(s, month);
    else amount = scheduleRunAmount(s, month, before.get(s.id) ?? 0);
    if (amount > 0) out.push({ ref: s.id, amount });
  }
  return out.sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
}

/** The jsonb lines acc_asset_run_prepare takes. */
export function runPayload(kind: RunKind, lines: readonly RunLine[]) {
  return lines.map((l) =>
    kind === "depreciation"
      ? { asset_id: l.ref, amount: l.amount }
      : { schedule_id: l.ref, amount: l.amount },
  );
}

export function runTotal(lines: readonly RunLine[]): number {
  return lines.reduce((s, l) => s + toFils(l.amount), 0) / 100;
}
