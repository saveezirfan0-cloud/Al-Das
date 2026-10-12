"use server";

import { randomUUID } from "node:crypto";

import { formatInTimeZone } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, type CurrentMember } from "@/lib/auth/session";
import { isCategory, type DocumentCategory } from "@/lib/documents/categories";
import {
  expiryLabel,
  expiryState,
  validExpiryDate,
  type ExpiryState,
} from "@/lib/documents/expiry";
import { documentMetaSchema } from "@/lib/documents/schema";
import { readDocumentSettings } from "@/lib/documents/settings";
import { inspectStoredObject } from "@/lib/media/inspect";
import { validateMedia } from "@/lib/media/limits";
import { DOCUMENT_BUCKET, documentObjectPath, isDocumentPathInOrg } from "@/lib/media/paths";
import { probeObject, removeObjects } from "@/lib/media/probe";
import { isServable } from "@/lib/media/scan";
import { configuredScanner, downloadName, scanColumns, scanStored } from "@/lib/media/server";
import { redactText } from "@/lib/redact";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult<T = undefined> =
  { ok: true; data?: T; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const DENIED = "You do not have permission for that.";

export type DocumentRow = {
  id: string;
  title: string;
  category: DocumentCategory;
  mime_type: string;
  size_bytes: number;
  expires_on: string | null;
  expiry_state: ExpiryState;
  expiry_text: string;
  scan_status: string;
  created_at: string;
  uploader: string | null;
};

export type DocumentsView = {
  /** Patient documents are switched on for this workspace (Settings, Patient documents). */
  enabled: boolean;
  canManage: boolean;
  /** Today in the clinic's timezone, YYYY-MM-DD. */
  today: string;
  documents: DocumentRow[];
};

async function viewer() {
  const member = await requireMember();
  return can(member, "documents.view") ? member : null;
}
async function manager() {
  const member = await requireMember();
  return can(member, "documents.manage") ? member : null;
}

/** The patient must belong to this workspace and not be erased. */
async function ownContact(member: CurrentMember, contactId: string) {
  const admin = createAdminClient(member.userId);
  const { data } = await admin
    .from("contacts")
    .select("id, erased_at, deleted_at")
    .eq("id", contactId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  return { admin, contact: data && !data.erased_at ? data : null };
}

async function ownDocument(member: CurrentMember, id: string) {
  const admin = createAdminClient(member.userId);
  const { data } = await admin
    .from("patient_documents")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  return { admin, doc: data };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The Documents tab of one patient. Opening it is recorded (sampled) in the record access log. */
export async function listContactDocuments(
  contactId: string,
): Promise<ActionResult<DocumentsView>> {
  const member = await viewer();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(contactId).success) return fail("Invalid input");
  const { admin, contact } = await ownContact(member, contactId);
  if (!contact) return fail("Patient not found.");
  const settings = readDocumentSettings(member.org.settings);
  const today = formatInTimeZone(new Date(), member.org.timezone || "UTC", "yyyy-MM-dd");
  const { data: rows } = await admin
    .from("patient_documents")
    .select(
      "id, title, category, mime_type, size_bytes, expires_on, scan_status, created_at, uploaded_by",
    )
    .eq("org_id", member.orgId)
    .eq("contact_id", contactId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(200);
  const ids = [...new Set((rows ?? []).map((r) => r.uploaded_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", ids);
    for (const p of profiles ?? [])
      names.set(p.id, `${p.first_name} ${p.last_name}`.trim() || "Someone");
  }
  await recordAccess(admin, member, {
    entity: "document",
    entityId: contactId,
    action: "list",
    detail: { source: "contact_documents", rows: rows?.length ?? 0 },
  });
  return {
    ok: true,
    data: {
      enabled: settings.enabled,
      canManage: can(member, "documents.manage"),
      today,
      documents: (rows ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        category: isCategory(r.category) ? r.category : "other",
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        expires_on: r.expires_on,
        expiry_state: expiryState(r.expires_on, today, settings.expiry_lead_days),
        expiry_text: expiryLabel(r.expires_on, today, settings.expiry_lead_days),
        scan_status: r.scan_status,
        created_at: r.created_at,
        uploader: r.uploaded_by ? (names.get(r.uploaded_by) ?? null) : null,
      })),
    },
  };
}

const openSchema = z.object({ id: uuid, mode: z.enum(["view", "download"]).default("view") });

/**
 * A 60-second link to one document. Every call is written to the record access log (who, which document, when,
 * view or download; never the title or the contents). A file the malware scan blocked is never served.
 */
export async function getDocumentUrl(
  input: z.input<typeof openSchema>,
): Promise<ActionResult<{ url: string }>> {
  const member = await viewer();
  if (!member) return fail(DENIED);
  const p = openSchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  const { admin, doc } = await ownDocument(member, p.data.id);
  if (!doc || doc.status !== "ready") return fail("Document not found.");
  if (!isServable(doc.scan_status))
    return fail("The malware scan blocked this file. It cannot be opened.");
  if (!isDocumentPathInOrg(doc.storage_path, member.orgId, doc.id))
    return fail("Document not found.");
  const ext = doc.storage_path.split(".").pop() ?? "bin";
  const { data, error } = await admin.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(
      doc.storage_path,
      60,
      p.data.mode === "download" ? { download: downloadName(doc.title, ext) } : undefined,
    );
  if (error || !data) return fail("Could not open the document.");
  await recordAccess(admin, member, {
    entity: "document",
    entityId: doc.id,
    action: p.data.mode,
    detail: { category: doc.category, contact_id: doc.contact_id },
  });
  return { ok: true, data: { url: data.signedUrl } };
}

export type AccessEntry = { at: string; action: string; who: string };

/** Who opened or downloaded this document (documents.manage). Reads the Phase 15 record access log. */
export async function listDocumentAccess(id: string): Promise<ActionResult<AccessEntry[]>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, doc } = await ownDocument(member, id);
  if (!doc) return fail("Document not found.");
  const { data } = await admin
    .from("record_access_log")
    .select("at, action, user_id")
    .eq("org_id", member.orgId)
    .eq("entity", "document")
    .eq("entity_id", id)
    .in("action", ["view", "download"])
    .order("at", { ascending: false })
    .limit(50);
  const ids = [...new Set((data ?? []).map((r) => r.user_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", ids);
    for (const p of profiles ?? [])
      names.set(p.id, `${p.first_name} ${p.last_name}`.trim() || "Someone");
  }
  return {
    ok: true,
    data: (data ?? []).map((r) => ({
      at: r.at,
      action: r.action,
      who: r.user_id ? (names.get(r.user_id) ?? "A former colleague") : "A former colleague",
    })),
  };
}

// ---------------------------------------------------------------------------
// Upload: prepare -> browser -> finalise
// ---------------------------------------------------------------------------

const prepareSchema = z.object({
  contact_id: uuid,
  title: z.string(),
  category: z.string(),
  expires_on: z.string().nullish(),
  mime_type: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});

export async function prepareDocumentUpload(
  input: z.input<typeof prepareSchema>,
): Promise<ActionResult<{ document_id: string; upload: { path: string; token: string } }>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const p = prepareSchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  if (!readDocumentSettings(member.org.settings).enabled)
    return fail(
      "Patient documents are switched off for this workspace. An administrator can turn them on under Settings, Patient documents.",
    );
  const meta = documentMetaSchema.safeParse({
    title: p.data.title,
    category: p.data.category,
    expires_on: p.data.expires_on || null,
  });
  if (!meta.success) return fail(meta.error.issues[0]?.message ?? "Check the title and category.");
  const today = formatInTimeZone(new Date(), member.org.timezone || "UTC", "yyyy-MM-dd");
  if (meta.data.expires_on && !validExpiryDate(meta.data.expires_on, today))
    return fail("The expiry date is not valid.");
  const check = validateMedia({ mime: p.data.mime_type, size: p.data.size }, "patient_document");
  if (!check.ok) return fail(check.message);
  const { admin, contact } = await ownContact(member, p.data.contact_id);
  if (!contact) return fail("Patient not found.");

  const documentId = randomUUID();
  const path = documentObjectPath(member.orgId, contact.id, documentId, check.extension);
  const { error } = await admin.from("patient_documents").insert({
    id: documentId,
    org_id: member.orgId,
    contact_id: contact.id,
    category: meta.data.category,
    title: meta.data.title,
    mime_type: check.mime,
    size_bytes: p.data.size,
    storage_path: path,
    expires_on: meta.data.expires_on ?? null,
    uploaded_by: member.userId,
  });
  if (error) return fail("Could not start the upload.");
  const signed = await admin.storage.from(DOCUMENT_BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) {
    await admin.from("patient_documents").delete().eq("id", documentId);
    return fail("Could not prepare the upload.");
  }
  return {
    ok: true,
    data: { document_id: documentId, upload: { path: signed.data.path, token: signed.data.token } },
  };
}

/** Checks the stored file (size, content, malware scan) and only then makes the document visible. */
export async function finalizeDocumentUpload(id: string): Promise<ActionResult<{ id: string }>> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, doc } = await ownDocument(member, id);
  if (!doc) return fail("That upload was not found.");
  if (doc.status === "ready") return { ok: true, data: { id: doc.id } };

  const reject = async (message: string) => {
    await removeObjects(admin, DOCUMENT_BUCKET, [doc.storage_path]);
    await admin.from("patient_documents").delete().eq("id", doc.id).eq("status", "pending");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "document.upload_rejected",
      entity: "patient_document",
      entityId: doc.id,
      diff: { reason: message.slice(0, 120) } as Json,
    });
    return fail(message);
  };

  const stored = await probeObject(admin, DOCUMENT_BUCKET, doc.storage_path);
  if (!stored) return reject("The file did not arrive. Please try again.");
  const verdict = inspectStoredObject(
    { declaredMime: doc.mime_type, purpose: "patient_document" },
    stored,
  );
  if (!verdict.ok) return reject(verdict.message);
  const scan = await scanStored(admin, {
    bucket: DOCUMENT_BUCKET,
    path: doc.storage_path,
    size: stored.size,
    mime: verdict.mime,
  });
  const { error } = await admin
    .from("patient_documents")
    .update({
      status: "ready",
      size_bytes: stored.size,
      mime_type: verdict.mime,
      ...scanColumns(scan),
    })
    .eq("id", doc.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save the document.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "document.uploaded",
    entity: "patient_document",
    entityId: doc.id,
    diff: {
      contact_id: doc.contact_id,
      category: doc.category,
      size_bytes: stored.size,
      has_expiry: !!doc.expires_on,
      scan_status: scan.verdict,
    } as Json,
  });
  revalidatePath("/contacts");
  return {
    ok: true,
    data: { id: doc.id },
    message:
      scan.verdict === "infected"
        ? "Saved, but the malware scan blocked this file."
        : scan.verdict === "unscanned"
          ? "Saved. No malware scanner is configured, so the file is marked not scanned."
          : "Document saved.",
  };
}

