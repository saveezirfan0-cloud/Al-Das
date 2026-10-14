"use server";

import { z } from "zod";

import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { loadCustomer, loadOpenItems, loadStatement } from "@/lib/accounting/receivables-server";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import {
  customerEmailProblem,
  documentSpec,
  maskAddress,
  recipientHash,
} from "@/lib/finance/document-email";
import { queueDocumentEmail } from "@/lib/finance/document-email-server";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * E-mail a customer's statement or balance-confirmation letter (Phase G). Same permission as the download (a receivables
 * read key). Business customers only (acc_customers); the address must be the one the person confirmed. The document is
 * rendered and sent by the `notifications` job; here it is audited (ids and dates, never the address) and logged as an
 * export.
 */

async function gate() {
  const member = await requireMember();
  return canAny(member, RECEIVABLES_READ) ? member : null;
}

const confirmed = z.object({ recipient: z.string().trim().min(3).max(200) });

async function prepare(
  member: NonNullable<Awaited<ReturnType<typeof gate>>>,
  customerId: string,
  recipient: string,
) {
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const limit = await checkRateLimit(
    admin,
    "finance-document-email",
    member.userId,
    RATE_RULES.financeDocumentEmailPerUser,
  );
  if (!limit.allowed)
    return {
      ok: false,
      error: `Too many e-mails sent. Try again in ${waitText(limit.retryAfter)}.`,
    } as const;
  const customer = await loadCustomer(admin, member.orgId, customerId);
  if (!customer) return { ok: false, error: "That customer was not found." } as const;
  const problem = customerEmailProblem(customer);
  if (problem) return { ok: false, error: problem } as const;
  if (recipientHash(customer.email!) !== recipientHash(recipient))
    return {
      ok: false,
      error:
        "The customer's e-mail address changed since the page was opened. Reload and try again.",
    } as const;
  return { ok: true, admin, customer } as const;
}

export async function emailCustomerStatement(raw: {
  customerId: string;
  from: string;
  to: string;
  recipient: string;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const spec = documentSpec.safeParse({
    kind: "customer_statement",
    customer_id: raw.customerId,
    from: raw.from,
    to: raw.to,
  });
  const who = confirmed.safeParse(raw);
  if (!spec.success) return fail(firstIssue(spec.error));
  if (!who.success) return fail(firstIssue(who.error));
  const d = spec.data;
  if (d.kind !== "customer_statement") return fail(DENIED);
  const ready = await prepare(member, d.customer_id, who.data.recipient);
  if (!ready.ok) return fail(ready.error);
  const { admin, customer } = ready;
  try {
    const s = await loadStatement(admin, member.orgId, d.customer_id, d.from, d.to);
    if (!s) return fail("That customer was not found.");
    const requestId = await queueDocumentEmail({
      orgId: member.orgId,
      userId: member.userId,
      document: d,
      recipientEmail: customer.email!,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.statement.emailed",
      entity: "acc_customers",
      entityId: d.customer_id,
      diff: { from: d.from, to: d.to, rows: s.rows.length, request_id: requestId },
    });
    await recordExport(admin, member, {
      dataset: "accounting:customer_statement:email",
      rows: s.rows.length,
      format: "pdf",
    });
    return { ok: true, message: `The statement is on its way to ${maskAddress(customer.email!)}.` };
  } catch {
    return fail("The statement could not be queued. Try again.");
  }
}

export async function emailBalanceConfirmation(raw: {
  customerId: string;
  asOf: string;
  recipient: string;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const spec = documentSpec.safeParse({
    kind: "balance_confirmation",
    customer_id: raw.customerId,
    as_of: raw.asOf,
  });
  const who = confirmed.safeParse(raw);
  if (!spec.success) return fail(firstIssue(spec.error));
  if (!who.success) return fail(firstIssue(who.error));
  const d = spec.data;
  if (d.kind !== "balance_confirmation") return fail(DENIED);
  const ready = await prepare(member, d.customer_id, who.data.recipient);
  if (!ready.ok) return fail(ready.error);
  const { admin, customer } = ready;
  try {
    const items = await loadOpenItems(admin, member.orgId, d.customer_id, d.as_of);
    const rows = items.invoices.length + items.on_account.length;
    const requestId = await queueDocumentEmail({
      orgId: member.orgId,
      userId: member.userId,
      document: d,
      recipientEmail: customer.email!,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.balance_confirmation.emailed",
      entity: "acc_customers",
      entityId: d.customer_id,
      diff: { as_of: d.as_of, rows, request_id: requestId },
    });
    await recordExport(admin, member, {
      dataset: "accounting:balance_confirmation:email",
      rows,
      format: "pdf",
    });
    return {
      ok: true,
      message: `The balance confirmation is on its way to ${maskAddress(customer.email!)}.`,
    };
  } catch {
    return fail("The balance confirmation could not be queued. Try again.");
  }
}
