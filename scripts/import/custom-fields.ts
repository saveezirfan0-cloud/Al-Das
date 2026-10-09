import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { toCustomFieldDef } from "@/lib/contacts/defs";
import type { AdminClient } from "@/lib/supabase/admin";

export async function loadCustomFieldsForScript(
  admin: AdminClient,
  orgId: string,
): Promise<CustomFieldDef[]> {
  const { data } = await admin
    .from("custom_fields")
    .select("key, label, type, options, required")
    .eq("org_id", orgId)
    .eq("entity", "contact")
    .order("sort");
  return (data ?? []).map(toCustomFieldDef);
}

/** Creates the custom fields a mapper writes into when they do not exist yet. */
export async function ensureCustomFields(
  admin: AdminClient,
  orgId: string,
  wanted: Array<{
    key: string;
    label: string;
    type: CustomFieldDef["type"];
    options?: Array<{ value: string; label: string }>;
  }>,
  dryRun: boolean,
): Promise<{ defs: CustomFieldDef[]; created: string[] }> {
  const defs = await loadCustomFieldsForScript(admin, orgId);
  const created: string[] = [];
  let sort = defs.length;
  for (const w of wanted) {
    if (defs.some((d) => d.key === w.key)) continue;
    created.push(w.key);
    if (!dryRun) {
      await admin
        .from("custom_fields")
        .insert({
          org_id: orgId,
          entity: "contact",
          key: w.key,
          label: w.label,
          type: w.type,
          options: w.options ?? [],
          sort: sort++,
        });
    }
    defs.push({
      key: w.key,
      label: w.label,
      type: w.type,
      options: w.options ?? [],
      required: false,
    });
  }
  return { defs, created };
}
