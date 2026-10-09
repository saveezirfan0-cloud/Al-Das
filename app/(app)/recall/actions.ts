"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm, type CurrentMember } from "@/lib/auth/session";
import { isValidCron } from "@/lib/cron";
import { parseTestNumbers } from "@/lib/recall/engine";
import { ALLOWED_VIEWS, CLINICAL_KINDS, ELIGIBLE_FLAG_VIEWS } from "@/lib/recall/types";
import type { ScenarioKey } from "@/lib/parallel-run/diff";
import { COMPARABLE, SCENARIO_KEYS } from "@/lib/parallel-run/diff";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminClient } from "@/lib/supabase/admin";
import { toE164 } from "@/lib/whatsapp/phone";

export type ActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

const uuid = z.string().uuid();

function refresh() {
  revalidatePath("/recall");
}

function signer(member: CurrentMember): string {
  const p = member.profile as {
    first_name?: string;
    last_name?: string;
    email?: string | null;
  } | null;
  return `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim() || p?.email || member.userId;
}

/** Approves a clinical setting value (sign-off trail: who, when). Caller has checked clinical.settings.manage. */
async function approveSetting(
  admin: AdminClient,
  member: CurrentMember,
  key: string,
  value: string,
) {
  const { error } = await admin
    .from("clinical_settings")
    .update({
      approved_value: value,
      sign_off_status: "approved",
      signed_by: signer(member),
      signed_at: new Date().toISOString().slice(0, 10),
    })
    .eq("org_id", member.orgId)
    .eq("key", key);
  if (error) throw new Error(`Could not update ${key}`);
}

export async function settingValue(
  admin: AdminClient,
  orgId: string,
  key: string,
): Promise<string | null> {
  const { data } = await admin.rpc("clinical_setting", { p_org: orgId, p_key: key });
  return (data as string | null) ?? null;
}

// ---------------------------------------------------------------------------
// Programme settings
// ---------------------------------------------------------------------------

const programmeSchema = z.object({
  status: z.enum(["draft", "active", "paused"]),
  cron_expression: z.string().trim().max(60).nullable(),
  max_per_run: z.number().int().min(1).max(1000),
  send_mode_override: z.enum(["test", "live"]).nullable(),
  test_sample_size: z.number().int().min(0).max(50).optional(),
});

export async function saveProgramme(
  id: string,
  input: z.input<typeof programmeSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("campaigns.create");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Programme not found" };
  const parsed = programmeSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  const d = parsed.data;
  if (d.cron_expression && !isValidCron(d.cron_expression))
    return {
      ok: false,
      error: "That schedule is not a valid cron expression (minute hour day month weekday).",
    };
  const admin = createAdminClient();
  const { data: p } = await admin
    .from("recall_programmes")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!p) return { ok: false, error: "Programme not found" };

  // Going Live is a clinical sign-off, not a marketing toggle.
  if (d.send_mode_override === "live" && p.send_mode_override !== "live") {
    if (!can(member, "clinical.settings.manage"))
      return {
        ok: false,
        error: "Only someone who can sign off clinical settings can switch a programme to Live.",
      };
    if (
      CLINICAL_KINDS.has(p.kind) &&
      (await settingValue(admin, member.orgId, "clinical_messaging_enabled"))?.toLowerCase() !==
        "true"
    ) {
      return {
        ok: false,
        error: "Clinical messaging is not enabled yet. It needs a clinical sign-off first.",
      };
    }
  }
  if (d.status === "active" && (!p.eligibility_view || !ALLOWED_VIEWS.has(p.eligibility_view))) {
    return {
      ok: false,
      error: "This programme has no eligibility rule yet, so it cannot be activated.",
    };
  }
  const config = {
    ...((p.config as Record<string, unknown>) ?? {}),
    ...(d.test_sample_size !== undefined ? { test_sample_size: d.test_sample_size } : {}),
  };
  const { error } = await admin
    .from("recall_programmes")
    .update({
      status: d.status,
      cron_expression: d.cron_expression || null,
      max_per_run: d.max_per_run,
      send_mode_override: d.send_mode_override,
      config: config as never,
    })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the programme." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.programme_updated",
    entity: "recall_programme",
    entityId: id,
    diff: {
      status: d.status,
      mode: d.send_mode_override ?? "workspace default",
      max_per_run: d.max_per_run,
    },
  });
  refresh();
  return { ok: true, message: "Programme saved.", data: undefined };
}

const mapSchema = z.object({
  segment_key: z.string().trim().min(1).max(60),
  wa_template_id: uuid.nullable(),
  active: z.boolean().default(true),
});

export async function saveTemplateMap(
  programmeId: string,
  input: z.input<typeof mapSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("templates.manage");
  const parsed = mapSchema.safeParse(input);
  if (!parsed.success || !uuid.safeParse(programmeId).success)
    return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: p } = await admin
    .from("recall_programmes")
    .select("id")
    .eq("id", programmeId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!p) return { ok: false, error: "Programme not found" };
  if (parsed.data.wa_template_id) {
    const { data: t } = await admin
      .from("wa_templates")
      .select("id")
      .eq("id", parsed.data.wa_template_id)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!t) return { ok: false, error: "Template not found" };
  }
  const { error } = await admin
    .from("recall_programme_templates")
    .upsert(
      {
        org_id: member.orgId,
        programme_id: programmeId,
        segment_key: parsed.data.segment_key,
        wa_template_id: parsed.data.wa_template_id,
        active: parsed.data.active,
      },
      { onConflict: "programme_id,segment_key" },
    );
  if (error) return { ok: false, error: "Could not save the template." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.template_mapped",
    entity: "recall_programme",
    entityId: programmeId,
    diff: { segment: parsed.data.segment_key, linked: Boolean(parsed.data.wa_template_id) },
  });
  refresh();
  return { ok: true, message: "Template saved.", data: undefined };
}

export type Preview = { eligible: number; bySegment: Record<string, number>; note?: string };

/** Counts only (no names or numbers): who would be picked up on the next run. */
export async function previewProgramme(id: string): Promise<ActionResult<Preview>> {
  const member = await requirePerm("campaigns.view");
  const admin = createAdminClient();
  const { data: p } = await admin
    .from("recall_programmes")
    .select("eligibility_view")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!p?.eligibility_view || !ALLOWED_VIEWS.has(p.eligibility_view))
    return { ok: true, data: { eligible: 0, bySegment: {}, note: "No eligibility rule yet." } };
  type Loose = { select(c: string): { eq(c: string, v: unknown): Loose2 } };
  type Loose2 = {
    eq(c: string, v: unknown): Loose2;
    limit(
      n: number,
    ): PromiseLike<{
      data: Array<{ segment_key: string | null }> | null;
      error: { message: string } | null;
    }>;
  };
  let q = (admin as unknown as { from(v: string): Loose })
    .from(p.eligibility_view)
    .select("segment_key")
    .eq("org_id", member.orgId);
  if (ELIGIBLE_FLAG_VIEWS.has(p.eligibility_view)) q = q.eq("eligible", true) as never;
  const { data, error } = await (q as unknown as Loose2).limit(5000);
  if (error) return { ok: false, error: "Could not read the eligibility rule." };
  const bySegment: Record<string, number> = {};
  for (const r of data ?? [])
    bySegment[r.segment_key ?? "(no segment)"] =
      (bySegment[r.segment_key ?? "(no segment)"] ?? 0) + 1;
  const threshold =
    p.eligibility_view === "v_chronic_recall_eligibility"
      ? await settingValue(admin, member.orgId, "chronic_recall_min_days")
      : "n/a";
  return {
    ok: true,
    data: {
      eligible: data?.length ?? 0,
      bySegment,
      note:
        threshold === null
          ? "The chronic recall threshold is not signed off, so nobody is eligible yet."
          : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace sending settings (clinical sign-off)
// ---------------------------------------------------------------------------

const sendingSchema = z.object({
  mode: z.enum(["test", "live"]),
  test_numbers: z.string().max(2000),
});

export async function saveSendingSettings(
  input: z.input<typeof sendingSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("clinical.settings.manage");
  const parsed = sendingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  // Accept any common format, store E.164.
  const numbers = new Set<string>();
  for (const part of parsed.data.test_numbers.split(/[\n,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    const e164 = toE164(t);
    if (!e164) return { ok: false, error: `“${t}” is not a valid phone number.` };
    numbers.add(e164);
  }
  try {
    await approveSetting(
      admin,
      member,
      "test_recipient_numbers",
      parseTestNumbers([...numbers].join(",")).join(", "),
    );
    await approveSetting(admin, member, "recall_send_mode", parsed.data.mode);
  } catch {
    return {
      ok: false,
      error: "Could not save the sending settings (is the workspace set up for recall?).",
    };
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "recall.sending_settings_changed",
    entity: "clinical_settings",
    diff: { mode: parsed.data.mode, test_recipients: numbers.size },
  });
  refresh();
  return {
    ok: true,
    message:
      parsed.data.mode === "live"
        ? "Workspace default is now Live. Each programme still needs its own checks to pass."
        : "Workspace default is Test.",
    data: undefined,
  };
}

// ---------------------------------------------------------------------------
// Call list
// ---------------------------------------------------------------------------

const followUpSchema = z.object({
  id: uuid,
  follow_up_status: z.enum(["called", "no_response", "booked"]).nullable(),
  notes: z.string().max(500).optional(),
});

export async function updateFollowUp(input: z.input<typeof followUpSchema>): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "portal.recall_sends.write"))
    return { ok: false, error: "You don't have permission for that." };
  const parsed = followUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const patch: Record<string, unknown> = {
    follow_up_status: parsed.data.follow_up_status,
    assigned_user_id: member.userId,
  };
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
  // "Always fill in Booking Date when setting this to Booked."
  if (parsed.data.follow_up_status === "booked") patch.booked_at = new Date().toISOString();
  const { error } = await admin
    .from("recall_sends")
    .update(patch as never)
    .eq("id", parsed.data.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not update the entry." };
  revalidatePath("/recall/calls");
  return { ok: true, message: "Updated.", data: undefined };
}

// ---------------------------------------------------------------------------
// Parallel run checklist
// ---------------------------------------------------------------------------

const checklistSchema = z.object({
  scenario_key: z.enum(SCENARIO_KEYS),
  field: z.enum(["diffs_explained", "make_off", "native_built"]),
  value: z.boolean(),
});

export async function updateChecklist(
  input: z.input<typeof checklistSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = checklistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("parallel_run_scenarios")
    .select("*")
    .eq("org_id", member.orgId)
    .eq("scenario_key", parsed.data.scenario_key)
    .maybeSingle();
  if (!row) return { ok: false, error: "Scenario not found" };
  if (parsed.data.field === "make_off" && parsed.data.value) {
    const { count } = await admin
      .from("parallel_run_diffs")
      .select("run_date", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("scenario_key", parsed.data.scenario_key);
    const days = count ?? 0;
    if (!row.native_built) return { ok: false, error: "The native replacement is not built yet." };
    if (!row.diffs_explained)
      return { ok: false, error: "Mark the differences as explained first." };
    if (COMPARABLE.has(parsed.data.scenario_key) && days < 7)
      return { ok: false, error: `Only ${days} of 7 parallel days have been compared.` };
  }
  const patch: Record<string, unknown> = {
    [parsed.data.field]: parsed.data.value,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.field === "native_built" && parsed.data.value && !row.parallel_started_on)
    patch.parallel_started_on = new Date().toISOString().slice(0, 10);
  await admin
    .from("parallel_run_scenarios")
    .update(patch as never)
    .eq("org_id", member.orgId)
    .eq("scenario_key", parsed.data.scenario_key);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.checklist",
    entity: "parallel_run_scenario",
    diff: { scenario: parsed.data.scenario_key, [parsed.data.field]: parsed.data.value },
  });
  revalidatePath("/recall/parallel-run");
  return { ok: true, message: "Checklist updated.", data: undefined };
}

const reasonSchema = z.object({
  scenario_key: z.enum(SCENARIO_KEYS),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(3).max(500),
  explained: z.boolean(),
});

export async function explainDiff(input: z.input<typeof reasonSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = reasonSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Write a short reason first." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("parallel_run_diffs")
    .update({ reason: parsed.data.reason, explained: parsed.data.explained })
    .eq("org_id", member.orgId)
    .eq("scenario_key", parsed.data.scenario_key)
    .eq("run_date", parsed.data.run_date);
  if (error) return { ok: false, error: "Could not save." };
  revalidatePath("/recall/parallel-run");
  return { ok: true, message: "Saved.", data: undefined };
}

export type { ScenarioKey };
