import "server-only";

import { randomUUID } from "node:crypto";

import {
  renderBalanceConfirmation,
  renderCustomerStatement,
} from "@/lib/accounting/receivable-documents-server";
import { loadCustomer } from "@/lib/accounting/receivables-server";
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
import { closePackPdfFile } from "@/lib/finance/signed-pdfs-server";
import { enqueue } from "@/lib/jobs/enqueue";
import { createNotification } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";

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
}): Promise<string> {
  const requestId = randomUUID();
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

function ports(
  admin: AdminClient,
  job: DocumentEmailJob,
  transport: EmailTransport | undefined,
): DocumentEmailPorts {
  const d = job.document;
  let org: { name: string; timezone: string | null } | null = null;
  const loadOrg = async () => {
    if (!org) {
      const { data } = await admin
        .from("orgs")
        .select("name, timezone")
        .eq("id", job.org_id)
        .maybeSingle();
      org = { name: data?.name ?? "", timezone: data?.timezone ?? null };
    }
    return org;
  };
  return {
    orgName: async () => (await loadOrg()).name,
    async recipient() {
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

/** Runs one queued request. A refusal tells the person who asked (generic words); a failed send throws to retry. */
export async function deliverDocumentEmail(
  admin: AdminClient,
  job: DocumentEmailJob,
  opts: { transport?: EmailTransport } = {},
): Promise<DocumentEmailOutcome> {
  const outcome = await runDocumentEmail(job, ports(admin, job, opts.transport));
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
