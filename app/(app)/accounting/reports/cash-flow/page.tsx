import { PageHeader } from "@/components/shell/page-header";
import { statementQuery } from "@/lib/accounting/statements/params";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Cash flow" };
export const dynamic = "force-dynamic";

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, p, built } = await loadReportPage("cash-flow", searchParams);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cash flow"
        description="Indirect method: the net profit, non-cash items added back, changes in working capital, investing and financing, reconciled to the cash and bank ledgers. Set a ledger's class on the chart of accounts (Reporting)."
      >
        <DownloadButtons report="cash-flow" query={statementQuery(p)} />
      </PageHeader>
      <StatementFilters
        entities={ctx.entities}
        entity={p.entity}
        from={p.from}
        to={p.to}
        includeAdjustment={p.includeAdjustment}
      />
      <ProblemNote problem={p.problem} />
      <ReportView doc={built.doc} />
    </div>
  );
}
