import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, Tables, TablesInsert } from "@/lib/supabase/types";
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

type ExistingTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  archived_at: string | null;
  meta_template_id: string | null;
};

export type TemplateSyncPlan = {
  /** Meta rows not yet mirrored: inserted with the syncing channel. */
  inserts: MetaTemplate[];
  /** Meta rows already mirrored: updated, keeping channel_id, variable_map and local archive state. */
  updates: MetaTemplate[];
  /** Mirrored rows (ever submitted) that Meta no longer lists. Drafts are never included. */
  gone: ExistingTemplate[];
  /** Rows previously marked DELETED by a sync that Meta lists again. */
  revive: ExistingTemplate[];
};

const keyOf = (t: { name: string; language: string }) => `${t.name}::${t.language}`;

/** Pure: decides what a sync does, so draft-safety is unit-tested. */
export function planTemplateSync(
  remote: MetaTemplate[],
  existing: ExistingTemplate[],
): TemplateSyncPlan {
  const have = new Map(existing.map((e) => [keyOf(e), e]));
  const seen = new Set(remote.map(keyOf));
  return {
    inserts: remote.filter((t) => !have.has(keyOf(t))),
    updates: remote.filter((t) => have.has(keyOf(t))),
    gone: existing.filter(
      (e) =>
        e.archived_at === null &&
        e.meta_template_id !== null &&
        e.status !== "DRAFT" &&
        !seen.has(keyOf(e)),
    ),
    revive: existing.filter((e) => e.status === "DELETED" && seen.has(keyOf(e))),
  };
}

function metaRow(channel: ChannelRef, t: MetaTemplate, now: string): TablesInsert<"wa_templates"> {
  return {
    org_id: channel.org_id,
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
  };
}

/**
 * Mirrors every Meta template of the WABA into wa_templates (upsert by waba/name/language).
 * Local-only data survives: drafts are never archived, existing rows keep their channel,
 * variable_map and archive flag, and rows Meta deleted are archived, never removed.
 */
export async function syncTemplatesForChannel(
  admin: AdminClient,
  channel: ChannelRef,
): Promise<{ synced: number; removed: number; revived: number }> {
  const client = await clientForChannel(admin, channel);
  const remote = await client.listAllTemplates(channel.waba_id);
  const now = new Date().toISOString();
  const { data: existing, error: readError } = await admin
    .from("wa_templates")
    .select("id, name, language, status, archived_at, meta_template_id")
    .eq("waba_id", channel.waba_id);
  if (readError) throw new Error(`template read failed: ${readError.message}`);
  const plan = planTemplateSync(remote, existing ?? []);

  if (plan.inserts.length) {
    const { error } = await admin.from("wa_templates").upsert(
      plan.inserts.map((t) => ({ ...metaRow(channel, t, now), channel_id: channel.id })),
      { onConflict: "waba_id,name,language" },
    );
    if (error) throw new Error(`template insert failed: ${error.message}`);
  }
  if (plan.updates.length) {
    const { error } = await admin.from("wa_templates").upsert(
      plan.updates.map((t) => metaRow(channel, t, now)),
      { onConflict: "waba_id,name,language" },
    );
    if (error) throw new Error(`template update failed: ${error.message}`);
  }
  if (plan.revive.length) {
    await admin
      .from("wa_templates")
      .update({ archived_at: null })
      .in(
        "id",
        plan.revive.map((r) => r.id),
      );
  }
  if (plan.gone.length) {
    await admin
      .from("wa_templates")
      .update({ archived_at: now, status: "DELETED" })
      .in(
        "id",
        plan.gone.map((g) => g.id),
      );
  }
  return { synced: remote.length, removed: plan.gone.length, revived: plan.revive.length };
}

/**
 * One channel per (org, WABA): numbers that share a WABA share its templates, so
 * the nightly job syncs each WABA once (the oldest active channel speaks for it).
 */
export function channelsToSync<
  C extends { id: string; org_id: string; waba_id: string; status: string; created_at: string },
>(channels: C[]): C[] {
  const byWaba = new Map<string, C>();
  for (const c of [...channels].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (c.status !== "active") continue;
    const k = `${c.org_id}::${c.waba_id}`;
    if (!byWaba.has(k)) byWaba.set(k, c);
  }
  return [...byWaba.values()];
}
