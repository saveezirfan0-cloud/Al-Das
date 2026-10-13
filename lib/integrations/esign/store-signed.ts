import "server-only";

import { deterministicUuid } from "@/lib/integrations/esign/signer";
import type { EsignStorage } from "@/lib/integrations/esign/storage";
import { inspectStoredObject } from "@/lib/media/inspect";
import { validateMedia } from "@/lib/media/limits";
import { DOCUMENT_BUCKET, documentObjectPath, isUuid } from "@/lib/media/paths";
import { scanColumns } from "@/lib/media/server";
import { sniffMatches, sniffMime } from "@/lib/media/sniff";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Stores a signed PDF as a normal patient document (category "consent") through the same checks as an upload (docs/15): declared size and
 * type, the stored object's real size and first bytes, then the malware-scan hook, and only then "ready". The document id comes from the
 * request id, so a provider retry or a job run twice produces one document, never two. Nothing is logged.
 */
export type StoreSignedResult =
  | { ok: true; documentId: string; scanStatus: string; created: boolean }
  | { ok: false; reason: "not_a_pdf" | "too_large" | "storage_failed" | "rejected" };

export async function storeSignedPdf(
  admin: AdminClient,
  storage: EsignStorage,
  a: {
    orgId: string;
    contactId: string;
    requestId: string;
    bytes: Uint8Array;
    title: string;
    uploadedBy: string | null;
  },
): Promise<StoreSignedResult> {
  const documentId = deterministicUuid(`esign-signed:${a.requestId}`);
  if (!isUuid(a.orgId) || !isUuid(a.contactId)) return { ok: false, reason: "rejected" };

  const { data: existing } = await admin
    .from("patient_documents")
    .select("id, status, scan_status")
    .eq("id", documentId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (existing?.status === "ready")
    return { ok: true, documentId, scanStatus: existing.scan_status, created: false };

  const declared = validateMedia(
    { mime: "application/pdf", size: a.bytes.length },
    "patient_document",
  );
  if (!declared.ok)
    return { ok: false, reason: declared.code === "too_large" ? "too_large" : "not_a_pdf" };
  if (!sniffMatches("application/pdf", sniffMime(a.bytes.subarray(0, 64))))
    return { ok: false, reason: "not_a_pdf" };

  const path = documentObjectPath(a.orgId, a.contactId, documentId, "pdf");
  if (!existing) {
    const { error } = await admin.from("patient_documents").insert({
      id: documentId,
      org_id: a.orgId,
      contact_id: a.contactId,
      category: "consent",
      title: a.title.slice(0, 120),
      mime_type: "application/pdf",
      size_bytes: a.bytes.length,
      storage_path: path,
      status: "pending",
      uploaded_by: a.uploadedBy,
    });
    // A concurrent delivery of the same event inserted it first: carry on with that row.
    if (error && error.code !== "23505") return { ok: false, reason: "storage_failed" };
  }

  const fail = async (reason: "storage_failed" | "rejected"): Promise<StoreSignedResult> => {
    await storage.remove(DOCUMENT_BUCKET, [path]);
    await admin.from("patient_documents").delete().eq("id", documentId).eq("status", "pending");
    return { ok: false, reason };
  };

  if (!(await storage.upload(DOCUMENT_BUCKET, path, a.bytes, "application/pdf")))
    return fail("storage_failed");
  const stored = await storage.probe(DOCUMENT_BUCKET, path);
  if (!stored) return fail("storage_failed");
  const verdict = inspectStoredObject(
    { declaredMime: "application/pdf", purpose: "patient_document" },
    stored,
  );
  if (!verdict.ok) return fail("rejected");
  const scan = await storage.scan({
    bucket: DOCUMENT_BUCKET,
    path,
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
    .eq("id", documentId)
    .eq("org_id", a.orgId);
  if (error) return fail("storage_failed");
  // An infected file is kept (so the staff can see it was blocked) but is never served: getDocumentUrl refuses it.
  return { ok: true, documentId, scanStatus: scan.verdict, created: true };
}
