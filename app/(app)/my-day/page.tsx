import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, CheckSquare, ClipboardList, RefreshCw } from "lucide-react";

import { KpiTile } from "@/components/charts/kpi-tile";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { STATUS_LABELS, type AppointmentStatus } from "@/lib/appointments/status";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { CHECKIN_LABELS, isCheckinState } from "@/lib/front-desk/checkin";
import { doctorCalendarHref } from "@/lib/organisation/doctors";
import { dayState, nextUp, summariseDay } from "@/lib/organisation/my-day";
import { todayWindow } from "@/lib/organisation/server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "My day" };
export const dynamic = "force-dynamic";

type Appt = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  checkin_status: string | null;
  location_id: string | null;
  specialist_id: string | null;
  contact: { id: string; full_name: string | null; deleted_at: string | null } | null;
  service: { name: string } | null;
  location: { name: string; timezone: string } | null;
};

/**
 * My day (Phase C): a doctor's own appointments today (for the doctor records linked to the signed-in user), where
 * each patient is in the visit (check-in states from the front desk), their tasks due today or overdue, and the
 * clinical follow-up queue. Read-only; the branch rule applies (only branches this person may see).
 */
export default async function MyDayPage() {
  const member = await requirePerm("appointments.view");
  const admin = createAdminClient();
  const timezone = member.org.timezone || "Asia/Dubai";
  const { today, from, to } = todayWindow(timezone);
  const access = readBranchAccess(member);
  const canContacts = can(member, "contacts.view");

  const { data: mine } = await admin
    .from("specialists")
    .select("id, name")
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId)
    .eq("active", true)
    .order("name");
  const doctorIds = (mine ?? []).map((d) => d.id);

  const [{ data: appts }, { data: tasks }] = await Promise.all([
    doctorIds.length
      ? admin
          .from("appointments")
          .select(
            "id, starts_at, ends_at, status, checkin_status, location_id, specialist_id, contact:contacts(id, full_name, deleted_at), service:services(name), location:locations(name, timezone)",
          )
          .eq("org_id", member.orgId)
          .in("specialist_id", doctorIds)
          .gte("starts_at", from)
          .lt("starts_at", to)
          .order("starts_at")
          .limit(200)
      : Promise.resolve({ data: [] as Appt[] }),
    can(member, "tasks.view")
      ? admin
          .from("tasks")
          .select("id, subject, due_at")
          .eq("org_id", member.orgId)
          .eq("assignee_id", member.userId)
          .eq("done", false)
          .is("deleted_at", null)
          .lt("due_at", to)
          .order("due_at")
          .limit(50)
      : Promise.resolve({ data: [] as Array<{ id: string; subject: string; due_at: string }> }),
  ]);

  const list = ((appts ?? []) as unknown as Appt[]).filter(
    (a) => a.status !== "cancelled" && canSeeLocation(access, a.location_id),
  );
  const summary = summariseDay(list);
  const next = nextUp(list, new Date());
  if (list.length > 0)
    await recordAccess(admin, member, {
      entity: "appointment",
      action: "list",
      detail: { page: "my-day", count: list.length },
    });

  const time = (iso: string, tz: string | undefined) =>
    formatInTimeZone(new Date(iso), tz || timezone, "HH:mm");
  const patient = (a: Appt) =>
    canContacts && a.contact && !a.contact.deleted_at
      ? a.contact.full_name?.trim() || "Patient"
      : "Patient";
  const followUps = can(member, "portal.clinical_followups.read");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My day"
        description={`Your appointments and tasks for today, ${formatInTimeZone(new Date(), timezone, "EEEE d MMMM")}.`}
      >
        <Button asChild variant="outline">
          <Link href="/my-day">
            <RefreshCw aria-hidden /> Refresh
          </Link>
        </Button>
        {doctorIds.length === 1 && (
          <Button asChild variant="outline">
            <Link href={doctorCalendarHref(doctorIds[0])}>
              <CalendarDays aria-hidden /> My calendar
            </Link>
          </Button>
        )}
      </PageHeader>

      {doctorIds.length === 0 ? (
        <div className="rounded-xl border p-6 text-sm">
          <p className="font-medium">Your Pulse user is not linked to a doctor yet.</p>
          <p className="text-muted-foreground mt-1">
            Ask an administrator to link you under Settings, Appointments (the doctor&apos;s Pulse
            user). Until then this page cannot tell which appointments are yours.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <KpiTile label="Today" value={summary.total} hint="appointments" />
            <KpiTile label="Still to come" value={summary.expected} />
            <KpiTile label="Waiting" value={summary.waiting} hint="arrived" />
            <KpiTile label="With you" value={summary.withDoctor} />
            <KpiTile label="Seen" value={summary.seen} />
          </div>

          <section aria-labelledby="my-day-list" className="grid gap-2">
            <h3 id="my-day-list" className="text-sm font-semibold">
              Appointments
            </h3>
            {list.length === 0 ? (
              <p className="text-muted-foreground text-sm">No appointments today.</p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {list.map((a) => {
                  const state = dayState(a);
                  const label = isCheckinState(a.checkin_status)
                    ? CHECKIN_LABELS[a.checkin_status]
                    : (STATUS_LABELS[a.status as AppointmentStatus] ?? a.status);
                  return (
                    <li key={a.id}>
                      <Link
                        href={`/appointments?appointment=${a.id}`}
                        className={
                          "hover:bg-muted/50 flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm" +
                          (next?.id === a.id ? " bg-primary/5" : "")
                        }
                      >
                        <span className="w-24 font-medium tabular-nums">
                          {time(a.starts_at, a.location?.timezone)}–
                          {time(a.ends_at, a.location?.timezone)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {patient(a)}
                          {a.service?.name ? (
                            <span className="text-muted-foreground"> · {a.service.name}</span>
                          ) : null}
                        </span>
                        {a.location?.name && (
                          <span className="text-muted-foreground text-xs">{a.location.name}</span>
                        )}
                        <Badge
                          variant={
                            state === "arrived"
                              ? "warning"
                              : state === "with_doctor"
                                ? "default"
                                : state === "done" || state === "checked_out"
                                  ? "success"
                                  : state === "no_show"
                                    ? "destructive"
                                    : "outline"
                          }
                        >
                          {next?.id === a.id ? `Next · ${label}` : label}
                        </Badge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="my-day-tasks" className="grid content-start gap-2">
          <h3 id="my-day-tasks" className="flex items-center gap-2 text-sm font-semibold">
            <CheckSquare aria-hidden className="size-4" /> My tasks due today
          </h3>
          {(tasks ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing due.</p>
          ) : (
            <ul className="divide-y rounded-xl border text-sm">
              {(tasks ?? []).map((t) => (
                <li key={t.id}>
                  <Link href={`/tasks?task=${t.id}`} className="hover:bg-muted/50 flex gap-3 p-3">
                    <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                    <span
                      className={
                        t.due_at < from
                          ? "text-destructive text-xs"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {t.due_at < from ? "Overdue" : time(t.due_at, timezone)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/tasks" className="text-primary text-sm underline-offset-4 hover:underline">
            All my tasks
          </Link>
        </section>
        {followUps && (
          <section aria-labelledby="my-day-followups" className="grid content-start gap-2">
            <h3 id="my-day-followups" className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardList aria-hidden className="size-4" /> Clinical follow-ups
            </h3>
            <p className="text-muted-foreground text-sm">
              Visits that tripped a clinical rule and the outcome of the call to the patient.
            </p>
            <Link
              href="/portal/follow-ups"
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              Open the follow-up queue
            </Link>
          </section>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Today is {today} in the clinic&apos;s timezone.
      </p>
    </div>
  );
}
