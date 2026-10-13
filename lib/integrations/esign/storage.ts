import "server-only";

import type { StoredObject } from "@/lib/media/inspect";
import { probeObject, removeObjects } from "@/lib/media/probe";
import type { ScanResult } from "@/lib/media/scan";
import { configuredScanner, scanStored } from "@/lib/media/server";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The storage steps the e-signature flow needs, behind an interface so the database tests can run without a storage service. The real
 * implementation uses the private buckets through the service role; nothing here logs a path, a title or bytes.
 */
export interface EsignStorage {
  /** A short-lived download link for the provider (null if the object cannot be read). */
  signedUrl(bucket: string, path: string, seconds: number): Promise<string | null>;
  upload(bucket: string, path: string, bytes: Uint8Array, mime: string): Promise<boolean>;
  /** The stored object's real size and first bytes (null when it is not there). */
  probe(bucket: string, path: string): Promise<StoredObject | null>;
  remove(bucket: string, paths: string[]): Promise<boolean>;
  /** The malware scan hook; "unscanned" until a provider is configured (MALWARE_SCAN_PROVIDER). */
  scan(target: { bucket: string; path: string; size: number; mime: string }): Promise<ScanResult>;
}

export function supabaseEsignStorage(admin: AdminClient): EsignStorage {
  return {
    async signedUrl(bucket, path, seconds) {
      const { data } = await admin.storage.from(bucket).createSignedUrl(path, seconds);
      return data?.signedUrl ?? null;
    },
    async upload(bucket, path, bytes, mime) {
      const { error } = await admin.storage
        .from(bucket)
        .upload(path, bytes, { contentType: mime, upsert: true });
      return !error;
    },
    probe: (bucket, path) => probeObject(admin, bucket, path),
    remove: (bucket, paths) => removeObjects(admin, bucket, paths),
    scan: (target) => scanStored(admin, target, configuredScanner()),
  };
}
