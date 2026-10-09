/** Header sample files for templates: allowed types, size limits and storage paths. Pure. */
import type { MediaFormat } from "@/lib/whatsapp/template-builder";

const MB = 1024 * 1024;

const TYPES: Record<string, { format: MediaFormat; max: number; ext: string }> = {
  "image/jpeg": { format: "IMAGE", max: 5 * MB, ext: "jpg" },
  "image/png": { format: "IMAGE", max: 5 * MB, ext: "png" },
  "video/mp4": { format: "VIDEO", max: 16 * MB, ext: "mp4" },
  "application/pdf": { format: "DOCUMENT", max: 15 * MB, ext: "pdf" },
};

/** Accepts only what WhatsApp templates allow for the chosen header format. */
export function checkSample(
  mimeType: string,
  size: number,
  expected: MediaFormat | readonly MediaFormat[],
): { ok: true; format: MediaFormat; ext: string } | { ok: false; error: string } {
  const info = TYPES[mimeType.toLowerCase()];
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!info || !(allowed as readonly MediaFormat[]).includes(info.format)) {
    const names = allowed.map((f) => f.toLowerCase()).join(" or ");
    return { ok: false, error: `Upload a ${names} file (JPEG/PNG, MP4 or PDF).` };
  }
  if (size <= 0) return { ok: false, error: "The file is empty." };
  if (size > info.max)
    return {
      ok: false,
      error: `${info.format.toLowerCase()} samples are limited to ${Math.round(info.max / MB)} MB.`,
    };
  return { ok: true, format: info.format, ext: info.ext };
}

/** Storage path inside the private wa-media bucket: <org>/templates/<id>.<ext>. */
export function sampleStoragePath(orgId: string, id: string, ext: string): string {
  return `${orgId}/templates/${id}.${ext}`;
}

/** True when `path` is a template sample inside this org's folder (no traversal). */
export function isOwnSamplePath(orgId: string, path: string): boolean {
  return path.startsWith(`${orgId}/templates/`) && !path.includes("..") && !path.includes("//");
}
