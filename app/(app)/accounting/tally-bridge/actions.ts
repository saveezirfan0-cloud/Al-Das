"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { generatePairingCode, hashSecret, PUSH_SOURCES } from "@/lib/accounting/tally/bridge";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  optionalDate,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Tally bridge (Phase 22J), accounting.settings.manage: pairing the connector, revoking it, what is sent and pulled, and
 * sending a failed voucher again. Switching the integration itself on or off is on Settings, Integrations
 * (integrations.manage and the typed words). The database checks the permission again; every change is audited with ids
 * and settings only (never the pairing code or a token).
 */

const PERM = "accounting.settings.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const refresh = () => revalidatePath("/accounting/tally-bridge");

async function limited(userId: string): Promise<string | null> {
  const r = await checkRateLimit(
    createAdminClient(),
    "tally-bridge-manage",
    userId,
    RATE_RULES.tallyBridgeManagePerUser,
  );
  return r.allowed ? null : `Too many changes. Try again in ${waitText(r.retryAfter)}.`;
}

const settingsSchema = z.object({
  push_enabled: z.enum(["on", "off"]).default("off"),
  pull_enabled: z.enum(["on", "off"]).default("off"),
  push_from: optionalDate.default(""),
  revenue_mode: z.enum(["daily", "per_item"]),
  cost_category: z.string().trim().min(1).max(80),
  push_sources: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .refine(
      (xs) => xs.every((x) => (PUSH_SOURCES as readonly string[]).includes(x)),
      "Unknown source.",
    ),
});

export async function saveBridgeSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = settingsSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const payload = {
    push_enabled: v.push_enabled === "on",
    pull_enabled: v.pull_enabled === "on",
    push_from: v.push_from || null,
    revenue_mode: v.revenue_mode,
    cost_category: v.cost_category,
    push_sources: [...new Set(v.push_sources)].sort(),
  };
  const { error } = await admin.rpc("acc_tally_bridge_save_settings", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: payload,
  });
  if (error) return fail(rpcErrorMessage(error, "The settings could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.tally_bridge.settings",
    entity: "acc_tally_bridge_settings",
    entityId: member.orgId,
    diff: payload,
  });
  refresh();
  return { ok: true, message: "Saved. The next run (every 15 minutes) uses it." };
}

const labelSchema = z.object({ label: z.string().trim().min(1, "Name the PC.").max(60) });

/** A one-time pairing code for the connector, shown once (only its SHA-256 is stored), valid 30 minutes. */
export async function createPairingCode(
  values: Record<string, string>,
): Promise<ActionResult<{ code: string; expiresAt: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = labelSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const wait = await limited(member.userId);
  if (wait) return fail(wait);
  const code = generatePairingCode();
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_tally_bridge_pair_create", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_label: p.data.label,
    p_code_sha256: hashSecret(code),
  });
  const res = data as { device_id: string; expires_at: string } | null;
  if (error || !res) return fail(rpcErrorMessage(error, "The pairing code could not be created."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.tally_bridge.pairing_code",
    entity: "acc_tally_devices",
    entityId: res.device_id,
    diff: { expires_at: res.expires_at },
  });
  refresh();
  return { ok: true, data: { code, expiresAt: res.expires_at } };
}

const idSchema = z.object({ id: uuid });

export async function revokeConnector(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = idSchema.safeParse(values);
  if (!p.success) return fail("Choose a connector.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { error } = await admin.rpc("acc_tally_bridge_revoke", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_device_id: p.data.id,
  });
  if (error) return fail(rpcErrorMessage(error, "The connector could not be revoked."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.tally_bridge.revoked",
    entity: "acc_tally_devices",
    entityId: p.data.id,
  });
  refresh();
  return { ok: true, message: "Revoked. That connector can no longer reach Pulse." };
}

/** Sends a failed voucher again (after fixing the cause in Tally), or one whose answer never came (looked up first). */
export async function retryPush(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = idSchema.safeParse(values);
  if (!p.success) return fail("Choose a voucher.");
  const wait = await limited(member.userId);
  if (wait) return fail(wait);
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data: org } = await admin
    .from("orgs")
    .select("timezone")
    .eq("id", member.orgId)
    .maybeSingle();
  const { error } = await admin.rpc("acc_tally_bridge_retry", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_push_id: p.data.id,
    p_today: todayIn((org as { timezone?: string | null } | null)?.timezone ?? "Asia/Dubai"),
  });
  if (error) return fail(rpcErrorMessage(error, "It could not be sent again."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.tally_bridge.retry",
    entity: "acc_tally_push",
    entityId: p.data.id,
  });
  refresh();
  return { ok: true, message: "Queued. The connector sends it at its next poll." };
}
