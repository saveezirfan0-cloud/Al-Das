import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { CLIPS, readHelpSettings } from "@/lib/help/clips";
import { createAdminClient } from "@/lib/supabase/admin";

import { TrainingSettings } from "./training-settings";

export const metadata = { title: "Training mode" };

export default async function TrainingSettingsPage() {
  const member = await requirePerm("settings.manage");
  const { data: org } = await createAdminClient()
    .from("orgs")
    .select("settings, is_training")
    .eq("id", member.orgId)
    .single();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Training mode"
        description="A practice workspace for teaching new staff, and the links to your recorded training videos."
      />
      <TrainingSettings
        isTraining={org?.is_training ?? false}
        orgName={member.org.name}
        clips={CLIPS.map((c) => ({ id: c.id, title: c.title, roles: [...c.roles] }))}
        videos={readHelpSettings(org?.settings).videos}
      />
    </div>
  );
}
