"use server";

import { z } from "zod";

import { loadCustomer, loadSalesDetail } from "@/lib/accounting/receivables-server";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import {
  customerEmailProblem,
  maskAddress,
  recipientHash,
} from "@/lib/finance/document-email";
import { queueDocumentEmail } from "@/lib/finance/document-email-server";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * E-mail a business customer a copy of an issued sales invoice or credit note (Phase G). Sending a document to a customer
 * is sales work, so it needs accounting.sales.manage (the read-only receivables keys can download, not send). Business
 * customers only (acc_customers, never a patient); the address must be the one the person confirmed. The copy is marked
 * "Internal copy - not a tax invoice" and is rendered and sent by the `notifications` job; here it is rate limited,
 * audited (ids and the number, never the address) and logged as an export.
 */

const SALES = "accounting.sales.manage";

async function gate() {
  const member = await requireMember();
  return can(member, SALES) ? member : null;
}

const input = z.object({
  invoiceId: z.string().uuid(),
  recipient: z.string().trim().min(3).max(200),
});

export async function emailSalesDocument(raw: {
  invoiceId: string;
  recipient: string;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = input.safeParse(raw);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const limit = await checkRateLimit(
    admin,
    "finance-document-email",
    member.userId,
    RATE_RULES.financeDocumentEmailPerUser,
  );
  if (!limit.allowed)
    return fail(`Too many e-mails sent. Try again in ${waitText(limit.retryAfter)}.`);
  try {
    const d = await loadSalesDetail(admin, member.orgId, parsed.data.invoiceId);
    if (!d || d.status === "draft" || !d.number)
      return fail("Only an issued invoice or credit note can be e-mailed.");
    const customer = await loadCustomer(admin, member.orgId, d.customer.id);
    if (!customer) return fail("That customer was not found.");
    const problem = customerEmailProblem(customer);
    if (problem) return fail(problem);
    if (recipientHash(customer.email!) !== recipientHash(parsed.data.recipient))
      return fail(
        "The customer's e-mail address changed since the page was opened. Reload and try again.",
      );
    const requestId = await queueDocumentEmail({
      orgId: member.orgId,
      userId: member.userId,
      document: { kind: "sales_invoice", customer_id: customer.id, invoice_id: d.id },
      recipientEmail: customer.email!,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.sales_document.emailed",
      entity: "acc_sales_invoices",
      entityId: d.id,
      diff: { number: d.number, kind: d.kind, customer_id: customer.id, request_id: requestId },
    });
    await recordExport(admin, member, {
      dataset: `accounting:${d.kind}:email`,
      rows: 1,
      format: "pdf",
    });
    return {
      ok: true,
      message: `A copy of ${d.number} is on its way to ${maskAddress(customer.email!)}.`,
    };
  } catch {
    return fail("The invoice could not be queued. Try again.");
  }
}
