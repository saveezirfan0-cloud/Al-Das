"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { readDocumentSettings } from "@/lib/documents/settings";
import { loadAccount } from "@/lib/integrations/accounts";
import { cancelEsignRequest, createEsignRequest } from "@/lib/integrations/esign/server";
import { isEsignStatus, type EsignStatus } from "@/lib/integrations/esign/state";
import { supabaseEsignStorage } from "@/lib/integrations/esign/storage";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult<T = undefined> =
  { ok: true; data?: T; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const DENIED = "You do not have permission for that.";

export type EsignRequestRow = {
  id: string;
  status: EsignStatus;
  signer_hint: string | null;
  test_mode: boolean;
  created_at: string;
  completed_at: string | null;
  signed_document_id: string | null;
  error_code: string | null;
};

export type EsignSource = { kind: "patient_document" | "library_asset"; id: string; label: string };

export type EsignView = {
  /** E-signature is switched on and patient documents are on. */
  enabled: boolean;
  canManage: boolean;
  requests: EsignRequestRow[];
  sources: EsignSource[];
  defaultName: string;
  defaultEmail: string;
};

async function viewer() {
  const member = await requireMember();
  return can(member, "documents.view") ? member : null;
}
async function manager() {
  const member = await requireMember();
  return can(member, "documents.manage") ? member : null;
}

/** The "E-signature" section of a patient's Documents tab. Empty (enabled: false) while the integration or documents are off. */
export async function getEsignView(contactId: string): Promise<ActionResult<EsignView>> {
  const member = await viewer();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(contactId).success) return fail("Invalid input");
  const admin = createAdminClient(member.userId);
  const empty: EsignView = {
    enabled: false,
    canManage: false,
    requests: [],
    sources: [],
    defaultName: "",
    defaultEmail: "",
  };
  const account = await loadAccount(admin, member.orgId, "esign");
  if (!account?.enabled || !readDocumentSettings(member.org.settings).enabled)
    return { ok: true, data: empty };
  const { data: contact } = await admin
    .from("contacts")
    .select("id, full_name, email, erased_at")
    .eq("id", contactId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!contact || contact.erased_at) return fail("Patient not found.");
  const canManage = can(member, "documents.manage");
  const { data: rows } = await admin
    .from("esign_requests")
    .select(
      "id, status, signer_hint, test_mode, created_at, completed_at, signed_document_id, error_code",
    )
    .eq("org_id", member.orgId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(50);
  let sources: EsignSource[] = [];
  if (canManage) {
    const [{ data: docs }, { data: assets }] = await Promise.all([
      admin
        .from("patient_documents")
        .select("id, title")
        .eq("org_id", member.orgId)
        .eq("contact_id", contactId)
        .eq("category", "consent")
        .eq("mime_type", "application/pdf")
        .eq("status", "ready")
        .neq("scan_status", "infected")
        .order("created_at", { ascending: false })
        .limit(50),
      admin
        .from("media_assets")
        .select("id, name, tags")
        .eq("org_id", member.orgId)
        .eq("kind", "document")
        .eq("mime_type", "application/pdf")
        .eq("status", "ready")
        .neq("scan_status", "infected")
        .order("name")
        .limit(100),
    ]);
    sources = [
      ...(docs ?? []).map((d) => ({
        kind: "patient_document" as const,
        id: d.id,
        label: `This patient's document: ${d.title}`,
      })),
      ...(assets ?? [])
        .sort((a, b) => Number(b.tags.includes("consent")) - Number(a.tags.includes("consent")))
        .map((a) => ({
          kind: "library_asset" as const,
          id: a.id,
          label: `Media Library: ${a.name}`,
        })),
    ];
  }
  return {
    ok: true,
    data: {
      enabled: true,
      canManage,
      requests: (rows ?? []).map((r) => ({
        ...r,
        status: isEsignStatus(r.status) ? r.status : "failed",
      })),
      sources,
      defaultName: canManage ? (contact.full_name ?? "") : "",
      defaultEmail: canManage ? (contact.email ?? "") : "",
    },
  };
}

const sendSchema = z.object({
  contactId: uuid,
  source: z.object({ kind: z.enum(["patient_document", "library_asset"]), id: uuid }),
  signerName: z.string().max(200),
  signerEmail: z.string().max(300),
});

/**
 * Sends one consent form to the e-signature provider for one signer. The provider receives the form and the signer's name and e-mail,
 * nothing else. Needs documents.manage; patient documents and the integration must be switched on.
 */
export async function sendForSignature(
  input: z.input<typeof sendSchema>,
): Promise<ActionResult<{ requestId: string }>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const p = sendSchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(
    admin,
    "esign-send",
    member.userId,
    RATE_RULES.esignSendPerUser,
  );
  if (!limit.allowed) return fail(`Too many requests. Try again in ${waitText(limit.retryAfter)}.`);
  const r = await createEsignRequest(
    admin,
    { storage: supabaseEsignStorage(admin) },
    {
      orgId: member.orgId,
      actorId: member.userId,
      contactId: p.data.contactId,
      source: p.data.source,
      signerName: p.data.signerName,
      signerEmail: p.data.signerEmail,
    },
  );
  if (!r.ok) return fail(r.error);
  // The document's content left Pulse: that is a download in the access record, and the request is an audited action (ids only).
  if (p.data.source.kind === "patient_document")
    await recordAccess(admin, member, {
      entity: "document",
      entityId: p.data.source.id,
      action: "download",
      detail: { purpose: "esign", request_id: r.requestId },
    });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "esign.requested",
    entity: "esign_request",
    entityId: r.requestId,
    diff: { contact_id: p.data.contactId, source_kind: p.data.source.kind },
  });
  revalidatePath("/contacts");
  return { ok: true, data: { requestId: r.requestId }, message: "Sent for signature." };
}

/** Withdraws a request that is still waiting for a signature. */
export async function cancelSignature(requestId: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(requestId).success) return fail("Invalid input");
  const admin = createAdminClient(member.userId);
  const r = await cancelEsignRequest(
    admin,
    {},
    { orgId: member.orgId, actorId: member.userId, requestId },
  );
  if (!r.ok) return fail(r.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "esign.cancelled",
    entity: "esign_request",
    entityId: requestId,
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Request cancelled." };
}
