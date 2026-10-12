import Link from "next/link";
import { CircleAlert } from "lucide-react";

import { KpiTile } from "@/components/charts/kpi-tile";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { formatDuration } from "@/lib/reports/format";
import { readReportSettings } from "@/lib/reports/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { AutoRefresh } from "../auto-refresh";
import { SlaForm } from "./sla-form";

export const metadata = { title: "Team lead dashboard" };

const PRESENCE: Record<string, { label: string; variant: "success" | "warning" | "outline" }> = {
  online: { label: "Online", variant: "success" },
  away: { label: "Away", variant: "warning" },
  offline: { label: "Offline", variant: "outline" },
};

export default async function TeamLeadDashboard() {
  const member = await requireMember();
  if (!can(member, "reports.view") && !can(member, "inbox.view_all")) throw new ForbiddenError("reports.view");

  // Live views over the whole workspace, read with the service role AFTER the permission check above
  // and always scoped to this org.
  const admin = createAdminClient();
  const [{ data: queues }, { data: breaches }, { data: load }, { data: teams }] = await Promise.all([
    admin.from("v_team_queue_now").select("*").eq("org_id", member.orgId),
    admin.from("v_sla_breaches_now").select("*").eq("org_id", member.orgId).order("waiting_minutes", { ascending: false }).limit(200),
    admin.from("v_agent_workload_now").select("*").eq("org_id", member.orgId),
    admin.from("teams").select("id, name").eq("org_id", member.orgId),
  ]);
  // Enquiries still waiting for a first reply past their SLA (the enquiry SLA clock, Settings → Enquiries).
  const enquiryPastSla = can(member, "enquiries.view")
    ? await admin
        .from("enquiries")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("status", "open")
        .is("deleted_at", null)
        .is("first_touch_at", null)
        .not("sla_due_at", "is", null)
        .lt("sla_due_at", new Date().toISOString())
    : null;
  const userIds = (load ?? []).map((l) => l.user_id).filter((u): u is string => !!u);
  const { data: profiles } = userIds.length ? await admin.from("profiles").select("id, first_name, last_name, email").in("id", userIds) : { data: [] };

  const teamName = (id: string | null) => (id ? (teams ?? []).find((t) => t.id === id)?.name ?? "Deleted team" : "No team");
  const personName = (id: string | null) => {
    const p = (profiles ?? []).find((x) => x.id === id);
    return p ? `${p.first_name} ${p.last_name}`.trim() || p.email || "Unnamed" : "Unassigned";
  };
  const total = (k: "open_count" | "waiting_count" | "unassigned_count" | "unread_count") => (queues ?? []).reduce((s, q) => s + (q[k] ?? 0), 0);
  const sla = readReportSettings(member.org.settings).sla_minutes;
  const longest = breaches?.[0]?.waiting_minutes ?? null;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh seconds={30} />
      <PageHeader title="Team lead dashboard" description="Live queues, unanswered patients and who is working on what. Refreshes every 30 seconds." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Open" value={total("open_count")} hint="in progress" />
        <KpiTile label="Waiting" value={total("waiting_count")} hint="waiting on the patient" />
        <KpiTile label="Unassigned" value={total("unassigned_count")} hint="nobody owns them" />
        <KpiTile label={`Past the ${sla}-minute SLA`} value={breaches?.length ?? 0} hint={longest !== null ? `longest wait ${formatDuration(longest * 60)}` : "nobody is waiting too long"} />
      </div>
      {enquiryPastSla && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/enquiries" className="rounded-xl focus-visible:ring-2">
            <KpiTile label="Enquiries past SLA" value={enquiryPastSla.count ?? 0} hint="open, no first reply yet" />
          </Link>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queues by team</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Unassigned</TableHead>
                <TableHead className="text-right">Unread</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(queues ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground text-center">
                    No live conversations.
                  </TableCell>
                </TableRow>
              )}
              {(queues ?? [])
                .slice()
                .sort((a, b) => teamName(a.assignee_team_id).localeCompare(teamName(b.assignee_team_id)))
                .map((q) => (
                  <TableRow key={q.assignee_team_id ?? "none"}>
                    <TableCell>{teamName(q.assignee_team_id)}</TableCell>
                    <TableCell className="text-right tabular-nums">{q.open_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{q.waiting_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{q.unassigned_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{q.unread_count}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleAlert className="size-4" aria-hidden /> Waiting too long
          </CardTitle>
          <CardDescription>The patient wrote last and nobody has replied within the SLA. Oldest first (showing up to 20).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(breaches ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">Nobody is waiting past the SLA.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {(breaches ?? []).slice(0, 20).map((b) => (
                <li key={b.conversation_id ?? ""} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                  <span className="font-medium tabular-nums">{formatDuration((b.waiting_minutes ?? 0) * 60)}</span>
                  <span className="text-muted-foreground">{teamName(b.assignee_team_id)}</span>
                  <span className="text-muted-foreground">{b.assignee_user_id ? personName(b.assignee_user_id) : "Unassigned"}</span>
                  <Link href={`/inbox?c=${b.conversation_id}`} className="text-primary ml-auto underline">
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {can(member, "settings.manage") && <SlaForm minutes={sla} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Staff workload and presence</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff member</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Open conversations</TableHead>
                <TableHead className="text-right">With unread</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(load ?? [])
                .slice()
                .sort((a, b) => (b.open_conversations ?? 0) - (a.open_conversations ?? 0))
                .map((l) => {
                  const p = PRESENCE[l.presence ?? "offline"] ?? PRESENCE.offline;
                  return (
                    <TableRow key={l.user_id ?? ""}>
                      <TableCell>{personName(l.user_id)}</TableCell>
                      <TableCell>
                        <Badge variant={p.variant}>{p.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.open_conversations}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.unread_conversations}</TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
