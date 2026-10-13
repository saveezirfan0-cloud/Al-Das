"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  bankingErrorMessage,
  CHEQUE_ACTIONS,
  ENTRY_KINDS,
  PARTY_KINDS,
  postingMessage,
  TRANSFER_KINDS,
} from "@/lib/accounting/banking";
import { orgToday } from "@/lib/accounting/banking-server";
import { cleanNarration, parseAmount, roundMoney } from "@/lib/accounting/journal";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  abandonFinanceDocument,
  finalizeFinanceDocument,
  prepareFinanceDocument,
  signedFinanceDocumentUrl,
  type FinalizedDocument,
} from "@/lib/finance/finance-documents";
import { redactStatementText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Banking and cash (Phase 22F). Every action needs accounting.banking.manage (checked here, and again for the named
 * person inside each database function); writes use the service role after the check, name the person for the record
 * history and are audited (ids, kinds and amounts only). The database posts every item through acc_post_from_source; an
 * item dated before the ledger starts waits (waiting_ledger_start) instead of failing. Petty cash counts are signed by a
 * different person from the one who counted, bound to the fingerprint they were shown.
 */

const PERM = "accounting.banking.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

function refresh() {
  for (const p of ["", "/transfers", "/entries", "/petty-cash", "/cheques"])
    revalidatePath(`/accounting/banking${p}`);
  revalidatePath("/accounting/dashboard");
}

const optionalId = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || uuid.safeParse(v).success, "Reload the page and try again.");

const amount = z
  .string()
  .trim()
  .transform((v) => parseAmount(v))
  .refine((v) => Number.isFinite(v) && v > 0 && v < 1e12, "Enter an amount above zero.")
  .refine((v) => roundMoney(v) === v, "Amounts have at most two decimals.");

const narration = z
  .string()
  .max(1000)
  .transform((v) => cleanNarration(v))
  .refine((v): v is string => !!v, "Write a narration.");

const reference = z
  .string()
  .optional()
  .transform((v) => redactStatementText(v ?? "", 60));

const branch = z
  .string()
  .optional()
  .transform((v) => (v ?? "").trim().toUpperCase())
  .refine((v) => v === "" || /^[A-Z0-9]{1,4}$/.test(v), "Choose a branch.");

const code = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(v), "Codes are up to 20 letters or digits.");

type Admin = ReturnType<typeof createAdminClient>;

async function audit(
  admin: Admin,
  member: { orgId: string; userId: string },
  action: string,
  entity: string,
  entityId: string | null,
  diff: Record<string, string | number | boolean | null> | null = null,
) {
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `accounting.banking.${action}`,
    entity,
    entityId,
    diff,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Bank accounts: ledger link, a new ledger, the statement balance
// ---------------------------------------------------------------------------------------------------------------------

const linkSchema = z.object({ bank_account_id: uuid, account_id: optionalId });

export async function linkBankLedger(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = linkSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { error } = await admin.rpc("acc_bank_link_gl", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_bank_account_id: p.data.bank_account_id,
    p_account_id: p.data.account_id as string,
  });
  if (error) return fail(bankingErrorMessage(error, "The ledger could not be linked."));
  await audit(admin, member, "ledger_linked", "fin_bank_accounts", p.data.bank_account_id, {
    gl_account_id: p.data.account_id,
  });
  refresh();
  return { ok: true, message: p.data.account_id ? "Ledger linked." : "Link removed." };
}

const createLedgerSchema = z.object({
  bank_account_id: uuid,
  group: z.enum(["bank", "od"]),
  code,
  name: z.string().trim().min(1, "Name the ledger.").max(120),
});

export async function createBankLedger(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = createLedgerSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_bank_create_ledger", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_bank_account_id: p.data.bank_account_id,
    p_group: p.data.group,
    p_code: p.data.code,
    p_name: p.data.name,
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The ledger could not be created."));
  await audit(admin, member, "ledger_created", "fin_bank_accounts", p.data.bank_account_id, {
    group: p.data.group,
    code: p.data.code,
    gl_account_id: (data as { gl_account_id: string }).gl_account_id,
  });
  refresh();
  revalidatePath("/accounting/accounts");
  return { ok: true, message: "Ledger created and linked." };
}

