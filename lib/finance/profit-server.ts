import "server-only";

import {
  computeProfitability,
  type CompRow,
  type OverheadRow,
  type ProfitGroupBy,
  type ProfitInputRow,
  type ProfitResult,
} from "@/lib/finance/profitability";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Reads the report inputs and runs the pure profitability calculation. Service-role reads: the CALLER must already have
 * checked can(member, 'finance.profit.view') (and finance.costs.compensation for the by-doctor view).
 */

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function loadProfitability(
  admin: AdminClient,
  orgId: string,
  range: { from: string; to: string },
  groupBy: ProfitGroupBy,
): Promise<ProfitResult> {
  const [inputs, comp, overheads, periods] = await Promise.all([
    admin.rpc("fin_profit_inputs", { p_org_id: orgId, p_from: range.from, p_to: range.to }),
    admin
      .from("fin_cost_doctor_comp")
      .select("month, doctor_dha_id, amount")
      .eq("org_id", orgId)
      .gte("month", monthStart(range.from))
      .lte("month", monthStart(range.to))
      .limit(20000),
    admin
      .from("fin_cost_overheads")
      .select("month, branch_code, pool, amount, basis")
      .eq("org_id", orgId)
      .gte("month", monthStart(range.from))
      .lte("month", monthStart(range.to))
      .limit(20000),
    admin
      .from("fin_cost_periods")
      .select("month")
      .eq("org_id", orgId)
      .eq("status", "approved")
      .limit(1000),
  ]);

  const rows: ProfitInputRow[] = (Array.isArray(inputs.data) ? inputs.data : []).map((r) => {
    const x = r as Record<string, unknown>;
    return {
      month: String(x.month),
      branch_code: (x.branch_code as string | null) ?? null,
      department: (x.department as string | null) ?? null,
      doctor_dha_id: (x.doctor_dha_id as string | null) ?? null,
      revenue_net: n(x.revenue_net),
      direct_cost: n(x.direct_cost),
      costed_net: n(x.costed_net),
      lines: n(x.lines),
      uncosted_lines: n(x.uncosted_lines),
    };
  });
  const compRows: CompRow[] = (comp.data ?? []).map((c) => ({
    month: c.month,
    doctor_dha_id: c.doctor_dha_id,
    amount: n(c.amount),
  }));
  const overheadRows: OverheadRow[] = (overheads.data ?? []).map((o) => ({
    month: o.month,
    branch_code: o.branch_code,
    pool: o.pool,
    amount: n(o.amount),
    basis: (["revenue", "invoices", "equal"].includes(o.basis)
      ? o.basis
      : "revenue") as OverheadRow["basis"],
  }));
  return computeProfitability(
    {
      rows,
      comp: compRows,
      overheads: overheadRows,
      approvedMonths: (periods.data ?? []).map((p) => p.month),
    },
    groupBy,
  );
}
