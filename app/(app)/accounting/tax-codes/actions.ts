"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { TAX_KINDS } from "@/lib/accounting/tax";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/** Tax codes (Phase 22A), accounting.coa.manage. The database checks the rate against the kind and the accounts. Audited. */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const schema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9_-]{1,12}$/.test(v), "Codes are up to 12 letters or digits."),
  name: z.string().trim().min(1, "Enter a name.").max(80),
  rate: z.coerce.number().min(0).max(100),
  kind: z.enum(TAX_KINDS),
  output_account_id: z.union([uuid, z.literal("")]).default(""),
  input_account_id: z.union([uuid, z.literal("")]).default(""),
  active: z.string().optional(),
});

export async function saveTaxCode(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.coa.manage");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const zeroKind = v.kind === "zero" || v.kind === "exempt" || v.kind === "out_of_scope";
  if (zeroKind ? v.rate !== 0 : v.rate <= 0)
    return fail(zeroKind ? "This kind has a rate of 0." : "This kind needs a rate above 0.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    code: v.code,
    name: v.name,
    rate: Math.round(v.rate * 100) / 100,
    kind: v.kind,
    output_account_id: v.output_account_id || null,
    input_account_id: v.input_account_id || null,
    active: v.id ? v.active === "on" : true,
  };
  const { data, error } = v.id
    ? await admin
        .from("acc_tax_codes")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("acc_tax_codes")
        .insert({ ...row, org_id: member.orgId })
        .select("id")
        .single();
  if (error || !data) return fail(rpcErrorMessage(error, "The tax code could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.tax_code.updated" : "accounting.tax_code.created",
    entity: "acc_tax_codes",
    entityId: data.id,
    diff: { code: row.code, rate: row.rate, kind: row.kind, active: row.active },
  });
  revalidatePath("/accounting/tax-codes");
  return { ok: true, message: "Tax code saved." };
}
