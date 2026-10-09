"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { isValidCron } from "@/lib/flow-engine/cron";
import { checkRateLimit, RATE_RULES } from "@/lib/rate-limit";
import { runProgramme, type RunSummary } from "@/lib/recall/engine";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, TablesUpdate } from "@/lib/supabase/types";

type Result<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const PERM = "flows.manage";
const uuid = z.string().uuid();
const bad = (error = "Invalid input"): { ok: false; error: string } => ({ ok: false, error });
const refresh = () => revalidatePath("/flows/recall");

async function load(orgId: string, id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("recall_programmes")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return { admin, programme: data };
}

export async function setProgrammeStatus(
  id: string,
  status: "draft" | "active" | "paused",
): Promise<Result> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success || !["draft", "active", "paused"].includes(status)) return bad();
  const { admin, programme } = await load(member.orgId, id);
  if (!programme) return bad("Programme not found.");
  if (programme.eligibility === "managed")
    return bad("This programme is run from Settings → Appointments.");
  if (status === "active") {
    if (!programme.cron_expression || !isValidCron(programme.cron_expression))
      return bad("Set a valid schedule first.");
    const { count } = await admin
      .from("recall_programme_templates")
      .select("id", { count: "exact", head: true })
      .eq("programme_id", id)
      .eq("active", true)
      .not("wa_template_id", "is", null);
    if (!count)
      return bad("Map at least one approved template first. Nothing is sent without one.");
  }
  await admin.from("recall_programmes").update({ status }).eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `recall.programme_${status}`,
    entity: "recall_programme",
    entityId: id,
    diff: { key: programme.key },
  });
  refresh();
  return {
    ok: true,
    message:
      status === "active"
        ? "Programme is on its schedule."
        : status === "paused"
          ? "Programme paused."
          : "Programme set to draft.",
  };
}

const configSchema = z.object({
  min_days: z.number().int().min(0).max(3650).nullable().optional(),
  max_days: z.number().int().min(0).max(3650).nullable().optional(),
  gender: z.enum(["male", "female"]).nullable().optional(),
  min_age: z.number().int().min(0).max(120).nullable().optional(),
  max_age: z.number().int().min(0).max(120).nullable().optional(),
});
const settingsSchema = z.object({
  cron_expression: z.string().trim().max(100).nullable(),
  max_per_run: z.number().int().min(1).max(2000),
  send_mode_override: z.enum(["test", "live"]).nullable(),
  channel_id: uuid.nullable(),
  config: configSchema.optional(),
});

export async function updateProgramme(
  id: string,
  input: z.input<typeof settingsSchema>,
): Promise<Result> {
  const member = await requirePerm(PERM);
  const parsed = settingsSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return bad(parsed.success ? undefined : parsed.error.issues[0]?.message);
  const d = parsed.data;
  const { admin, programme } = await load(member.orgId, id);
  if (!programme) return bad("Programme not found.");
  if (programme.eligibility === "managed")
    return bad("This programme is run from Settings → Appointments.");
  if (d.cron_expression && !isValidCron(d.cron_expression))
    return bad("That schedule is not valid (five cron fields).");
  if (d.send_mode_override === "live") {
    // A per-programme live override sidesteps the workspace's Test/Live setting, so it is for admins who can sign off clinical settings.
    const { can } = await import("@/lib/auth/can");
    if (!can(member, "clinical.settings.manage"))
      return bad("Only someone who can sign off clinical settings can force a programme live.");
  }
  if (d.channel_id) {
    const { data } = await admin
      .from("channels")
      .select("id")
      .eq("id", d.channel_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!data) return bad("That number does not exist.");
  }
  const config =
    d.config && programme.eligibility === "visit_gap"
      ? { ...(programme.config as Record<string, unknown>), ...d.config }
      : programme.config;
  const { error } = await admin
    .from("recall_programmes")
    .update({
      cron_expression: d.cron_expression || null,
      max_per_run: d.max_per_run,
      send_mode_override: d.send_mode_override,
      channel_id: d.channel_id,
      config: config as Json as NonNullable<Json>,
    })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return bad("Could not save the programme.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.programme_updated",
    entity: "recall_programme",
    entityId: id,
    diff: {
      key: programme.key,
      send_mode_override: d.send_mode_override,
      max_per_run: d.max_per_run,
    },
  });
  refresh();
  return { ok: true, message: "Saved." };
}

const templateSchema = z.object({
  wa_template_id: uuid.nullable(),
  variables_map: z.record(z.string().max(40), z.string().max(300)).default({}),
  active: z.boolean().default(true),
});

