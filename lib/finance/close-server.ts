import "server-only";

import { addDays } from "@/lib/documents/expiry";
import {
  buildClosePack,
  packDrift,
  readClosePack,
  type ClosePack,
  type DriftRow,
  type MonthFigures,
  type RevenueLine,
  type ReasonLine,
} from "@/lib/finance/close-pack";
import { readControls } from "@/lib/finance/close-controls";
import type { SignOff } from "@/lib/finance/close-xlsx";
import { parseRevenue } from "@/lib/finance/revenue";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/** Server side of the month-end close: gathering the figures, freezing the snapshot, drift and sign-off names. Service role; callers have run can(). */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthRange(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { first, last };
}

/** The last month that has fully ended, as YYYY-MM, in the clinic's calendar. */
export function lastClosedMonth(today: string): string {
  const first = `${today.slice(0, 7)}-01`;
  return (addDays(first, -1) ?? today).slice(0, 7);
}

const asLines = (json: unknown): RevenueLine[] =>
  parseRevenue(json).map((r) => ({ key: r.key, label: r.label, net: r.net, invoices: r.invoices }));

async function gather(admin: AdminClient, orgId: string, month: string) {
  const { first, last } = monthRange(month);
  const rev = (dimension: string) =>
    admin.rpc("fin_revenue_breakdown", {
      p_org_id: orgId,
      p_from: first,
      p_to: last,
      p_dimension: dimension,
      p_limit: 60,
    });
  const [figures, category, department, doctor, branch, reasons] = await Promise.all([
    admin.rpc("fin_close_month_figures", { p_org_id: orgId, p_month: first }),
    rev("category"),
    rev("department"),
    rev("doctor"),
    rev("branch"),
    admin.rpc("fin_denial_reasons", { p_org_id: orgId, p_from: first, p_to: last, p_limit: 10 }),
  ]);
  for (const r of [figures, category, department, doctor, branch, reasons])
    if (r.error) throw new Error(`close figures: ${r.error.code ?? "unknown"}`);
  return {
    figures: figures.data as unknown as MonthFigures,
    revenue: {
      by_category: asLines(category.data),
      by_department: asLines(department.data),
      by_doctor: asLines(doctor.data),
      by_branch: asLines(branch.data),
    },
    reasons: ((reasons.data ?? []) as unknown as ReasonLine[]).map((r) => ({
      ...r,
      claims: Number(r.claims),
      amount: Number(r.amount),
    })),
  };
}

/** Builds the pack for a finished month and stores it (and its sha256) as the month's snapshot. Refused once finance has signed. */
export async function buildAndStorePack(
  admin: AdminClient,
  input: { orgId: string; orgName: string; month: string; userId: string; now?: Date },
): Promise<{ closeId: string }> {
  const [g, controls] = await Promise.all([
    gather(admin, input.orgId, input.month),
    admin.rpc("fin_close_controls", { p_org_id: input.orgId, p_month: `${input.month}-01` }),
  ]);
  if (controls.error) throw new Error(`close controls: ${controls.error.code ?? "unknown"}`);
  const summary = readControls(controls.data);
  if (!summary) throw new Error("close controls: unreadable summary");
  const pack = buildClosePack({
    orgName: input.orgName,
    month: `${input.month}-01`,
    builtAt: (input.now ?? new Date()).toISOString(),
    figures: g.figures,
    revenue: g.revenue,
    denialReasons: g.reasons,
    controls: summary,
  });
  const { data, error } = await admin.rpc("fin_close_store_snapshot", {
    p_org_id: input.orgId,
    p_month: `${input.month}-01`,
    p_user_id: input.userId,
    p_snapshot: pack as unknown as NonNullable<Json>,
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return { closeId: data as string };
}

/** What the live mirror says now for a month that already has a pack. */
export async function liveDriftFor(
  admin: AdminClient,
  orgId: string,
  pack: ClosePack,
): Promise<DriftRow[]> {
  const month = pack.month.slice(0, 7);
  const g = await gather(admin, orgId, month);
  return packDrift(
    pack,
    g.figures,
    g.revenue.by_category.reduce((a, r) => a + r.net, 0),
  );
}

export type CloseRecord = {
  id: string;
  month: string;
  status: "open" | "built" | "finance_signed" | "locked";
  pack: ClosePack | null;
  hash: string | null;
  financeById: string | null;
  ceoById: string | null;
  sign: SignOff;
};

export async function loadCloseByMonth(
  admin: AdminClient,
  orgId: string,
  month: string,
): Promise<CloseRecord | null> {
  const { data: c } = await admin
    .from("fin_period_closes")
    .select("*")
    .eq("org_id", orgId)
    .eq("month", `${month}-01`)
    .maybeSingle();
  if (!c) return null;
  const ids = [c.finance_signed_by, c.ceo_signed_by].filter((x): x is string => !!x);
  const { data: people } = ids.length
    ? await admin.from("profiles").select("id, first_name, last_name").in("id", ids)
    : { data: [] };
  const name = (id: string | null) => {
    if (!id) return null;
    const p = (people ?? []).find((x) => x.id === id);
    return p ? `${p.first_name} ${p.last_name}`.trim() || "A member" : "A former member";
  };
  return {
    id: c.id,
    month: c.month,
    status: c.status as CloseRecord["status"],
    pack: readClosePack(c.snapshot),
    hash: c.snapshot_hash,
    financeById: c.finance_signed_by,
    ceoById: c.ceo_signed_by,
    sign: {
      financeBy: name(c.finance_signed_by),
      financeAt: c.finance_signed_at,
      financeNote: c.finance_note,
      ceoBy: name(c.ceo_signed_by),
      ceoAt: c.ceo_signed_at,
      ceoNote: c.ceo_note,
      lockedAt: c.locked_at,
      hash: c.snapshot_hash,
    },
  };
}
