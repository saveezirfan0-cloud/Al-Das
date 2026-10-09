"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PERM = "finance.reference.manage";
const text = z.string().trim().max(200);
const nullable = text.transform((v) => (v === "" ? null : v));
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

function failure(error: { code?: string; message: string }): ActionResult {
  if (error.code === "23505")
    return { ok: false, error: "That value is already used by another row." };
  if (error.code === "42501")
    return { ok: false, error: "You do not have permission to change reference data." };
  return { ok: false, error: "Could not save." };
}

async function audit(
  action: string,
  entity: string,
  entityId: string,
  diff: Record<string, unknown>,
) {
  const member = await requirePerm(PERM);
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action,
    entity,
    entityId,
    diff: diff as never,
  });
}

// All writes use the member's own client, so row level security (finance.reference.manage) decides.

const branchSchema = z.object({
  id: z.string().uuid(),
  name: text.min(1),
  unite_clinic_long_name: nullable,
  unite_clinic_short_name: nullable,
  active: checkbox,
});
export async function saveBranch(formData: FormData): Promise<ActionResult> {
  await requirePerm(PERM);
  const p = branchSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { ok: false, error: "Check the branch name and clinic names." };
  const { id, ...patch } = p.data;
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_branches")
    .update(patch)
    .eq("id", id);
  if (error) return failure(error);
  await audit("finance.reference.branch_saved", "fin_ref_branches", id, patch);
  revalidatePath("/finance/reference");
  return {
    ok: true,
    message: "Branch saved. Use “Re-derive branches” to apply it to stored invoices.",
  };
}

const newBranchSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}$/),
  name: text.min(1),
});
export async function addBranch(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = newBranchSchema.safeParse(Object.fromEntries(formData));
  if (!p.success)
    return { ok: false, error: "Use a 1-4 character code (letters or digits) and a name." };
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_branches")
    .insert({ org_id: member.orgId, ...p.data });
  if (error) return failure(error);
  await audit("finance.reference.branch_added", "fin_ref_branches", p.data.code, p.data);
  revalidatePath("/finance/reference");
  return { ok: true, message: "Branch added." };
}

const serviceSchema = z.object({
  item_code: text.min(1),
  service_category: text.min(1),
  cpt_code: nullable,
});
export async function saveService(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = serviceSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { ok: false, error: "A category is required." };
  const { item_code, ...patch } = p.data;
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_services")
    .update(patch)
    .eq("org_id", member.orgId)
    .eq("item_code", item_code);
  if (error) return failure(error);
  await audit("finance.reference.service_saved", "fin_ref_services", item_code, patch);
  revalidatePath("/finance/reference");
  return { ok: true, message: "Service saved." };
}

const doctorSchema = z.object({
  dha_id: text.min(1),
  name: nullable,
  department: nullable,
  specialty: nullable,
  active: checkbox,
});
export async function saveDoctor(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = doctorSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { ok: false, error: "Check the doctor fields." };
  const { dha_id, ...patch } = p.data;
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_doctors")
    .update(patch)
    .eq("org_id", member.orgId)
    .eq("dha_id", dha_id);
  if (error) return failure(error);
  await audit("finance.reference.doctor_saved", "fin_ref_doctors", dha_id, patch);
  revalidatePath("/finance/reference");
  return { ok: true, message: "Doctor saved." };
}

const ruleSchema = z.object({
  rule_code: z.string().regex(/^E[0-9]{2}$/),
  threshold_days: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 3650),
      "Days must be a whole number.",
    ),
  active: checkbox,
});
export async function saveRule(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = ruleSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Check the values." };
  const { rule_code, ...patch } = p.data;
  const { error } = await (
    await createClient()
  )
    .from("fin_ref_exception_rules")
    .update(patch)
    .eq("org_id", member.orgId)
    .eq("rule_code", rule_code);
  if (error) return failure(error);
  await audit("finance.reference.rule_saved", "fin_ref_exception_rules", rule_code, patch);
  revalidatePath("/finance/reference");
  return { ok: true, message: "Rule saved." };
}

/** After a clinic name is mapped, fix invoices stored without a branch and close their E07. */
export async function rederiveBranchesAction(): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const { data, error } = await createAdminClient().rpc("fin_rederive_branches", {
    p_org_id: member.orgId,
  });
  if (error) return { ok: false, error: "Could not re-derive branches." };
  await audit("finance.reference.branches_rederived", "fin_invoices", member.orgId, {
    updated: Number(data ?? 0),
  });
  revalidatePath("/finance/reference");
  return { ok: true, message: `${data ?? 0} invoice(s) updated.` };
}
