import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import type { TemplatesBootstrap, TemplateView } from "./types";
import { TemplatesWorkspace } from "./templates-workspace";

export const metadata = { title: "Templates" };

export default async function TemplatesPage() {
  // Every member can see templates (the Inbox composer uses them); only templates.manage can change them.
  const member = await requireMember();
  const admin = createAdminClient();
  const [{ data: rows }, { data: channels }] = await Promise.all([
    admin
      .from("wa_templates")
      .select(
        "id, channel_id, name, language, category, status, type, quality, components, variable_map, rejected_reason, last_error, needs_review, source, meta_template_id, archived_at, last_edited_at, submitted_at, last_synced_at, header_sample_path, card_sample_paths, internal_key, clinical_approval, updated_at",
      )
      .eq("org_id", member.orgId)
      .order("updated_at", { ascending: false })
      .limit(1000),
    admin
      .from("channels")
      .select("id, name, phone_number_id, display_phone, waba_id, status")
      .eq("org_id", member.orgId)
      .order("created_at"),
  ]);

  const templates: TemplateView[] = (rows ?? []).map((t) => ({
    ...t,
    components: (t.components ?? []) as unknown as MetaTemplateComponent[],
    variable_map: (t.variable_map ?? {}) as Record<string, string>,
    card_sample_paths: Array.isArray(t.card_sample_paths)
      ? (t.card_sample_paths as Array<string | null>)
      : [],
  }));

  const bootstrap: TemplatesBootstrap = {
    templates,
    channels: channels ?? [],
    canManage: can(member, "templates.manage"),
    uploadsEnabled: !!process.env.META_APP_ID,
  };
  return <TemplatesWorkspace bootstrap={bootstrap} />;
}
