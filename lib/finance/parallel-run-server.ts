import "server-only";

import { can, type MemberLike } from "@/lib/auth/can";
import type { MonthFigures } from "@/lib/finance/close-pack";
import { monthRange } from "@/lib/finance/close-server";
import {
  AREAS,
  AREA_VIEW_KEY,
  areaStatus,
  canSwitch,
  completeMonthTotals,
  compare,
  lastMonths,
  switchedWarning,
  type Area,
  type AreaStatus,
  type Comparison,
  type SwitchCheck,
} from "@/lib/finance/parallel-run";
import { lockLabel, shiftMonth } from "@/lib/finance/report-emails";
import { parseRevenue } from "@/lib/finance/revenue";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Server side of the parallel run (W4). Pulse's figure per area comes from the code that already produces it; nothing is
 * derived again here:
 *   revenue, collections, insurance: fin_close_month_figures() and fin_revenue_breakdown() (the close pack's own inputs,
 *     lib/finance/close-server.ts), so the figure equals the pack's totals.revenue_net / collected / outstanding;
 *   bank: the frozen figures of reviewed or signed reconciliations (fin_bank_recs, lib/finance/bank-recon.ts runFigures);
 *   labs: the frozen figures of reviewed or posted provider statements (fin_provider_statements, labs.ts statementFigures).
 * A figure that does not exist for a month is null ("not available yet"), never zero. Service role; callers have run can().
 */

export const WINDOW_MONTHS = 6;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const sum = (xs: readonly number[]) => r3(xs.reduce((a, x) => a + x, 0));

/** The close pack's three month figures for one month. */
async function closeFigures(admin: AdminClient, orgId: string, month: string) {
  const { first, last } = monthRange(month);
  const [figures, category] = await Promise.all([
    admin.rpc("fin_close_month_figures", { p_org_id: orgId, p_month: first }),
    admin.rpc("fin_revenue_breakdown", {
      p_org_id: orgId,
      p_from: first,
      p_to: last,
      p_dimension: "category",
      p_limit: 60,
    }),
  ]);
  if (figures.error || category.error) return { revenue: null, collections: null, insurance: null };
  const f = figures.data as unknown as MonthFigures;
  return {
    revenue: sum(parseRevenue(category.data).map((r) => r.net)),
    collections: sum((f.collections ?? []).map((c) => Number(c.paid) || 0)),
    insurance: sum((f.by_branch ?? []).map((b) => Number(b.outstanding) || 0)),
  };
}

const path = (json: unknown, ...keys: string[]): number | null => {
  let v: unknown = json;
  for (const k of keys)
    v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return num(v);
};

export async function loadPulseFigures(
  admin: AdminClient,
  orgId: string,
  months: readonly string[],
): Promise<Record<string, Record<Area, number | null>>> {
  const first = `${months[months.length - 1]}-01`;
  const [close, accounts, recs, providers, statements] = await Promise.all([
    Promise.all(months.map((m) => closeFigures(admin, orgId, m))),
    admin.from("fin_bank_accounts").select("id").eq("org_id", orgId).eq("active", true),
    admin
      .from("fin_bank_recs")
      .select("account_id, month, figures")
      .eq("org_id", orgId)
      .gte("month", first)
      .in("status", ["reviewed", "signed"]),
    admin.from("fin_providers").select("id").eq("org_id", orgId).eq("active", true),
    admin
      .from("fin_provider_statements")
      .select("provider_id, month, figures")
      .eq("org_id", orgId)
      .gte("month", first)
      .in("status", ["reviewed", "posted"]),
  ]);
  const bank = completeMonthTotals(
    (recs.data ?? []).map((r) => ({
      month: r.month,
      owner: r.account_id,
      value: path(r.figures, "summary", "matchedBank"),
    })),
    new Set((accounts.data ?? []).map((a) => a.id)),
    months,
  );
  const labs = completeMonthTotals(
    (statements.data ?? []).map((r) => ({
      month: r.month,
      owner: r.provider_id,
      value: path(r.figures, "summary", "totalCost"),
    })),
    new Set((providers.data ?? []).map((p) => p.id)),
    months,
  );
  return Object.fromEntries(
    months.map((m, i) => [
      m,
      { ...close[i], bank: bank[m], labs: labs[m] } as Record<Area, number | null>,
    ]),
  );
}

