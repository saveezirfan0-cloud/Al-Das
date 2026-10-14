"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, uuid, type ActionResult } from "@/lib/finance/action-support";
import {
  abandonFinanceDocument,
  discardInboxDocument,
  finalizeFinanceDocument,
  prepareFinanceDocument,
  signedFinanceDocumentUrl,
  type FinalizedDocument,
} from "@/lib/finance/finance-documents";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The Finance inbox (Phase 20B): drop files in, label them, open them, discard them. Every action needs
 * finance.inbox.manage; writes use the service role after the check and are audited (ids, kinds and sizes only; a file
 * name is never sent to the server). Making a supplier invoice from a document is the 20D invoice form and its own action.
 */

async function gate() {
  const member = await requireMember();
  return can(member, "finance.inbox.manage") ? member : null;
}

const INBOX = "/finance/inbox";

const prepareSchema = z.object({
  mime: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

export async function prepareInboxUpload(
  raw: z.input<typeof prepareSchema>,
): Promise<ActionResult<{ documentId: string; path: string; token: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = prepareSchema.safeParse(raw);
  if (!p.success) return fail("Choose a file.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const res = await prepareFinanceDocument(admin, member, {
    ...p.data,
    kind: "unclassified",
    inbox: true,
  });
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}

export async function finalizeInboxUpload(raw: {
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
        : "finance.inbox.dropped"
      : "finance.document.upload_rejected",
    entity: "fin_documents",
    entityId: res.ok ? res.data.id : raw.id,
    diff: res.ok ? { size: res.data.size, scan: res.data.scan } : null,
  });
  revalidatePath(INBOX);
  if (!res.ok) return fail(res.error);
  return { ok: true, data: res.data, message: res.message };
}

export async function abandonInboxUpload(raw: { id: string }): Promise<ActionResult> {
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

/** What a person may label an inbox document as. */
const LABELS = [
  "supplier_invoice",
  "bank_statement",
  "processor_report",
  "other",
  "unclassified",
] as const;
const labelSchema = z.object({ id: uuid, kind: z.enum(LABELS) });

export async function labelInboxDocument(raw: z.input<typeof labelSchema>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = labelSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_documents")
    .update({ kind: p.data.kind })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .eq("status", "ready")
    .not("inbox_at", "is", null)
    .is("routed_at", null)
    .select("id");
  if (error || !data?.length) return fail("That document is no longer in the inbox.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.inbox.labelled",
    entity: "fin_documents",
    entityId: p.data.id,
    diff: { kind: p.data.kind },
  });
  revalidatePath(INBOX);
  return { ok: true, message: "Label saved." };
}

export async function discardInboxFile(raw: { id: string }): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const res = await discardInboxDocument(admin, member, raw.id);
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.inbox.discarded",
    entity: "fin_documents",
    entityId: raw.id,
    diff: { kind: res.data.kind },
  });
  revalidatePath(INBOX);
  return { ok: true, message: "Discarded." };
}

/** A 60-second link to a document in the inbox (logged in the access log). */
export async function openInboxDocument(raw: {
  id: string;
}): Promise<ActionResult<{ url: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(raw.id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const res = await signedFinanceDocumentUrl(admin, member, raw.id, "view", { inboxOnly: true });
  return res.ok ? { ok: true, data: res.data } : fail(res.error);
}
