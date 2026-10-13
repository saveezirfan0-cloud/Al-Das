import "server-only";

import { loadAccounts, loadEntities, type EntityView } from "@/lib/accounting/accounting-server";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { buildBalanceSheet, type BsData } from "@/lib/accounting/statements/balance-sheet";
import { buildBudgetVsActual, type BvaData } from "@/lib/accounting/statements/budget";
import { buildCashFlow, type CfData } from "@/lib/accounting/statements/cash-flow";
import { ctAccountsTable, ctBridge, type CtData } from "@/lib/accounting/statements/corporate-tax";
import {
  buildExceptions,
  exceptionCount,
  type ExceptionsData,
} from "@/lib/accounting/statements/exceptions";
import type { StatementParams, StatementReport } from "@/lib/accounting/statements/params";
import { STATEMENT_TITLES } from "@/lib/accounting/statements/params";
import {
  buildProfitAndLoss,
  mergeComparison,
  PL_DIMENSIONS,
  type PlData,
} from "@/lib/accounting/statements/profit-loss";
import {
  computeRatios,
  ratioInputs,
  ratioInputsTable,
  ratiosTable,
} from "@/lib/accounting/statements/ratios";
import {
  comparisonRange,
  dateLabel,
  rangeLabel,
  yearEarlier,
  type ReportDoc,
} from "@/lib/accounting/statements/report";
import type { StatementAccount } from "@/lib/accounting/statements/tree";
import { buildVatReturn, vatBoxLines, type VatData } from "@/lib/accounting/statements/vat";
import { can, canAny, type MemberLike } from "@/lib/auth/can";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Server side of the Phase 22G statements: one loader per report that calls the SQL function (service role; the caller
 * has run can() for REPORT_PERMISSIONS) and shapes the result into the ReportDoc the page, the Excel and the PDF all
 * render. Drill-down links are added only for what the viewer may open.
 */

export const REPORT_PERMISSIONS: Record<StatementReport, readonly string[]> = {
  "profit-and-loss": ["accounting.reports.view"],
  "balance-sheet": ["accounting.reports.view"],
  "cash-flow": ["accounting.reports.view"],
  "budget-vs-actual": [
    "accounting.reports.view",
    "accounting.budgets.manage",
    "accounting.journals.approve",
  ],
  "vat-return": ["accounting.reports.view", "accounting.tax.manage"],
  ratios: ["accounting.reports.view"],
  exceptions: ["accounting.reports.view"],
  "corporate-tax": ["accounting.reports.view"],
};

export function mayOpenReport(member: MemberLike, report: StatementReport): boolean {
  return canAny(member, REPORT_PERMISSIONS[report]);
}

export type StatementContext = {
  entities: EntityView[];
  entity: EntityView | null;
  accounts: StatementAccount[];
  fy: { start: string; end: string; label: string };
};

export async function statementContext(
  admin: AdminClient,
  orgId: string,
  entityId: string | null,
  today: string,
): Promise<StatementContext> {
  const [entities, accounts] = await Promise.all([
    loadEntities(admin, orgId),
    loadAccounts(admin, orgId),
  ]);
  const entity = entities.find((e) => e.id === entityId) ?? null;
  const start =
    (entity ?? entities.find((e) => e.is_default) ?? entities[0])?.fiscal_year_start_month ?? 7;
  const fy = fiscalYearOf(start, today);
  return { entities, entity, accounts, fy };
}

export type BuiltStatement = { doc: ReportDoc; rows: number; vat?: VatData; bva?: BvaData };

const rpcData = async <T>(
  p: PromiseLike<{ data: unknown; error: { message?: string } | null }>,
): Promise<T> => {
  const { data, error } = await p;
  if (error || !data) throw new Error("statement query failed");
  return data as T;
};

