import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { EMIRATES } from "@/lib/accounting/accounts";
import { statementQuery } from "@/lib/accounting/statements/params";
import { loadVatSettings } from "@/lib/accounting/statements/server";
import { vatPeriods } from "@/lib/accounting/statements/vat";
import { can } from "@/lib/auth/can";

import { loadReportPage } from "../load";
import { DownloadButtons, ProblemNote, ReportView, StatementFilters } from "../report-view";
import { VatSettingsButton } from "./settings-form";

export const metadata = { title: "VAT return" };
export const dynamic = "force-dynamic";

export default async function VatReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { member, admin, today, ctx, p, built } = await loadReportPage(
    "vat-return",
    searchParams,
    async ({ today: todayDate, admin: client, orgId, entityId }) => {
      const s = await loadVatSettings(client, orgId, entityId);
      const cur = vatPeriods(
        todayDate,
        s?.vat_period_months ?? 3,
        s?.vat_period_anchor_month ?? 1,
        2,
      );
      // the last complete period by default
      return cur[1] ?? cur[0];
    },
  );
  const settings = await loadVatSettings(admin, member.orgId, ctx.entity?.id ?? null);
  const periods = vatPeriods(
    today,
    settings?.vat_period_months ?? 3,
    settings?.vat_period_anchor_month ?? 1,
    8,
  );
  const entityQ = p.entity ? `&entity=${p.entity}` : "";
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="VAT return (VAT 201)"
        description="The FTA return's boxes from the tax codes on journal lines, with the supporting lines per box and the lines without a tax code. A working paper: Pulse never files."
      >
        <div className="flex flex-wrap gap-2">
          {settings && can(member, "accounting.tax.manage") && (
            <VatSettingsButton
              entityId={settings.entity_id}
              entityName={settings.name}
              months={settings.vat_period_months}
              anchor={settings.vat_period_anchor_month}
              emirate={settings.default_emirate}
              emirates={EMIRATES}
            />
          )}
          <DownloadButtons report="vat-return" query={statementQuery(p)} />
        </div>
      </PageHeader>
      <div className="flex flex-wrap gap-2 print:hidden">
        {periods.map((x) => (
          <Button
            key={x.from}
            asChild
            size="sm"
            variant={x.from === p.from && x.to === p.to ? "default" : "outline"}
          >
            <Link href={`/accounting/reports/vat-return?from=${x.from}&to=${x.to}${entityQ}`}>
              {x.label}
            </Link>
          </Button>
        ))}
      </div>
      <StatementFilters entities={ctx.entities} entity={p.entity} from={p.from} to={p.to} />
      <ProblemNote problem={p.problem} />
      <ReportView doc={built.doc} />
    </div>
  );
}
