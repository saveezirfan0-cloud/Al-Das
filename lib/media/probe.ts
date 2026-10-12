import "server-only";

import type { StoredObject } from "@/lib/media/inspect";

/** The slice of a Supabase storage bucket this module uses (so tests can pass a fake). */
export type BucketLike = {
  info(path: string): PromiseLike<{
    data: { size?: number; contentType?: string } | null;
    error: unknown;
  }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
    options?: { download?: string | boolean },
  ): PromiseLike<{ data: { signedUrl: string } | null; error: unknown }>;
  remove(paths: string[]): PromiseLike<{ error: unknown }>;
};

export type StorageHost = { storage: { from(bucket: string): BucketLike } };

const HEAD_BYTES = 64;

async function readHead(res: Response, n: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array((await res.arrayBuffer()).slice(0, n));
  const reader = res.body.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, n - got);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } finally {
    // The server may have ignored the Range header; never pull the whole file.
    await reader.cancel().catch(() => undefined);
  }
  return out.slice(0, got);
}

/**
 * Looks at a stored object: its real size (from storage metadata) and its first bytes (a ranged read through a
 * 30-second signed URL). Returns null when the object is not there. Nothing is logged: not the path, not the bytes.
 */
export async function probeObject(
  host: StorageHost,
  bucket: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredObject | null> {
  const store = host.storage.from(bucket);
  const { data: info, error } = await store.info(path);
  if (error || !info || typeof info.size !== "number") return null;
  const { data: signed } = await store.createSignedUrl(path, 30);
  if (!signed?.signedUrl) return null;
  const res = await fetchImpl(signed.signedUrl, {
    headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
  });
  if (!res.ok && res.status !== 206) return null;
  const head = await readHead(res, HEAD_BYTES);
  return { size: info.size, contentType: info.contentType ?? null, head };
}

/** Removes objects; returns false when storage reported an error (callers keep the row and retry). */
export async function removeObjects(
  host: StorageHost,
  bucket: string,
  paths: readonly string[],
): Promise<boolean> {
  if (paths.length === 0) return true;
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await host.storage.from(bucket).remove(paths.slice(i, i + 100) as string[]);
    if (error) return false;
  }
  return true;
}
