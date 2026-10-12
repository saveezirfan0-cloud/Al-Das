import "server-only";

import type { OptionSets } from "@/lib/ai/campaign-copilot/audience";
import { loadCustomFields, registryFor } from "@/lib/contacts/server";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";

/** The registry and the ids the model may choose from. Reference data only (tags, places, services); never a patient. */
export async function loadAudienceContext(
  admin: AdminClient,
  orgId: string,
): Promise<{ registry: FieldRegistry; sets: OptionSets }> {
  const [customFields, tags, segments, locations, services, specialists, departments] =
    await Promise.all([
      loadCustomFields(admin, orgId),
      admin
        .from("tags")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("scope", "contact")
        .order("name")
        .limit(100),
      admin.from("segments").select("id, name").eq("org_id", orgId).order("name").limit(100),
      admin
        .from("locations")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name")
        .limit(100),
      admin
        .from("services")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name")
        .limit(100),
      admin
        .from("specialists")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name")
        .limit(100),
      admin
        .from("departments")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name")
        .limit(100),
    ]);
  const rows = (r: { data: Array<{ id: string; name: string }> | null }) => r.data ?? [];
  return {
    registry: registryFor(customFields),
    sets: {
      tags: rows(tags),
      segments: rows(segments),
      locations: rows(locations),
      services: rows(services),
      specialists: rows(specialists),
      departments: rows(departments),
    },
  };
}
