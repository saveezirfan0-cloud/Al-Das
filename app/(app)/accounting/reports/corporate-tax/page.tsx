import { PageHeader } from "@/components/shell/page-header";
import { Input } from "@/components/ui/input";
import { statementQuery } from "@/lib/accounting/statements/params";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";

export const metadata = { title: "Corporate tax bridge" };
export const dynamic = "force-dynamic";

export default async function CorporateTaxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, p, built } = await loadReportPage("corporate-tax", searchParams, ({ fy }) => ({
    from: fy.start,
    to: fy.end,
  }));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Corporate tax bridge"
        description="From accounting profit to taxable income: a working paper for the tax adviser, not a tax return. Tag ledgers (entertainment, fines, donations, connected persons) on the chart of accounts (Reporting)."
      >
        <DownloadButtons report="corporate-tax" query={statementQuery(p)} />
      </PageHeader>
      <StatementFilters entities={ctx.entities} entity={p.entity} from={p.from} to={p.to}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Other add-backs (AED)</span>
          <Input
            name="add"
            defaultValue={p.otherAddBacks || ""}
            inputMode="decimal"
            className="w-36"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Other deductions (AED)</span>
          <Input
            name="ded"
            defaultValue={p.otherDeductions || ""}
            inputMode="decimal"
            className="w-36"
          />
        </label>
      </StatementFilters>
      <ProblemNote problem={p.problem} />
      <ReportView doc={built.doc} />
    </div>
  );
}
