import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { CurrentMember } from "@/lib/auth/session";
import { inspectStoredObject } from "@/lib/media/inspect";
import { validateMedia } from "@/lib/media/limits";
import {
  FINANCE_DOCUMENT_BUCKET,
  financeDocumentPath,
  isFinanceDocumentPathFor,
} from "@/lib/media/paths";
import { removeObjects } from "@/lib/media/probe";
import { isServable } from "@/lib/media/scan";
import { scanColumns, scanStored } from "@/lib/media/server";
import { recordAccess } from "@/lib/security/access-log";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Finance documents (supplier invoices, voucher backup; bank statements from 20B): prepare -> the browser uploads to a
 * signed URL -> finalise, as Phase 16. Finalise downloads the stored object once to compute its sha256 (the fingerprint
 * approvals are bound to), checks size and content against the declared type, runs the malware-scan hook and refuses a
 * file the organisation already holds. Nothing here logs a file name, a path or the bytes; file names are never stored.
 */

export const FINANCE_DOCUMENT_KINDS = [
  "supplier_invoice",
  "voucher_backup",
  "bank_statement",
  "other",
] as const;
export type FinanceDocumentKind = (typeof FINANCE_DOCUMENT_KINDS)[number];

export const KIND_LABEL: Record<FinanceDocumentKind, string> = {
  supplier_invoice: "Supplier invoice",
  voucher_backup: "Voucher backup",
  bank_statement: "Bank statement",
  other: "Other",
};

type Result<T> = { ok: true; data: T; message?: string } | { ok: false; error: string };

export async function prepareFinanceDocument(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId" | "userId">,
  input: { kind: FinanceDocumentKind; mime: string; size: number },
): Promise<Result<{ documentId: string; path: string; token: string }>> {
  const check = validateMedia({ mime: input.mime, size: input.size }, "finance_document");
  if (!check.ok) return { ok: false, error: check.message };
  const documentId = randomUUID();
  const path = financeDocumentPath(member.orgId, documentId, check.extension);
  const { error } = await admin.from("fin_documents").insert({
    id: documentId,
    org_id: member.orgId,
    kind: input.kind,
    source: "upload",
    storage_path: path,
    mime_type: check.mime,
    size_bytes: input.size,
    uploaded_by: member.userId,
  });
  if (error) return { ok: false, error: "Could not start the upload." };
  const signed = await admin.storage.from(FINANCE_DOCUMENT_BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) {
    await admin.from("fin_documents").delete().eq("id", documentId).eq("status", "pending");
    return { ok: false, error: "Could not prepare the upload." };
  }
  return { ok: true, data: { documentId, path: signed.data.path, token: signed.data.token } };
}

export type FinalizedDocument = {
  id: string;
  kind: string;
  sha256: string;
  size: number;
  scan: string;
  /** Set when the same file was already held: the upload was discarded and this is the existing document. */
  duplicateOf: string | null;
};

