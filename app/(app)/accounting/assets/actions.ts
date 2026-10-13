"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { disposalFigures, monthStart } from "@/lib/accounting/assets/depreciation";
import { assetErrorMessage } from "@/lib/accounting/assets/errors";
import {
  defaultEntityId,
  loadAssetClasses,
  loadAssets,
  loadInvoiceOptions,
  loadPostedLines,
} from "@/lib/accounting/assets/server";
import { cleanDescription } from "@/lib/accounting/journal";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  optionalAmount,
  optionalDate,
  optionalInt,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Fixed assets (Phase 22H): the register, asset classes and disposals. accounting.assets.manage to add, edit and prepare
 * a disposal; accounting.journals.approve (a different person, checked in SQL) to post a disposal. The database guards
 * the rules (acc_asset_guard, acc_asset_disposal_*). Every step is audited with ids, codes and amounts only.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

function refresh() {
  revalidatePath("/accounting/assets");
  revalidatePath("/accounting/depreciation");
}

const optionalId = z.union([uuid, z.literal("")]).default("");

const assetSchema = z.object({
  id: optionalId,
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(
      (v) => v === "" || /^[A-Z0-9][A-Z0-9/_-]{0,19}$/.test(v),
      "Codes are up to 20 letters, digits, / - or _.",
    ),
  class_id: uuid,
  description: z.string().trim().min(1, "Describe the asset.").max(400),
  branch_code: z.string().trim().max(20).default(""),
  department: z.string().trim().max(60).default(""),
  supplier_invoice_id: optionalId,
  acquisition_date: optionalDate,
  in_service_date: optionalDate,
  cost: optionalAmount,
  residual: optionalAmount,
  life_months: optionalInt(600),
  method: z.enum(["", "straight_line", "reducing_balance"]).default(""),
  opening_accumulated: optionalAmount,
});

/**
 * Adds or edits an asset. From a bill (supplier invoice): a blank cost takes what is left of its net amount, a blank
 * acquisition date its invoice date, a blank branch its branch. Blank life, method and residual take the class's.
 */
export async function saveAsset(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  const p = assetSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check; history names the person
  const classes = await loadAssetClasses(admin, member.orgId);
  const cls = classes.find((c) => c.id === v.class_id);
  if (!cls) return fail("Choose an asset class.");
  let cost = v.cost;
  let acquisition = v.acquisition_date;
  let branch = v.branch_code.toUpperCase() || null;
  if (v.supplier_invoice_id) {
    const inv = (await loadInvoiceOptions(admin, member.orgId)).find(
      (i) => i.id === v.supplier_invoice_id,
    );
    if (!inv) return fail("That bill was not found.");
    let already = 0; // an edited asset already linked to this bill counts its own cost back
    if (v.id) {
      const current = (await loadAssets(admin, member.orgId)).find((a) => a.id === v.id);
      if (current?.supplierInvoiceId === inv.id) already = current.cost;
    }
    if (cost === null) cost = Math.round((inv.net - inv.capitalised + already) * 100) / 100;
    if (acquisition === null) acquisition = inv.invoiceDate;
    if (branch === null) branch = inv.branchCode;
  }
  if (cost === null || cost <= 0) return fail("Enter the cost.");
  if (acquisition === null) return fail("Enter the acquisition date.");
  const description = cleanDescription(v.description);
  if (!description) return fail("Describe the asset.");
  const row = {
    class_id: cls.id,
    description,
    branch_code: branch,
    department: v.department || null,
    supplier_invoice_id: v.supplier_invoice_id || null,
    acquisition_date: acquisition,
    in_service_date: v.in_service_date ?? acquisition,
    cost,
    residual: v.residual ?? Math.round(cost * cls.residual_pct) / 100,
    life_months: v.life_months ?? cls.life_months,
    method: v.method || cls.method,
    opening_accumulated: v.opening_accumulated ?? 0,
  };
  let id = v.id;
  if (v.id) {
    const { error } = await admin
      .from("acc_assets")
      .update({ ...row, ...(v.code ? { code: v.code } : {}) })
      .eq("id", v.id)
      .eq("org_id", member.orgId);
    if (error) return fail(assetErrorMessage(error, "The asset could not be saved."));
  } else {
    const entityId = await defaultEntityId(admin, member.orgId);
    if (!entityId) return fail("Set up the accounting entity first.");
    const code = v.code || (await nextAssetCode(admin, member.orgId));
    const { data, error } = await admin
      .from("acc_assets")
      .insert({
        ...row,
        code,
        org_id: member.orgId,
        entity_id: entityId,
        created_by: member.userId,
      })
      .select("id")
      .single();
    if (error || !data) return fail(assetErrorMessage(error, "The asset could not be saved."));
    id = data.id;
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.asset.updated" : "accounting.asset.created",
    entity: "acc_assets",
    entityId: id,
    diff: { cost: row.cost, class_id: row.class_id, supplier_invoice_id: row.supplier_invoice_id },
  });
  refresh();
  return { ok: true, message: "Asset saved." };
}

async function nextAssetCode(admin: ReturnType<typeof createAdminClient>, orgId: string) {
  const { data } = await admin
    .from("acc_assets")
    .select("code")
    .eq("org_id", orgId)
    .like("code", "FA-%");
  const max = (data ?? []).reduce((m, r) => {
    const n = Number(/^FA-(\d+)$/.exec(r.code)?.[1] ?? 0);
    return n > m ? n : m;
  }, 0);
  return `FA-${String(max + 1).padStart(5, "0")}`;
}

