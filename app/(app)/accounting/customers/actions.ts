"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { EMIRATES } from "@/lib/accounting/accounts";
import { rpcErrorMessage } from "@/lib/accounting/errors";
import { CUSTOMER_KINDS } from "@/lib/accounting/sales";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Customers (Phase 22E), accounting.sales.manage. Businesses only (insurers, corporates, tenants, others); never patients.
 * Deactivated, never deleted. The audit row carries the id, kind and flags only: never the name, TRN or e-mail.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const blankToNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .default("")
    .transform((v) => (v === "" ? null : v));

const schema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  kind: z.enum(CUSTOMER_KINDS),
  name: z.string().trim().min(1, "Enter the customer's name.").max(120),
  trn: z
    .string()
    .trim()
    .toUpperCase()
    .default("")
    .refine((v) => v === "" || /^[0-9A-Z-]{5,20}$/.test(v), "A TRN is 5 to 20 digits.")
    .transform((v) => (v === "" ? null : v)),
  emirate: z
    .union([z.enum(EMIRATES), z.literal("")])
    .default("")
    .transform((v) => (v === "" ? null : v)),
  address_line1: blankToNull(120),
  address_line2: blankToNull(120),
  city: blankToNull(60),
  country: z.string().trim().min(2).max(60).default("United Arab Emirates"),
  email: z
    .union([z.string().trim().email("Enter a valid e-mail address.").max(200), z.literal("")])
    .default("")
    .transform((v) => (v === "" ? null : v.toLowerCase())),
  credit_terms_days: z.coerce.number().int().min(0).max(365).default(30),
  connected_person: z.string().optional(),
  payer_id: blankToNull(40),
  receivable_account_id: z
    .union([uuid, z.literal("")])
    .default("")
    .transform((v) => (v === "" ? null : v)),
  active: z.string().optional(),
});

export async function saveCustomer(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.sales.manage");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  if (v.payer_id && v.kind !== "insurer") return fail("Only an insurer is linked to a payer.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    kind: v.kind,
    name: v.name,
    trn: v.trn,
    emirate: v.emirate,
    address_line1: v.address_line1,
    address_line2: v.address_line2,
    city: v.city,
    country: v.country,
    email: v.email,
    credit_terms_days: v.credit_terms_days,
    connected_person: v.connected_person === "on",
    payer_id: v.kind === "insurer" ? v.payer_id : null,
    receivable_account_id: v.receivable_account_id,
    active: v.id ? v.active === "on" : true,
  };
  const { data, error } = v.id
    ? await admin
        .from("acc_customers")
        .update(row)
        .eq("id", v.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("acc_customers")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id")
        .single();
  if (error || !data) return fail(rpcErrorMessage(error, "The customer could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.customer.updated" : "accounting.customer.created",
    entity: "acc_customers",
    entityId: data.id,
    diff: {
      kind: row.kind,
      registered: !!row.trn,
      payer_linked: !!row.payer_id,
      own_receivable_account: !!row.receivable_account_id,
      active: row.active,
    },
  });
  revalidatePath("/accounting/customers");
  return { ok: true, message: "Customer saved." };
}
