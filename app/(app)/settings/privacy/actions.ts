"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { cancelPendingForErasure } from "@/lib/integrations/esign/server";
import { createNotification } from "@/lib/notifications";
import { redactPhone, redactText } from "@/lib/redact";
import {
  canCancel,
  canDecide,
  canExecute,
  validReason,
  type PrivacyRequestLike,
} from "@/lib/security/privacy";
import { DOCUMENT_BUCKET, isDocumentPathInOrg } from "@/lib/media/paths";
import { removeObjects } from "@/lib/media/probe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/privacy";
const MEDIA_BUCKET = "wa-media"; // same bucket the inbox stores patient media in
const uuid = z.string().uuid();

export type PatientHit = { id: string; label: string };

/** Finds a patient to raise a request for. Shows a name and a masked phone number, never more. */
export async function searchPatientsForRequest(
  query: string,
): Promise<{ ok: true; data: PatientHit[] } | { ok: false; error: string }> {
  const member = await requirePerm("privacy.manage");
  const q = query
    .replace(/[%_\\,()]/g, " ")
    .trim()
    .slice(0, 60);
  if (q.length < 2) return { ok: true, data: [] };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contacts")
    .select("id, full_name, phone_e164")
    .eq("org_id", member.orgId)
    .is("erased_at", null)
    .or(`full_name.ilike.%${q}%,phone_e164.ilike.%${q}%`)
    .order("full_name")
    .limit(8);
  if (error) return { ok: false, error: "Search failed." };
  return {
    ok: true,
    data: (data ?? []).map((c) => ({
      id: c.id,
      label: `${c.full_name || "Unnamed"}${c.phone_e164 ? ` · ${redactPhone(c.phone_e164)}` : ""}`,
    })),
  };
}

const createSchema = z.object({
  kind: z.enum(["export", "erasure"]),
  contactId: uuid,
  reason: z.string(),
});

/** Raises a request. Nothing happens until a second administrator approves it. */
export async function createPrivacyRequest(
  input: z.input<typeof createSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("privacy.manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const reason = validReason(parsed.data.reason);
  if (!reason.ok) return reason;
  const admin = createAdminClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, erased_at")
    .eq("id", parsed.data.contactId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!contact) return { ok: false, error: "Patient not found." };
  if (contact.erased_at) return { ok: false, error: "This patient has already been erased." };
  const { data: open } = await admin
    .from("privacy_requests")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("contact_id", contact.id)
    .eq("kind", parsed.data.kind)
    .in("status", ["pending", "approved"])
    .limit(1);
  if (open?.length)
    return { ok: false, error: "There is already an open request of this kind for this patient." };

  const { data, error } = await admin
    .from("privacy_requests")
    .insert({
      org_id: member.orgId,
      kind: parsed.data.kind,
      contact_id: contact.id,
      reason: parsed.data.reason.trim(),
      requested_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not raise the request." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `privacy.${parsed.data.kind}_requested`,
    entity: "privacy_request",
    entityId: data.id,
    diff: { contact_id: contact.id },
  });
  // Tell the other people who can approve it (counts and kind only).
  const { data: approvers } = await admin
    .from("memberships")
    .select("user_id, roles(permissions)")
    .eq("org_id", member.orgId)
    .eq("status", "active")
    .neq("user_id", member.userId);
  for (const a of approvers ?? []) {
    const perms = (a.roles?.permissions as unknown[]) ?? [];
    if (perms.includes("*") || perms.includes("privacy.manage")) {
      await createNotification(admin, {
        orgId: member.orgId,
        userId: a.user_id,
        type: "system",
        title: `Patient data ${parsed.data.kind} request needs approval`,
        body: "Open Settings → Patient data requests.",
        payload: { request_id: data.id },
      });
    }
  }
  revalidatePath(PATH);
  return { ok: true, message: "Request raised. A different administrator must approve it." };
}

async function loadRequest(admin: ReturnType<typeof createAdminClient>, orgId: string, id: string) {
  const { data } = await admin
    .from("privacy_requests")
    .select("id, kind, status, contact_id, requested_by")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

const decideSchema = z.object({
  id: uuid,
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).default(""),
});

/** Second-person decision. The database also refuses an approval by the person who raised the request. */
export async function decidePrivacyRequest(
  input: z.input<typeof decideSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("privacy.manage");
  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const req = await loadRequest(admin, member.orgId, parsed.data.id);
  if (!req) return { ok: false, error: "Request not found." };
  const like: PrivacyRequestLike = {
    kind: req.kind as "export" | "erasure",
    status: req.status as PrivacyRequestLike["status"],
    requestedBy: req.requested_by,
  };
  const verdict = canDecide(like, member.userId);
  if (!verdict.ok) return verdict;

  const approve = parsed.data.decision === "approve";
  const { data: updated, error } = await admin
    .from("privacy_requests")
    .update({
      status: approve ? "approved" : "rejected",
      decided_by: member.userId,
      decided_at: new Date().toISOString(),
      decision_note: parsed.data.note || null,
    })
    .eq("id", req.id)
    .eq("status", "pending")
    .select("id");
  if (error || !updated?.length) return { ok: false, error: "Could not record the decision." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `privacy.${req.kind}_${approve ? "approved" : "rejected"}`,
    entity: "privacy_request",
    entityId: req.id,
    diff: { contact_id: req.contact_id, requested_by: req.requested_by },
  });
  revalidatePath(PATH);
  return { ok: true, message: approve ? "Approved. It can now be carried out." : "Rejected." };
}

