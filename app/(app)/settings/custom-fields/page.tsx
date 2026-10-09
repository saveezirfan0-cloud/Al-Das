import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { toCustomFieldDef } from "@/lib/contacts/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { CustomFieldDialog } from "./custom-field-dialog";
import { CustomFieldsTable } from "./custom-fields-table";

export const metadata = { title: "Custom fields" };

export default async function CustomFieldsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data } = await admin
    .from("custom_fields")
    .select("id, entity, key, label, type, options, required, sort")
    .eq("org_id", member.orgId)
    .eq("entity", "contact")
    .order("sort")
    .order("label");
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    entity: r.entity,
    sort: r.sort,
    ...toCustomFieldDef(r),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Custom fields"
        description="Extra contact fields shown in the contact drawer, the grid, filters, imports and exports."
      >
        <CustomFieldDialog mode="create" />
      </PageHeader>
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No custom fields yet. Add one to capture data the standard contact record does not have
          (insurance plan, preferred branch, consent…).
        </p>
      ) : (
        <CustomFieldsTable rows={rows} />
      )}
    </div>
  );
}
