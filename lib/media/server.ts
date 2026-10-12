import "server-only";

import { resolveScanner, runScan, type MalwareScanner, type ScanResult } from "@/lib/media/scan";
import type { StorageHost } from "@/lib/media/probe";

/**
 * The configured malware scanner. MALWARE_SCAN_PROVIDER names a provider registered with registerScanProvider();
 * without one, files are stored 'unscanned' and flagged in the UI (see lib/media/scan.ts).
 */
export function configuredScanner(): MalwareScanner {
  return resolveScanner(process.env.MALWARE_SCAN_PROVIDER);
}

export function scannerLabel(): string {
  const s = configuredScanner();
  return s.name === "none" ? "No scanner configured" : s.name;
}

/** Scans a stored object. The bytes are fetched lazily through a short signed URL and never logged. */
export async function scanStored(
  host: StorageHost,
  target: { bucket: string; path: string; size: number; mime: string },
  scanner: MalwareScanner = configuredScanner(),
): Promise<ScanResult> {
  return runScan(scanner, {
    ...target,
    open: async () => {
      const { data } = await host.storage.from(target.bucket).createSignedUrl(target.path, 60);
      if (!data?.signedUrl) throw new Error("object not readable");
      const res = await fetch(data.signedUrl);
      if (!res.ok) throw new Error("object not readable");
      return res.blob();
    },
  });
}

/** `scan_status` column values for a verdict. */
export function scanColumns(r: ScanResult): {
  scan_status: "unscanned" | "clean" | "infected" | "error";
  scanned_at: string | null;
  scan_engine: string | null;
} {
  return {
    scan_status: r.verdict,
    scanned_at: r.verdict === "unscanned" ? null : new Date().toISOString(),
    scan_engine: r.engine === "none" ? null : r.engine.slice(0, 40),
  };
}

/** A safe download file name built from a person-typed title: letters, digits, dashes; no path characters. */
export function downloadName(title: string, extension: string): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document";
  const ext = extension.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
  return `${base}.${ext}`;
}
