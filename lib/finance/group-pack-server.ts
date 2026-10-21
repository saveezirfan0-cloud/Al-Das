import "server-only";

import { loadEntities } from "@/lib/accounting/accounting-server";
import { PAYABLES_READ } from "@/lib/accounting/nav";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { loadPayablesAgeing } from "@/lib/accounting/payables-server";
import type { PlData } from "@/lib/accounting/statements/profit-loss";
import { can, canAny } from "@/lib/auth/can";
import type { CurrentMember } from "@/lib/auth/session";
import { liveClosePack, loadCloseByMonth, monthRange } from "@/lib/finance/close-server";
import { loadPerfScope, loadDoctorPerformance } from "@/lib/finance/doctor-performance-server";
import { loadLines, loadTargets } from "@/lib/finance/flash-server";
import {
  type BranchFigures,
  type CloseTaskRow,
  type GroupPackInput,
  type Missing,
  type PlSection,
  type PlTotals,
} from "@/lib/finance/group-pack";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * docs/51: gathers Al Das's group-pack submission. Service role; the caller has checked finance.group_pack.export. Each
 * section is read only when the member also holds that section's own key (the ledger P&L: accounting.reports.view;
 * payables: the payables keys); otherwise the sheet says which permission it needs. The whole clinic is reported, so
 * the member must see every branch (the caller refuses otherwise).
 */

export class GroupPackScopeError extends Error {}

const ZERO: PlTotals = {
  direct_income: 0,
  direct_expense: 0,
  gross_profit: 0,
  indirect_income: 0,
  indirect_expense: 0,
  net_profit: 0,
};

const plTotals = (d: PlData): PlTotals => {
  const t = d.totals[0];
  if (!t) return ZERO;
  return {
    direct_income: Number(t.direct_income) || 0,
    direct_expense: Number(t.direct_expense) || 0,
    gross_profit: Number(t.gross_profit) || 0,
    indirect_income: Number(t.indirect_income) || 0,
    indirect_expense: Number(t.indirect_expense) || 0,
    net_profit: Number(t.net_profit) || 0,
  };
};

async function loadPl(
  admin: AdminClient,
  orgId: string,
  month: string,
): Promise<PlSection | Missing> {
  const entities = await loadEntities(admin, orgId);
  const entity = entities.find((e) => e.is_default) ?? entities[0];
  if (!entity) return { missing: "No accounting entity is set up (Accounting, Setup)." };
  const { last } = monthRange(month.slice(0, 7));
  const fy = fiscalYearOf(entity.fiscal_year_start_month, month);
  const call = async (from: string, to: string) => {
    const { data, error } = await admin.rpc("acc_profit_and_loss", {
      p_org_id: orgId,
      p_entity_id: entity.id,
      p_from: from,
      p_to: to,
      p_dimension: "none",
      p_include_adjustment: false,
    });
    if (error || !data) throw new Error("Could not read the profit and loss.");
    return data as unknown as PlData;
  };
  const [m, y] = await Promise.all([call(month, last), call(fy.start, last)]);
  return {
    month: plTotals(m),
    ytd: plTotals(y),
    ytdFrom: fy.start,
    provisional: m.provisional || y.provisional,
    empty: y.rows.length === 0,
  };
}

/** The month's total revenue and patient targets, as the flash report sets them (daily target × days in the month). */
async function loadMonthTargets(admin: AdminClient, orgId: string, month: string) {
  const [lines, targets] = await Promise.all([
    loadLines(admin, orgId),
    loadTargets(admin, orgId, month),
  ]);
  const days = Number(monthRange(month.slice(0, 7)).last.slice(8, 10));
  const total = targets.find((t) => t.lineCode === null);
  const core = new Set(lines.filter((l) => l.inCore).map((l) => l.code));
  const lineRates = targets
    .filter((t) => t.lineCode !== null && core.has(t.lineCode))
    .map((t) => t.dailyRevenue)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const revenueRate =
    total?.dailyRevenue ?? (lineRates.length > 0 ? lineRates.reduce((a, v) => a + v, 0) : null);
  const patientRate = total?.dailyPatients ?? null;
  const times = (r: number | null) => (r === null ? null : Math.round(r * days * 100) / 100);
  return { revenue: times(revenueRate), patients: times(patientRate) };
}

