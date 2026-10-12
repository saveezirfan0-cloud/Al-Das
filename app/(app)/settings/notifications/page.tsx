import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { vapidEnv } from "@/lib/env";
import { readEscalationSettings } from "@/lib/notify/escalation";
import { eventsFor } from "@/lib/notify/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { EscalationCard } from "./escalation-card";
import { NotificationsForm } from "./notifications-form";
import { PushCard } from "./push-card";

export const metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const member = await requireMember();
  const supabase = await createClient(); // own rows only (RLS)
  const [{ data: prefs }, { data: devices }] = await Promise.all([
    supabase
      .from("notification_preferences")
      .select("event, channel, enabled, quiet_start, quiet_end")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId),
    supabase
      .from("push_subscriptions")
      .select("id, ua_family, created_at, last_used_at")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId)
      .order("created_at"),
  ]);

  const isAdmin = can(member, "settings.manage");
  let escalation: React.ReactNode = null;
  if (isAdmin) {
    const admin = createAdminClient();
    const [{ data: org }, { data: teams }, { data: teamMembers }, { data: members }] =
      await Promise.all([
        admin.from("orgs").select("settings").eq("id", member.orgId).single(),
        admin
          .from("teams")
          .select("id, name, lead_user_id")
          .eq("org_id", member.orgId)
          .order("name"),
        admin.from("team_members").select("team_id, user_id").eq("org_id", member.orgId),
        admin
          .from("memberships")
          .select("user_id")
          .eq("org_id", member.orgId)
          .eq("status", "active"),
      ]);
    const ids = (members ?? []).map((m) => m.user_id);
    const { data: profiles } = ids.length
      ? await admin.from("profiles").select("id, first_name, last_name, email").in("id", ids)
      : { data: [] };
    const people = (profiles ?? [])
      .map((p) => ({
        id: p.id,
        name: `${p.first_name} ${p.last_name}`.trim() || p.email || "Unnamed",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    escalation = (
      <EscalationCard
        initial={readEscalationSettings(org?.settings)}
        people={people}
        teams={(teams ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          leadId: t.lead_user_id,
          memberIds: (teamMembers ?? []).filter((m) => m.team_id === t.id).map((m) => m.user_id),
        }))}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Choose how Pulse tells you about new messages, assignments, mentions and tasks."
      />
      <NotificationsForm
        events={eventsFor((perm) => can(member, perm)).map((e) => ({
          key: e.key,
          group: e.group,
          label: e.label,
          description: e.description,
          channels: [...e.channels],
          defaults: { ...e.defaults },
        }))}
        prefs={prefs ?? []}
      />
      <PushCard vapidPublicKey={vapidEnv().VAPID_PUBLIC_KEY ?? null} devices={devices ?? []} />
      {escalation}
    </div>
  );
}
