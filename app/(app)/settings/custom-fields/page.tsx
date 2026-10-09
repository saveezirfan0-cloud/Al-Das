import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { toCustomFieldDef } from "@/lib/contacts/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

import { CustomFieldDialog } from "./custom-field-dialog";
import { CustomFieldsTable } from "./custom-fields-table";

export const metadata = { title: "Custom fields" };

const ENTITIES = [
  {
    key: "contact",
    label: "Contacts",
    blurb:
      "Extra contact fields shown in the contact drawer, the grid, filters, imports and exports.",
  },
  {
    key: "enquiry",
    label: "Enquiries",
    blurb: "Extra enquiry fields shown in the enquiry drawer and table, and in enquiry exports.",
  },
] as const;

export default async function CustomFieldsPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  const member = await requirePerm("settings.manage");
  const { entity: raw } = await searchParams;
  const current = ENTITIES.find((e) => e.key === raw) ?? ENTITIES[0];
  const admin = createAdminClient();
  const { data } = await admin
    .from("custom_fields")
    .select("id, entity, key, label, type, options, required, sort")
    .eq("org_id", member.orgId)
    .eq("entity", current.key)
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
      <PageHeader title="Custom fields" description={current.blurb}>
        <CustomFieldDialog mode="create" entity={current.key} />
      </PageHeader>
      <nav aria-label="Record type" className="flex gap-1 border-b">
        {ENTITIES.map((e) => (
          <Link
            key={e.key}
            href={`/settings/custom-fields?entity=${e.key}`}
            aria-current={e.key === current.key ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-sm",
              e.key === current.key
                ? "border-primary font-medium"
                : "text-muted-foreground border-transparent",
            )}
          >
            {e.label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No {current.label.toLowerCase()} custom fields yet. Add one to capture data the standard
          record does not have.
        </p>
      ) : (
        <CustomFieldsTable rows={rows} entity={current.key} />
      )}
    </div>
  );
}
