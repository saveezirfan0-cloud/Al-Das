"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/crypto";
import { enqueue } from "@/lib/jobs/enqueue";
import { assertPublicHttpsUrl, UnsafeUrlError } from "@/lib/net/url-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { WEBHOOK_EVENT_NAMES, WEBHOOK_TEST_EVENT } from "@/lib/webhooks/events";
import { buildEnvelope } from "@/lib/webhooks/payload";
import { generateWebhookSecret } from "@/lib/webhooks/sign";

export type SecretResult = { ok: true; data: { id: string; secret: string } } | { ok: false; error: string };
export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/webhooks";
const MAX_ENDPOINTS = 20;
const uuid = z.string().uuid();

const createSchema = z.object({
  url: z.string().trim().min(1, "Enter the endpoint URL.").max(2000),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.string()).min(1, "Pick at least one event.").max(50),
});

/** Encrypts with ENCRYPTION_KEY; a missing key is a configuration problem the admin can act on. */
function sealSecret(secret: string): { ok: true; enc: string } | { ok: false; error: string } {
  try {
    return { ok: true, enc: encryptSecret(secret) };
  } catch {
    return { ok: false, error: "ENCRYPTION_KEY is not configured on the server, so signing secrets cannot be stored." };
  }
}

async function checkUrl(raw: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    return { ok: true, url: (await assertPublicHttpsUrl(raw)).toString() };
  } catch (err) {
    return { ok: false, error: err instanceof UnsafeUrlError ? err.message : "Enter a valid https:// URL." };
  }
}

export async function createWebhook(input: z.input<typeof createSchema>): Promise<SecretResult> {
  const member = await requirePerm("settings.manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const unknown = parsed.data.events.filter((e) => !WEBHOOK_EVENT_NAMES.includes(e));
  if (unknown.length) return { ok: false, error: `Unknown event: ${unknown[0]}.` };
  const target = await checkUrl(parsed.data.url);
  if (!target.ok) return target;

  const admin = createAdminClient();
  const { count } = await admin.from("webhook_subscriptions").select("id", { count: "exact", head: true }).eq("org_id", member.orgId);
  if ((count ?? 0) >= MAX_ENDPOINTS) return { ok: false, error: `You can have at most ${MAX_ENDPOINTS} endpoints.` };

  const secret = generateWebhookSecret();
  const sealed = sealSecret(secret);
  if (!sealed.ok) return sealed;

  const { data, error } = await admin
    .from("webhook_subscriptions")
    .insert({ org_id: member.orgId, url: target.url, description: parsed.data.description || null, events: [...new Set(parsed.data.events)], created_by: member.userId })
    .select("id")
    .single();
  if (error) return { ok: false, error: "Could not create the endpoint." };
  const { error: secretError } = await admin.from("webhook_secrets").insert({ subscription_id: data.id, secret_enc: sealed.enc });
  if (secretError) {
    await admin.from("webhook_subscriptions").delete().eq("id", data.id);
    return { ok: false, error: "Could not store the signing secret." };
  }
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "webhook.created", entity: "webhook", entityId: data.id, diff: { host: new URL(target.url).hostname, events: parsed.data.events } });
  revalidatePath(PATH);
  return { ok: true, data: { id: data.id, secret } };
}

export async function setWebhookActive(id: string, active: boolean): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { error } = await admin.from("webhook_subscriptions").update({ active }).eq("id", id).eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not update the endpoint." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: active ? "webhook.enabled" : "webhook.disabled", entity: "webhook", entityId: id });
  revalidatePath(PATH);
  return { ok: true, message: active ? "Endpoint enabled." : "Endpoint paused. Pending deliveries are dropped." };
}

export async function deleteWebhook(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { error } = await admin.from("webhook_subscriptions").delete().eq("id", id).eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not delete the endpoint." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "webhook.deleted", entity: "webhook", entityId: id });
  revalidatePath(PATH);
  return { ok: true, message: "Endpoint deleted." };
}

export async function rotateWebhookSecret(id: string): Promise<SecretResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: sub } = await admin.from("webhook_subscriptions").select("id").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!sub) return { ok: false, error: "Endpoint not found." };
  const secret = generateWebhookSecret();
  const sealed = sealSecret(secret);
  if (!sealed.ok) return sealed;
  const { error } = await admin.from("webhook_secrets").upsert({ subscription_id: id, secret_enc: sealed.enc, updated_at: new Date().toISOString() });
  if (error) return { ok: false, error: "Could not rotate the secret." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "webhook.secret_rotated", entity: "webhook", entityId: id });
  return { ok: true, data: { id, secret } };
}

/** Queues a signed `webhook.test` delivery so an endpoint can be verified end to end. */
export async function sendTestWebhook(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: sub } = await admin.from("webhook_subscriptions").select("id").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!sub) return { ok: false, error: "Endpoint not found." };
  const eventId = randomUUID();
  const envelope = buildEnvelope({ id: eventId, type: WEBHOOK_TEST_EVENT, orgId: member.orgId, createdAt: new Date(), payload: { source: "settings_test" } });
  const { data, error } = await admin
    .from("webhook_deliveries")
    .insert({ org_id: member.orgId, subscription_id: id, event_id: eventId, event: WEBHOOK_TEST_EVENT, payload: envelope as unknown as NonNullable<Json> })
    .select("id")
    .single();
  if (error) return { ok: false, error: "Could not queue the test." };
  await enqueue("webhooks_out", { delivery_id: data.id });
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "webhook.test_sent", entity: "webhook", entityId: id });
  revalidatePath(PATH);
  return { ok: true, message: "Test queued. It appears in the delivery log within a minute." };
}

/** Gives a failed or dead delivery a fresh set of attempts. */
export async function retryDelivery(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("webhook_deliveries")
    .update({ status: "pending", attempts: 0, error: null, next_attempt_at: null })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .in("status", ["failed", "dead"])
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "That delivery cannot be retried." };
  await enqueue("webhooks_out", { delivery_id: data.id });
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "webhook.delivery_retried", entity: "webhook_delivery", entityId: data.id });
  revalidatePath(PATH);
  return { ok: true, message: "Retry queued." };
}
