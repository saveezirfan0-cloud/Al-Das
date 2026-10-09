import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadCalendar, loadClinicalSettings } from "@/lib/clinical/engine";
import { followUpState } from "@/lib/clinical/recall";
import { orgTimezone } from "@/lib/flow-engine/scope";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { CallList, type CallRowData } from "./call-list";

export const metadata = { title: "Recall call list" };
export const dynamic = "force-dynamic";

export default async function CallListPage() {
  const member = await requirePerm("portal.clinical_followups.read");
  const supabase = await createClient();
  const admin = createAdminClient();
  const [tz, settings, calendar] = await Promise.all([
    orgTimezone(admin, member.orgId),
    loadClinicalSettings(admin, member.orgId),
    loadCalendar(admin, member.orgId),
  ]);
  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();

  const [{ data: sends }, { data: people }] = await Promise.all([
    supabase
      .from("recall_sends")
      .select(
        "id, segment_key, send_mode, status, sent_at, replied_at, follow_up_status, assigned_user_id, outcome, days_since_last_visit_at_send, contacts(first_name, last_name), recall_programmes(name)",
      )
      .eq("org_id", member.orgId)
      .eq("send_mode", "live")
      .in("status", ["sent", "delivered", "read"])
      .gte("sent_at", since)
      .order("sent_at", { ascending: true })
      .limit(1000),
    supabase
      .from("memberships")
      .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
      .eq("org_id", member.orgId)
      .eq("status", "active"),
  ]);

  const rows: CallRowData[] = [];
  for (const s of sends ?? []) {
    const state = followUpState(
      {
        sendMode: s.send_mode,
        status: s.status,
        sentDate: s.sent_at ? formatInTimeZone(new Date(s.sent_at), tz, "yyyy-MM-dd") : null,
        repliedAt: s.replied_at,
        followUpStatus: s.follow_up_status,
        daysSinceLastVisitAtSend: s.days_since_last_visit_at_send,
      },
      today,
      calendar,
      {
        followupWorkdays: settings.num("recall_followup_workdays"),
        overdueDays: settings.num("chronic_recall_overdue_days"),
      },
    );
    if (!state.callNow) continue;
    const c = s.contacts as { first_name?: string; last_name?: string } | null;
    rows.push({
      id: s.id,
      patient: `${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim() || "Patient",
      programme: (s.recall_programmes as { name?: string } | null)?.name ?? "",
      segment: s.segment_key,
      sentOn: s.sent_at ? formatInTimeZone(new Date(s.sent_at), tz, "d MMM") : "",
      workdays: state.workdaysWaiting ?? 0,
      overdue: state.overdue === true,
      followUp: s.follow_up_status,
      assignee: s.assigned_user_id,
      outcome: s.outcome ?? "",
    });
  }
  rows.sort((a, b) => b.workdays - a.workdays);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recall call list"
        description={`Patients messaged live who have not answered after ${settings.num("recall_followup_workdays") ?? "(not signed off)"} working days. A person calls them; they do not get a second message.`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/flows/recall">
            <ArrowLeft className="size-4" />
            Programmes
          </Link>
        </Button>
      </PageHeader>
      <CallList
        rows={rows}
        canEdit={can(member, "portal.clinical_followups.write")}
        people={(people ?? []).map((m) => {
          const p = m.profiles as {
            first_name?: string;
            last_name?: string;
            email?: string;
          } | null;
          return {
            id: m.user_id,
            name: `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim() || p?.email || "Member",
          };
        })}
        thresholdSigned={settings.num("recall_followup_workdays") !== undefined}
      />
    </div>
  );
}
