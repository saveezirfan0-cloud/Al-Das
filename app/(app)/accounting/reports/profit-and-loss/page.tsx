import { selectClass } from "@/components/finance/forms";
import { PageHeader } from "@/components/shell/page-header";
import { PL_DIMENSIONS } from "@/lib/accounting/statements/profit-loss";
import { statementQuery } from "@/lib/accounting/statements/params";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Profit and loss" };
export const dynamic = "force-dynamic";

export default async function ProfitAndLossPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, p, built } = await loadReportPage("profit-and-loss", searchParams);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Profit and loss"
        description="Tally's layout: sales and direct incomes less purchases and direct expenses give the gross profit; indirect incomes and expenses give the net profit. Click a ledger for its general ledger."
      >
        <DownloadButtons report="profit-and-loss" query={statementQuery(p)} />
      </PageHeader>
      <StatementFilters
        entities={ctx.entities}
        entity={p.entity}
        from={p.from}
        to={p.to}
        includeAdjustment={p.includeAdjustment}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Columns</span>
          <select name="dim" defaultValue={p.dimension} className={`${selectClass} w-40`}>
            {PL_DIMENSIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Compare with</span>
          <select name="compare" defaultValue={p.compare} className={`${selectClass} w-44`}>
            <option value="none">Nothing</option>
            <option value="previous">The previous period</option>
            <option value="last_year">The same period last year</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Show</span>
          <select
            name="view"
            defaultValue={p.groupsOnly ? "groups" : ""}
            className={`${selectClass} w-40`}
          >
            <option value="">Groups and ledgers</option>
            <option value="groups">Groups only</option>
          </select>
        </label>
      </StatementFilters>
      <ProblemNote problem={p.problem} />
      {p.dimension !== "none" && p.compare !== "none" && (
        <p className="text-muted-foreground text-xs">
          A comparison is shown with one column only; choose &quot;One column&quot; to compare.
        </p>
      )}
      <ReportView doc={built.doc} />
    </div>
  );
}
