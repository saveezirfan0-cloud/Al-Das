"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { fiscalMonths, parseBudgetCsv } from "@/lib/accounting/statements/budget";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Budgets (Phase 22G). accounting.budgets.manage prepares (create, edit the grid, import a CSV, reopen, delete a draft);
 * a DIFFERENT person holding accounting.journals.approve approves, quoting the sha256 of the content they reviewed
 * (acc_budget_act checks both). An approved budget cannot change until it is reopened, which makes the reopener its
 * preparer. Every step is audited (ids and counts only).
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const headerSchema = z.object({
  id: z.union([uuid, z.literal("")]).default(""),
  entity_id: z.union([uuid, z.literal("")]).default(""),
  fy_start: z.string().regex(/^\d{4}-\d{2}-01$/, "Choose the fiscal year."),
  name: z.string().trim().min(1, "Name the budget.").max(80),
});

const lineSchema = z.object({
  account_id: uuid,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  branch_code: z.string().trim().max(20).nullable().optional(),
  department: z.string().trim().max(60).nullable().optional(),
  amount: z.number().min(0).max(1e11),
});

type LineInput = z.infer<typeof lineSchema>;

async function save(
  member: Awaited<ReturnType<typeof gate>> & object,
  header: z.infer<typeof headerSchema>,
  lines: Array<Record<string, unknown>>,
  action: string,
): Promise<ActionResult<{ id: string }>> {
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_budget_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_budget_id: (header.id || null) as string,
    p_header: { entity_id: header.entity_id || null, fy_start: header.fy_start, name: header.name },
    p_lines: lines as never,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The budget could not be saved."));
  const id = (data as { id: string }).id;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action,
    entity: "acc_budgets",
    entityId: id,
    diff: { lines: lines.length, fy_start: header.fy_start },
  });
  revalidatePath("/accounting/budgets");
  return { ok: true, data: { id }, message: "Budget saved." };
}

/** Create a budget (no lines yet) or rename it, keeping its lines. */
export async function saveBudgetHeader(
  values: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.budgets.manage");
  if (!member) return fail(DENIED);
  const p = headerSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  let lines: Array<Record<string, unknown>> = [];
  if (p.data.id) {
    const admin = createAdminClient(member.userId);
    // Every line is read (in pages: PostgREST returns at most 1,000 per request) because save() replaces them all;
    // a failed or partial read stops here rather than drop lines.
    const { data, error, truncated } = await fetchAll((from, to) =>
      admin
        .from("acc_budget_lines")
        .select("account_id, month, branch_code, department, amount")
        .eq("org_id", member.orgId)
        .eq("budget_id", p.data.id as string)
        .order("id")
        .range(from, to),
    );
    if (error || truncated)
      return fail("Could not read the budget lines. Nothing was changed; try again.");
    lines = data.map((l) => ({
      ...l,
      month: l.month.slice(0, 7),
      amount: Number(l.amount),
    }));
  }
  return save(
    member,
    p.data,
    lines,
    p.data.id ? "accounting.budget.updated" : "accounting.budget.created",
  );
}

/**
 * The grid: replaces the whole-entity lines (no branch, no department) with the cells sent; lines that carry a branch
 * or department (from a CSV) are kept as they are.
 */
