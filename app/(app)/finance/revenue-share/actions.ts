"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { lastClosedMonth } from "@/lib/finance/close-server";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  buildRunSnapshot,
  CHARGE_KINDS,
  normaliseDoctorId,
  parseChargesCsv,
  ruleFromForm,
} from "@/lib/finance/revshare";
import { knownCategories, loadInputs, MONTH_RE } from "@/lib/finance/revshare-server";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Doctor revenue share (slice 20F). Each action checks the key for what it does: preparing (schemes, charges, the
 * draft run, accounting and payment references) needs finance.revshare.manage, verifying needs finance.revshare.verify,
 * approving and retiring need finance.revshare.approve. Writes use the service role after the check; the database
 * enforces the order, the two different people, the hash the person saw, frozen runs and locked months. Audit rows hold
 * ids, months and counts: never a payout or a rule (those stay in the RLS-protected tables).
 */

async function gate(perm: string) {
  const member = await requireMember();
  return can(member, perm) ? member : null;
}

/** Our own SQL messages (state, two people, locked month) are safe to show; anything else is not. */
function rpcMessage(error: { code?: string; message?: string }, fallback: string): string {
  if (
    (error.code === "23514" || error.code === "42501" || error.code === "P0001") &&
    error.message
  ) {
    if (/violates check constraint|permission denied/i.test(error.message)) return fallback;
    return error.message.charAt(0).toUpperCase() + error.message.slice(1) + ".";
  }
  return fallback;
}

function refresh() {
  revalidatePath("/finance/revenue-share");
  revalidatePath("/finance/revenue-share/schemes");
  revalidatePath("/finance/revenue-share/charges");
}

const monthField = z.string().trim().regex(MONTH_RE, "Choose a month.");
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const reference = z
  .string()
  .trim()
  .min(1, "Give the reference.")
  .max(80, "Keep the reference under 80 characters.");

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function buildRevshareRun(raw: { month: string }): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  const p = z.object({ month: monthField }).safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const month = p.data.month;
  if (month > lastClosedMonth(todayIn(member.org.timezone)))
    return fail("A month can only be calculated after it has ended.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  try {
    const snapshot = buildRunSnapshot(await loadInputs(admin, member.orgId, month));
    const { data, error } = await admin.rpc("fin_revshare_store_draft", {
      p_org_id: member.orgId,
      p_month: `${month}-01`,
      p_user_id: member.userId,
      p_snapshot: snapshot as unknown as Json,
    });
    if (error) return fail(rpcMessage(error, "The run could not be built."));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.revshare.run_built",
      entity: "fin_revshare_runs",
      entityId: String(data),
      diff: { month, doctors: snapshot.results.length, without_scheme: snapshot.no_scheme.length },
    });
    refresh();
    return {
      ok: true,
      message: `Draft built for ${snapshot.results.length} doctors. Review it, then verify.`,
    };
  } catch {
    return fail("The run could not be built.");
  }
}

const stepSchema = z.object({ id: uuid, month: monthField, hash });

async function runStep(
  perm: string,
  step: "verify" | "withdraw" | "approve",
  raw: { id: string; month: string; hash: string },
  done: string,
): Promise<ActionResult> {
  const member = await gate(perm);
  if (!member) return fail(DENIED);
  const p = stepSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_revshare_run_step", {
    p_org_id: member.orgId,
    p_run_id: p.data.id,
    p_step: step,
    p_user_id: member.userId,
    p_hash: p.data.hash,
  });
  if (error) return fail(rpcMessage(error, "Nothing was changed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `finance.revshare.run_${step === "withdraw" ? "returned_to_draft" : step === "verify" ? "verified" : "approved"}`,
    entity: "fin_revshare_runs",
    entityId: p.data.id,
    diff: { month: p.data.month, snapshot_sha256: p.data.hash },
  });
  refresh();
  return { ok: true, message: done };
}

export async function verifyRevshareRun(raw: { id: string; month: string; hash: string }) {
  return runStep("finance.revshare.verify", "verify", raw, "Verified. The CEO approves next.");
}
export async function withdrawRevshareRun(raw: { id: string; month: string; hash: string }) {
  return runStep(
    "finance.revshare.verify",
    "withdraw",
    raw,
    "Returned to draft. The run and its charges can change again.",
  );
}
export async function approveRevshareRun(raw: { id: string; month: string; hash: string }) {
  return runStep(
    "finance.revshare.approve",
    "approve",
    raw,
    "Approved. Post it to accounting next.",
  );
}

