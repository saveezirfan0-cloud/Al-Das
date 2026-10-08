import "server-only";

import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { toCustomFieldDef } from "@/lib/contacts/defs";
import { buildContactFieldRegistry, type FieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

export type OrgUserOption = { id: string; label: string };
export type SegmentSummary = Pick<
  Tables<"segments">,
  "id" | "name" | "kind" | "member_count" | "count_refreshed_at"
> & {
  filter: unknown;
};

export type ContactContext = {
  customFields: CustomFieldDef[];
  registry: FieldRegistry;
  tags: Array<{ id: string; name: string; color: string }>;
  segments: SegmentSummary[];
  users: OrgUserOption[];
};

export { toCustomFieldDef };

export async function loadCustomFields(
  admin: AdminClient,
  orgId: string,
  entity = "contact",
): Promise<CustomFieldDef[]> {
  const { data } = await admin
    .from("custom_fields")
    .select("key, label, type, options, required, sort")
    .eq("org_id", orgId)
    .eq("entity", entity)
    .order("sort")
    .order("label");
  return (data ?? []).map(toCustomFieldDef);
}

export function registryFor(customFields: CustomFieldDef[]): FieldRegistry {
  return buildContactFieldRegistry({
    customFields: customFields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options,
    })),
  });
}

/** Everything the Contacts screen and its actions need to interpret filters and fields. */
export async function loadContactContext(
  admin: AdminClient,
  orgId: string,
): Promise<ContactContext> {
  const [customFields, { data: tags }, { data: segments }, { data: members }] = await Promise.all([
    loadCustomFields(admin, orgId),
    admin
      .from("tags")
      .select("id, name, color")
      .eq("org_id", orgId)
      .eq("scope", "contact")
      .order("name"),
    admin
      .from("segments")
      .select("id, name, kind, filter, member_count, count_refreshed_at")
      .eq("org_id", orgId)
      .order("name"),
    admin
      .from("memberships")
      .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
      .eq("org_id", orgId)
      .eq("status", "active"),
  ]);
  const users = (members ?? [])
    .map((m) => ({
      id: m.user_id,
      label:
        `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
        m.profiles?.email ||
        m.user_id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    customFields,
    registry: registryFor(customFields),
    tags: tags ?? [],
    segments: segments ?? [],
    users,
  };
}
