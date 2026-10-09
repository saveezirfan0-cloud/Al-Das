import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BusinessProfile } from "@/lib/whatsapp/types";

import { AddChannelDialog } from "./add-channel-dialog";
import { ChannelCard, type ChannelView } from "./channel-card";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const env = serverEnv();
  const [{ data: channels }, { data: secrets }, { data: templateCounts }] = await Promise.all([
    admin.from("channels").select("*").eq("org_id", member.orgId).order("created_at"),
    admin.from("channel_secrets").select("channel_id"),
    admin
      .from("wa_templates")
      .select("channel_id, status")
      .eq("org_id", member.orgId)
      .is("archived_at", null),
  ]);
  const hasOwnToken = new Set((secrets ?? []).map((s) => s.channel_id));
  const counts = new Map<string, { total: number; approved: number }>();
  for (const t of templateCounts ?? []) {
    if (!t.channel_id) continue;
    const c = counts.get(t.channel_id) ?? { total: 0, approved: 0 };
    c.total++;
    if (t.status === "APPROVED") c.approved++;
    counts.set(t.channel_id, c);
  }

  const views: ChannelView[] = (channels ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status as ChannelView["status"],
    waba_id: c.waba_id,
    phone_number_id: c.phone_number_id,
    display_phone: c.display_phone,
    verified_name: c.verified_name,
    quality_rating: c.quality_rating,
    messaging_limit_tier: c.messaging_limit_tier,
    name_status: c.name_status,
    catalog_id: c.catalog_id,
    send_rate_per_sec: c.send_rate_per_sec,
    last_synced_at: c.last_synced_at,
    business_profile: (c.business_profile as BusinessProfile) ?? {},
    own_token: hasOwnToken.has(c.id),
    subscribed: !!(c.meta as { subscribed_at?: string } | null)?.subscribed_at,
    templates: counts.get(c.id) ?? { total: 0, approved: 0 },
  }));

  const configured = !!env.META_APP_SECRET && !!env.META_WEBHOOK_VERIFY_TOKEN;
  const webhookUrl = `${env.APP_URL.replace(/\/$/, "")}/api/webhooks/meta`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Channels"
        description="WhatsApp numbers connected to this workspace. Each number is identified by its phone_number_id and WABA ID."
      >
        <AddChannelDialog envTokenAvailable={!!env.META_SYSTEM_USER_TOKEN} />
      </PageHeader>

      {!configured && (
        <Alert>
          <AlertTitle>Webhook ingress is not configured</AlertTitle>
          <AlertDescription>
            Set META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN, then point the Meta app&apos;s
            WhatsApp webhook at <code className="text-xs">{webhookUrl}</code> with the fields
            messages, message_template_status_update, template_category_update,
            message_template_quality_update, phone_number_quality_update, account_update,
            user_id_update and business_username_updates.
          </AlertDescription>
        </Alert>
      )}

      {views.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No numbers yet. Add one with its phone_number_id and WABA ID from Meta Business Manager.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {views.map((c) => (
            <ChannelCard key={c.id} channel={c} />
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Webhook URL: <code>{webhookUrl}</code>. Migrating a number from another provider: remove
        their app from the WABA first, then press “Subscribe webhook” here. One number at a time,
        out of hours.
      </p>
    </div>
  );
}