export async function postRevshareRun(raw: {
  id: string;
  month: string;
  ref: string;
}): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  const p = z.object({ id: uuid, month: monthField, ref: reference }).safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_revshare_post", {
    p_org_id: member.orgId,
    p_run_id: p.data.id,
    p_user_id: member.userId,
    p_ref: p.data.ref,
  });
  if (error) return fail(rpcMessage(error, "The accounting reference could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.revshare.run_posted",
    entity: "fin_revshare_runs",
    entityId: p.data.id,
    diff: { month: p.data.month },
  });
  refresh();
  return { ok: true, message: "Accounting reference saved. Record each doctor's payment next." };
}

export async function recordRevsharePayment(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  const p = z
    .object({ line_id: uuid, month: monthField, paid_on: isoDate, ref: reference })
    .safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  if (p.data.paid_on > todayIn(member.org.timezone))
    return fail("The payment date cannot be in the future.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("fin_revshare_record_payment", {
    p_org_id: member.orgId,
    p_line_id: p.data.line_id,
    p_user_id: member.userId,
    p_paid_on: p.data.paid_on,
    p_ref: p.data.ref,
  });
  if (error) return fail(rpcMessage(error, "The payment could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.revshare.payment_recorded",
    entity: "fin_revshare_lines",
    entityId: p.data.line_id,
    diff: { month: p.data.month, paid_on: p.data.paid_on, run_status: String(data) },
  });
  refresh();
  return {
    ok: true,
    message: data === "paid" ? "Payment saved. Every doctor is now paid." : "Payment saved.",
  };
}

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

const schemeMeta = z.object({
  scheme_id: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || uuid.safeParse(v).success, "Reload the page and try again."),
  doctor_dha_id: z
    .string()
    .transform((v) => normaliseDoctorId(v))
    .refine((v): v is string => v !== null, "Give the doctor's DHA id (1 to 40 characters)."),
  effective_month: monthField,
  note: z.string().trim().max(300, "Keep the note under 300 characters.").default(""),
});

export async function saveRevshareScheme(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  const meta = schemeMeta.safeParse(raw);
  if (!meta.success) return fail(firstIssue(meta.error));
  const admin = createAdminClient(member.userId);
  const rule = ruleFromForm(raw, await knownCategories(admin, member.orgId));
  if (!rule.ok) return fail(rule.error);
  const { data, error } = await admin.rpc("fin_revshare_scheme_save", {
    p_org_id: member.orgId,
    // null = a new version (the generated type cannot say that a plain uuid parameter accepts null)
    p_scheme_id: meta.data.scheme_id as string,
    p_doctor: meta.data.doctor_dha_id as string,
    p_effective_from: `${meta.data.effective_month}-01`,
    p_rule: rule.rule as unknown as Json,
    p_note: meta.data.note ? redactText(meta.data.note, 300) : "",
    p_user_id: member.userId,
  });
  if (error) return fail(rpcMessage(error, "The scheme could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: meta.data.scheme_id
      ? "finance.revshare.scheme_edited"
      : "finance.revshare.scheme_drafted",
    entity: "fin_revshare_schemes",
    entityId: String(data),
    diff: { doctor: meta.data.doctor_dha_id, effective_from: meta.data.effective_month },
  });
  refresh();
  return { ok: true, message: "Draft saved. Finance verifies it, then the CEO approves it." };
}

const SCHEME_STEP_PERM = {
  verify: "finance.revshare.verify",
  approve: "finance.revshare.approve",
  retire: "finance.revshare.approve",
  delete: "finance.revshare.manage",
} as const;
const SCHEME_STEP_DONE = {
  verify: "Verified. The CEO approves next.",
  approve: "Approved. Runs from its start month use this version.",
  retire: "Retired. Months from this version's start no longer have a scheme for this doctor.",
  delete: "Draft deleted.",
} as const;

