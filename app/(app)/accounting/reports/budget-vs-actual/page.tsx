import Link from "next/link";

import { selectClass } from "@/components/finance/forms";
import { PageHeader } from "@/components/shell/page-header";
import { Input } from "@/components/ui/input";
import { fiscalYearOf } from "@/lib/accounting/numbering";
import { statementQuery } from "@/lib/accounting/statements/params";
import { loadBudgets } from "@/lib/accounting/statements/server";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Budget against actual" };
export const dynamic = "force-dynamic";

export default async function BudgetVsActualPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { admin, member, ctx, p, built } = await loadReportPage("budget-vs-actual", searchParams);
  const [budgets, branches] = await Promise.all([
    loadBudgets(admin, member.orgId),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", member.orgId).order("code"),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Budget against actual"
        description="Each income and expense ledger's budget and actual for the range, the variance and its percentage. Lines worse than budget by more than the threshold are highlighted."
      >
        {p.budget && <DownloadButtons report="budget-vs-actual" query={statementQuery(p)} />}
      </PageHeader>
      <StatementFilters
        entities={[]}
        entity={p.entity}
        from={built.bva?.from ?? p.from}
        to={built.bva?.to ?? p.to}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Budget</span>
          <select name="budget" defaultValue={p.budget ?? ""} className={`${selectClass} w-56`}>
            <option value="">Choose a budget</option>
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({fiscalYearOf(Number(b.fy_start.slice(5, 7)), b.fy_start).label}
                {b.status === "approved" ? "" : ", draft"})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Branch</span>
          <select name="branch" defaultValue={p.branch ?? ""} className={`${selectClass} w-40`}>
            <option value="">All</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.code} value={b.code}>
                {b.name ?? b.code}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Department</span>
          <Input
            name="department"
            defaultValue={p.department ?? ""}
            className="w-40"
            maxLength={60}
          />
        </label>
      </StatementFilters>
      <ProblemNote problem={p.problem} />
      {budgets.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No budgets yet. Add one under{" "}
          <Link href="/accounting/budgets" className="underline">
            Budgets
          </Link>
          .
        </p>
      ) : p.budget ? (
        <ReportView doc={built.doc} />
      ) : (
        <p className="text-muted-foreground text-sm">
          Choose a budget. The range is limited to its fiscal year.
        </p>
      )}
      {ctx.entities.length > 1 && (
        <p className="text-muted-foreground text-xs">Actuals are the budget&apos;s own entity.</p>
      )}
    </div>
  );
}
