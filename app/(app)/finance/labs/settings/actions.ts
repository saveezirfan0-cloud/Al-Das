"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { DATE_FORMATS, isLabImportKind, validateMapping } from "@/lib/finance/import-kinds";
import { isProviderKind, parseTestList } from "@/lib/finance/labs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Providers, their tests (expected turnaround and agreed price), the lab file layouts and the matching settings.
 * Everything here needs finance.labs.manage; writes use the service role after the check and are audited.
 */

const PERM = "finance.labs.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const refresh = () => {
  revalidatePath("/finance/labs");
  revalidatePath("/finance/labs/settings");
};

const optionalId = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || uuid.safeParse(v).success, "Invalid record.");

const providerSchema = z.object({
  id: optionalId,
  name: z.string().trim().min(1, "Give the provider a name.").max(80),
  kind: z.string().refine(isProviderKind, "Choose the kind of provider."),
  fixed_monthly_fee: z
    .string()
    .trim()
    .optional()
    .default("")
    .transform((v) => (v === "" ? null : Number(v.replace(/,/g, ""))))
    .refine(
      (v) => v === null || (Number.isFinite(v) && v > 0 && v <= 1e8),
      "The monthly fee must be an amount above 0.",
    ),
  allocation_basis: z.enum(["test_count", "revenue"]).default("test_count"),
  active: z.string().optional(),
});

/** A provider. Its kind is fixed once saved (it decides the file kind and where its cost is charged). */
export async function saveProvider(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = providerSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  let kind: string = v.kind;
  if (v.id) {
    const { data: existing } = await admin
      .from("fin_providers")
      .select("kind")
      .eq("org_id", member.orgId)
      .eq("id", v.id)
      .maybeSingle();
    if (!existing) return fail("Provider not found.");
    kind = existing.kind;
  }
  const inHouse = kind === "in_house_lab";
  const row = {
    name: v.name,
    fixed_monthly_fee: inHouse ? v.fixed_monthly_fee : null,
    allocation_basis: inHouse ? v.allocation_basis : "test_count",
    active: v.active === "on",
  };
  const { data, error } = v.id
    ? await admin
        .from("fin_providers")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", v.id)
        .select("id")
    : await admin
        .from("fin_providers")
        .insert({ ...row, kind, org_id: member.orgId, created_by: member.userId })
        .select("id");
  if (error || !data?.length)
    return fail(
      error?.code === "23505"
        ? "A provider with that name exists."
        : dbMessage(error, "Could not save the provider."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.labs.provider_updated" : "finance.labs.provider_added",
    entity: "fin_providers",
    entityId: data[0].id,
    diff: {
      kind,
      fee_set: row.fixed_monthly_fee !== null,
      basis: row.allocation_basis,
      active: row.active,
    },
  });
  refresh();
  return { ok: true, message: "Provider saved." };
}

const testsSchema = z.object({ provider_id: uuid, list: z.string().max(100_000) });

/** Adds or updates a provider's tests from "code, expected days, agreed price" lines. Other tests are kept. */
export async function saveProviderTests(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = testsSchema.safeParse(values);
  if (!p.success) return fail("Choose a provider and enter the tests.");
  const parsed = parseTestList(p.data.list);
  if (!parsed.ok) return fail(parsed.error);
  const admin = createAdminClient(member.userId);
  const { data: provider } = await admin
    .from("fin_providers")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("id", p.data.provider_id)
    .maybeSingle();
  if (!provider) return fail("Provider not found.");
  const { error } = await admin.from("fin_ref_provider_tests").upsert(
    parsed.rows.map((t) => ({
      org_id: member.orgId,
      provider_id: provider.id,
      code: t.code,
      expected_days: t.expectedDays,
      agreed_price: t.agreedPrice,
    })),
    { onConflict: "provider_id,code" },
  );
  if (error) return fail(dbMessage(error, "Could not save the tests."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.tests_saved",
    entity: "fin_providers",
    entityId: provider.id,
    diff: { tests: parsed.rows.length },
  });
  refresh();
  return { ok: true, message: `${parsed.rows.length} test(s) saved.` };
}

export async function deleteProviderTest(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(values.id);
  if (!id.success) return fail("Choose a test.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_ref_provider_tests")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id.data)
    .select("provider_id, code");
  if (error || !data?.length) return fail(dbMessage(error, "Could not delete the test."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.test_deleted",
    entity: "fin_providers",
    entityId: data[0].provider_id,
    diff: { code: data[0].code },
  });
  refresh();
  return { ok: true, message: "Test removed." };
}

const formatSchema = z.object({
  id: optionalId,
  kind: z.string().refine(isLabImportKind, "Choose the kind of file."),
  name: z.string().trim().min(1, "Give the layout a name.").max(60),
  date_format: z.enum(DATE_FORMATS, { message: "Choose the date format." }),
  active: z.string().optional(),
});

/** Saves a lab or provider file layout. Field names are `col_<field>` (the header text in the file for that field). */
export async function saveLabFormat(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = formatSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const kind = v.kind as "lab_activity" | "provider_invoice";
  const raw = Object.fromEntries(
    Object.entries(values)
      .filter(([k]) => k.startsWith("col_"))
      .map(([k, val]) => [k.slice(4), val]),
  );
  const mapping = validateMapping(kind, "signed", raw);
  if (!mapping.ok) return fail(mapping.error);
  const admin = createAdminClient(member.userId);
  const row = {
    kind,
    name: v.name,
    mapping: mapping.mapping,
    date_format: v.date_format,
    amount_style: "signed",
    active: v.active === "on",
  };
  // a lab manager edits lab layouts only (bank layouts belong to finance.bank.manage)
  const { data, error } = v.id
    ? await admin
        .from("fin_import_formats")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", v.id)
        .in("kind", ["lab_activity", "provider_invoice"])
        .select("id")
    : await admin
        .from("fin_import_formats")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id");
  if (error || !data?.length)
    return fail(
      error?.code === "23505"
        ? "A layout with that name exists."
        : dbMessage(error, "Could not save the layout."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "finance.labs.format_updated" : "finance.labs.format_added",
    entity: "fin_import_formats",
    entityId: data[0].id,
    diff: { kind, fields: Object.keys(mapping.mapping), date_format: v.date_format },
  });
  refresh();
  return { ok: true, message: "Layout saved." };
}

const settingsSchema = z.object({
  lab_date_window_days: z.coerce
    .number()
    .int()
    .min(0, "Window: 0 to 10 days.")
    .max(10, "Window: 0 to 10 days."),
  lab_price_tolerance: z.coerce
    .number()
    .min(0, "Price tolerance: 0 to 10,000.")
    .max(10000, "Price tolerance: 0 to 10,000."),
});

export async function saveLabSettings(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = settingsSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...p.data }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: { ...p.data },
  });
  refresh();
  return { ok: true, message: "Settings saved." };
}
