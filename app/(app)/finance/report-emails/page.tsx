import { formatInTimeZone } from "date-fns-tz";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { permissionMatches } from "@/lib/auth/permissions";
import { requirePerm } from "@/lib/auth/session";
import { maskAddress } from "@/lib/finance/document-email";
import {
  DEFAULT_SCHEDULE,
  nextSend,
  normaliseTime,
  REPORT_EMAIL_KINDS,
  REPORT_EMAIL_LABEL,
  REPORT_EMAIL_PERMISSION,
  REPORT_EMAILS_MANAGE,
  type ReportEmailKind,
} from "@/lib/finance/report-emails";
import { readFinanceAccess } from "@/lib/security/finance-access";
import { createAdminClient } from "@/lib/supabase/admin";

import { ScheduleForm, type MemberOption } from "./forms";

export const metadata = { title: "Report e-mails" };
export const dynamic = "force-dynamic";

const DESCRIPTION: Record<ReportEmailKind, string> = {
  daily_flash:
    "Yesterday's flash report (the day and month to date) as an Excel file, every morning at the time you choose.",
  monthly_summary:
    "Last month's summary (generated, claimed, collected, outstanding by branch, compared with the month before) as an Excel file, on the day you choose.",
};

const STATUS_LABEL: Record<string, string> = {
  claimed: "Started",
  queued: "Sent",
  skipped: "Not sent",
};
const REASON_LABEL: Record<string, string> = {
  no_recipients: "nobody on the list could receive it",
  queue_failed: "the e-mails could not be queued",
};

export default async function ReportEmailsPage() {
  const member = await requirePerm(REPORT_EMAILS_MANAGE);
  const admin = createAdminClient(); // service role AFTER the permission check: names and masked addresses only
  const [{ data: schedules }, { data: runs }, { data: memberships }] = await Promise.all([
    admin
      .from("fin_report_schedules")
      .select("kind, enabled, send_time, day_of_month, recipient_ids, enabled_at")
      .eq("org_id", member.orgId),
    admin
      .from("fin_report_schedule_runs")
      .select("id, kind, period_key, status, recipients, skipped, reason, claimed_at")
      .eq("org_id", member.orgId)
      .order("claimed_at", { ascending: false })
      .limit(20),
    admin
      .from("memberships")
      .select("user_id, roles(permissions), profiles(first_name, last_name, email)")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .limit(1000),
  ]);
  const tz = member.org.timezone;
  const access = readFinanceAccess(member.org.settings);
  const windowOn = !access.ok || access.settings.enabled;
  const addressList = access.ok && access.settings.enabled && access.settings.ip_allowlist.length > 0;
  const now = new Date();

  const people = (memberships ?? []).map((m) => {
    const p = m.profiles;
    const perms = Array.isArray(m.roles?.permissions) ? (m.roles.permissions as unknown[]) : [];
    return {
      id: m.user_id,
      name: p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Unnamed member" : "Member",
      email: p?.email ? maskAddress(p.email) : null,
      perms: perms.filter((x): x is string => typeof x === "string"),
    };
  });
  const optionsFor = (kind: ReportEmailKind, chosen: readonly string[]): MemberOption[] =>
    people
      .map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        eligible: p.perms.some((g) => permissionMatches(g, REPORT_EMAIL_PERMISSION[kind])),
      }))
      .filter((p) => p.eligible || chosen.includes(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Report e-mails"
        description="E-mail the daily flash and the monthly summary to members of your team. Only people who can see a report in Pulse can receive it, and that is checked again every time it is sent. The e-mail itself carries no figures: the report is the attachment."
      />
      {member.org.is_training && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          This is a training workspace: nothing is e-mailed from it.
        </p>
      )}
      {windowOn && (
        <p className="text-muted-foreground rounded-md border px-3 py-2 text-sm">
          The finance access window is on (Settings, Security). A report goes only to people inside
          the window at the send time
          {addressList
            ? ". Because finance is limited to listed network addresses, nothing is e-mailed: an e-mail would take the figures off-site."
            : ", so choose a send time inside it."}
        </p>
      )}
      {REPORT_EMAIL_KINDS.map((kind) => {
        const row = (schedules ?? []).find((s) => s.kind === kind);
        const value = {
          enabled: row?.enabled ?? DEFAULT_SCHEDULE[kind].enabled,
          sendTime: normaliseTime(row?.send_time) ?? DEFAULT_SCHEDULE[kind].sendTime,
          dayOfMonth: row?.day_of_month ?? DEFAULT_SCHEDULE[kind].dayOfMonth,
          recipientIds: row?.recipient_ids ?? [],
        };
        const next = nextSend({ kind, ...value, enabledAt: row?.enabled_at ?? null }, now, tz);
        return (
          <Card key={kind}>
            <CardHeader>
              <CardTitle>{REPORT_EMAIL_LABEL[kind]}</CardTitle>
              <CardDescription>{DESCRIPTION[kind]}</CardDescription>
            </CardHeader>
            <CardContent>
              <ScheduleForm
                kind={kind}
                value={value}
                members={optionsFor(kind, value.recipientIds)}
                timezone={tz}
                nextSendText={
                  next ? formatInTimeZone(next, tz, "EEEE d MMMM yyyy 'at' HH:mm") : null
                }
              />
            </CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader>
          <CardTitle>Recent sends</CardTitle>
          <CardDescription>
            One line per report and period. Each period is sent once, however often the job runs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(runs ?? []).length === 0 ? (
            <EmptyState
              title="Nothing sent yet"
              description="Once a report is switched on, each send is listed here with how many people it went to."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">People</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{REPORT_EMAIL_LABEL[r.kind as ReportEmailKind] ?? r.kind}</TableCell>
                    <TableCell>{r.period_key}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "queued" ? "success" : "warning"}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </Badge>
                      {r.reason && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          {REASON_LABEL[r.reason] ?? r.reason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{r.recipients}</TableCell>
                    <TableCell className="text-right">{r.skipped}</TableCell>
                    <TableCell>{formatInTimeZone(new Date(r.claimed_at), tz, "d MMM HH:mm")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
