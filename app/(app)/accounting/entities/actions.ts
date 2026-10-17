"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { EMIRATES } from "@/lib/accounting/accounts";
import { rpcErrorMessage } from "@/lib/accounting/errors";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  optionalText,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Entities, branch mapping and fiscal years (Phase 22A), accounting.settings.manage. The fiscal year start cannot change
 * once a fiscal year exists (database guard). Audited.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const entitySchema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  name: z.string().trim().min(1, "Enter the legal name.").max(120),
  trn: optionalText(20).refine(
    (v) => v === null || /^[0-9A-Z-]{5,20}$/.test(v),
    "The TRN is digits (and dashes).",
  ),
  base_currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase() || "AED")
    .refine((v) => /^[A-Z]{3}$/.test(v), "Currency is a three-letter code."),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12),
  // The entity's Tally company, exactly as TallyPrime names it (W7). Empty: the default entity uses the Tally bridge
  // integration's company; any other entity is not bridged.
  tally_company: optionalText(120),
  active: z.string().optional(),
});

export async function saveEntity(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.settings.manage");
  if (!member) return fail(DENIED);
  const p = entitySchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    name: v.name,
    trn: v.trn,
    base_currency: v.base_currency,
    fiscal_year_start_month: v.fiscal_year_start_month,
    tally_company: v.tally_company,
  };
  const { data, error } = v.id
    ? await admin
        .from("acc_entities")
        .update({ ...row, active: v.active === "on" })
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("acc_entities")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id")
        .single();
  if (error || !data) return fail(rpcErrorMessage(error, "The entity could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.entity.updated" : "accounting.entity.created",
    entity: "acc_entities",
    entityId: data.id,
    diff: {
      fy_start: v.fiscal_year_start_month,
      has_trn: !!v.trn,
      currency: v.base_currency,
      has_tally_company: !!v.tally_company,
    },
  });
  revalidatePath("/accounting/entities");
  return { ok: true, message: "Entity saved." };
}

const branchSchema = z.object({
  branch_code: z.string().trim().min(1).max(20),
  entity_id: uuid,
  emirate: z.enum(EMIRATES),
});

export async function saveBranchMapping(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.settings.manage");
  if (!member) return fail(DENIED);
  const p = branchSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data: branch } = await admin
    .from("fin_ref_branches")
    .select("code")
    .eq("org_id", member.orgId)
    .eq("code", p.data.branch_code)
    .maybeSingle();
  if (!branch) return fail("Unknown branch.");
  const { error } = await admin.from("acc_entity_branches").upsert(
    {
      org_id: member.orgId,
      branch_code: p.data.branch_code,
      entity_id: p.data.entity_id,
      emirate: p.data.emirate,
    },
    { onConflict: "org_id,branch_code" },
  );
  if (error) return fail(rpcErrorMessage(error, "The branch could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.branch.mapped",
    entity: "acc_entity_branches",
    diff: { branch: p.data.branch_code, entity_id: p.data.entity_id, emirate: p.data.emirate },
  });
  revalidatePath("/accounting/entities");
  return { ok: true, message: "Branch saved." };
}

const ledgerStartSchema = z.object({
  entity_id: uuid,
  date: isoDate,
  confirm: z.string().trim().default(""),
});

/**
 * The ledger start (Phase 22D): the first day Pulse is the book of record (OQ-117). Typed confirmation (START); the
 * database checks the permission again and refuses clearing it, moving it earlier or past the first Pulse journal once
 * Pulse has posted. Audited.
 */
export async function setLedgerStart(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.settings.manage");
  if (!member) return fail(DENIED);
  const p = ledgerStartSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  if (p.data.confirm !== "START") return fail("Type START to confirm the ledger start.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_set_ledger_start", {
    p_org_id: member.orgId,
    p_entity_id: p.data.entity_id,
    p_user_id: member.userId,
    p_date: p.data.date,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The ledger start could not be saved."));
  const r = data as { previous: string | null; ledger_start_date: string };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.ledger_start.set",
    entity: "acc_entities",
    entityId: p.data.entity_id,
    diff: { from: r.previous, to: r.ledger_start_date },
  });
  revalidatePath("/accounting/entities");
  revalidatePath("/accounting/posting-rules");
  revalidatePath("/accounting/posting-preview");
  return { ok: true, message: `Ledger start set to ${r.ledger_start_date}.` };
}