export async function buildStatement(
  admin: AdminClient,
  member: MemberLike & { org: { name: string } },
  report: StatementReport,
  p: StatementParams,
  ctx: StatementContext,
): Promise<BuiltStatement> {
  const orgId = member.orgId;
  const entityId = ctx.entity?.id ?? null;
  const ledger = can(member, "accounting.ledger.view");
  const ledgerHref = (from: string, to: string) => (a: StatementAccount) =>
    ledger ? `/accounting/ledger?account=${a.id}&from=${from}&to=${to}` : null;
  const ledgerHrefId = (from: string, to: string) => (id: string) =>
    ledger ? `/accounting/ledger?account=${id}&from=${from}&to=${to}` : null;
  const journalHref = (id: string) => (ledger ? `/accounting/journals/${id}` : null);
  const entityText = ctx.entities.length > 1 ? `${ctx.entity?.name ?? "All entities"}. ` : "";
  const adjText = p.includeAdjustment ? "" : " Adjustment period left out.";
  const title = STATEMENT_TITLES[report];
  const doc = (
    d: Omit<ReportDoc, "title" | "warnings" | "notes"> & Partial<ReportDoc>,
  ): ReportDoc => ({
    title,
    warnings: [],
    notes: [],
    ...d,
  });

  switch (report) {
    case "profit-and-loss": {
      const call = (from: string, to: string, dim: string) =>
        rpcData<PlData>(
          admin.rpc("acc_profit_and_loss", {
            p_org_id: orgId,
            p_entity_id: entityId as string,
            p_from: from,
            p_to: to,
            p_dimension: dim,
            p_include_adjustment: p.includeAdjustment,
          }),
        );
      let data: PlData;
      let extra: "total" | "change" | null = null;
      let subtitle = rangeLabel(p.from, p.to);
      if (p.dimension === "none" && p.compare !== "none") {
        const r = comparisonRange(p.from, p.to, p.compare);
        const [cur, cmp] = await Promise.all([
          call(p.from, p.to, "none"),
          call(r.from, r.to, "none"),
        ]);
        data = mergeComparison(cur, cmp, {
          cur: rangeLabel(p.from, p.to),
          cmp: rangeLabel(r.from, r.to),
        });
        extra = "change";
        subtitle = `${rangeLabel(p.from, p.to)} compared with ${rangeLabel(r.from, r.to)}`;
      } else {
        data = await call(p.from, p.to, p.dimension);
        if (data.columns.length === 0) {
          data = { ...data, columns: ["total"], labels: { total: "Amount" } };
        }
        if (p.dimension !== "none") {
          extra = "total";
          subtitle += `, ${PL_DIMENSIONS.find((d) => d.value === p.dimension)?.label.toLowerCase()}`;
        }
      }
      const pl = buildProfitAndLoss(ctx.accounts, data, {
        extra,
        hrefFor: ledgerHref(p.from, p.to),
        groupsOnly: p.groupsOnly,
      });
      return {
        rows: pl.table.rows.length,
        doc: doc({
          subtitle: `${entityText}${subtitle}.${adjText}`,
          provisional: data.provisional,
          tables: [pl.table],
          notes: [
            "Gross profit uses Tally's 'affects gross profit' flag: Sales Accounts and Direct Incomes less Purchase Accounts and Direct Expenses.",
            ...(p.dimension !== "none"
              ? [
                  "Columns follow the branch, department or doctor written on each journal line; 'Not set' collects lines without one.",
                ]
              : []),
          ],
        }),
      };
    }
    case "balance-sheet": {
      const call = (asAt: string) =>
        rpcData<BsData>(
          admin.rpc("acc_balance_sheet", {
            p_org_id: orgId,
            p_entity_id: entityId as string,
            p_as_at: asAt,
            p_include_adjustment: p.includeAdjustment,
          }),
        );
      const dates = [p.to];
      if (p.compare === "last_year") dates.push(yearEarlier(p.to));
      if (p.compare === "previous")
        dates.push(dateBefore(fiscalYearOf(Number(ctx.fy.start.slice(5, 7)), p.to).start));
      const data = await Promise.all(dates.map(call));
      const bs = buildBalanceSheet(ctx.accounts, data, {
        hrefFor: ledgerHref(data[0]?.fy_start ?? p.from, p.to),
        groupsOnly: p.groupsOnly,
      });
      return {
        rows: bs.table.rows.length,
        doc: doc({
          subtitle: `${entityText}As at ${dateLabel(p.to)}${dates.length > 1 ? `, compared with ${dateLabel(dates[1])}` : ""}.${adjText}`,
          provisional: data.some((d) => d.provisional),
          warnings: bs.balanced
            ? []
            : [
                "The balance sheet does not balance: assets differ from capital and liabilities. Check imported and opening balances.",
              ],
          tables: [bs.table],
          notes: [
            "The current year's profit and earlier years' profit stay as lines in equity until the year-end close moves them into reserves.",
          ],
        }),
      };
    }
    case "cash-flow": {
      const data = await rpcData<CfData>(
        admin.rpc("acc_cash_flow", {
          p_org_id: orgId,
          p_entity_id: entityId as string,
          p_from: p.from,
          p_to: p.to,
          p_include_adjustment: p.includeAdjustment,
        }),
      );
      const cf = buildCashFlow(ctx.accounts, data, { hrefFor: ledgerHref(p.from, p.to) });
      return {
        rows: cf.tables[0].rows.length,
        doc: doc({
          subtitle: `${entityText}${rangeLabel(p.from, p.to)}, indirect method.${adjText}`,
          provisional: data.provisional,
          warnings: cf.reconciles
            ? []
            : [
                "The statement does not reconcile to the cash and bank ledgers. Check each ledger's cash flow class.",
              ],
          tables: cf.tables,
          notes: [
            "Each balance-sheet ledger's class (non-cash, working capital, investing, financing, cash) comes from the chart of accounts (Reporting), else from its Tally group.",
          ],
        }),
      };
    }
    case "vat-return": {
      const data = await rpcData<VatData>(
        admin.rpc("acc_vat_return", {
          p_org_id: orgId,
          p_entity_id: entityId as string,
          p_from: p.from,
          p_to: p.to,
        }),
      );
      const boxHref = (box: string) =>
        `/accounting/reports/vat-return?${vatQuery(p)}&box=${box}#box`;
      const vat = buildVatReturn(data, { journalHref, boxHref });
      const tables = p.box
        ? [...vat.tables.slice(0, 5), vatBoxLines(data, p.box, journalHref), vat.tables[5]]
        : vat.tables;
      const warnings: string[] = [];
      if (vat.checks.missing)
        warnings.push(
          `${vat.checks.missing} line(s) on income, expense or VAT ledgers have no tax code.`,
        );
      if (vat.checks.defaultedLines)
        warnings.push(
          `${vat.checks.defaultedLines} standard-rated line(s) name no branch and use the default emirate (${data.default_emirate}).`,
        );
      if (vat.checks.vatMismatch)
        warnings.push(
          "The VAT booked differs from amount x rate in at least one box (see Checks).",
        );
      if (vat.checks.review)
        warnings.push(
          `${vat.checks.review} line(s) carry a tax code on an unexpected account (see Checks).`,
        );
      return {
        rows: data.lines.length,
        vat: data,
        doc: doc({
          subtitle: `${data.entity_name}${data.trn ? `, TRN ${data.trn}` : ""}. Tax period ${rangeLabel(p.from, p.to)}.`,
          provisional: data.provisional,
          workingPaper:
            "Working paper: Pulse does not file VAT returns. Enter the figures in EmaraTax after review.",
          warnings,
          tables,
          notes: [
            "Box 1 splits standard-rated supplies by the emirate of the branch on each line. The Adjustment column (for example bad debt relief) is not captured and stays zero.",
            "Which services are zero-rated, exempt or standard-rated is for the tax adviser to confirm (OQ-120).",
          ],
        }),
      };
    }
    case "ratios": {
      const [bs, pl, flash] = await Promise.all([
        rpcData<BsData>(
          admin.rpc("acc_balance_sheet", {
            p_org_id: orgId,
            p_entity_id: entityId as string,
            p_as_at: p.to,
            p_include_adjustment: true,
          }),
        ),
        rpcData<PlData>(
          admin.rpc("acc_profit_and_loss", {
            p_org_id: orgId,
            p_entity_id: entityId as string,
            p_from: p.from,
            p_to: p.to,
            p_dimension: "none",
            p_include_adjustment: true,
          }),
        ),
        admin.rpc("fin_flash_inputs", { p_org_id: orgId, p_from: p.from, p_to: p.to }),
      ]);
      const flashRows = (flash.data as { rows?: Array<{ patients?: number }> } | null)?.rows ?? [];
      const patients = flashRows.reduce((s, r) => s + Number(r.patients ?? 0), 0) || null;
      const inputs = ratioInputs(ctx.accounts, bs, pl, patients);
      const r = computeRatios(inputs);
      return {
        rows: 8,
        doc: doc({
          subtitle: `${entityText}${rangeLabel(p.from, p.to)}; balances as at ${dateLabel(p.to)}.`,
          provisional: bs.provisional || pl.provisional,
          tables: [ratiosTable(inputs, r), ratioInputsTable(inputs)],
          notes: [
            "Patient visits are counted by the finance analytics (distinct patients per day, branch, department and doctor); no patient data is shown here.",
          ],
        }),
      };
    }
    case "exceptions": {
      const data = await rpcData<ExceptionsData>(
        admin.rpc("acc_statement_exceptions", {
          p_org_id: orgId,
          p_entity_id: entityId as string,
          p_from: p.from,
          p_to: p.to,
        }),
      );
      const tables = buildExceptions(data, { journalHref, ledgerHref: ledgerHrefId(p.from, p.to) });
      return {
        rows: exceptionCount(data),
        doc: doc({
          subtitle: `${entityText}${rangeLabel(p.from, p.to)}. ${exceptionCount(data)} item(s) to look at.`,
          provisional: data.provisional,
          tables,
          notes: ["Each list shows at most 500 items."],
        }),
      };
    }
    case "corporate-tax": {
      const data = await rpcData<CtData>(
        admin.rpc("acc_ct_bridge", {
          p_org_id: orgId,
          p_entity_id: entityId as string,
          p_from: p.from,
          p_to: p.to,
        }),
      );
      const ct = ctBridge(data, {
        otherAddBacks: p.otherAddBacks,
        otherDeductions: p.otherDeductions,
      });
      return {
        rows: ct.table.rows.length,
        doc: doc({
          subtitle: `${entityText}${rangeLabel(p.from, p.to)}.`,
          provisional: data.provisional,
          workingPaper: "Working paper, not a tax return.",
          tables: [ct.table, ctAccountsTable(data, ledgerHrefId(p.from, p.to))],
          notes: ct.notes,
        }),
      };
    }
    case "budget-vs-actual": {
      if (!p.budget) {
        return {
          rows: 0,
          doc: doc({
            subtitle: "Choose a budget.",
            provisional: false,
            tables: [],
          }),
        };
      }
      const data = await rpcData<BvaData>(
        admin.rpc("acc_budget_vs_actual", {
          p_org_id: orgId,
          p_budget_id: p.budget,
          p_from: p.from,
          p_to: p.to,
          p_branch: p.branch as string,
          p_department: p.department as string,
        }),
      );
      const b = buildBudgetVsActual(ctx.accounts, data, {
        hrefFor: ledgerHref(data.from, data.to),
      });
      const filters = [
        data.branch ? `branch ${data.branch}` : null,
        data.department ? `department ${data.department}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        rows: b.tables[0].rows.length,
        bva: data,
        doc: doc({
          subtitle: `${data.name} (${data.status === "approved" ? "approved" : "draft, not approved"}). ${rangeLabel(data.from, data.to)}${filters ? `, ${filters}` : ""}.`,
          provisional: data.provisional,
          warnings: b.adverseCount
            ? [`${b.adverseCount} line(s) are more than ${data.threshold_pct}% worse than budget.`]
            : [],
          tables: b.tables,
          notes: [
            `Highlighted: expenses more than ${data.threshold_pct}% over budget (or spent without a budget) and income more than ${data.threshold_pct}% under budget. The percentage is set in Accounting, Report settings.`,
          ],
        }),
      };
    }
  }
}

function dateBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export type VatSettings = {
  entity_id: string;
  name: string;
  vat_period_months: 1 | 3;
  vat_period_anchor_month: number;
  default_emirate: string;
};

/** The VAT period settings of an entity (null = the default entity). */
export async function loadVatSettings(
  admin: AdminClient,
  orgId: string,
  entityId: string | null,
): Promise<VatSettings | null> {
  let q = admin
    .from("acc_entities")
    .select("id, name, vat_period_months, vat_period_anchor_month, default_emirate")
    .eq("org_id", orgId);
  q = entityId ? q.eq("id", entityId) : q.eq("is_default", true);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  return {
    entity_id: data.id,
    name: data.name,
    vat_period_months: data.vat_period_months === 1 ? 1 : 3,
    vat_period_anchor_month: data.vat_period_anchor_month,
    default_emirate: data.default_emirate,
  };
}

/** Who may open the budgets pages (the page checks again; editing and approving have their own keys). */
export const BUDGET_VIEW_KEYS = [
  "accounting.budgets.manage",
  "accounting.journals.approve",
  "accounting.reports.view",
] as const;

export type BudgetListRow = {
  id: string;
  entity_id: string;
  fy_start: string;
  name: string;
  status: "draft" | "approved";
  prepared_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string;
};

export async function loadBudgets(admin: AdminClient, orgId: string): Promise<BudgetListRow[]> {
  const { data } = await admin
    .from("acc_budgets")
    .select(
      "id, entity_id, fy_start, name, status, prepared_by, approved_by, approved_at, updated_at",
    )
    .eq("org_id", orgId)
    .order("fy_start", { ascending: false })
    .order("name")
    .limit(500);
  return (data ?? []).map((b) => ({
    ...b,
    status: b.status === "approved" ? "approved" : "draft",
  }));
}

export type BudgetDetail = BudgetListRow & {
  prepared_at: string | null;
  approved_sha256: string | null;
  lines: Array<{
    account_id: string;
    month: string;
    branch_code: string | null;
    department: string | null;
    amount: number;
  }>;
  /** the hash of the content now: what an approver approves */
  hash: string | null;
};

export async function loadBudget(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<BudgetDetail | null> {
  const { data: b } = await admin
    .from("acc_budgets")
    .select(
      "id, entity_id, fy_start, name, status, prepared_by, prepared_at, approved_by, approved_at, approved_sha256, updated_at",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!b) return null;
  const [{ data: lines }, hash] = await Promise.all([
    admin
      .from("acc_budget_lines")
      .select("account_id, month, branch_code, department, amount")
      .eq("budget_id", b.id)
      .order("month")
      .limit(20000),
    admin.rpc("acc_budget_hash", { p_budget_id: b.id }),
  ]);
  return {
    ...b,
    status: b.status === "approved" ? "approved" : "draft",
    lines: (lines ?? []).map((l) => ({
      ...l,
      month: l.month.slice(0, 7),
      amount: Number(l.amount),
    })),
    hash: (hash.data as string | null) ?? null,
  };
}

function vatQuery(p: StatementParams): string {
  const q = new URLSearchParams({ from: p.from, to: p.to });
  if (p.entity) q.set("entity", p.entity);
  return q.toString();
}
