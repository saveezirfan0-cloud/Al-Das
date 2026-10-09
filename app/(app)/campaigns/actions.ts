"use server";

import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  csvAudience,
  csvPreview,
  parseAudienceCsv,
  segmentAudience,
  type AudienceCounts,
  type AudienceSample,
  type CsvPreview,
} from "@/lib/campaigns/audience";
import {
  tierDailyLimit,
  canCancel,
  canDelete,
  canPause,
  canReschedule,
  canResume,
  canStartNow,
} from "@/lib/campaigns/constants";
import {
  cancelCampaign,
  loadCampaign,
  pauseCampaign,
  refreshStats,
  resumeCampaign,
  startCampaign,
} from "@/lib/campaigns/engine";
import { isMarketingCategory } from "@/lib/campaigns/recipients";
import { parseSource, resolveVariables, unmappedVariables } from "@/lib/campaigns/variables";
import { enqueue, scheduleJob } from "@/lib/jobs/enqueue";
import { queueOutbound } from "@/lib/inbox/send";
import { normalizePhone } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { renderTemplatePreview, templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const uuid = z.string().uuid();

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message && e.message.length < 200 ? e.message : fallback;
}

const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("segment"), segment_id: uuid }),
  z.object({
    type: z.literal("csv"),
    csv_text: z.string().min(1).max(12_000_000),
    opt_in_confirmed: z.boolean().default(false),
  }),
]);

const mapSchema = z.record(z.string().max(80), z.string().max(500));
const guardrailsSchema = z
  .object({
    max_failure_pct: z.number().min(1).max(100).optional(),
    max_total_failure_pct: z.number().min(1).max(100).optional(),
    min_sample: z.number().int().min(5).max(10_000).optional(),
    pause_on_quality_drop: z.boolean().optional(),
  })
  .default({});

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(120),
  channel_id: uuid,
  template_id: uuid,
  audience: audienceSchema,
  variable_map: mapSchema.default({}),
  fallbacks: mapSchema.default({}),
  /** "now" or a local date-time ("2026-10-12T09:30") in the workspace timezone. */
  schedule: z.object({ mode: z.enum(["now", "later"]), at_local: z.string().max(40).optional() }),
  retry_rounds: z.number().int().min(0).max(3).default(0),
  retry_delay_minutes: z.number().int().min(5).max(1440).default(60),
  guardrails: guardrailsSchema,
});
export type CreateCampaignInput = z.input<typeof createSchema>;