export async function saveProgrammeTemplate(
  programmeId: string,
  segmentKey: string,
  input: z.input<typeof templateSchema>,
): Promise<Result> {
  const member = await requirePerm(PERM);
  const parsed = templateSchema.safeParse(input);
  if (
    !uuid.safeParse(programmeId).success ||
    !parsed.success ||
    !segmentKey ||
    segmentKey.length > 80
  )
    return bad();
  const { admin, programme } = await load(member.orgId, programmeId);
  if (!programme) return bad("Programme not found.");
  if (parsed.data.wa_template_id) {
    const { data } = await admin
      .from("wa_templates")
      .select("id")
      .eq("id", parsed.data.wa_template_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!data) return bad("That template does not exist.");
  }
  const { error } = await admin.from("recall_programme_templates").upsert(
    {
      org_id: member.orgId,
      programme_id: programmeId,
      segment_key: segmentKey,
      wa_template_id: parsed.data.wa_template_id,
      variables_map: parsed.data.variables_map as Json as NonNullable<Json>,
      active: parsed.data.active,
    },
    { onConflict: "programme_id,segment_key" },
  );
  if (error) return bad("Could not save the template mapping.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.template_mapped",
    entity: "recall_programme",
    entityId: programmeId,
    diff: { programme: programme.key, segment: segmentKey, template: parsed.data.wa_template_id },
  });
  refresh();
  return { ok: true, message: "Saved." };
}

/** "Check eligibility now": counts who would be recalled and why others would not. Queues nothing. */
export async function checkProgramme(id: string): Promise<Result<RunSummary>> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const { admin, programme } = await load(member.orgId, id);
  if (!programme) return bad("Programme not found.");
  if (programme.eligibility === "managed")
    return bad("This programme is run from Settings → Appointments.");
  const limited = await checkRateLimit(
    admin,
    "recall-run",
    member.userId,
    RATE_RULES.recallRunPerUser,
  );
  if (!limited.allowed) return bad("Too many runs in a short time. Wait a moment.");
  const summary = await runProgramme(admin, programme, { trigger: "check" });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.programme_checked",
    entity: "recall_programme",
    entityId: id,
    diff: { key: programme.key, scanned: summary.scanned },
  });
  return { ok: true, data: summary };
}

/** "Run now": same as the schedule. In live mode it messages real patients, so it needs an explicit confirmation. */
export async function runProgrammeNow(
  id: string,
  confirmLive = false,
): Promise<Result<RunSummary>> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return bad();
  const { admin, programme } = await load(member.orgId, id);
  if (!programme) return bad("Programme not found.");
  if (programme.eligibility === "managed")
    return bad("This programme is run from Settings → Appointments.");
  if (programme.status !== "active")
    return bad("Turn the programme on first, or use “Check eligibility”.");
  const limited = await checkRateLimit(
    admin,
    "recall-run",
    member.userId,
    RATE_RULES.recallRunPerUser,
  );
  if (!limited.allowed) return bad("Too many runs in a short time. Wait a moment.");
  const { loadClinicalSettings } = await import("@/lib/clinical/engine");
  const { resolveSendMode } = await import("@/lib/clinical/recall");
  const mode = resolveSendMode(
    programme.send_mode_override,
    (await loadClinicalSettings(admin, member.orgId)).value("recall_send_mode"),
  );
  if (mode === "live" && !confirmLive)
    return bad("This programme is live. Confirm that you want to message real patients now.");
  const summary = await runProgramme(admin, programme, { trigger: "manual" });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.programme_run",
    entity: "recall_programme",
    entityId: id,
    diff: { key: programme.key, mode, queued: summary.queued, dry_run: summary.dryRun },
  });
  refresh();
  return {
    ok: true,
    data: summary,
    message: summary.dryRun
      ? "Counted only: clinical messaging is not signed off."
      : `${summary.queued} message${summary.queued === 1 ? "" : "s"} queued.`,
  };
}

// ---------------------------------------------------------------------------
// Call list
// ---------------------------------------------------------------------------

const callSchema = z.object({
  follow_up_status: z.enum(["called", "no_response", "booked"]).nullable().optional(),
  assigned_user_id: uuid.nullable().optional(),
  outcome: z.string().trim().max(80).nullable().optional(),
});

export async function updateRecallFollowUp(
  sendId: string,
  input: z.input<typeof callSchema>,
): Promise<Result> {
  const member = await requirePerm("portal.clinical_followups.write");
  const parsed = callSchema.safeParse(input);
  if (!uuid.safeParse(sendId).success || !parsed.success) return bad();
  const d = parsed.data;
  const admin = createAdminClient();
  const { data: send } = await admin
    .from("recall_sends")
    .select("id, booked_at")
    .eq("id", sendId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!send) return bad("Not found.");
  if (d.assigned_user_id) {
    const { data } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("user_id", d.assigned_user_id)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return bad("That person is not an active member.");
  }
  const patch: TablesUpdate<"recall_sends"> = {};
  if (d.follow_up_status !== undefined) {
    patch.follow_up_status = d.follow_up_status;
    if (d.follow_up_status === "booked" && !send.booked_at)
      patch.booked_at = new Date().toISOString(); // "always fill in the booking date"
  }
  if (d.assigned_user_id !== undefined) patch.assigned_user_id = d.assigned_user_id;
  if (d.outcome !== undefined) patch.outcome = d.outcome || null;
  const { error } = await admin
    .from("recall_sends")
    .update(patch)
    .eq("id", sendId)
    .eq("org_id", member.orgId);
  if (error) return bad("Could not save.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.follow_up_updated",
    entity: "recall_send",
    entityId: sendId,
    diff: { status: d.follow_up_status ?? null },
  });
  revalidatePath("/flows/recall/calls");
  return { ok: true };
}
