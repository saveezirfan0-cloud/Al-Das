import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { loadEnquiryContext } from "@/lib/enquiries/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { EnquirySettingsTabs } from "./tabs";

export const metadata = { title: "Enquiry settings" };

export default async function EnquirySettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [ctx, { data: rules }, { data: fields }, { data: stageCounts }] = await Promise.all([
    loadEnquiryContext(admin, member.orgId),
    admin
      .from("enquiry_assignment_rules")
      .select("id, name, sort, enabled, conditions, action")
      .eq("org_id", member.orgId)
      .order("sort")
      .order("name"),
    admin
      .from("custom_fields")
      .select("id, entity, key, label, type, options, required, sort")
      .eq("org_id", member.orgId)
      .eq("entity", "enquiry")
      .order("sort")
      .order("label"),
    admin.from("enquiries").select("stage_id").eq("org_id", member.orgId).is("deleted_at", null),
  ]);
  const perStage: Record<string, number> = {};
  for (const e of stageCounts ?? []) perStage[e.stage_id] = (perStage[e.stage_id] ?? 0) + 1;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Enquiries"
        description="Pipelines and stages, assignment rules, SLA, notifications, custom fields and the clinic lists enquiries use."
      />
      <EnquirySettingsTabs
        settings={ctx.settings}
        pipelines={ctx.pipelines}
        stageCounts={perStage}
        rules={(rules ?? []).map((r) => ({ ...r, conditions: r.conditions, action: r.action }))}
        customFields={(fields ?? []).map((f) => ({
          id: f.id,
          entity: f.entity,
          sort: f.sort,
          key: f.key,
          label: f.label,
          type: f.type as never,
          options: Array.isArray(f.options)
            ? (f.options as Array<{ value: string; label: string }>)
            : [],
          required: f.required,
        }))}
        teams={ctx.teams}
        users={ctx.users}
        lookups={ctx.lookups}
      />
    </div>
  );
}
