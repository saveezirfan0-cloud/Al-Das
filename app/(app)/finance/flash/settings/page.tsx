import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { DEFAULT_LATE_INVOICE_DAYS } from "@/lib/finance/collections";
import { DEFAULT_PERF_SETTINGS } from "@/lib/finance/doctor-performance";
import { monthOf, targetFromRow } from "@/lib/finance/flash";
import { monthTitle } from "@/lib/finance/flash-xlsx";
import { DEFAULT_RECON_SETTINGS } from "@/lib/finance/insurance-billing";
import { mgmtAlertSettingsFromRow } from "@/lib/finance/management-alerts";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  CopyTargetsButton,
  DisplayForm,
  EditLineButton,
  DataQualityForm,
  InsuranceReconForm,
  MgmtAlertsForm,
  RecruitDefaultsForm,
  PerfBandsForm,
  NewLineButton,
  TargetsForm,
  type LineView,
} from "./forms";

export const metadata = { title: "Flash targets and lines" };
export const dynamic = "force-dynamic";

export default async function FlashSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const member = await requirePerm("finance.targets.manage");
  const sp = await searchParams;
  const thisMonth = `${todayIn(member.org.timezone).slice(0, 7)}-01`;
  const month = monthOf(`${(sp.month ?? "").slice(0, 7)}-01`) ?? thisMonth;

  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: lineRows }, { data: targetRows }, { data: settings }] = await Promise.all([
    admin
      .from("fin_ref_report_lines")
      .select("code, label, match_kind, match_values, in_core, active, sort_order")
      .eq("org_id", member.orgId)
      .order("sort_order"),
    admin
      .from("fin_ref_revenue_targets")
      .select("month, line_code, daily_revenue, daily_patients, arpp")
      .eq("org_id", member.orgId)
      .eq("month", month),
    admin
      .from("fin_ref_finance_settings")
      .select(
        "flash_share_basis, flash_top_doctors, perf_arpp_target, perf_band_near, perf_band_moderate, dq_late_invoice_days, ins_recon_tolerance, ins_recon_grace_days, alert_report_late_days, alert_revenue_target_pct, alert_revenue_target_days, alert_band_min_patients, recruit_conservative_pct, recruit_consumables_pct, recruit_gateway_pct, recruit_min_peer_months",
      )
      .eq("org_id", member.orgId)
      .maybeSingle(),
  ]);
  const lines: LineView[] = (lineRows ?? []).map((l) => ({
    code: l.code,
    label: l.label,
    matchKind: l.match_kind,
    matchValues: l.match_values,
    inCore: l.in_core,
    active: l.active,
    sortOrder: l.sort_order,
  }));
  const targets = (targetRows ?? []).map(targetFromRow);
  const active = lines.filter((l) => l.active);
  const alerts = mgmtAlertSettingsFromRow(settings);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Flash targets and lines"
        description="How invoices are grouped on the daily flash report, the targets they are measured against, and the revenue-per-patient bands of the doctor performance page and the late invoice days of the collections page. Every change is audited."
      >
        <Button asChild variant="outline">
          <Link href="/finance/flash">Back to the flash report</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Reporting lines</CardTitle>
          <NewLineButton />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            A line matches invoices by branch code or by department. A department line (Chiro) takes
            its invoices from every branch. Lines not counted in the main total are shown
            separately, as Chiro and the leased Dental unit are on the current sheets. With no lines
            at all, each branch code is its own line.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Matches</TableHead>
                <TableHead>Main total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-sm">
                    No lines yet.
                  </TableCell>
                </TableRow>
              ) : (
                lines.map((l) => (
                  <TableRow key={l.code} className={l.active ? "" : "opacity-60"}>
                    <TableCell className="tabular-nums">{l.sortOrder}</TableCell>
                    <TableCell className="font-mono text-xs">{l.code}</TableCell>
                    <TableCell>
                      {l.label}
                      {!l.active && (
                        <Badge variant="secondary" className="ml-2">
                          inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.matchKind === "department" ? "Department" : "Branch"}:{" "}
                      {l.matchValues.join(", ")}
                    </TableCell>
                    <TableCell>{l.inCore ? "Yes" : "Separate"}</TableCell>
                    <TableCell className="text-right">
                      <EditLineButton line={l} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Targets for {monthTitle(month)}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <form className="flex items-center gap-2">
              <Input
                type="month"
                name="month"
                defaultValue={month.slice(0, 7)}
                className="w-40"
                aria-label="Month"
              />
              <Button type="submit" variant="secondary" size="sm">
                Show
              </Button>
            </form>
            {targets.length === 0 && <CopyTargetsButton month={month} />}
          </div>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-muted-foreground text-sm">Add the reporting lines first.</p>
          ) : (
            <TargetsForm
              key={month}
              month={month}
              lines={active.map((l) => ({ code: l.code, label: l.label, inCore: l.inCore }))}
              targets={targets}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Display</CardTitle>
        </CardHeader>
        <CardContent>
          <DisplayForm
            shareBasis={settings?.flash_share_basis ?? "section"}
            topDoctors={settings?.flash_top_doctors ?? 5}
          />
        </CardContent>
      </Card>

      <Card id="performance">
        <CardHeader>
          <CardTitle className="text-base">Doctor performance: revenue per patient</CardTitle>
        </CardHeader>
        <CardContent>
          <PerfBandsForm
            target={Number(settings?.perf_arpp_target ?? DEFAULT_PERF_SETTINGS.target)}
            near={Number(settings?.perf_band_near ?? DEFAULT_PERF_SETTINGS.near)}
            moderate={Number(settings?.perf_band_moderate ?? DEFAULT_PERF_SETTINGS.moderate)}
          />
        </CardContent>
      </Card>

      <Card id="data-quality">
        <CardHeader>
          <CardTitle className="text-base">Collections: data quality</CardTitle>
        </CardHeader>
        <CardContent>
          <DataQualityForm
            lateInvoiceDays={settings?.dq_late_invoice_days ?? DEFAULT_LATE_INVOICE_DAYS}
          />
        </CardContent>
      </Card>

      <Card id="insurance-billing">
        <CardHeader>
          <CardTitle className="text-base">Insurance billed vs claimed</CardTitle>
        </CardHeader>
        <CardContent>
          <InsuranceReconForm
            tolerance={Number(settings?.ins_recon_tolerance ?? DEFAULT_RECON_SETTINGS.tolerance)}
            graceDays={Number(settings?.ins_recon_grace_days ?? DEFAULT_RECON_SETTINGS.graceDays)}
          />
        </CardContent>
      </Card>

      <Card id="alerts">
        <CardHeader>
          <CardTitle className="text-base">Management alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <MgmtAlertsForm
            lateDays={alerts.reportLateDays}
            targetPct={alerts.revenueTargetPct}
            targetDays={alerts.revenueTargetDays}
            minPatients={alerts.bandMinPatients}
          />
        </CardContent>
      </Card>

      {can(member, "finance.costs.manage") && settings && (
        <Card id="recruitment">
          <CardHeader>
            <CardTitle className="text-base">Recruitment calculator defaults</CardTitle>
          </CardHeader>
          <CardContent>
            <RecruitDefaultsForm
              conservative={Number(settings.recruit_conservative_pct)}
              consumables={Number(settings.recruit_consumables_pct)}
              gateway={Number(settings.recruit_gateway_pct)}
              minPeerMonths={Number(settings.recruit_min_peer_months)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