export async function saveBudgetGrid(input: {
  id: string;
  cells: Array<{ account_id: string; month: string; amount: number }>;
}): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.budgets.manage");
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(input.id);
  const cells = z.array(lineSchema).max(20000).safeParse(input.cells);
  if (!id.success || !cells.success)
    return fail("Check the amounts: zero or more, at most two decimals.");
  if (cells.data.some((c) => Math.round(c.amount * 100) !== c.amount * 100))
    return fail("Amounts have at most two decimals.");
  const admin = createAdminClient(member.userId);
  const { data: b } = await admin
    .from("acc_budgets")
    .select("id, entity_id, fy_start, name")
    .eq("org_id", member.orgId)
    .eq("id", id.data)
    .maybeSingle();
  if (!b) return fail("Budget not found.");
  // Every kept line is read (in pages) because save() replaces them all; a failed or partial read stops here.
  const {
    data: kept,
    error: keptErr,
    truncated,
  } = await fetchAll((from, to) =>
    admin
      .from("acc_budget_lines")
      .select("account_id, month, branch_code, department, amount")
      .eq("budget_id", b.id)
      .or("branch_code.not.is.null,department.not.is.null")
      .order("id")
      .range(from, to),
  );
  if (keptErr || truncated)
    return fail("Could not read the budget lines. Nothing was changed; try again.");
  const lines: Array<Record<string, unknown>> = [
    ...kept.map((l) => ({ ...l, month: l.month.slice(0, 7), amount: Number(l.amount) })),
    ...cells.data
      .filter((c: LineInput) => c.amount > 0)
      .map((c) => ({ account_id: c.account_id, month: c.month, amount: c.amount })),
  ];
  return save(
    member,
    { id: b.id, entity_id: b.entity_id, fy_start: b.fy_start, name: b.name },
    lines,
    "accounting.budget.updated",
  );
}

/** A CSV replaces every line of a draft budget (account_code, month, amount, optional branch_code and department). */
export async function importBudgetCsv(input: {
  id: string;
  csv: string;
}): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.budgets.manage");
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(input.id);
  if (!id.success || typeof input.csv !== "string" || input.csv.length > 2_000_000)
    return fail("Choose a CSV file (at most 2 MB).");
  const admin = createAdminClient(member.userId);
  const { data: b } = await admin
    .from("acc_budgets")
    .select("id, entity_id, fy_start, name")
    .eq("org_id", member.orgId)
    .eq("id", id.data)
    .maybeSingle();
  if (!b) return fail("Budget not found.");
  const parsed = parseBudgetCsv(input.csv, fiscalMonths(b.fy_start));
  if (parsed.errors.length) return fail(parsed.errors.slice(0, 5).join(" "));
  // Every active income/expense ledger (in pages), so a valid code is never reported as unknown.
  const { data: ledgers } = await fetchAll((from, to) =>
    admin
      .from("acc_accounts")
      .select("code")
      .eq("org_id", member.orgId)
      .eq("is_group", false)
      .eq("is_active", true)
      .in("nature", ["income", "expense"])
      .order("id")
      .range(from, to),
  );
  const known = new Set((ledgers ?? []).map((a) => a.code));
  const unknown = [
    ...new Set(parsed.lines.map((l) => l.account_code).filter((c) => !known.has(c))),
  ];
  if (unknown.length)
    return fail(
      `Not an active income or expense ledger: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? " ..." : ""}.`,
    );
  return save(
    member,
    { id: b.id, entity_id: b.entity_id, fy_start: b.fy_start, name: b.name },
    parsed.lines,
    "accounting.budget.imported",
  );
}

const actSchema = z.object({
  id: uuid,
  action: z.enum(["approve", "reopen", "delete"]),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
});

export async function actOnBudget(raw: z.input<typeof actSchema>): Promise<ActionResult> {
  const p = actSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const member = await gate(
    p.data.action === "approve" ? "accounting.journals.approve" : "accounting.budgets.manage",
  );
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("acc_budget_act", {
    p_org_id: member.orgId,
    p_budget_id: p.data.id,
    p_user_id: member.userId,
    p_action: p.data.action,
    p_hash: (p.data.hash ?? null) as string,
  });
  if (error) return fail(rpcErrorMessage(error, "The budget could not be changed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `accounting.budget.${p.data.action === "approve" ? "approved" : p.data.action === "reopen" ? "reopened" : "deleted"}`,
    entity: "acc_budgets",
    entityId: p.data.id,
    diff: p.data.hash ? { sha256: p.data.hash } : null,
  });
  revalidatePath("/accounting/budgets");
  return {
    ok: true,
    message:
      p.data.action === "approve"
        ? "Budget approved."
        : p.data.action === "reopen"
          ? "Budget reopened as a draft."
          : "Budget deleted.",
  };
}
