import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { monthLabel } from "@/lib/finance/close-pack";
import { lastClosedMonth, MONTH_RE } from "@/lib/finance/close-server";
import {
  addMonths,
  backupCoverage,
  closeMonthFor,
  dueOn,
  lateness,
  WEEKDAY_LABELS,
  workingDayOf,
  type Delivery,
  type TaskStatus,
} from "@/lib/finance/close-timetable";
import { loadCloseCalendar, loadCloseKpis } from "@/lib/finance/close-timetable-server";
import { holds } from "@/lib/finance/rules";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

import {
  CalendarForm,
  CreateTasksButton,
  DeleteHolidayButton,
  HolidayForm,
  StepButton,
  TaskUpdateButton,
  type Person,
  type StepView,
} from "./forms";

export const metadata = { title: "Close timetable" };
export const dynamic = "force-dynamic";

const VIEW = ["finance.close.view", "finance.close.manage", "finance.close.tasks"] as const;
const CLOSE_PAGE = [
  "finance.close.view",
  "finance.close.manage",
  "finance.close.signoff.finance",
  "finance.close.signoff.ceo",
] as const;

const day = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : "—";
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);

const CLOSE_LABEL: Record<string, string> = {
  open: "Pack not built",
  built: "Pack built, not signed",
  finance_signed: "Waiting for the CEO",
  locked: "Issued and locked",
};
const DELIVERY: Record<
  Delivery,
  { label: string; variant: "success" | "warning" | "destructive" | "outline" }
> = {
  on_time: { label: "Yes", variant: "success" },
  late: { label: "No, late", variant: "destructive" },
  missed: { label: "No, not yet closed", variant: "destructive" },
  open: { label: "Not due yet", variant: "outline" },
};