export async function finalizeFinanceDocument(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId">,
  id: string,
): Promise<Result<FinalizedDocument>> {
  const { data: doc } = await admin
    .from("fin_documents")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!doc) return { ok: false, error: "That upload was not found." };
  if (doc.status === "ready" && doc.sha256)
    return {
      ok: true,
      data: {
        id: doc.id,
        kind: doc.kind,
        sha256: doc.sha256,
        size: Number(doc.size_bytes),
        scan: doc.scan_status,
        duplicateOf: null,
      },
    };
  if (doc.status !== "pending" || !isFinanceDocumentPathFor(doc.storage_path, member.orgId, doc.id))
    return { ok: false, error: "That upload was not found." };

  const reject = async (message: string) => {
    await removeObjects(admin, FINANCE_DOCUMENT_BUCKET, [doc.storage_path]);
    await admin
      .from("fin_documents")
      .update({ status: "rejected" })
      .eq("id", doc.id)
      .eq("status", "pending");
    return { ok: false as const, error: message };
  };

  const { data: blob, error: dlError } = await admin.storage
    .from(FINANCE_DOCUMENT_BUCKET)
    .download(doc.storage_path);
  if (dlError || !blob) return reject("The file did not arrive. Please try again.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const verdict = inspectStoredObject(
    { declaredMime: doc.mime_type, purpose: "finance_document" },
    { size: bytes.byteLength, contentType: blob.type || null, head: bytes.slice(0, 64) },
  );
  if (!verdict.ok) return reject(verdict.message);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const { data: existing } = await admin
    .from("fin_documents")
    .select("id, kind, size_bytes, scan_status")
    .eq("org_id", member.orgId)
    .eq("sha256", sha256)
    .maybeSingle();
  if (existing) {
    await removeObjects(admin, FINANCE_DOCUMENT_BUCKET, [doc.storage_path]);
    await admin
      .from("fin_documents")
      .update({ status: "rejected" })
      .eq("id", doc.id)
      .eq("status", "pending");
    return {
      ok: true,
      data: {
        id: existing.id,
        kind: existing.kind,
        sha256,
        size: Number(existing.size_bytes),
        scan: existing.scan_status,
        duplicateOf: existing.id,
      },
      message: "This file is already in Pulse; the existing copy is used.",
    };
  }

  const scan = await scanStored(admin, {
    bucket: FINANCE_DOCUMENT_BUCKET,
    path: doc.storage_path,
    size: bytes.byteLength,
    mime: verdict.mime,
  });
  if (scan.verdict === "infected") return reject("The malware scan blocked this file.");
  const { error } = await admin
    .from("fin_documents")
    .update({
      status: "ready",
      sha256,
      size_bytes: bytes.byteLength,
      mime_type: verdict.mime,
      ...scanColumns(scan),
    })
    .eq("id", doc.id)
    .eq("org_id", member.orgId)
    .eq("status", "pending");
  if (error) return { ok: false, error: "Could not save the document." };
  return {
    ok: true,
    data: {
      id: doc.id,
      kind: doc.kind,
      sha256,
      size: bytes.byteLength,
      scan: scan.verdict,
      duplicateOf: null,
    },
    message:
      scan.verdict === "unscanned"
        ? "Saved. No malware scanner is configured, so the file is marked not scanned."
        : "Saved.",
  };
}

/** Removes a pending upload the browser gave up on (never a ready document). */
export async function abandonFinanceDocument(
  admin: AdminClient,
  member: Pick<CurrentMember, "orgId">,
  id: string,
): Promise<boolean> {
  const { data: doc } = await admin
    .from("fin_documents")
    .select("id, storage_path, status")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!doc || doc.status !== "pending") return false;
  await removeObjects(admin, FINANCE_DOCUMENT_BUCKET, [doc.storage_path]);
  await admin.from("fin_documents").delete().eq("id", doc.id).eq("status", "pending");
  return true;
}

/** A 60-second link to one ready document. Every call is written to the access log (ids only). */
export async function signedFinanceDocumentUrl(
  admin: AdminClient,
  member: CurrentMember,
  id: string,
  mode: "view" | "download",
): Promise<Result<{ url: string }>> {
  const { data: doc } = await admin
    .from("fin_documents")
    .select("id, kind, status, scan_status, storage_path")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (
    !doc ||
    doc.status !== "ready" ||
    !isFinanceDocumentPathFor(doc.storage_path, member.orgId, doc.id)
  )
    return { ok: false, error: "Document not found." };
  if (!isServable(doc.scan_status))
    return { ok: false, error: "The malware scan blocked this file." };
  const ext = doc.storage_path.split(".").pop() ?? "bin";
  const { data, error } = await admin.storage
    .from(FINANCE_DOCUMENT_BUCKET)
    .createSignedUrl(
      doc.storage_path,
      60,
      mode === "download"
        ? { download: `${doc.kind.replace(/_/g, "-")}-${doc.id.slice(0, 8)}.${ext}` }
        : undefined,
    );
  if (error || !data) return { ok: false, error: "Could not open the document." };
  await recordAccess(admin, member, {
    entity: "finance_document",
    entityId: doc.id,
    action: mode,
    detail: { kind: doc.kind },
  });
  return { ok: true, data: { url: data.signedUrl } };
}
