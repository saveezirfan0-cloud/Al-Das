import { createClient } from "@/lib/supabase/client";

/** Sends bytes to a signed upload URL made by the server. Returns an error message, or null on success. */
export async function putToSignedUrl(
  bucket: string,
  path: string,
  token: string,
  blob: Blob,
  contentType: string,
): Promise<string | null> {
  const { error } = await createClient()
    .storage.from(bucket)
    .uploadToSignedUrl(path, token, blob, { contentType, upsert: false });
  return error ? "The upload did not complete. Check the connection and try again." : null;
}

/** Image types the browser can turn into a JPEG or PNG for WhatsApp. GIF is left out: it would lose its animation. */
export const CONVERTIBLE_IMAGE = /^image\/(jpeg|jpg|png|webp|heic|heif|bmp)$/i;

/** "IMG_0042.jpeg" -> "IMG_0042" (the display name; the extension comes from the content type). */
export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName)
    .replace(/[\u0000-\u001f]/g, " ")
    .trim();
  return (base || "Untitled").slice(0, 120);
}
