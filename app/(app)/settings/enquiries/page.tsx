import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { ensureDefaultPipelines, loadPipelines, orgEnquirySettings } from "@/lib/enquiries/service";
import { createAdminClient } from "@/lib/supabase/admin";

import { PipelinesEditor } from "./pipelines-editor";
import { EnquirySettingsForm } from "./settings-form";

export const metadata = { title: "Enquiry settings" };

export default async function EnquirySettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  await ensureDefaultPipelines(admin, member.orgId);
  const [pipelines, settings, { data: teams }] = await Promise.all([
    loadPipelines(admin, member.orgId),
    orgEnquirySettings(admin, member.orgId),
    admin.from("teams").select("id, name").eq("org_id", member.orgId).order("name"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Enquiries"
        description="Pipelines and stages, the service level, notifications and how new enquiries are assigned."
      />
      <EnquirySettingsForm initial={settings} />
      <section className="flex flex-col gap-3" aria-label="Pipelines">
        <h2 className="text-lg font-semibold">Pipelines</h2>
        <PipelinesEditor pipelines={pipelines} teams={teams ?? []} />
      </section>
      <p className="text-muted-foreground text-sm">
        Extra fields on enquiries (text, dates, choices…) are managed in{" "}
        <Link className="underline" href="/settings/custom-fields?entity=enquiry">
          Custom fields
        </Link>
        , on the Enquiries tab.
      </p>
    </div>
  );
}