async function loadTasks(
  admin: AdminClient,
  orgId: string,
  month: string,
): Promise<CloseTaskRow[]> {
  const [{ data: tasks, error }, { data: steps }] = await Promise.all([
    admin
      .from("fin_close_tasks")
      .select("step_code, due_wd, status, done_at, blocked_reason")
      .eq("org_id", orgId)
      .eq("month", month),
    admin.from("fin_close_steps").select("code, title, owner_role, sort_order").eq("org_id", orgId),
  ]);
  if (error) throw new Error("Could not load the close tasks.");
  const byCode = new Map((steps ?? []).map((s) => [s.code, s]));
  return (tasks ?? [])
    .map((t) => {
      const s = byCode.get(t.step_code);
      return {
        step: t.step_code,
        title: s?.title ?? t.step_code,
        owner: s?.owner_role ?? null,
        dueWd: t.due_wd,
        status: t.status as CloseTaskRow["status"],
        doneAt: t.done_at,
        blockedReason: t.blocked_reason,
        sort: s?.sort_order ?? 100,
      };
    })
    .sort((a, b) => a.dueWd - b.dueWd || a.sort - b.sort || a.step.localeCompare(b.step))
    .map((t) => ({
      step: t.step,
      title: t.title,
      owner: t.owner,
      dueWd: t.dueWd,
      status: t.status,
      doneAt: t.doneAt,
      blockedReason: t.blockedReason,
    }));
}

export async function loadGroupPackInput(
  admin: AdminClient,
  member: CurrentMember,
  month: string, // YYYY-MM-01
  builtAt: string,
): Promise<GroupPackInput> {
  const scope = await loadPerfScope(admin, member);
  if (scope.allowed !== null)
    throw new GroupPackScopeError(
      "The group pack covers every branch; your access is limited to some branches.",
    );

  const ym = month.slice(0, 7);
  const [clinicPerf, branchPerfs, record, targets, tasks] = await Promise.all([
    loadDoctorPerformance(admin, member.orgId, { month, branch: null, allowed: null }),
    Promise.all(
      scope.branches.map((b) =>
        loadDoctorPerformance(admin, member.orgId, { month, branch: b.code, allowed: null }).then(
          (p) => ({ b, p }),
        ),
      ),
    ),
    loadCloseByMonth(admin, member.orgId, ym),
    loadMonthTargets(admin, member.orgId, month),
    loadTasks(admin, member.orgId, month),
  ]);

  const frozen = record?.pack ?? null;
  const pack = frozen ?? (await liveClosePack(admin, member.orgId, member.org.name, ym, builtAt));

  const pl: PlSection | Missing = can(member, "accounting.reports.view")
    ? await loadPl(admin, member.orgId, month)
    : { missing: "Needs the Accounting reports permission (accounting.reports.view)." };
  const payables = canAny(member, [...PAYABLES_READ, "finance.payables.view"])
    ? await loadPayablesAgeing(admin, member.orgId, monthRange(ym).last)
    : { missing: "Needs a payables permission (finance.payables.view)." };

  const t = clinicPerf.total;
  const branches: BranchFigures[] = branchPerfs.map(({ b, p }) => ({
    code: b.code,
    name: b.name,
    revenue: p.total.revenue,
    visits: p.total.visits,
    patients: p.total.patients,
    unbilledPatients: p.total.unbilledPatients,
    newVisits: p.total.newVisits,
    cancelledVisits: p.total.cancelledVisits,
  }));

  return {
    org: member.org.name,
    month,
    builtAt,
    status: record?.status ?? "open",
    branches,
    clinic: clinicPerf.hasData
      ? {
          revenue: t.revenue,
          visits: t.visits,
          patients: t.patients,
          unbilledPatients: t.unbilledPatients,
          newVisits: t.newVisits,
          cancelledVisits: t.cancelledVisits,
          previous: t.previous,
          arppTarget: clinicPerf.settings.target,
          coverage: { label: clinicPerf.coverage.label, full: clinicPerf.coverage.full },
        }
      : null,
    targets,
    close: { pack, frozen: !!frozen },
    pl,
    payables,
    tasks,
    sign: record
      ? {
          financeBy: record.sign.financeBy,
          financeAt: record.sign.financeAt,
          ceoBy: record.sign.ceoBy,
          ceoAt: record.sign.ceoAt,
          lockedAt: record.sign.lockedAt,
          hash: record.sign.hash,
        }
      : null,
  };
}
