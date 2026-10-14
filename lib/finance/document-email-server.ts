import "server-only";

import { randomUUID } from "node:crypto";

import {
  renderBalanceConfirmation,
  renderCustomerStatement,
} from "@/lib/accounting/receivable-documents-server";
import { loadCustomer } from "@/lib/accounting/receivables-server";
import { renderSalesDocument } from "@/lib/accounting/sales-document-server";
import { recordAudit } from "@/lib/audit";
import { sendEmail, type EmailTransport } from "@/lib/email";
import { loadCloseByMonth } from "@/lib/finance/close-server";
import {
  customerEmailProblem,
  DOCUMENT_EMAIL_JOB,
  documentFilename,
  OUTCOME_NOTICE,
  recipientHash,
  runDocumentEmail,
  type DocumentEmailJob,
  type DocumentEmailOutcome,
  type DocumentEmailPorts,
  type DocumentSpec,
} from "@/lib/finance/document-email";
import { renderFlashDocument, renderSummaryDocument } from "@/lib/finance/report-documents-server";
import { recipientDecision, type ReportEmailKind } from "@/lib/finance/report-emails";
import { closePackPdfFile } from "@/lib/finance/signed-pdfs-server";
import { enqueue } from "@/lib/jobs/enqueue";
import { createNotification } from "@/lib/notifications";
import { recordExport } from "@/lib/security/access-log";
import { readFinanceAccess } from "@/lib/security/finance-access";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * E-mailing finance documents (Phase G), the server part. The action checks the permission of the underlying export,
 * shows the recipient, audits and logs the export, then calls queueDocumentEmail; the `notifications` job calls
 * deliverDocumentEmail, which re-reads the recipient and renders the document from stored data (service role).
 */

/** Puts one request on the `notifications` queue: ids, dates and the address's SHA-256 only. Returns the request id. */
export async function queueDocumentEmail(input: {
  orgId: string;
  userId: string;
  document: DocumentSpec;
  recipientEmail: string;
  /** A fixed id (the scheduled e-mails derive one per run and recipient, so a duplicate is the same e-mail). */
  requestId?: string;
}): Promise<string> {
  const requestId = input.requestId ?? randomUUID();
  const job: DocumentEmailJob = {
    type: DOCUMENT_EMAIL_JOB,
    request_id: requestId,
    org_id: input.orgId,
    requested_by: input.userId,
    recipient_sha256: recipientHash(input.recipientEmail),
    document: input.document,
  };
  await enqueue("notifications", job);
  return requestId;
}

/** The people who signed a month's close, with their profile address (the only recipients of a close pack). */
export async function closeSigners(
  admin: AdminClient,
  orgId: string,
  close: { financeById: string | null; ceoById: string | null },
): Promise<Array<{ userId: string; email: string | null; name: string }>> {
  const ids = [...new Set([close.financeById, close.ceoById].filter((x): x is string => !!x))];
  if (ids.length === 0) return [];
  const [{ data: people }, { data: members }] = await Promise.all([
    admin.from("profiles").select("id, email, first_name, last_name").in("id", ids),
    admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("user_id", ids),
  ]);
  const active = new Set((members ?? []).map((m) => m.user_id));
  return ids
    .filter((id) => active.has(id))
    .map((id) => {
      const p = (people ?? []).find((x) => x.id === id);
      return {
        userId: id,
        email: p?.email ?? null,
        name: p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Colleague" : "Colleague",
      };
    });
}

type OrgRow = { name: string; timezone: string | null; settings: Json | null };

/**
 * A member who should receive a report, re-read now: still an active member, holding the report's own key with the
 * finance access window applied (the same decision a request makes, lib/finance/report-emails.ts), with an address.
 */
async function reportRecipient(
  admin: AdminClient,
  orgId: string,
  org: OrgRow,
  kind: ReportEmailKind,
  userId: string,
): Promise<{ email: string; name: string | null } | null | "not_allowed"> {
  const [{ data: membership }, { data: profile }] = await Promise.all([
    admin
      .from("memberships")
      .select("role_id, status, roles(permissions)")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    admin.from("profiles").select("email, first_name, last_name").eq("id", userId).maybeSingle(),
  ]);
  const perms = membership?.roles?.permissions;
  const decision = recipientDecision(
    kind,
    {
      userId,
      membership: membership
        ? {
            roleId: membership.role_id,
            status: membership.status,
            permissions: Array.isArray(perms)
              ? perms.filter((p): p is string => typeof p === "string")
              : [],
          }
        : null,
      email: profile?.email ?? null,
      name: null,
    },
    {
      orgId,
      now: new Date(),
      timezone: org.timezone ?? "Asia/Dubai",
      financeAccess: readFinanceAccess(org.settings),
    },
  );
  if (decision.ok)
    return {
      email: decision.email,
      name: profile ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() || null : null,
    };
  return decision.reason === "no_permission" || decision.reason === "finance_window"
    ? "not_allowed"
    : null;
}

type Rendered = { rows: number };

