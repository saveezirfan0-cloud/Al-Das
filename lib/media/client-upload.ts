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