/** The person who raised a pending request may withdraw it. */
export async function cancelPrivacyRequest(id: string): Promise<ActionResult> {
  const member = await requirePerm("privacy.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const req = await loadRequest(admin, member.orgId, id);
  if (!req) return { ok: false, error: "Request not found." };
  const verdict = canCancel(
    {
      kind: req.kind as "export" | "erasure",
      status: req.status as PrivacyRequestLike["status"],
      requestedBy: req.requested_by,
    },
    member.userId,
  );
  if (!verdict.ok) return verdict;
  const { error } = await admin
    .from("privacy_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "pending");
  if (error) return { ok: false, error: "Could not cancel the request." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "privacy.request_cancelled",
    entity: "privacy_request",
    entityId: id,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Request cancelled." };
}

/**
 * Carries out an approved erasure: first removes the patient's media files from storage, then anonymises
 * the records in one database transaction (erase_contact). If the files cannot be removed nothing else
 * is touched, so the request can simply be run again.
 */
export async function executeErasure(id: string): Promise<ActionResult> {
  const member = await requirePerm("privacy.manage");
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient(member.userId);
  const req = await loadRequest(admin, member.orgId, id);
  if (!req) return { ok: false, error: "Request not found." };
  if (req.kind !== "erasure") return { ok: false, error: "This is not an erasure request." };
  const verdict = canExecute({
    kind: "erasure",
    status: req.status as PrivacyRequestLike["status"],
    requestedBy: req.requested_by,
  });
  if (!verdict.ok) return verdict;

  // 1. Media files (storage is outside the database transaction, so it goes first and is retryable).
  const { data: convs } = await admin
    .from("conversations")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("contact_id", req.contact_id);
  const convIds = (convs ?? []).map((c) => c.id);
  let removedFiles = 0;
  if (convIds.length) {
    const { data: media } = await admin
      .from("messages")
      .select("media_path")
      .eq("org_id", member.orgId)
      .in("conversation_id", convIds)
      .not("media_path", "is", null)
      .limit(20_000);
    const paths = [
      ...new Set(
        (media ?? [])
          .map((m) => m.media_path)
          .filter((p): p is string => !!p && p.startsWith(`${member.orgId}/`)),
      ),
    ];
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { error } = await admin.storage.from(MEDIA_BUCKET).remove(batch);
      if (error) {
        console.error("[privacy] storage removal failed", { error: redactText(error.message) });
        return {
          ok: false,
          error: "Could not remove the patient's files. Nothing else was changed; try again.",
        };
      }
      removedFiles += batch.length;
    }
  }

  // 1b. The patient's uploaded documents (referrals, lab reports, insurance cards, consent forms), same rule: files
  // first, retryable, and nothing else is touched if any file cannot be removed.
  const { data: docs } = await admin
    .from("patient_documents")
    .select("id, storage_path")
    .eq("org_id", member.orgId)
    .eq("contact_id", req.contact_id)
    .limit(20_000);
  const docList = docs ?? [];
  // The patient segment of a path can differ after a record merge, so only org and document id are compared.
  if (docList.some((d) => !isDocumentPathInOrg(d.storage_path, member.orgId, d.id))) {
    return {
      ok: false,
      error:
        "A document has an unexpected storage location. Nothing was changed; ask an administrator.",
    };
  }
  const docPaths = docList.map((d) => d.storage_path);
  if (!(await removeObjects(admin, DOCUMENT_BUCKET, docPaths))) {
    console.error("[privacy] document storage removal failed");
    return {
      ok: false,
      error: "Could not remove the patient's documents. Nothing else was changed; try again.",
    };
  }

  // 1c. E-signature requests still waiting at the provider are withdrawn (best effort: the provider keeps its own record under its own
  // terms, which the clinic's agreement with it has to cover). The request rows themselves are deleted by erase_contact.
  const esign = await cancelPendingForErasure(
    admin,
    {},
    { orgId: member.orgId, contactId: req.contact_id },
  );

  // 2. Database anonymisation, one transaction.
  const { data, error } = await admin.rpc("erase_contact", {
    p_org: member.orgId,
    p_contact: req.contact_id,
    p_actor: member.userId,
  });
  if (error) {
    const known = /already erased|not found/i.test(error.message);
    return {
      ok: false,
      error: known ? error.message : "Could not erase the patient. Nothing was changed.",
    };
  }
  const result = {
    ...((data ?? {}) as Record<string, Json>),
    media_files_removed: removedFiles,
    document_files_removed: docPaths.length,
    esign_requests_withdrawn: esign.cancelled,
    esign_requests_not_withdrawn: esign.failed,
  };
  await admin
    .from("privacy_requests")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result: result as NonNullable<Json>,
    })
    .eq("id", id);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "privacy.erasure_completed",
    entity: "privacy_request",
    entityId: id,
    diff: result,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Patient anonymised. Clinical records synced from Unite were kept." };
}