function ports(
  admin: AdminClient,
  job: DocumentEmailJob,
  transport: EmailTransport | undefined,
  rendered: Rendered,
): DocumentEmailPorts & { loadOrg(): Promise<OrgRow> } {
  const d = job.document;
  let org: OrgRow | null = null;
  const loadOrg = async (): Promise<OrgRow> => {
    if (!org) {
      const { data } = await admin
        .from("orgs")
        .select("name, timezone, settings")
        .eq("id", job.org_id)
        .maybeSingle();
      org = {
        name: data?.name ?? "",
        timezone: data?.timezone ?? null,
        settings: (data?.settings as Json | null) ?? null,
      };
    }
    return org;
  };
  return {
    loadOrg,
    orgName: async () => (await loadOrg()).name,
    async recipient() {
      if (d.kind === "daily_flash" || d.kind === "monthly_summary")
        return reportRecipient(admin, job.org_id, await loadOrg(), d.kind, d.recipient_user_id);
      if (d.kind === "close_pack") {
        const close = await loadCloseByMonth(admin, job.org_id, d.month);
        if (!close) return null;
        const signer = (await closeSigners(admin, job.org_id, close)).find(
          (s) => s.userId === d.recipient_user_id,
        );
        return signer?.email ? { email: signer.email, name: signer.name } : null;
      }
      const c = await loadCustomer(admin, job.org_id, d.customer_id);
      if (!c || customerEmailProblem(c)) return null;
      return { email: c.email!, name: c.name };
    },
    async render() {
      if (d.kind === "daily_flash" || d.kind === "monthly_summary") {
        const o = await loadOrg();
        const who = { id: job.org_id, name: o.name };
        const doc =
          d.kind === "daily_flash"
            ? await renderFlashDocument(admin, who, d.day, "xlsx")
            : await renderSummaryDocument(
                admin,
                who,
                { from: d.from, to: d.to, branch: d.branch },
                "xlsx",
              );
        rendered.rows = doc.rows;
        return {
          attachment: {
            filename: documentFilename(d),
            content: doc.body,
            contentType: doc.contentType,
          },
          provisional: doc.provisional,
        };
      }
      if (d.kind === "sales_invoice") {
        // a copy of the issued document, and only when it still belongs to the customer that was confirmed
        const doc = await renderSalesDocument(admin, job.org_id, d.invoice_id, { copy: true });
        if (!doc || doc.customerId !== d.customer_id) return null;
        rendered.rows = 1;
        return {
          attachment: {
            filename: documentFilename(d, { number: doc.number }),
            content: doc.pdf,
            contentType: "application/pdf",
          },
          reference: { number: doc.number, date: doc.date, creditNote: doc.kind === "credit_note" },
        };
      }
      if (d.kind === "customer_statement") {
        const doc = await renderCustomerStatement(
          admin,
          job.org_id,
          d.customer_id,
          d.from,
          d.to,
          "pdf",
        );
        return doc
          ? {
              attachment: {
                filename: documentFilename(d),
                content: doc.body,
                contentType: "application/pdf",
              },
              closing: doc.closing,
            }
          : null;
      }
      if (d.kind === "balance_confirmation") {
        const doc = await renderBalanceConfirmation(admin, job.org_id, d.customer_id, d.as_of);
        return doc
          ? {
              attachment: {
                filename: documentFilename(d),
                content: doc.body,
                contentType: "application/pdf",
              },
            }
          : null;
      }
      const close = await loadCloseByMonth(admin, job.org_id, d.month);
      if (!close?.pack) return null;
      const o = await loadOrg();
      // the same file the download route serves: a locked month's sealed copy is the stored one
      const pdf = await closePackPdfFile(
        admin,
        { orgId: job.org_id, orgName: o.name, timezone: o.timezone, userId: job.requested_by },
        close,
      );
      const draft = close.status !== "locked";
      return {
        attachment: {
          filename: documentFilename(d, { draft }),
          content: pdf.pdf,
          contentType: "application/pdf",
        },
        draft,
      };
    },
    send: (message) => sendEmail(message, { transport }),
  };
}

/**
 * Runs one queued request. A refusal tells the person who asked (generic words); a failed send throws to retry. A
 * scheduled report that was sent is logged as an export by its recipient and audited (ids, kind and period only).
 */
export async function deliverDocumentEmail(
  admin: AdminClient,
  job: DocumentEmailJob,
  opts: { transport?: EmailTransport } = {},
): Promise<DocumentEmailOutcome> {
  const rendered: Rendered = { rows: 0 };
  const p = ports(admin, job, opts.transport, rendered);
  const outcome = await runDocumentEmail(job, p);
  const d = job.document;
  if (outcome === "sent" && (d.kind === "daily_flash" || d.kind === "monthly_summary") && d.run_id) {
    const o = await p.loadOrg();
    await recordExport(
      admin,
      {
        orgId: job.org_id,
        userId: d.recipient_user_id,
        org: { timezone: o.timezone ?? "Asia/Dubai", settings: o.settings ?? {} },
      },
      { dataset: `finance:${d.kind}:scheduled_email`, rows: rendered.rows, format: "xlsx" },
    );
    await recordAudit(admin, {
      orgId: job.org_id,
      userId: d.recipient_user_id,
      action: "finance.report_email.sent",
      entity: "fin_report_schedule_runs",
      entityId: d.run_id,
      diff: {
        kind: d.kind,
        period: d.kind === "daily_flash" ? d.day : d.from,
        request_id: job.request_id,
      },
    });
  }
  const notice = OUTCOME_NOTICE[outcome];
  if (notice)
    await createNotification(admin, {
      orgId: job.org_id,
      userId: job.requested_by,
      type: "finance.document_email",
      title: "A finance e-mail was not sent",
      body: notice,
      payload: { request_id: job.request_id, kind: job.document.kind },
    });
  return outcome;
}