export default async function CloseTimetablePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VIEW)) throw new ForbiddenError("finance.close.tasks");
  const manage = can(member, "finance.close.manage");
  const seesKpis = canAny(member, ["finance.close.view", "finance.close.manage"]);
  const opensClose = canAny(member, CLOSE_PAGE);
  const tz = member.org.timezone || "UTC";
  const today = todayIn(tz);
  const current = closeMonthFor(today);
  const sp = await searchParams;
  const month = sp.month && MONTH_RE.test(sp.month) ? `${sp.month}-01` : current;
  const ended = month.slice(0, 7) <= lastClosedMonth(today);

  const admin = createAdminClient(); // service role AFTER the permission check above
  const cal = await loadCloseCalendar(admin, member.orgId);
  const [{ data: stepRows }, { data: taskRows }, { data: close }, { data: memberRows }, kpis] =
    await Promise.all([
      admin
        .from("fin_close_steps")
        .select(
          "code, title, owner_role, owner_user_id, backup_user_id, due_wd, depends_on, evidence_hint, active, sort_order",
        )
        .eq("org_id", member.orgId)
        .order("sort_order")
        .order("code"),
      admin
        .from("fin_close_tasks")
        .select("id, step_code, due_wd, status, blocked_reason, note, done_by, done_at")
        .eq("org_id", member.orgId)
        .eq("month", month),
      admin
        .from("fin_period_closes")
        .select("status, locked_at")
        .eq("org_id", member.orgId)
        .eq("month", month)
        .maybeSingle(),
      admin
        .from("memberships")
        .select("user_id, roles(permissions)")
        .eq("org_id", member.orgId)
        .eq("status", "active"),
      seesKpis
        ? loadCloseKpis(admin, member.orgId, tz, cal, today, current)
        : Promise.resolve(null),
    ]);

  const steps: StepView[] = (stepRows ?? []).map((s) => ({
    code: s.code,
    title: s.title,
    ownerRole: s.owner_role,
    ownerUserId: s.owner_user_id,
    backupUserId: s.backup_user_id,
    dueWd: s.due_wd,
    dependsOn: s.depends_on,
    evidenceHint: s.evidence_hint,
    active: s.active,
    sortOrder: s.sort_order,
  }));
  const stepBy = new Map(steps.map((s) => [s.code, s]));
  const order = new Map(steps.map((s, i) => [s.code, i]));
  const tasks = [...(taskRows ?? [])].sort(
    (a, b) => (order.get(a.step_code) ?? 0) - (order.get(b.step_code) ?? 0),
  );
  const taskBy = new Map(tasks.map((t) => [t.step_code, t]));

  // names: the people the timetable mentions, and who may be chosen as owner or backup
  const ids = new Set<string>();
  for (const s of steps) for (const u of [s.ownerUserId, s.backupUserId]) if (u) ids.add(u);
  for (const t of tasks) if (t.done_by) ids.add(t.done_by);
  const assignable = (memberRows ?? [])
    .filter((m) => {
      const perms = Array.isArray(m.roles?.permissions)
        ? (m.roles.permissions as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      return holds(perms, "finance.close.tasks") || holds(perms, "finance.close.manage");
    })
    .map((m) => m.user_id);
  for (const u of assignable) ids.add(u);
  const { data: profiles } = ids.size
    ? await admin
        .from("profiles")
        .select("id, first_name, last_name")
        .in("id", [...ids])
    : { data: [] };
  const names = new Map(
    (profiles ?? []).map((p) => [p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "—"]),
  );
  const people: Person[] = assignable
    .map((id) => ({ id, name: names.get(id) ?? "—" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Former member") : null);

  const locked = close?.status === "locked";
  const workingMonth = addMonths(month, 1);
  const wdToday = today.slice(0, 7) === workingMonth.slice(0, 7) ? workingDayOf(today, cal) : null;
  const deadline = dueOn(month, cal.deadlineWd, cal);
  const backups = backupCoverage(steps);
  const thisMonthKpi = kpis?.months[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Close timetable"
        description="The month-end close by working day: each step with its owner, trained backup, due day and what it depends on. Working days are counted in the month after the month being closed."
      >
        <Button asChild variant="outline">
          <Link href="/finance/close">Month-end close</Link>
        </Button>
      </PageHeader>

      {!cal.startMonth && (
        <Alert>
          <AlertTitle>The daily timetable job is off</AlertTitle>
          <AlertDescription>
            {manage
              ? "Set the first close month under Calendar below. Until then, steps are created only with the button on this page and nobody is reminded."
              : "Someone who prepares the month-end close needs to switch it on."}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">Closing {monthLabel(month)}</CardTitle>
            <CardDescription>
              Working days of {monthLabel(workingMonth)}
              {wdToday !== null ? `; today is working day ${wdToday}` : ""}. Weekend:{" "}
              {cal.weekend.map((d) => WEEKDAY_LABELS[d]).join(", ") || "none"};{" "}
              {cal.holidays.length} holiday(s) listed.
            </CardDescription>
          </div>
          <form className="flex items-center gap-2">
            <Input
              type="month"
              name="month"
              defaultValue={month.slice(0, 7)}
              className="w-40"
              aria-label="Close month"
            />
            <Button type="submit" variant="secondary" size="sm">
              Show
            </Button>
          </form>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {tasks.length === 0 && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted-foreground">
                {steps.length === 0
                  ? "The checklist has no steps yet."
                  : locked
                    ? "This month was locked before the timetable was used."
                    : ended
                      ? "This month's steps have not been created yet."
                      : "Steps are created once the month has ended."}
              </span>
              {manage && ended && !locked && steps.length > 0 && (
                <CreateTasksButton month={month.slice(0, 7)} />
              )}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Backup</TableHead>
                <TableHead>Depends on</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const s = stepBy.get(t.step_code);
                const due = dueOn(month, t.due_wd, cal);
                const late = lateness(t.status as TaskStatus, due, today);
                const mine =
                  !!s && (s.ownerUserId === member.userId || s.backupUserId === member.userId);
                const mayAct = !locked && (manage || (can(member, "finance.close.tasks") && mine));
                return (
                  <TableRow
                    key={t.id}
                    className={cn(late === "overdue" && "bg-red-50 dark:bg-red-950/30")}
                  >
                    <TableCell className="max-w-72">
                      <div className="text-sm font-medium">{s?.title ?? t.step_code}</div>
                      {s?.evidenceHint && (
                        <div className="text-muted-foreground text-xs">{s.evidenceHint}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      WD{t.due_wd}, {day(due)}
                      {late === "overdue" && (
                        <Badge variant="destructive" className="ml-2">
                          overdue
                        </Badge>
                      )}
                      {late === "due_today" && (
                        <Badge variant="warning" className="ml-2">
                          today
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {nameOf(s?.ownerUserId ?? null) ?? (
                        <span className="text-amber-700">
                          No owner{s?.ownerRole ? ` (${s.ownerRole})` : ""}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {nameOf(s?.backupUserId ?? null) ?? (
                        <span className="text-amber-700">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {(s?.dependsOn ?? []).length === 0
                        ? "—"
                        : s!.dependsOn.map((code) => {
                            const dep = taskBy.get(code);
                            return (
                              <div key={code}>
                                {stepBy.get(code)?.title ?? code}
                                <span className="text-muted-foreground">
                                  {" "}
                                  (
                                  {dep
                                    ? dep.status === "done"
                                      ? "done"
                                      : dep.status
                                    : "not in this month"}
                                  )
                                </span>
                              </div>
                            );
                          })}
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.status === "done" ? (
                        <>
                          <Badge variant="success">Done</Badge>
                          <div className="text-muted-foreground mt-1">
                            {nameOf(t.done_by) ?? "—"},{" "}
                            {t.done_at
                              ? new Date(t.done_at).toLocaleDateString("en-GB", { timeZone: tz })
                              : ""}
                          </div>
                        </>
                      ) : t.status === "blocked" ? (
                        <>
                          <Badge variant="warning">Blocked</Badge>
                          <div className="mt-1">Waiting for: {t.blocked_reason}</div>
                        </>
                      ) : (
                        <Badge variant="outline">Open</Badge>
                      )}
                      {t.note && <div className="text-muted-foreground mt-1">{t.note}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      {mayAct && (
                        <TaskUpdateButton
                          id={t.id}
                          title={s?.title ?? t.step_code}
                          status={t.status}
                          reason={t.blocked_reason}
                          note={t.note}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow>
                <TableCell>
                  <div className="text-sm font-medium">Final Management / Board pack issued</div>
                  <div className="text-muted-foreground text-xs">
                    The month-end close: Finance signs, then the CEO signs and the month locks.
                  </div>
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  WD{cal.deadlineWd}, {day(deadline)}
                  {!locked && deadline && today > deadline && (
                    <Badge variant="destructive" className="ml-2">
                      overdue
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm">Finance, then the CEO</TableCell>
                <TableCell className="text-sm">—</TableCell>
                <TableCell className="text-xs">Every step above</TableCell>
                <TableCell className="text-xs">
                  <Badge variant={locked ? "success" : "outline"}>
                    {CLOSE_LABEL[close?.status ?? "open"]}
                  </Badge>
                  {close?.locked_at && (
                    <div className="text-muted-foreground mt-1">
                      {new Date(close.locked_at).toLocaleDateString("en-GB", { timeZone: tz })}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {opensClose && (
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/finance/close/${month.slice(0, 7)}`}>Open</Link>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {kpis && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Close measures</CardTitle>
            <CardDescription>
              Targets from the finance control plan: inputs by WD{cal.inputsWd} (100%), close
              delivered by WD
              {cal.deadlineWd}, no reconciling item older than {cal.itemMaxAgeDays} days, a trained
              backup for every step.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Measure
                label={`Inputs by WD${cal.inputsWd}, ${monthLabel(current)}`}
                value={pct(thisMonthKpi?.inputs.rate ?? null)}
                note={
                  thisMonthKpi && thisMonthKpi.inputs.total > 0
                    ? `${thisMonthKpi.inputs.onTime} on time, ${thisMonthKpi.inputs.late} late, ${thisMonthKpi.inputs.pending} not due yet`
                    : "No input steps this month"
                }
                bad={!!thisMonthKpi && thisMonthKpi.inputs.late > 0}
              />
              <Measure
                label="Open reconciling items"
                value={String(kpis.items.open)}
                note={`Oldest ${kpis.items.oldestDays ?? 0} days; ${kpis.items.overLimit} over ${cal.itemMaxAgeDays} days. Finance exceptions today; bank items join with the bank reconciliation.`}
                bad={kpis.items.overLimit > 0}
              />
              <Measure
                label="Steps with a trained backup"
                value={pct(backups.rate)}
                note={
                  backups.missing.length === 0
                    ? `${backups.covered} of ${backups.total}`
                    : `No backup: ${backups.missing.map((c) => stepBy.get(c)?.title ?? c).join("; ")}`
                }
                bad={backups.missing.length > 0}
              />
              <Measure
                label="Unapproved invoice changes"
                value="Not measured yet"
                note="Needs the invoice-change approval matrix (slice 20J)."
              />
              <Measure
                label="Calculation trail for revenue shares"
                value="Not measured yet"
                note="Needs the revenue-share engine (slice 20F)."
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Close month</TableHead>
                  <TableHead>Inputs by WD{cal.inputsWd}</TableHead>
                  <TableHead>Delivered by WD{cal.deadlineWd}</TableHead>
                  <TableHead>Deadline</TableHead>
                  <TableHead>Locked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kpis.months.map((k) => (
                  <TableRow key={k.month}>
                    <TableCell className="text-sm">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`?month=${k.month.slice(0, 7)}`}
                      >
                        {monthLabel(k.month)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {k.inputs.total === 0
                        ? "—"
                        : `${pct(k.inputs.rate)} (${k.inputs.onTime} of ${k.inputs.onTime + k.inputs.late})`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={DELIVERY[k.delivery].variant}>
                        {DELIVERY[k.delivery].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{day(k.deadlineOn)}</TableCell>
                    <TableCell className="text-xs">{day(k.lockedOn)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {manage && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base">Checklist template</CardTitle>
              <CardDescription>
                The steps every month gets. Assign each an owner and a trained backup; name what it
                depends on.
              </CardDescription>
            </div>
            <StepButton steps={steps} people={people} />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Due</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Backup</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {steps.map((s) => (
                  <TableRow key={s.code} className={s.active ? "" : "opacity-60"}>
                    <TableCell className="text-xs">WD{s.dueWd}</TableCell>
                    <TableCell className="text-sm">
                      {s.title}{" "}
                      <span className="text-muted-foreground font-mono text-xs">{s.code}</span>
                      {!s.active && (
                        <Badge variant="secondary" className="ml-2">
                          inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {nameOf(s.ownerUserId) ?? s.ownerRole ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">{nameOf(s.backupUserId) ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <StepButton step={s} steps={steps} people={people} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Calendar and settings</CardTitle>
            <CardDescription>
              Weekend days and public holidays decide which days are working days.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <CalendarForm
              start={cal.startMonth}
              weekend={[...cal.weekend]}
              inputsWd={cal.inputsWd}
              deadlineWd={cal.deadlineWd}
              itemMaxAgeDays={cal.itemMaxAgeDays}
              revshareWd={cal.revshareWd}
              voucherUnpaidDays={cal.voucherUnpaidDays}
              receivablesOver90Pct={cal.receivablesOver90Pct}
            />
            <div className="flex flex-col gap-3">
              <div className="text-sm font-medium">Public holidays</div>
              {cal.holidayRows.length > 0 && (
                <Table>
                  <TableBody>
                    {cal.holidayRows.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-sm whitespace-nowrap">
                          {day(h.holidayOn)} {h.holidayOn.slice(0, 4)}
                        </TableCell>
                        <TableCell className="text-sm">{h.name}</TableCell>
                        <TableCell className="text-right">
                          <DeleteHolidayButton id={h.id} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <HolidayForm />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Measure({
  label,
  value,
  note,
  bad,
}: {
  label: string;
  value: string;
  note: string;
  bad?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-6">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={cn("text-2xl font-semibold tabular-nums", bad && "text-red-600")}>
          {value}
        </div>
        <div className="text-muted-foreground text-xs">{note}</div>
      </CardContent>
    </Card>
  );
}
