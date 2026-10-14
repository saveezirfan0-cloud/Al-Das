/**
 * Storage paths for the Media Library and patient documents (pure). Same idea as lib/inbox/media-path.ts:
 * paths arrive from the browser and are used by the service role, so they are parsed strictly (fixed number
 * of segments, UUIDs, a plain file name, no traversal) and always compared with the caller's org.
 *
 *   media-library       <org>/<asset>/<file>           file = original.<ext> | thumb.jpg
 *   patient-documents   <org>/<contact>/<document>.<ext>
 *   finance-documents   <org>/<document>.<ext>             (supplier invoices, voucher backup, statements)
 *
 * File names chosen by people are never part of a path (they can contain a patient's name); the display
 * name lives in the database.
 */

export const LIBRARY_BUCKET = "media-library";
export const DOCUMENT_BUCKET = "patient-documents";
export const FINANCE_DOCUMENT_BUCKET = "finance-documents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = /^[a-z0-9]{1,5}$/;
const LIBRARY_FILE = /^(original\.[a-z0-9]{1,5}|thumb\.jpg)$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export type LibraryPathParts = {
  orgId: string;
  assetId: string;
  file: string;
  variant: "original" | "thumb";
};

export function parseLibraryPath(path: string): LibraryPathParts | null {
  if (typeof path !== "string" || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const [orgId, assetId, file] = parts;
  if (!UUID.test(orgId) || !UUID.test(assetId)) return null;
  if (!LIBRARY_FILE.test(file)) return null;
  return {
    orgId: orgId.toLowerCase(),
    assetId: assetId.toLowerCase(),
    file,
    variant: file.startsWith("thumb") ? "thumb" : "original",
  };
}

export function libraryObjectPath(
  orgId: string,
  assetId: string,
  variant: "original" | "thumb",
  extension = "jpg",
): string {
  if (!UUID.test(orgId) || !UUID.test(assetId)) throw new Error("invalid id in storage path");
  if (variant === "thumb") return `${orgId}/${assetId}/thumb.jpg`;
  if (!EXT.test(extension)) throw new Error("invalid extension");
  return `${orgId}/${assetId}/original.${extension}`;
}

export function isLibraryPathFor(path: string, orgId: string, assetId: string): boolean {
  const p = parseLibraryPath(path);
  return !!p && p.orgId === orgId.toLowerCase() && p.assetId === assetId.toLowerCase();
}

export type DocumentPathParts = {
  orgId: string;
  contactId: string;
  documentId: string;
  extension: string;
};

export function parseDocumentPath(path: string): DocumentPathParts | null {
  if (typeof path !== "string" || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const [orgId, contactId, file] = parts;
  if (!UUID.test(orgId) || !UUID.test(contactId)) return null;
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  const documentId = file.slice(0, dot);
  const extension = file.slice(dot + 1);
  if (!UUID.test(documentId) || !EXT.test(extension)) return null;
  return {
    orgId: orgId.toLowerCase(),
    contactId: contactId.toLowerCase(),
    documentId: documentId.toLowerCase(),
    extension,
  };
}

export function documentObjectPath(
  orgId: string,
  contactId: string,
  documentId: string,
  extension: string,
): string {
  if (![orgId, contactId, documentId].every((v) => UUID.test(v)))
    throw new Error("invalid id in storage path");
  if (!EXT.test(extension)) throw new Error("invalid extension");
  return `${orgId}/${contactId}/${documentId}.${extension}`;
}

/**
 * True when `path` is a well-formed document path in this org for exactly this document. The patient segment is
 * deliberately not compared: merging two patient records moves a document to the surviving patient but not its file.
 */
export function isDocumentPathInOrg(path: string, orgId: string, documentId: string): boolean {
  const p = parseDocumentPath(path);
  return !!p && p.orgId === orgId.toLowerCase() && p.documentId === documentId.toLowerCase();
}

/** True when `path` is a well-formed document path inside exactly this org and patient. */
export function isDocumentPathFor(
  path: string,
  orgId: string,
  contactId: string,
  documentId?: string,
): boolean {
  const p = parseDocumentPath(path);
  return (
    !!p &&
    p.orgId === orgId.toLowerCase() &&
    p.contactId === contactId.toLowerCase() &&
    (documentId === undefined || p.documentId === documentId.toLowerCase())
  );
}

/** The media source stored in template and campaign variable maps: "media:<asset id>". */
export const MEDIA_SOURCE_PREFIX = "media:";

export function mediaSource(assetId: string): string {
  if (!UUID.test(assetId)) throw new Error("invalid asset id");
  return `${MEDIA_SOURCE_PREFIX}${assetId.toLowerCase()}`;
}

/** Parses "media:<uuid>" -> the asset id, or null for anything else (a link, a mapping, junk). */
export function parseMediaSource(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith(MEDIA_SOURCE_PREFIX)) return null;
  const id = value.slice(MEDIA_SOURCE_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

export type FinanceDocumentPathParts = { orgId: string; documentId: string; extension: string };

export function parseFinanceDocumentPath(path: string): FinanceDocumentPathParts | null {
  if (typeof path !== "string" || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  const [orgId, file] = parts;
  if (!UUID.test(orgId)) return null;
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  const documentId = file.slice(0, dot);
  const extension = file.slice(dot + 1);
  if (!UUID.test(documentId) || !EXT.test(extension)) return null;
  return { orgId: orgId.toLowerCase(), documentId: documentId.toLowerCase(), extension };
}

export function financeDocumentPath(orgId: string, documentId: string, extension: string): string {
  if (![orgId, documentId].every((v) => UUID.test(v))) throw new Error("invalid id in storage path");
  if (!EXT.test(extension)) throw new Error("invalid extension");
  return `${orgId.toLowerCase()}/${documentId.toLowerCase()}.${extension}`;
}

/** True when `path` is a well-formed finance document path for exactly this org and document. */
export function isFinanceDocumentPathFor(path: string, orgId: string, documentId: string): boolean {
  const p = parseFinanceDocumentPath(path);
  return !!p && p.orgId === orgId.toLowerCase() && p.documentId === documentId.toLowerCase();
}
