import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { readInboxSettings } from "@/lib/inbox/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { CategoriesCard, LabelsCard, QuickRepliesCard } from "./lists";
import { InboxSettingsForm } from "./settings-form";

export const metadata = { title: "Inbox settings" };

export default async function InboxSettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [
    { data: org },
    { data: teams },
    { data: categories },
    { data: quickReplies },
    { data: labels },
  ] = await Promise.all([
    admin.from("orgs").select("settings").eq("id", member.orgId).single(),
    admin.from("teams").select("id, name, round_robin").eq("org_id", member.orgId).order("name"),
    admin
      .from("conv_categories")
      .select("id, name")
      .eq("org_id", member.orgId)
      .order("sort")
      .order("name"),
    admin
      .from("quick_replies")
      .select("id, shortcut, text")
      .eq("org_id", member.orgId)
      .order("shortcut"),
    admin
      .from("tags")
      .select("id, name, color")
      .eq("org_id", member.orgId)
      .eq("scope", "conversation")
      .order("name"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inbox"
        description="Routing, closing rules, alerts, quick replies and labels for the shared inbox."
      />
      <InboxSettingsForm initial={readInboxSettings(org?.settings)} teams={teams ?? []} />
      <div className="grid gap-4 lg:grid-cols-3">
        <CategoriesCard items={categories ?? []} />
        <LabelsCard items={labels ?? []} />
        <QuickRepliesCard items={quickReplies ?? []} />
      </div>
    </div>
  );
}
