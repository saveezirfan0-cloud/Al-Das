import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { readLifecycleSettings } from "@/lib/contacts/lifecycle-settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { LifecycleForm } from "./lifecycle-form";

export const metadata = { title: "Patient lifecycle" };
export const dynamic = "force-dynamic";

export default async function LifecycleSettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const t = readLifecycleSettings(org?.settings);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Patient lifecycle"
        description="When a patient counts as new, active or lapsed. The stage is worked out from visit dates and never typed in."
      />
      <LifecycleForm initial={t} />
    </div>
  );
}
