import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { WEBHOOK_EVENTS } from "@/lib/webhooks/events";

import { WebhooksManager } from "./webhooks-manager";

export const metadata = { title: "Webhooks" };

export default async function WebhooksPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [{ data: subs }, { data: deliveries }] = await Promise.all([
    admin.from("webhook_subscriptions").select("id, url, description, events, active, created_at").eq("org_id", member.orgId).order("created_at", { ascending: false }),
    admin
      .from("webhook_deliveries")
      .select("id, subscription_id, event, status, attempts, response_code, error, created_at, delivered_at, next_attempt_at")
      .eq("org_id", member.orgId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Webhooks" description="Get an HTTPS request when something happens in Pulse. Requests are signed, retried on failure, and carry ids only (no patient details)." />
      <WebhooksManager
        subs={(subs ?? []).map((s) => ({ ...s, host: safeHost(s.url) }))}
        deliveries={(deliveries ?? []).map((d) => ({ ...d, host: safeHost((subs ?? []).find((s) => s.id === d.subscription_id)?.url) }))}
        events={WEBHOOK_EVENTS.map((e) => ({ name: e.name, label: e.label, description: e.description }))}
      />
    </div>
  );
}

function safeHost(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "deleted endpoint";
  } catch {
    return "invalid url";
  }
}
