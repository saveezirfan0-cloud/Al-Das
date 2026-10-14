import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadAccounts, peopleNames } from "@/lib/accounting/accounting-server";
import { addMonths } from "@/lib/accounting/assets/depreciation";
import { scheduleStatus } from "@/lib/accounting/assets/register";
import { SCHEDULE_KIND_LABELS } from "@/lib/accounting/assets/schedules";
import {
  loadBranchCodes,
  loadInvoiceOptions,
  loadPostedLines,
  loadRunLines,
  loadRuns,
  loadSchedules,
} from "@/lib/accounting/assets/server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { PrepareRunForm } from "../depreciation/controls";
import { RunsTable } from "../depreciation/runs-table";
import { ScheduleButton, ScheduleStepButton } from "./forms";

export const metadata = { title: "Schedules" };
export const dynamic = "force-dynamic";

const VIEW = [
  "accounting.assets.manage",
  "accounting.journals.approve",
  "accounting.reports.view",
  "accounting.view",
];

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VIEW)) throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.assets.manage");
  const approve = can(member, "accounting.journals.approve");
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check
  const [schedules, posted, runs, accounts, branches, invoices] = await Promise.all([
    loadSchedules(admin, member.orgId),
    loadPostedLines(admin, member.orgId, { kinds: ["schedules", "reversing_accruals"] }),
    loadRuns(admin, member.orgId, ["schedules", "reversing_accruals"]),
    loadAccounts(admin, member.orgId),
    loadBranchCodes(admin, member.orgId),
    manage ? loadInvoiceOptions(admin, member.orgId) : Promise.resolve([]),
  ]);
  const rows = scheduleStatus(schedules, posted);
  const withReleases = new Set(posted.map((l) => l.ref));
  const runParam = (await searchParams).run ?? null;
  const selected = runs.find((r) => r.id === runParam) ?? null;
  const lines = selected
    ? await loadRunLines(admin, member.orgId, selected.id, selected.version)
    : [];
  const people = await peopleNames(
    admin,
    runs.flatMap((r) => [r.preparedBy, r.postedBy]),
  );
  const ledgers = accounts
    .filter((a) => !a.is_group && a.is_active)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, nature: a.nature }));
  const accountName = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
  const byId = new Map(schedules.map((s) => [s.id, s]));
  const lastMonth = addMonths(today, -1).slice(0, 7);
  const invoiceChoices = invoices.map((i) => ({ id: i.id, label: i.label }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Schedules"
        description="Prepayments, accruals and deferred revenue released evenly each month. The monthly run posts one journal; a reversing accrual has its own run whose journal reverses itself on the 1st of the next month. Leases are entered here as prepayments or accruals until the IFRS 16 decision (OQ-125)."
      >
        {manage && (
          <ScheduleButton
            ledgers={ledgers}
            branches={branches}
            invoices={invoiceChoices}
            defaultMonth={today.slice(0, 7)}
          />
        )}
      </PageHeader>
      {manage && (
        <Card>
          <CardContent className="flex flex-wrap gap-6 pt-6">
            <PrepareRunForm kind="schedules" defaultMonth={lastMonth} label="Prepare releases" />
            <PrepareRunForm
              kind="reversing_accruals"
              defaultMonth={lastMonth}
              label="Prepare reversing accruals"
            />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Ledgers</TableHead>
                <TableHead>Months</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Released</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground text-sm">
                    No schedules yet.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((s) => (
                <TableRow key={s.id} className={s.status === "cancelled" ? "opacity-60" : ""}>
                  <TableCell className="text-sm">
                    {SCHEDULE_KIND_LABELS[s.kind]}
                    {s.autoReverse && (
                      <div className="text-muted-foreground text-xs">reversing</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.description}
                    {s.status !== "active" && (
                      <Badge variant="secondary" className="ml-2">
                        {s.status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {accountName.get(byId.get(s.id)!.plAccountId)}
                    <div className="text-muted-foreground">
                      {accountName.get(byId.get(s.id)!.bsAccountId)}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    {s.startMonth.slice(0, 7)} to {s.lastMonth.slice(0, 7)}
                    <div className="text-muted-foreground text-xs">{s.monthsPosted} posted</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.released)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.autoReverse ? "" : money(s.remaining)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {manage && s.status === "active" && !withReleases.has(s.id) && (
                      <ScheduleButton
                        schedule={byId.get(s.id)!}
                        ledgers={ledgers}
                        branches={branches}
                        invoices={invoiceChoices}
                        defaultMonth={s.startMonth.slice(0, 7)}
                      />
                    )}
                    {manage && s.status === "active" && (
                      <ScheduleStepButton id={s.id} action="cancel" />
                    )}
                    {manage && !withReleases.has(s.id) && (
                      <ScheduleStepButton id={s.id} action="delete" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runs</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <RunsTable
            runs={runs}
            people={people}
            viewerId={member.userId}
            canPost={approve}
            basePath="/accounting/schedules"
            selected={selected?.id ?? null}
            showKind
          />
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Lines for {selected.periodMonth.slice(0, 7)} (version {selected.version})
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Debit</TableHead>
                  <TableHead>Credit</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground text-sm">
                      Nothing to release this month.
                    </TableCell>
                  </TableRow>
                )}
                {lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.schedule_id ? byId.get(l.schedule_id)?.description : ""}
                    </TableCell>
                    <TableCell className="text-xs">{accountName.get(l.debit_account_id)}</TableCell>
                    <TableCell className="text-xs">
                      {accountName.get(l.credit_account_id)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
