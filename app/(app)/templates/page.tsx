import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { TemplatesWorkspace } from "./templates-workspace";
import type { TemplatesBootstrap } from "./types";

export const metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const member = await requirePerm("templates.manage");
  const admin = createAdminClient();
  const [{ data: rows }, { data: channels }] = await Promise.all([
    admin
      .from("wa_templates")
      .select(
        "id, name, language, category, status, type, channel_id, waba_id, meta_template_id, components, variable_map, retry_on_fail, rejected_reason, submit_error, quality, archived_at, last_synced_at, submitted_at, updated_at, media_paths, gallery_key, parameter_format",
      )
      .eq("org_id", member.orgId)
      .order("updated_at", { ascending: false })
      .limit(1000),
    admin
      .from("channels")
      .select("id, name, display_phone, waba_id, status")
      .eq("org_id", member.orgId)
      .neq("status", "disconnected")
      .order("created_at"),
  ]);

  const synced = (rows ?? []).map((r) => r.last_synced_at).filter((v): v is string => !!v);
  const bootstrap: TemplatesBootstrap = {
    rows: rows ?? [],
    channels: channels ?? [],
    hasMetaAppId: !!serverEnv().META_APP_ID,
    lastSyncedAt: synced.length ? synced.sort().at(-1)! : null,
  };
  return <TemplatesWorkspace bootstrap={bootstrap} />;
}
