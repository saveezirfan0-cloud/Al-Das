import { PageHeader } from "@/components/shell/page-header";
import { statementQuery } from "@/lib/accounting/statements/params";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Exceptions" };
export const dynamic = "force-dynamic";

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, p, built } = await loadReportPage("exceptions", searchParams);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Exceptions"
        description="What to look at before closing a period: late postings, cash below zero, balances opposite to their nature, suspense, large manual journals and lines missing a branch or cost centre."
      >
        <DownloadButtons report="exceptions" query={statementQuery(p)} />
      </PageHeader>
      <StatementFilters entities={ctx.entities} entity={p.entity} from={p.from} to={p.to} />
      <ProblemNote problem={p.problem} />
      <ReportView doc={built.doc} />
    </div>
  );
}