/** Channel + template for a campaign or test send, with every precondition checked. */
async function loadSendContext(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  channelId: string,
  templateId: string,
) {
  const [{ data: channel }, { data: template }] = await Promise.all([
    admin
      .from("channels")
      .select("id, name, status, waba_id, quality_rating, messaging_limit_tier")
      .eq("org_id", orgId)
      .eq("id", channelId)
      .maybeSingle(),
    admin
      .from("wa_templates")
      .select(
        "id, name, language, category, status, components, variable_map, waba_id, archived_at",
      )
      .eq("org_id", orgId)
      .eq("id", templateId)
      .maybeSingle(),
  ]);
  if (!channel) return { ok: false as const, error: "Choose a WhatsApp number." };
  if (channel.status !== "active")
    return { ok: false as const, error: "That number is paused or disconnected." };
  if (!template) return { ok: false as const, error: "Choose a template." };
  if (template.archived_at) return { ok: false as const, error: "That template is archived." };
  if (template.status !== "APPROVED")
    return {
      ok: false as const,
      error: `"${template.name}" is ${template.status}; only approved templates can be sent.`,
    };
  if (template.waba_id !== channel.waba_id)
    return {
      ok: false as const,
      error: "That template belongs to a different WhatsApp business account than the number.",
    };
  return { ok: true as const, channel, template };
}

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Mapping problems that can be found before touching any recipient. */
function mappingError(
  components: MetaTemplateComponent[],
  map: Record<string, string>,
  templateMap: Record<string, string>,
  fallbacks: Record<string, string>,
): string | null {
  for (const v of unmappedVariables(components, map, templateMap)) {
    if (fallbacks[v.key]) continue;
    return `Map "${v.key}" to a contact field, a CSV column or a fixed text.`;
  }
  for (const v of templateVariables(components)) {
    if (v.kind === "image" || v.kind === "video" || v.kind === "document") {
      const src = parseSource(map[v.key] ?? templateMap[v.key]);
      const url = src?.kind === "text" ? src.value : fallbacks[v.key];
      if (!url || !/^https:\/\//i.test(url))
        return `Header ${v.kind} needs a public https:// link.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audience preview
// ---------------------------------------------------------------------------

const previewSchema = z.object({
  channel_id: uuid,
  template_id: uuid,
  audience: audienceSchema,
});

export type AudiencePreviewResult = {
  counts: AudienceCounts;
  sample: AudienceSample | null;
  csv: CsvPreview | null;
  marketing: boolean;
  tierLimit: number | null;
};

export async function previewAudience(
  input: z.input<typeof previewSchema>,
): Promise<ActionResult<AudiencePreviewResult>> {
  const member = await requirePerm("campaigns.create");
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const admin = createAdminClient();
  const { channel_id, template_id, audience } = parsed.data;
  const { data: template } = await admin
    .from("wa_templates")
    .select("category")
    .eq("org_id", member.orgId)
    .eq("id", template_id)
    .maybeSingle();
  const { data: channel } = await admin
    .from("channels")
    .select("messaging_limit_tier")
    .eq("org_id", member.orgId)
    .eq("id", channel_id)
    .maybeSingle();
  if (!template || !channel) return fail("Choose a number and a template first.");
  const marketing = isMarketingCategory(template.category);
  try {
    if (audience.type === "segment") {
      const r = await segmentAudience(admin, {
        orgId: member.orgId,
        segmentId: audience.segment_id,
        marketing,
        timezone: member.org.timezone,
      });
      return {
        ok: true,
        data: {
          ...r,
          csv: null,
          marketing,
          tierLimit: tierDailyLimit(channel.messaging_limit_tier),
        },
      };
    }
    const csv = parseAudienceCsv(audience.csv_text);
    if ("error" in csv) return fail(csv.error);
    const r = await csvAudience(admin, {
      orgId: member.orgId,
      csv,
      marketing,
      confirmedOptIn: audience.opt_in_confirmed,
      userId: member.userId,
    });
    return {
      ok: true,
      data: {
        ...r,
        csv: csvPreview(csv),
        marketing,
        tierLimit: tierDailyLimit(channel.messaging_limit_tier),
      },
    };
  } catch (e) {
    return fail(messageOf(e, "Could not read the audience."));
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCampaign(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("campaigns.create");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const v = parsed.data;
  const admin = createAdminClient();

  const ctx = await loadSendContext(admin, member.orgId, v.channel_id, v.template_id);
  if (!ctx.ok) return fail(ctx.error);
  const { channel, template } = ctx;
  const components = template.components as unknown as MetaTemplateComponent[];
  const problem = mappingError(
    components,
    v.variable_map,
    stringMap(template.variable_map),
    v.fallbacks,
  );
  if (problem) return fail(problem);
  const marketing = isMarketingCategory(template.category);

  let scheduledAt: Date | null = null;
  if (v.schedule.mode === "later") {
    if (!v.schedule.at_local) return fail("Pick a date and time.");
    const at = fromZonedTime(v.schedule.at_local, member.org.timezone);
    if (Number.isNaN(at.getTime())) return fail("That date and time is not valid.");
    if (at.getTime() < Date.now() + 60_000) return fail("Schedule at least a minute ahead.");
    if (at.getTime() > Date.now() + 90 * 86_400_000)
      return fail("Schedule within the next 90 days.");
    scheduledAt = at;
  }

  let csv: Exclude<ReturnType<typeof parseAudienceCsv>, { error: string }> | null = null;
  if (v.audience.type === "csv") {
    const r = parseAudienceCsv(v.audience.csv_text);
    if ("error" in r) return fail(r.error);
    if (r.tooMany)
      return fail("That file has more than 50,000 numbers. Split it into smaller campaigns.");
    csv = r;
  }

  const { data: created, error: insertErr } = await admin
    .from("campaigns")
    .insert({
      org_id: member.orgId,
      name: v.name,
      channel_id: channel.id,
      template_id: template.id,
      audience_type: v.audience.type,
      segment_id: v.audience.type === "segment" ? v.audience.segment_id : null,
      csv_opt_in_confirmed: v.audience.type === "csv" ? v.audience.opt_in_confirmed : false,
      variable_map: v.variable_map as Json as NonNullable<Json>,
      fallbacks: v.fallbacks as Json as NonNullable<Json>,
      status: "preparing",
      retry_rounds: v.retry_rounds,
      retry_delay_minutes: v.retry_delay_minutes,
      guardrails: v.guardrails as Json as NonNullable<Json>,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (insertErr || !created) return fail("Could not create the campaign.");
  const id = created.id;

  try {
    const snapshot =
      v.audience.type === "segment"
        ? await segmentAudience(admin, {
            orgId: member.orgId,
            segmentId: v.audience.segment_id,
            marketing,
            timezone: member.org.timezone,
            campaignId: id,
          })
        : await csvAudience(admin, {
            orgId: member.orgId,
            csv: csv!,
            marketing,
            confirmedOptIn: v.audience.opt_in_confirmed,
            userId: member.userId,
            campaignId: id,
          });
    if (snapshot.counts.tooMany)
      throw new Error("That audience has more than 50,000 contacts. Narrow the segment.");
    if (snapshot.counts.eligible === 0)
      throw new Error(
        marketing
          ? "Nobody in this audience can receive a marketing message (no opt-in, opted out or no phone)."
          : "Nobody in this audience can receive this message.",
      );
  } catch (e) {
    await admin.from("campaigns").delete().eq("id", id);
    return fail(messageOf(e, "Could not build the audience."));
  }

  await refreshStats(admin, id);
  if (scheduledAt) {
    await admin
      .from("campaigns")
      .update({ status: "scheduled", scheduled_at: scheduledAt.toISOString() })
      .eq("id", id);
    await scheduleJob({
      kind: "campaign.start",
      payload: { campaign_id: id },
      runAt: scheduledAt,
      orgId: member.orgId,
      dedupeKey: `campaign:start:${id}`,
    });
  } else {
    await admin.from("campaigns").update({ status: "queued" }).eq("id", id);
    await enqueue("campaign_fanout", { op: "start", campaign_id: id });
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.created",
    entity: "campaign",
    entityId: id,
    diff: {
      template_id: template.id,
      channel_id: channel.id,
      audience: v.audience.type,
      scheduled: !!scheduledAt,
    },
  });
  revalidatePath("/campaigns");
  return {
    ok: true,
    data: { id },
    message: scheduledAt ? "Campaign scheduled." : "Campaign started.",
  };
}

// ---------------------------------------------------------------------------
// Test send
// ---------------------------------------------------------------------------

const testSchema = z.object({
  channel_id: uuid,
  template_id: uuid,
  phone: z.string().trim().min(5).max(40),
  variable_map: mapSchema.default({}),
  fallbacks: mapSchema.default({}),
  /** csv.* sample values from the preview, so a CSV mapping resolves in the test. */
  csv_sample: z.record(z.string().max(80), z.string().max(200)).default({}),
});

export async function sendTestMessage(input: z.input<typeof testSchema>): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const parsed = testSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const v = parsed.data;
  const phone = normalizePhone(v.phone);
  if (!phone) return fail("Enter a valid phone number, e.g. +971 50 123 4567.");
  const admin = createAdminClient();
  const ctx = await loadSendContext(admin, member.orgId, v.channel_id, v.template_id);
  if (!ctx.ok) return fail(ctx.error);
  const { channel, template } = ctx;
  const components = template.components as unknown as MetaTemplateComponent[];

  // The tester's own number becomes (or reuses) a contact so the message lands in a normal conversation.
  let { data: contact } = await admin
    .from("contacts")
    .select("id, first_name, last_name, wa_profile_name, phone_e164, email, custom, stop_marketing")
    .eq("org_id", member.orgId)
    .eq("phone_e164", phone.e164)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) {
    const { data: profile } = await admin
      .from("profiles")
      .select("first_name")
      .eq("id", member.userId)
      .maybeSingle();
    const ins = await admin
      .from("contacts")
      .insert({
        org_id: member.orgId,
        first_name: profile?.first_name || "Test",
        phone_e164: phone.e164,
        source: "campaign_test",
        created_by: member.userId,
      })
      .select(
        "id, first_name, last_name, wa_profile_name, phone_e164, email, custom, stop_marketing",
      )
      .single();
    if (ins.error || !ins.data) return fail("Could not prepare the test recipient.");
    contact = ins.data;
  }
  if (isMarketingCategory(template.category) && contact.stop_marketing)
    return fail("That number has opted out of marketing messages.");

  const resolved = resolveVariables({
    components,
    map: v.variable_map,
    templateMap: stringMap(template.variable_map),
    fallbacks: v.fallbacks,
    contact: {
      ...contact,
      custom:
        contact.custom && typeof contact.custom === "object" && !Array.isArray(contact.custom)
          ? (contact.custom as Record<string, unknown>)
          : {},
    },
    csv: v.csv_sample,
  });
  // A test may fill gaps with the template's own examples; a real send never does.
  const values = { ...resolved.values };
  for (const key of resolved.missing) {
    const ex = templateVariables(components).find((x) => x.key === key)?.example;
    if (!ex) return fail(`"${key}" has no value to test with. Map it or give it a fallback.`);
    values[key] = ex;
  }

  let { data: conversation } = await admin
    .from("conversations")
    .select("id")
    .eq("channel_id", channel.id)
    .eq("contact_id", contact.id)
    .neq("status", "closed")
    .maybeSingle();
  if (!conversation) {
    const created = await admin
      .from("conversations")
      .insert({
        org_id: member.orgId,
        channel_id: channel.id,
        contact_id: contact.id,
        status: "waiting",
        campaign_only: true,
      })
      .select("id")
      .single();
    if (created.error) {
      // Raced with another writer: use the live conversation.
      const again = await admin
        .from("conversations")
        .select("id")
        .eq("channel_id", channel.id)
        .eq("contact_id", contact.id)
        .neq("status", "closed")
        .maybeSingle();
      conversation = again.data;
    } else conversation = created.data;
  }
  if (!conversation) return fail("Could not prepare the test conversation.");

  const preview = renderTemplatePreview(components, values);
  await queueOutbound(admin, {
    orgId: member.orgId,
    conversationId: conversation.id,
    spec: { type: "template", template_id: template.id, values },
    body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
    sentByUserId: member.userId,
    priority: true,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.test_send",
    entity: "wa_template",
    entityId: template.id,
  });
  return { ok: true, message: "Test message queued." };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function ownedCampaign(orgId: string, id: string) {
  if (!uuid.safeParse(id).success) return null;
  const admin = createAdminClient();
  const campaign = await loadCampaign(admin, id);
  if (!campaign || campaign.org_id !== orgId) return null;
  return { admin, campaign };
}

function done(message: string): ActionResult {
  revalidatePath("/campaigns");
  return { ok: true, message };
}

export async function pauseCampaignAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedCampaign(member.orgId, id);
  if (!found) return fail("Campaign not found.");
  if (!canPause(found.campaign.status as never))
    return fail("Only a running campaign can be paused.");
  await pauseCampaign(found.admin, found.campaign, "Paused by a team member.");
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.paused",
    entity: "campaign",
    entityId: id,
  });
  return done("Campaign paused. Messages already queued are held back.");
}

export async function resumeCampaignAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedCampaign(member.orgId, id);
  if (!found) return fail("Campaign not found.");
  if (!canResume(found.campaign.status as never))
    return fail("Only a paused campaign can be resumed.");
  const ok = await resumeCampaign(found.admin, id);
  if (!ok) return fail("The campaign could not be resumed.");
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.resumed",
    entity: "campaign",
    entityId: id,
  });
  return done("Campaign resumed.");
}

export async function cancelCampaignAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedCampaign(member.orgId, id);
  if (!found) return fail("Campaign not found.");
  if (!canCancel(found.campaign.status as never))
    return fail("This campaign can no longer be cancelled.");
  await cancelCampaign(found.admin, id);
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.cancelled",
    entity: "campaign",
    entityId: id,
  });
  return done("Campaign cancelled. Nothing more will be sent.");
}

export async function startNowAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedCampaign(member.orgId, id);
  if (!found) return fail("Campaign not found.");
  if (!canStartNow(found.campaign.status as never))
    return fail("Only a scheduled campaign can be started now.");
  const ok = await startCampaign(found.admin, id);
  if (!ok) return fail("The campaign could not be started.");
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.started_now",
    entity: "campaign",
    entityId: id,
  });
  return done("Campaign started.");
}

export async function rescheduleCampaignAction(id: string, atLocal: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedCampaign(member.orgId, id);
  if (!found) return fail("Campaign not found.");
  if (!canReschedule(found.campaign.status as never))
    return fail("Only a scheduled campaign can be rescheduled.");
  const at = fromZonedTime(atLocal, member.org.timezone);
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000)
    return fail("Pick a time at least a minute ahead.");
  if (at.getTime() > Date.now() + 90 * 86_400_000) return fail("Schedule within the next 90 days.");
  const { admin } = found;
  await admin
    .from("scheduled_jobs")
    .update({ done_at: new Date().toISOString() })
    .eq("dedupe_key", `campaign:start:${id}`)
    .is("done_at", null);
  await admin
    .from("campaigns")
    .update({ scheduled_at: at.toISOString() })
    .eq("id", id)
    .eq("status", "scheduled");
  await scheduleJob({
    kind: "campaign.start",
    payload: { campaign_id: id },
    runAt: at,
    orgId: member.orgId,
    dedupeKey: `campaign:start:${id}`,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.rescheduled",
    entity: "campaign",
    entityId: id,
    diff: { scheduled_at: at.toISOString() },
  });
  return done("Campaign rescheduled.");
}

export async function deleteCampaignAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  const found = await ownedCampaign(member.orgId, id);
  if (!found) return fail("Campaign not found.");
  if (!canDelete(found.campaign.status as never))
    return fail("Cancel the campaign before deleting it.");
  await found.admin.from("campaigns").delete().eq("id", id).eq("org_id", member.orgId);
  await recordAudit(found.admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "campaign.deleted",
    entity: "campaign",
    entityId: id,
    diff: { name: found.campaign.name },
  });
  return done("Campaign deleted.");
}
