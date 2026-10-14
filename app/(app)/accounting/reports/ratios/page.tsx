import { PageHeader } from "@/components/shell/page-header";
import { statementQuery } from "@/lib/accounting/statements/params";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Ratios" };
export const dynamic = "force-dynamic";

export default async function RatiosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, p, built } = await loadReportPage("ratios", searchParams);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Ratios"
        description="Liquidity, collection and payment days, margins and revenue per patient visit, from the balance sheet at the end of the period and the profit and loss for it."
      >
        <DownloadButtons report="ratios" query={statementQuery(p)} />
      </PageHeader>
      <StatementFilters entities={ctx.entities} entity={p.entity} from={p.from} to={p.to} />
      <ProblemNote problem={p.problem} />
      <ReportView doc={built.doc} />
    </div>
  );
}