const balanceSchema = z.object({
  bank_account_id: uuid,
  as_of: isoDate,
  balance: z
    .string()
    .trim()
    .transform((v) => Number(v.replace(/,/g, "")))
    .refine(
      (v) => Number.isFinite(v) && Math.abs(v) < 1e13 && roundMoney(v) === v,
      "Enter the balance with at most two decimals (minus when overdrawn).",
    ),
});

export async function saveStatementBalance(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = balanceSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_bank_statement_balance_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_bank_account_id: p.data.bank_account_id,
    p_as_of: p.data.as_of,
    p_balance: p.data.balance,
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The balance could not be saved."));
  await audit(
    admin,
    member,
    "statement_balance_saved",
    "acc_bank_statement_balances",
    (data as { id: string }).id,
    { as_of: p.data.as_of },
  );
  refresh();
  return { ok: true, message: "Statement balance saved." };
}

// ---------------------------------------------------------------------------------------------------------------------
// Transfers and bank entries
// ---------------------------------------------------------------------------------------------------------------------

const transferSchema = z.object({
  kind: z.enum(TRANSFER_KINDS),
  transfer_date: isoDate,
  from_account_id: uuid,
  to_account_id: optionalId,
  float_id: optionalId,
  amount,
  reference,
  narration,
  branch_code: branch,
});

export async function createTransfer(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = transferSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  if (v.kind === "petty_cash_topup" ? !v.float_id : !v.to_account_id)
    return fail(
      v.kind === "petty_cash_topup" ? "Choose the float." : "Choose the account it goes to.",
    );
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_bank_transfer_create", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: {
      kind: v.kind,
      transfer_date: v.transfer_date,
      from_account_id: v.from_account_id,
      to_account_id: v.kind === "petty_cash_topup" ? null : v.to_account_id,
      float_id: v.kind === "petty_cash_topup" ? v.float_id : null,
      amount: v.amount,
      reference: v.reference,
      narration: v.narration,
      branch_code: v.branch_code,
    },
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The transfer could not be saved."));
  const r = data as { id: string; status: string };
  await audit(admin, member, "transfer_created", "acc_bank_transfers", r.id, {
    kind: v.kind,
    amount: v.amount,
    status: r.status,
  });
  refresh();
  return { ok: true, message: postingMessage(r.status, "Transfer saved.") };
}

const entrySchema = z.object({
  bank_account_id: uuid,
  entry_date: isoDate,
  kind: z.enum(ENTRY_KINDS),
  amount,
  account_id: uuid,
  tax_code_id: optionalId,
  reference,
  narration,
  branch_code: branch,
  bank_line_id: optionalId,
});

export async function createBankEntry(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = entrySchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_bank_entry_create", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: { ...v },
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The entry could not be saved."));
  const r = data as { id: string; status: string };
  await audit(admin, member, "entry_created", "acc_bank_entries", r.id, {
    kind: v.kind,
    amount: v.amount,
    from_statement_line: !!v.bank_line_id,
    status: r.status,
  });
  refresh();
  revalidatePath("/finance/bank");
  return { ok: true, message: postingMessage(r.status, "Bank entry saved.") };
}

const cancelSchema = z.object({
  kind: z.enum(["transfer", "entry", "expense"]),
  id: uuid,
  date: isoDate,
  reason: z
    .string()
    .max(1000)
    .transform((v) => redactStatementText(v, 300) ?? "")
    .refine((v) => v.length >= 3, "Say why (at least 3 characters)."),
});

const CANCEL_ENTITY = {
  transfer: "acc_bank_transfers",
  entry: "acc_bank_entries",
  expense: "acc_petty_cash_expenses",
} as const;

/** Cancels a transfer, bank entry or petty cash expense; a posted one is reversed on the date given. */
export async function cancelBankingItem(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = cancelSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_banking_cancel", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_kind: v.kind,
    p_id: v.id,
    p_date: v.date,
    p_reason: v.reason,
  });
  if (error || !data) return fail(bankingErrorMessage(error, "It could not be cancelled."));
  await audit(admin, member, `${v.kind}_cancelled`, CANCEL_ENTITY[v.kind], v.id, {
    reversed: (data as { reversed: boolean }).reversed,
  });
  refresh();
  return {
    ok: true,
    message: (data as { reversed: boolean }).reversed ? "Cancelled and reversed." : "Cancelled.",
  };
}

