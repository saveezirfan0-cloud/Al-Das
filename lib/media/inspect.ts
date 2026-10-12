/**
 * Verifies a stored upload against what the browser declared (pure; unit-tested). The browser sent the file
 * straight to storage, so size, type and content are checked again here before the row is marked ready.
 */
import {
  normaliseMime,
  validateMedia,
  type MediaKind,
  type Purpose,
  type ValidationResult,
} from "@/lib/media/limits";
import { sniffMatches, sniffMime } from "@/lib/media/sniff";

export type StoredObject = {
  size: number;
  /** Content type recorded by storage (informational; the declared type is what we validate). */
  contentType: string | null;
  /** The first bytes of the object. */
  head: Uint8Array;
};

export type InspectInput = {
  declaredMime: string;
  purpose: Purpose;
  expect?: MediaKind;
};

export type InspectResult =
  | { ok: true; size: number; mime: string; extension: string }
  | { ok: false; reason: "validation"; message: string }
  | { ok: false; reason: "content_mismatch"; message: string };

export function inspectStoredObject(input: InspectInput, stored: StoredObject): InspectResult {
  const check: ValidationResult = validateMedia(
    { mime: input.declaredMime, size: stored.size },
    input.purpose,
    input.expect,
  );
  if (!check.ok) return { ok: false, reason: "validation", message: check.message };
  if (!sniffMatches(input.declaredMime, sniffMime(stored.head)))
    return {
      ok: false,
      reason: "content_mismatch",
      message: "The file's content does not match its type, so it was rejected.",
    };
  return {
    ok: true,
    size: stored.size,
    mime: normaliseMime(input.declaredMime),
    extension: check.extension,
  };
}
