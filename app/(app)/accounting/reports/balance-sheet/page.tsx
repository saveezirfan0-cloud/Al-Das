import { selectClass } from "@/components/finance/forms";
import { PageHeader } from "@/components/shell/page-header";
import { statementQuery } from "@/lib/accounting/statements/params";

import { BranchCodeSelect } from "../../ui";
import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Balance sheet" };
export const dynamic = "force-dynamic";

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, p, built, branchOptions } = await loadReportPage("balance-sheet", searchParams);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Balance sheet"
        description="Capital and liabilities against assets, by Tally group. The current year's profit is shown in equity until the year-end close."
      >
        <DownloadButtons report="balance-sheet" query={statementQuery(p)} />
      </PageHeader>
      <StatementFilters
        entities={ctx.entities}
        entity={p.entity}
        from={p.from}
        to={p.to}
        showFrom={false}
        toLabel="As at"
        includeAdjustment={p.includeAdjustment}
      >
        <BranchCodeSelect options={branchOptions} value={p.branch} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Compare with</span>
          <select name="compare" defaultValue={p.compare} className={`${selectClass} w-48`}>
            <option value="none">Nothing</option>
            <option value="last_year">The same date last year</option>
            <option value="previous">The previous year end</option>
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
      <ReportView doc={built.doc} />
    </div>
  );
}
