/**
 * What may be uploaded, for each purpose (pure; unit-tested). Used by the browser (to refuse before
 * uploading), by the server actions (the browser is never trusted) and by the finalise step, which checks
 * the stored object again.
 *
 * WhatsApp Cloud API limits for message media: image 5 MB (JPEG, PNG), video 16 MB (MP4, 3GPP),
 * document 100 MB (PDF, Office files, plain text). Template header samples follow Meta's narrower list.
 */

export const MB = 1024 * 1024;

export type MediaKind = "image" | "video" | "document";

export type KindRule = {
  maxBytes: number;
  /** mime -> file extension */
  types: Readonly<Record<string, string>>;
};

export const WHATSAPP_LIMITS: Readonly<Record<MediaKind, KindRule>> = {
  image: { maxBytes: 5 * MB, types: { "image/jpeg": "jpg", "image/png": "png" } },
  video: { maxBytes: 16 * MB, types: { "video/mp4": "mp4", "video/3gpp": "3gp" } },
  document: {
    maxBytes: 100 * MB,
    types: {
      "application/pdf": "pdf",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.ms-powerpoint": "ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "text/plain": "txt",
    },
  },
};

/** Template header media: Meta accepts JPEG/PNG images, MP4 video and PDF documents as header formats. */
export const TEMPLATE_HEADER_TYPES: Readonly<Record<MediaKind, readonly string[]>> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  document: ["application/pdf"],
};

/** Patient documents are not sent over WhatsApp, so they follow the clinic's needs, not Meta's. */
export const PATIENT_DOCUMENT_MAX_BYTES = 25 * MB;
export const PATIENT_DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export type Purpose = "library" | "template_header" | "patient_document";

export type ValidationCode = "empty" | "unsupported_type" | "too_large" | "wrong_kind" | "bad_size";

export type ValidationResult =
  | { ok: true; kind: MediaKind | "patient_document"; extension: string; mime: string }
  | { ok: false; code: ValidationCode; message: string };

/** Normalises a declared content type: lower case, no parameters ("image/JPEG; charset=x" -> "image/jpeg"). */
export function normaliseMime(mime: string | null | undefined): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

/** Which WhatsApp media kind a content type belongs to, or null when WhatsApp cannot carry it. */
export function kindForMime(mime: string | null | undefined): MediaKind | null {
  const m = normaliseMime(mime);
  for (const kind of ["image", "video", "document"] as const) {
    if (m in WHATSAPP_LIMITS[kind].types) return kind;
  }
  return null;
}

export function extensionForMime(mime: string | null | undefined): string | null {
  const m = normaliseMime(mime);
  for (const kind of ["image", "video", "document"] as const) {
    const ext = WHATSAPP_LIMITS[kind].types[m];
    if (ext) return ext;
  }
  return PATIENT_DOCUMENT_TYPES[m] ?? null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
}

const fail = (code: ValidationCode, message: string): ValidationResult => ({
  ok: false,
  code,
  message,
});

/**
 * Checks a file's declared type and size for a purpose. For `template_header` pass the header format the
 * template needs (`expect`), so a PDF cannot be picked for an image header.
 */
export function validateMedia(
  file: { mime: string | null | undefined; size: number },
  purpose: Purpose,
  expect?: MediaKind,
): ValidationResult {
  const mime = normaliseMime(file.mime);
  if (!Number.isFinite(file.size) || !Number.isInteger(file.size) || file.size < 0)
    return fail("bad_size", "The file size is not valid.");
  if (file.size === 0) return fail("empty", "The file is empty.");

  if (purpose === "patient_document") {
    const ext = PATIENT_DOCUMENT_TYPES[mime];
    if (!ext)
      return fail("unsupported_type", "Use a PDF, a photo (JPEG, PNG, WebP, HEIC) or a Word file.");
    if (file.size > PATIENT_DOCUMENT_MAX_BYTES)
      return fail(
        "too_large",
        `That file is ${formatBytes(file.size)}. Documents can be up to ${formatBytes(PATIENT_DOCUMENT_MAX_BYTES)}.`,
      );
    return { ok: true, kind: "patient_document", extension: ext, mime };
  }

  const kind = kindForMime(mime);
  if (!kind)
    return fail(
      "unsupported_type",
      "WhatsApp cannot send that type. Use JPEG or PNG images, MP4 video, or a PDF or Office document.",
    );
  if (expect && kind !== expect)
    return fail(
      "wrong_kind",
      `This needs ${article(expect)} ${expect}, not ${article(kind)} ${kind}.`,
    );
  if (purpose === "template_header" && !TEMPLATE_HEADER_TYPES[kind].includes(mime))
    return fail(
      "unsupported_type",
      "Template headers accept JPEG or PNG images, MP4 video or a PDF.",
    );
  const rule = WHATSAPP_LIMITS[kind];
  if (file.size > rule.maxBytes)
    return fail(
      "too_large",
      `That ${kind} is ${formatBytes(file.size)}. WhatsApp allows ${formatBytes(rule.maxBytes)} for ${kind}s.`,
    );
  return { ok: true, kind, extension: rule.types[mime], mime };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** Largest upload any purpose accepts: the bucket's own file-size limit is set from this. */
export const LIBRARY_BUCKET_MAX_BYTES = WHATSAPP_LIMITS.document.maxBytes;
