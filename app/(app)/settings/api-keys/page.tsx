import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { ApiKeysManager } from "./api-keys-manager";

export const metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  const member = await requirePerm("settings.manage");
  // Never selects key_hash: the browser only ever sees the display prefix.
  const { data } = await createAdminClient()
    .from("api_keys")
    .select("id, name, key_prefix, scopes, expires_at, revoked_at, last_used_at, created_at")
    .eq("org_id", member.orgId)
    .order("created_at", { ascending: false });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="API keys" description="Let your own systems read and write contacts and send approved WhatsApp templates. Keys are shown once and stored hashed." />
      <ApiKeysManager keys={data ?? []} baseUrl={`${serverEnv().APP_URL.replace(/\/$/, "")}/api/public/v1`} />
    </div>
  );
}