export type ParallelMonth = Comparison & {
  month: string;
  note: string | null;
  enteredAt: string | null;
  provisional: boolean;
};

export type ParallelArea = {
  area: Area;
  status: AreaStatus;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  months: ParallelMonth[];
  check: SwitchCheck;
  warning: string | null;
};

export type ParallelView = {
  tolerance: number;
  latestMonth: string;
  /** "Provisional ..." / "Final ..." for the months shown (lockLabel, the same rule as the profit reports). */
  lockLabel: string;
  areas: ParallelArea[];
};

/** The whole page: the areas this member may see, six finished months each. */
export async function loadParallelView(
  admin: AdminClient,
  member: MemberLike,
  today: string,
): Promise<ParallelView> {
  const orgId = member.orgId;
  const latestMonth = shiftMonth(today.slice(0, 7), -1); // the last finished month
  const months = lastMonths(latestMonth, WINDOW_MONTHS);
  const visible = AREAS.filter((a) => can(member, AREA_VIEW_KEY[a]));

  const [settings, figures, decisions, locked, pulse] = await Promise.all([
    admin
      .from("fin_ref_finance_settings")
      .select("parallel_tolerance")
      .eq("org_id", orgId)
      .maybeSingle(),
    admin
      .from("fin_parallel_figures")
      .select("area, month, manual_amount, note, entered_at")
      .eq("org_id", orgId)
      .gte("month", `${months[months.length - 1]}-01`),
    admin.from("fin_parallel_decisions").select("*").eq("org_id", orgId),
    admin
      .from("fin_period_closes")
      .select("month")
      .eq("org_id", orgId)
      .eq("status", "locked")
      .gte("month", `${months[months.length - 1]}-01`),
    visible.length
      ? loadPulseFigures(admin, orgId, months)
      : Promise.resolve({} as Record<string, Record<Area, number | null>>),
  ]);
  // no settings row: the strictest tolerance (zero), never a guess
  const tolerance = num(settings.data?.parallel_tolerance) ?? 0;
  const lockedMonths = new Set((locked.data ?? []).map((l) => l.month.slice(0, 7)));
  const ids = [
    ...new Set((decisions.data ?? []).map((d) => d.decided_by).filter((x): x is string => !!x)),
  ];
  const { data: people } = ids.length
    ? await admin.from("profiles").select("id, first_name, last_name").in("id", ids)
    : { data: [] };

  const areas = visible.map((area): ParallelArea => {
    const rows = months.map((m): ParallelMonth => {
      const f = (figures.data ?? []).find((x) => x.area === area && x.month.slice(0, 7) === m);
      const c = compare(pulse[m]?.[area] ?? null, f ? num(f.manual_amount) : null, tolerance);
      return {
        ...c,
        month: m,
        note: f?.note ?? null,
        enteredAt: f?.entered_at ?? null,
        provisional: !lockedMonths.has(m),
      };
    });
    const d = (decisions.data ?? []).find((x) => x.area === area);
    const decision = d?.status === "switched" || d?.status === "running" ? d.status : null;
    const status = areaStatus(
      decision,
      rows.some((r) => r.manual !== null),
    );
    const check = canSwitch(rows, latestMonth, tolerance);
    const p = d?.decided_by ? (people ?? []).find((x) => x.id === d.decided_by) : undefined;
    return {
      area,
      status,
      decidedAt: d?.decided_at ?? null,
      decidedByName: p
        ? `${p.first_name} ${p.last_name}`.trim() || "A member"
        : d
          ? "A former member"
          : null,
      decisionNote: d?.note ?? null,
      months: rows,
      check,
      warning: switchedWarning(status, check),
    };
  });
  return { tolerance, latestMonth, lockLabel: lockLabel(lockedMonths, months), areas };
}
