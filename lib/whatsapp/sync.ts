import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";
import { clientForChannel } from "@/lib/whatsapp/channel";
import type { MetaTemplate, PhoneNumberInfo } from "@/lib/whatsapp/types";

type ChannelRef = Pick<Tables<"channels">, "id" | "org_id" | "phone_number_id" | "waba_id">;

/** Pulls phone-number fields + business profile from Meta into the channel row. */
export async function refreshChannelFromMeta(
  admin: AdminClient,
  channel: ChannelRef,
): Promise<PhoneNumberInfo> {
  const client = await clientForChannel(admin, channel);
  const [phone, profile] = await Promise.all([
    client.getPhoneNumber(),
    client.getBusinessProfile(),
  ]);
  await admin
    .from("channels")
    .update({
      display_phone: phone.display_phone_number ?? null,
      verified_name: phone.verified_name ?? null,
      quality_rating: phone.quality_rating ?? null,
      messaging_limit_tier: phone.messaging_limit_tier ?? null,
      name_status: phone.name_status ?? null,
      business_profile: profile as unknown as NonNullable<Json>,
      meta: {
        phone: phone as unknown as Json,
        refreshed_at: new Date().toISOString(),
      } as unknown as NonNullable<Json>,
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", channel.id);
  return phone;
}

function templateType(t: MetaTemplate): "standard" | "media_interactive" | "carousel" {
  if (t.components.some((c) => c.type === "CAROUSEL")) return "carousel";
  if (
    t.components.some(
      (c) =>
        (c.type === "HEADER" && (c as { format?: string }).format !== "TEXT") ||
        c.type === "BUTTONS",
    )
  )
    return "media_interactive";
  return "standard";
}

/** Mirrors every Meta template of the WABA into wa_templates (upsert by waba/name/language). */
export async function syncTemplatesForChannel(
  admin: AdminClient,
  channel: ChannelRef,
): Promise<{ synced: number; removed: number }> {
  const client = await clientForChannel(admin, channel);
  const templates = await client.listAllTemplates(channel.waba_id);
  const now = new Date().toISOString();
  const rows = templates.map((t) => ({
    org_id: channel.org_id,
    channel_id: channel.id,
    waba_id: channel.waba_id,
    meta_template_id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    type: templateType(t),
    components: t.components as unknown as NonNullable<Json>,
    parameter_format: t.parameter_format === "NAMED" ? "named" : "positional",
    rejected_reason: t.rejected_reason ?? null,
    quality: t.quality_score?.score ?? null,
    last_synced_at: now,
  }));
  if (rows.length) {
    const { error } = await admin
      .from("wa_templates")
      .upsert(rows, { onConflict: "waba_id,name,language" });
    if (error) throw new Error(`template upsert failed: ${error.message}`);
  }
  // Templates deleted on Meta's side: mark archived (never delete rows that messages reference).
  const seen = new Set(templates.map((t) => `${t.name}::${t.language}`));
  const { data: existing } = await admin
    .from("wa_templates")
    .select("id, name, language")
    .eq("waba_id", channel.waba_id)
    .is("archived_at", null);
  const gone = (existing ?? []).filter((e) => !seen.has(`${e.name}::${e.language}`));
  if (gone.length) {
    await admin
      .from("wa_templates")
      .update({ archived_at: now, status: "DELETED" })
      .in(
        "id",
        gone.map((g) => g.id),
      );
  }
  return { synced: rows.length, removed: gone.length };
}
