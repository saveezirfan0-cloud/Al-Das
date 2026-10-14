import { ChartRenderer } from "@/components/charts/chart-renderer";
import { KpiTile } from "@/components/charts/kpi-tile";
import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { loadClinicSetupFacts } from "@/lib/golive/clinic-setup-server";
import { clinicSetupRows, setupProgress } from "@/lib/golive/readiness";
import { parseDashboardOverview } from "@/lib/reports/dashboard-tiles";
import { addDays, resolveRange } from "@/lib/reports/range";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { SetupCard } from "./setup-card";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const member = await requireMember();
  const supabase = await createClient(); // the caller's own client: RLS decides which conversations they can see
  const canTasks = can(member, "tasks.view");
  const canEnquiries = can(member, "enquiries.view");
  const todayStart = resolveRange(
    { period: "today" },
    member.org.timezone || "UTC",
  ).fromUtc.toISOString();

  // One round trip for every tile (public.dashboard_overview), instead of ten count queries.
  const { data: overviewJson } = await supabase.rpc("dashboard_overview", {
    p_org: member.orgId,
    p_user: member.userId,
    p_today_start: todayStart,
    p_include_tasks: canTasks,
    p_include_enquiries: canEnquiries,
  });
  const { conversations: conv, team, tasks, enquiries } = parseDashboardOverview(overviewJson);
  const mine = { count: conv.mine };
  const unassigned = { count: conv.unassigned };
  const waiting = { count: conv.waiting };
  const unread = { count: conv.unread_mine };
  const members = team.members;
  const online = team.online;
  const myTasks = tasks ? { count: tasks.open } : null;
  const overdueTasks = tasks ? { count: tasks.overdue } : null;
  const openEnquiries = enquiries ? { count: enquiries.open } : null;
  const newToday = enquiries ? { count: enquiries.new_today } : null;

  // Last 14 days of volume, for people who can see reports.
  let trend = null;
  if (can(member, "reports.view")) {
    const tz = member.org.timezone || "UTC";
    const toDay = resolveRange({ period: "today" }, tz).toDay;
    const { data } = await createAdminClient().rpc("report_conversations_by_day", {
      p_org: member.orgId,
      p_from: addDays(toDay, -13),
      p_to: toDay,
    });
    trend = (data ?? []).map((d) => ({ day: d.day, opened: d.opened, closed: d.closed }));
  }

  // First-run card: the clinic set-up steps, for people who can do them, until every one is done.
  let setup = null;
  if (can(member, "settings.manage")) {
    const facts = await loadClinicSetupFacts(createAdminClient(), member.orgId, {
      staff: can(member, "hr.view"),
    });
    const progress = setupProgress(clinicSetupRows(facts.clinic, facts.whatsapp));
    if (!progress.complete) setup = progress;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Welcome back${member.profile.first_name ? `, ${member.profile.first_name}` : ""}`}
        description="Your conversations, tasks and enquiries right now."
      />
      {setup && (
        <SetupCard
          done={setup.done}
          total={setup.total}
          next={setup.next}
          allowed={(perm) => !perm || can(member, perm)}
        />
      )}
      <section aria-labelledby="dash-conversations" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 id="dash-conversations" className="text-sm font-semibold">
            Conversations
          </h3>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <span
              className={`size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
              aria-hidden
            />
            <span className="tabular-nums">
              {online ?? 0} of {members ?? 0} team members online
            </span>
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="My open conversations"
            value={mine.count ?? 0}
            hint="assigned to you"
            href="/inbox?folder=assigned_me"
          />
          <KpiTile
            label="Unread (mine)"
            value={unread.count ?? 0}
            hint="need your reply"
            href="/inbox?folder=assigned_me"
          />
          <KpiTile
            label="Unassigned"
            value={unassigned.count ?? 0}
            hint="open, nobody owns them"
            href="/inbox?folder=unassigned"
          />
          <KpiTile
            label="Waiting"
            value={waiting.count ?? 0}
            hint="you replied; waiting on the patient"
            href="/inbox?folder=waiting"
          />
        </div>
      </section>

      {trend && (
        <ChartRenderer
          spec={{
            kind: "bars",
            title: "Conversations, last 14 days",
            xKey: "day",
            series: [
              { key: "opened", label: "Opened" },
              { key: "closed", label: "Closed" },
            ],
            data: trend,
          }}
        />
      )}

      {(canTasks || canEnquiries) && (
        <section aria-labelledby="dash-work" className="flex flex-col gap-3">
          <h3 id="dash-work" className="text-sm font-semibold">
            Work
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {myTasks && (
              <KpiTile
                label="My open tasks"
                value={myTasks.count ?? 0}
                hint="assigned to you"
                href="/tasks"
              />
            )}
            {overdueTasks && (
              <KpiTile
                label="My overdue tasks"
                value={overdueTasks.count ?? 0}
                hint="past their due time"
                href="/tasks?state=overdue"
              />
            )}
            {openEnquiries && (
              <KpiTile
                label="Open enquiries"
                value={openEnquiries.count ?? 0}
                hint="across all pipelines"
                href="/enquiries?pipeline=all"
              />
            )}
            {newToday && (
              <KpiTile
                label="New enquiries today"
                value={newToday.count ?? 0}
                hint="created since midnight"
                href="/enquiries"
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