export async function deleteAsset(input: { id: string }): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(input.id).success) return fail("Asset not found.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("acc_assets")
    .delete()
    .eq("id", input.id)
    .eq("org_id", member.orgId);
  if (error) return fail(assetErrorMessage(error, "The asset could not be deleted."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.asset.deleted",
    entity: "acc_assets",
    entityId: input.id,
  });
  refresh();
  return { ok: true, message: "Asset deleted." };
}

const disposalSchema = z.object({
  id: uuid,
  disposal_date: isoDate,
  proceeds: optionalAmount,
  proceeds_account_id: optionalId,
});

/** Prepares a disposal (it posts nothing). The schedule through the month before disposal comes from depreciation.ts. */
export async function prepareDisposal(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  const p = disposalSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const asset = (await loadAssets(admin, member.orgId)).find((a) => a.id === v.id);
  if (!asset) return fail("Asset not found.");
  if (!monthStart(v.disposal_date)) return fail("Enter a valid date.");
  const posted = (await loadPostedLines(admin, member.orgId, { kinds: ["depreciation"] }))
    .filter((l) => l.ref === asset.id)
    .reduce((s, l) => s + Math.round(l.amount * 100), Math.round(asset.openingAccumulated * 100));
  const f = disposalFigures({
    basis: asset,
    disposalDate: v.disposal_date,
    postedAccumulated: posted / 100,
    proceeds: v.proceeds ?? 0,
  });
  const { error } = await admin.rpc("acc_asset_disposal_prepare", {
    p_org_id: member.orgId,
    p_asset_id: asset.id,
    p_user_id: member.userId,
    p_data: {
      disposal_date: v.disposal_date,
      proceeds: v.proceeds ?? 0,
      proceeds_account_id: v.proceeds_account_id || null,
      accumulated: f.accumulated,
    },
  });
  if (error) return fail(assetErrorMessage(error, "The disposal could not be prepared."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.asset.disposal_prepared",
    entity: "acc_assets",
    entityId: asset.id,
    diff: { disposal_date: v.disposal_date, proceeds: v.proceeds ?? 0, gain_loss: f.gainLoss },
  });
  refresh();
  return {
    ok: true,
    message: `Disposal prepared (${f.gainLoss >= 0 ? "gain" : "loss"} ${Math.abs(f.gainLoss).toFixed(2)}). Someone else with journal approval posts it.`,
  };
}

export async function postDisposal(input: { id: string; hash: string }): Promise<ActionResult> {
  const member = await gate("accounting.journals.approve");
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(input.id).success || !/^[0-9a-f]{64}$/.test(input.hash))
    return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_asset_disposal_post", {
    p_org_id: member.orgId,
    p_asset_id: input.id,
    p_user_id: member.userId,
    p_hash: input.hash,
  });
  if (error) return fail(assetErrorMessage(error, "The disposal could not be posted."));
  const r = data as { status?: string; journal_id?: string | null; number?: string | null } | null;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.asset.disposal_posted",
    entity: "acc_assets",
    entityId: input.id,
    diff: {
      status: r?.status ?? null,
      journal_id: r?.journal_id ?? null,
      number: r?.number ?? null,
    },
  });
  refresh();
  return r?.status === "waiting_ledger_start"
    ? {
        ok: true,
        message:
          "The date is before the ledger start date; the disposal waits and can be posted later.",
      }
    : { ok: true, message: `Disposal posted${r?.number ? ` as ${r.number}` : ""}.` };
}

export async function cancelDisposal(input: { id: string }): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(input.id).success) return fail("Asset not found.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("acc_asset_disposal_cancel", {
    p_org_id: member.orgId,
    p_asset_id: input.id,
    p_user_id: member.userId,
  });
  if (error) return fail(assetErrorMessage(error, "The disposal could not be withdrawn."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.asset.disposal_withdrawn",
    entity: "acc_assets",
    entityId: input.id,
  });
  refresh();
  return { ok: true, message: "Disposal withdrawn." };
}

const classSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1, "Enter a name.").max(80),
  life_months: optionalInt(600),
  method: z.enum(["straight_line", "reducing_balance"]),
  residual_pct: optionalAmount,
  cost_account_id: uuid,
  accum_account_id: uuid,
  expense_account_id: uuid,
  disposal_account_id: uuid,
  active: z.string().optional(),
});

/** Edits a class: defaults for new assets (life, method, residual %) and the ledgers its assets post to. */
export async function saveAssetClass(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  const p = classSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  if (!v.life_months || v.life_months < 1) return fail("The useful life is 1 to 600 months.");
  if ((v.residual_pct ?? 0) >= 100) return fail("The residual is below 100%.");
  const admin = createAdminClient(member.userId);
  const row = {
    name: v.name,
    life_months: v.life_months,
    method: v.method,
    residual_pct: v.residual_pct ?? 0,
    cost_account_id: v.cost_account_id,
    accum_account_id: v.accum_account_id,
    expense_account_id: v.expense_account_id,
    disposal_account_id: v.disposal_account_id,
    active: v.active === "on",
  };
  const { error } = await admin
    .from("acc_asset_classes")
    .update(row)
    .eq("id", v.id)
    .eq("org_id", member.orgId);
  if (error) return fail(assetErrorMessage(error, "The class could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.asset_class.updated",
    entity: "acc_asset_classes",
    entityId: v.id,
    diff: { life_months: row.life_months, method: row.method, residual_pct: row.residual_pct },
  });
  refresh();
  return { ok: true, message: "Class saved." };
}
