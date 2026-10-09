import Link from "next/link";

import { ChartRenderer } from "@/components/charts/chart-renderer";
import { KpiTile } from "@/components/charts/kpi-tile";
import { AwaitingCard } from "@/components/shell/awaiting-card";
import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { addDays, resolveRange } from "@/lib/reports/range";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const member = await requireMember();
  const supabase = await createClient(); // the caller's own client: RLS decides which conversations they can see
  const open = () => supabase.from("conversations").select("id", { count: "exact", head: true }).eq("org_id", member.orgId).neq("status", "closed");
  const mem = () => supabase.from("memberships").select("id", { count: "exact", head: true }).eq("org_id", member.orgId).eq("status", "active");

  const [mine, unassigned, waiting, unread, { count: members }, { count: online }] = await Promise.all([
    open().eq("assignee_user_id", member.userId),
    open().is("assignee_user_id", null),
    open().eq("status", "waiting"),
    open().eq("assignee_user_id", member.userId).gt("unread_count", 0),
    mem(),
    mem().eq("presence", "online"),
  ]);

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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Welcome back${member.profile.first_name ? `, ${member.profile.first_name}` : ""}`}
        description="Your conversations right now. Enquiry, task and appointment widgets arrive with their modules."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="My open conversations" value={mine.count ?? 0} hint="assigned to you" />
        <KpiTile label="Unread (mine)" value={unread.count ?? 0} hint="need your reply" />
        <KpiTile label="Unassigned" value={unassigned.count ?? 0} hint="open, nobody owns them" />
        <KpiTile label="Waiting" value={waiting.count ?? 0} hint="you replied; waiting on the patient" />
      </div>
      <p className="text-muted-foreground text-sm">
        <Link href="/inbox" className="text-primary underline">
          Open the inbox
        </Link>{" "}
        · {online ?? 0} of {members ?? 0} team members online
      </p>

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

      <div className="grid gap-3 md:grid-cols-3">
        <AwaitingCard title="Open tasks" phase="Phase 5 (enquiries & tasks)" />
        <AwaitingCard title="Open enquiries" phase="Phase 5 (enquiries & tasks)" />
        <AwaitingCard title="Daily enquiries" phase="Phase 5 (enquiries & tasks)" />
      </div>
    </div>
  );
}