export async function revshareSchemeStep(raw: {
  id: string;
  step: string;
  hash: string;
}): Promise<ActionResult> {
  const p = z
    .object({ id: uuid, step: z.enum(["verify", "approve", "retire", "delete"]), hash })
    .safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const member = await gate(SCHEME_STEP_PERM[p.data.step]);
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_revshare_scheme_step", {
    p_org_id: member.orgId,
    p_scheme_id: p.data.id,
    p_step: p.data.step,
    p_user_id: member.userId,
    p_hash: p.data.hash,
  });
  if (error) return fail(rpcMessage(error, "Nothing was changed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `finance.revshare.scheme_${p.data.step === "delete" ? "deleted" : p.data.step === "retire" ? "retired" : p.data.step === "verify" ? "verified" : "approved"}`,
    entity: "fin_revshare_schemes",
    entityId: p.data.id,
    diff: { rule_sha256: p.data.hash },
  });
  refresh();
  return { ok: true, message: SCHEME_STEP_DONE[p.data.step] };
}

// ---------------------------------------------------------------------------
// Doctor charges
// ---------------------------------------------------------------------------

const chargeSchema = z.object({
  month: monthField,
  doctor_dha_id: z
    .string()
    .transform((v) => normaliseDoctorId(v))
    .refine((v): v is string => v !== null, "Give the doctor's DHA id."),
  kind: z.enum(CHARGE_KINDS, { message: "Choose the kind of charge." }),
  amount: z
    .string()
    .trim()
    .transform((v) => Number(v.replace(/,/g, "")))
    .refine(
      (v) =>
        Number.isFinite(v) && v > 0 && v <= 1e9 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
      "Enter an amount above 0 with at most two decimals.",
    ),
  reference: z.string().trim().max(80, "Keep the reference under 80 characters.").default(""),
  note: z.string().trim().max(300, "Keep the note under 300 characters.").default(""),
});

export async function addDoctorCharge(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  const p = chargeSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_doctor_charges")
    .insert({
      org_id: member.orgId,
      month: `${p.data.month}-01`,
      doctor_dha_id: p.data.doctor_dha_id as string,
      kind: p.data.kind,
      amount: p.data.amount,
      source: "manual",
      reference: p.data.reference || null,
      note: p.data.note ? redactText(p.data.note, 300) : null,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error) return fail(rpcMessage(error, "The charge could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.revshare.charge_added",
    entity: "fin_doctor_charges",
    entityId: data.id,
    diff: { month: p.data.month, doctor: p.data.doctor_dha_id, kind: p.data.kind },
  });
  refresh();
  return { ok: true, message: "Charge saved." };
}

export async function deleteDoctorCharge(raw: { id: string }): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  const p = z.object({ id: uuid }).safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_doctor_charges")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", p.data.id)
    .select("id, month, doctor_dha_id, kind");
  if (error) return fail(rpcMessage(error, "The charge could not be deleted."));
  if (!data || data.length === 0) return fail("That charge no longer exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.revshare.charge_deleted",
    entity: "fin_doctor_charges",
    entityId: p.data.id,
    diff: { month: data[0].month, doctor: data[0].doctor_dha_id, kind: data[0].kind },
  });
  refresh();
  return { ok: true, message: "Charge deleted." };
}

const MAX_CHARS = 1_500_000;

export async function uploadDoctorCharges(csv: string): Promise<ActionResult> {
  const member = await gate("finance.revshare.manage");
  if (!member) return fail(DENIED);
  if (typeof csv !== "string" || csv.trim() === "") return fail("The file is empty.");
  if (csv.length > MAX_CHARS) return fail("The file is too large. Split it into smaller files.");
  const parsed = parseChargesCsv(csv);
  if (!parsed.ok) return fail(`Nothing was saved. ${parsed.errors.slice(0, 6).join(" ")}`);
  const rows = parsed.rows.map((r) => ({ ...r, note: r.note ? redactText(r.note, 300) : null }));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("fin_doctor_charges_replace_upload", {
    p_org_id: member.orgId,
    p_rows: rows as unknown as Json,
    p_user_id: member.userId,
  });
  if (error)
    return fail(`Nothing was saved. ${rpcMessage(error, "Check the file and try again.")}`);
  const res = (data ?? {}) as { added?: number; removed?: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.revshare.charges_uploaded",
    entity: "fin_doctor_charges",
    entityId: member.orgId,
    diff: {
      rows: rows.length,
      replaced: res.removed ?? 0,
      months: [...new Set(rows.map((r) => r.month.slice(0, 7)))].slice(0, 12),
    },
  });
  refresh();
  return {
    ok: true,
    message: `${res.added ?? rows.length} charges saved${res.removed ? `, replacing ${res.removed} from an earlier upload` : ""}.`,
  };
}