/** Posts what is due now: post-dated cheques that reached their date and items waiting for the ledger start. */
export async function runBankingSweep(): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const today = await orgToday(admin, member.orgId);
  const { data, error } = await admin.rpc("acc_banking_sweep", {
    p_org_id: member.orgId,
    p_today: today,
  });
  if (error || !data) return fail(bankingErrorMessage(error, "Nothing could be posted."));
  const r = data as { posted: number; waiting: number; stale: number; failed: unknown[] };
  await audit(admin, member, "sweep_run", "acc_cheques", null, {
    posted: r.posted,
    waiting: r.waiting,
    stale: r.stale,
    failed: r.failed.length,
  });
  refresh();
  return {
    ok: true,
    message: `Posted ${r.posted}; still waiting ${r.waiting}; stale ${r.stale}${r.failed.length ? `; ${r.failed.length} refused (check the period)` : ""}.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Petty cash
// ---------------------------------------------------------------------------------------------------------------------

const floatSchema = z.object({
  id: optionalId,
  name: z.string().trim().min(1, "Name the float.").max(80),
  branch_code: branch,
  imprest_amount: z
    .string()
    .trim()
    .transform((v) => parseAmount(v))
    .refine((v) => Number.isFinite(v) && v >= 0 && roundMoney(v) === v, "Enter the float amount."),
  custodian_id: optionalId,
  code: z.string().optional().default(""),
  active: z.string().optional(),
});

export async function savePettyCashFloat(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = floatSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  if (!v.id && !code.safeParse(v.code).success)
    return fail("Give the float's ledger a code (up to 20 letters or digits).");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_petty_cash_float_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: {
      id: v.id,
      name: v.name,
      branch_code: v.branch_code,
      imprest_amount: v.imprest_amount,
      custodian_id: v.custodian_id,
      code: v.code.trim().toUpperCase(),
      active: v.id ? v.active === "on" : true,
    },
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The float could not be saved."));
  await audit(
    admin,
    member,
    v.id ? "float_updated" : "float_created",
    "acc_petty_cash_floats",
    (data as { id: string }).id,
    { imprest_amount: v.imprest_amount },
  );
  refresh();
  return { ok: true, message: "Float saved." };
}

const expenseSchema = z.object({
  float_id: uuid,
  expense_date: isoDate,
  amount,
  account_id: uuid,
  tax_code_id: optionalId,
  reference,
  narration,
  branch_code: branch,
  document_id: optionalId,
});

export async function createPettyCashExpense(
  values: Record<string, string>,
): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = expenseSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_petty_cash_expense_create", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: { ...v },
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The expense could not be saved."));
  const r = data as { id: string; status: string };
  await audit(admin, member, "expense_created", "acc_petty_cash_expenses", r.id, {
    amount: v.amount,
    receipt: !!v.document_id,
    status: r.status,
  });
  refresh();
  return { ok: true, message: postingMessage(r.status, "Expense saved.") };
}

const countSchema = z.object({
  float_id: uuid,
  count_date: isoDate,
  counted: z
    .string()
    .trim()
    .transform((v) => parseAmount(v))
    .refine((v) => Number.isFinite(v) && v >= 0 && roundMoney(v) === v, "Enter the cash counted."),
  explanation: z
    .string()
    .optional()
    .transform((v) => redactStatementText(v ?? "", 500) ?? ""),
});

export async function preparePettyCashCount(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = countSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_petty_cash_count_prepare", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_float_id: v.float_id,
    p_count_date: v.count_date,
    p_counted: v.counted,
    p_explanation: v.explanation,
  });
  if (error || !data) return fail(bankingErrorMessage(error, "The count could not be saved."));
  const r = data as { id: string; difference: number };
  await audit(admin, member, "count_prepared", "acc_petty_cash_counts", r.id, {
    counted: v.counted,
    difference: Number(r.difference),
  });
  refresh();
  return { ok: true, message: "Count saved. Someone else signs it." };
}

const signSchema = z.object({ id: uuid, sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export async function signPettyCashCount(raw: z.input<typeof signSchema>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = signSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("acc_petty_cash_count_sign", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_count_id: p.data.id,
    p_sha256: p.data.sha256,
  });
  if (error) return fail(bankingErrorMessage(error, "The count could not be signed."));
  await audit(admin, member, "count_signed", "acc_petty_cash_counts", p.data.id, null);
  refresh();
  return { ok: true, message: "Count signed." };
}

// Receipts: the 20D finance-documents flow (prepare, browser upload to a signed URL, finalise), kind voucher_backup.

const prepareSchema = z.object({
  mime: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

export async function prepareReceiptUpload(
  raw: z.input<typeof prepareSchema>,
): Promise<ActionResult<{ documentId: string; path: string; token: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = prepareSchema.safeParse(raw);
  if (!p.success) return fail("Choose a file.");
  const admin = createAdminClient(member.userId);
  const res = await prepareFinanceDocument(admin, member, { ...p.data, kind: "voucher_backup" });
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}

export async function finalizeReceiptUpload(raw: {
  id: string;
}): Promise<ActionResult<FinalizedDocument>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const res = await finalizeFinanceDocument(admin, member, raw.id);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: res.ok
      ? res.data.duplicateOf
        ? "finance.document.duplicate"
        : "finance.document.uploaded"
      : "finance.document.upload_rejected",
    entity: "fin_documents",
    entityId: res.ok ? res.data.id : raw.id,
    diff: res.ok ? { kind: res.data.kind, size: res.data.size, scan: res.data.scan } : null,
  });
  if (!res.ok) return fail(res.error);
  return { ok: true, data: res.data, message: res.message };
}

export async function abandonReceiptUpload(raw: { id: string }): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return { ok: true };
  const admin = createAdminClient(member.userId);
  if (await abandonFinanceDocument(admin, member, raw.id))
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.document.upload_cancelled",
      entity: "fin_documents",
      entityId: raw.id,
    });
  return { ok: true };
}

/** Opens the receipt of a petty cash expense (only a document attached to an expense of this org; the open is logged). */
export async function openReceipt(raw: { id: string }): Promise<ActionResult<{ url: string }>> {
  const member = await requireMember();
  if (!can(member, PERM) && !can(member, "accounting.ledger.view")) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data: linked } = await admin
    .from("acc_petty_cash_expenses")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("document_id", raw.id)
    .limit(1);
  if (!linked?.length) return fail("Document not found.");
  const res = await signedFinanceDocumentUrl(admin, member, raw.id, "view");
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cheques
// ---------------------------------------------------------------------------------------------------------------------

const bookSchema = z.object({
  bank_account_id: uuid,
  first_number: z
    .string()
    .trim()
    .regex(/^\d{1,12}$/, "Enter the first cheque number."),
  last_number: z
    .string()
    .trim()
    .regex(/^\d{1,12}$/, "Enter the last cheque number."),
});

export async function saveChequeBook(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = bookSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_cheque_book_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: {
      bank_account_id: v.bank_account_id,
      first_number: v.first_number,
      last_number: v.last_number,
      width: Math.max(v.first_number.length, v.last_number.length),
    },
  });
  if (error || !data)
    return fail(bankingErrorMessage(error, "The cheque book could not be saved."));
  await audit(admin, member, "cheque_book_added", "acc_cheque_books", (data as { id: string }).id, {
    first: v.first_number,
    last: v.last_number,
  });
  refresh();
  return { ok: true, message: "Cheque book added." };
}

export async function closeChequeBook(raw: { id: string }): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("acc_cheque_book_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p: { id: raw.id, active: false },
  });
  if (error) return fail(bankingErrorMessage(error, "The cheque book could not be closed."));
  await audit(admin, member, "cheque_book_closed", "acc_cheque_books", raw.id, null);
  refresh();
  return { ok: true, message: "Cheque book closed." };
}

const chequeSchema = z.object({
  direction: z.enum(["issued", "received"]),
  bank_account_id: uuid,
  cheque_book_id: optionalId,
  cheque_no: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine((v) => v === "" || /^\d{1,12}$/.test(v), "Cheque numbers are digits only."),
  cheque_date: isoDate,
  recorded_on: isoDate,
  amount,
  party_kind: z.enum(PARTY_KINDS),
  party_ref: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine((v) => v.length <= 64, "The reference is too long."),
  party_name: z
    .string()
    .optional()
    .transform((v) => redactStatementText(v ?? "", 120) ?? ""),
  counter_account_id: uuid,
  voucher_id: optionalId,
  narration: z
    .string()
    .optional()
    .transform((v) => cleanNarration(v ?? "") ?? ""),
});

export async function registerCheque(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = chequeSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  // a patient is recorded by the Unite PIN only: never keep a name typed for one
  const partyName = v.party_kind === "patient" ? "" : v.party_name;
  const admin = createAdminClient(member.userId);
  const today = await orgToday(admin, member.orgId);
  const { data, error } = await admin.rpc("acc_cheque_register", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_today: today,
    p: {
      ...v,
      cheque_book_id: v.direction === "issued" ? v.cheque_book_id : null,
      party_name: partyName,
    },
  });
  if (error || !data)
    return fail(bankingErrorMessage(error, "The cheque could not be registered."));
  const r = data as { id: string; cheque_no: string; posting: string; party_flagged: boolean };
  await audit(admin, member, "cheque_registered", "acc_cheques", r.id, {
    direction: v.direction,
    amount: v.amount,
    post_dated: v.cheque_date > v.recorded_on,
    posting: r.posting,
    voucher: !!v.voucher_id,
  });
  refresh();
  const posted =
    r.posting === "not_due"
      ? "It posts on its date."
      : r.posting === "waiting_ledger_start"
        ? "It waits until the ledger starts."
        : "Posted.";
  return {
    ok: true,
    message: `Cheque ${r.cheque_no} registered. ${posted}${r.party_flagged ? " Note: this party has a bounced cheque on record." : ""}`,
  };
}

const stepSchema = z.object({
  id: uuid,
  action: z.enum(CHEQUE_ACTIONS),
  date: isoDate,
  reason: z
    .string()
    .optional()
    .transform((v) => redactStatementText(v ?? "", 300) ?? ""),
  charge_amount: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .refine(
      (v) => v === "" || (Number.isFinite(parseAmount(v)) && parseAmount(v) > 0),
      "Enter the charge.",
    ),
  charge_account_id: optionalId,
});

const STEP_DONE: Record<(typeof CHEQUE_ACTIONS)[number], string> = {
  present: "Marked presented.",
  clear: "Marked cleared.",
  bounce: "Marked bounced; the posting is reversed and the party flagged.",
  cancel: "Cancelled.",
  stale: "Marked stale; the posting is reversed.",
};

export async function chequeStep(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = stepSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const admin = createAdminClient(member.userId);
  const today = await orgToday(admin, member.orgId);
  const charge =
    v.action === "bounce" && v.charge_amount
      ? { amount: roundMoney(parseAmount(v.charge_amount)), account_id: v.charge_account_id }
      : null;
  const { data, error } = await admin.rpc("acc_cheque_act", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_cheque_id: v.id,
    p_action: v.action,
    p_date: v.date,
    p_reason: v.reason,
    p_charge: charge,
    p_today: today,
  });
  if (error || !data) return fail(bankingErrorMessage(error, "That step could not be saved."));
  const r = data as { status: string; posting: string };
  await audit(admin, member, `cheque_${v.action}`, "acc_cheques", v.id, {
    status: r.status,
    posting: r.posting,
    charge: !!charge,
  });
  refresh();
  return { ok: true, message: STEP_DONE[v.action] };
}

const flagSchema = z.object({
  id: uuid,
  reason: z
    .string()
    .max(1000)
    .transform((v) => redactStatementText(v, 300) ?? "")
    .refine((v) => v.length >= 3, "Say why (at least 3 characters)."),
});

export async function clearPartyFlag(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = flagSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("acc_party_flag_clear", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_flag_id: p.data.id,
    p_reason: p.data.reason,
  });
  if (error) return fail(bankingErrorMessage(error, "The flag could not be cleared."));
  await audit(admin, member, "party_flag_cleared", "acc_party_flags", p.data.id, null);
  refresh();
  return { ok: true, message: "Flag cleared." };
}