export async function abandonDocumentUpload(id: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, doc } = await ownDocument(member, id);
  if (!doc || doc.status !== "pending") return { ok: true };
  await removeObjects(admin, DOCUMENT_BUCKET, [doc.storage_path]);
  await admin.from("patient_documents").delete().eq("id", doc.id).eq("status", "pending");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "document.upload_cancelled",
    entity: "patient_document",
    entityId: doc.id,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Change and delete
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  id: uuid,
  title: z.string(),
  category: z.string(),
  expires_on: z.string().nullish(),
});

export async function updateDocument(input: z.input<typeof updateSchema>): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  const p = updateSchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  const meta = documentMetaSchema.safeParse({
    title: p.data.title,
    category: p.data.category,
    expires_on: p.data.expires_on || null,
  });
  if (!meta.success) return fail(meta.error.issues[0]?.message ?? "Check the title and category.");
  const today = formatInTimeZone(new Date(), member.org.timezone || "UTC", "yyyy-MM-dd");
  if (meta.data.expires_on && !validExpiryDate(meta.data.expires_on, today))
    return fail("The expiry date is not valid.");
  const { admin, doc } = await ownDocument(member, p.data.id);
  if (!doc || doc.status !== "ready") return fail("Document not found.");
  const changed = {
    title: doc.title !== meta.data.title,
    category: doc.category !== meta.data.category,
    expires_on: (doc.expires_on ?? null) !== (meta.data.expires_on ?? null),
  };
  if (!changed.title && !changed.category && !changed.expires_on) return { ok: true };
  const { error } = await admin
    .from("patient_documents")
    .update({
      title: meta.data.title,
      category: meta.data.category,
      expires_on: meta.data.expires_on ?? null,
      // A new date (or a different kind of document) is reminded about afresh.
      ...(changed.expires_on || changed.category ? { expiry_notified_at: null } : {}),
    })
    .eq("id", doc.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save the changes.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "document.updated",
    entity: "patient_document",
    entityId: doc.id,
    diff: { contact_id: doc.contact_id, changed } as Json,
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Saved." };
}

/** Removes the file first (so a failure leaves the document in place and can be retried), then the record. */
export async function deleteDocument(id: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, doc } = await ownDocument(member, id);
  if (!doc) return fail("Document not found.");
  if (!isDocumentPathInOrg(doc.storage_path, member.orgId, doc.id))
    return fail("Document not found.");
  const removed = await removeObjects(admin, DOCUMENT_BUCKET, [doc.storage_path]);
  if (!removed)
    return fail("The file could not be removed from storage. Nothing was deleted; try again.");
  const { error } = await admin
    .from("patient_documents")
    .delete()
    .eq("id", doc.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not delete the document.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "document.deleted",
    entity: "patient_document",
    entityId: doc.id,
    diff: {
      contact_id: doc.contact_id,
      category: doc.category,
      size_bytes: doc.size_bytes,
    } as Json,
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Document deleted." };
}

export async function rescanDocument(id: string): Promise<ActionResult> {
  const member = await manager();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid input");
  const { admin, doc } = await ownDocument(member, id);
  if (!doc || doc.status !== "ready") return fail("Document not found.");
  const scanner = configuredScanner();
  if (scanner.name === "none")
    return fail("No malware scanner is configured, so there is nothing to scan with.");
  try {
    const scan = await scanStored(
      admin,
      {
        bucket: DOCUMENT_BUCKET,
        path: doc.storage_path,
        size: doc.size_bytes,
        mime: doc.mime_type,
      },
      scanner,
    );
    await admin
      .from("patient_documents")
      .update(scanColumns(scan))
      .eq("id", doc.id)
      .eq("org_id", member.orgId);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "document.rescanned",
      entity: "patient_document",
      entityId: doc.id,
      diff: { scan_status: scan.verdict } as Json,
    });
    revalidatePath("/contacts");
    return { ok: true, message: `Scan result: ${scan.verdict}.` };
  } catch (err) {
    console.error("[documents] rescan failed", { error: redactText(err) });
    return fail("The scan could not run.");
  }
}
