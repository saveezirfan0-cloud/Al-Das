/**
 * Malware scanning hook (pure interface; no provider is built in).
 *
 * Every upload passes through a `MalwareScanner`. Until a real provider is registered and named in
 * MALWARE_SCAN_PROVIDER, the no-op implementation is used: it inspects nothing and returns "unscanned",
 * and the file is stored with scan_status = 'unscanned'. The UI flags unscanned files, so nobody mistakes
 * "not checked" for "clean". An "infected" verdict quarantines the file: it cannot be opened, downloaded
 * or sent. A provider that errors leaves the file 'error' (also flagged and retryable).
 */

export type ScanVerdict = "clean" | "infected" | "error" | "unscanned";

export type ScanStatus = ScanVerdict;

export type ScanTarget = {
  bucket: string;
  path: string;
  size: number;
  mime: string;
  /** Opens the stored bytes for providers that scan by content (server only; never log them). */
  open: () => Promise<Blob>;
};

export type ScanResult = { verdict: ScanVerdict; engine: string; signature?: string };

export interface MalwareScanner {
  readonly name: string;
  scan(target: ScanTarget): Promise<ScanResult>;
}

export class NoopScanner implements MalwareScanner {
  readonly name = "none";
  async scan(): Promise<ScanResult> {
    return { verdict: "unscanned", engine: "none" };
  }
}

type Factory = () => MalwareScanner;
const providers = new Map<string, Factory>();

/** Registers a provider under a name; select it with MALWARE_SCAN_PROVIDER=<name>. */
export function registerScanProvider(name: string, factory: Factory): void {
  providers.set(name.trim().toLowerCase(), factory);
}

export function clearScanProviders(): void {
  providers.clear();
}

/** The configured scanner. An empty or unknown name gives the no-op scanner (files stay 'unscanned'). */
export function resolveScanner(providerName: string | null | undefined): MalwareScanner {
  const key = (providerName ?? "").trim().toLowerCase();
  const factory = key ? providers.get(key) : undefined;
  return factory ? factory() : new NoopScanner();
}

/** Runs the scanner and never lets a provider failure escape or block an upload. */
export async function runScan(scanner: MalwareScanner, target: ScanTarget): Promise<ScanResult> {
  try {
    const r = await scanner.scan(target);
    const verdicts: ScanVerdict[] = ["clean", "infected", "error", "unscanned"];
    return verdicts.includes(r.verdict) ? r : { verdict: "error", engine: scanner.name };
  } catch {
    return { verdict: "error", engine: scanner.name };
  }
}

/** A quarantined file is never served. 'unscanned' and 'error' are served but flagged. */
export function isServable(status: string | null | undefined): boolean {
  return status !== "infected";
}

export type ScanBadge = { label: string; tone: "ok" | "warn" | "danger"; hint: string };

export function scanBadge(status: string | null | undefined): ScanBadge {
  switch (status) {
    case "clean":
      return { label: "Scanned", tone: "ok", hint: "Checked for malware." };
    case "infected":
      return {
        label: "Blocked",
        tone: "danger",
        hint: "The scanner flagged this file. It cannot be opened or sent.",
      };
    case "error":
      return {
        label: "Scan failed",
        tone: "warn",
        hint: "The malware scan did not finish. Treat the file with care and scan it again.",
      };
    default:
      return {
        label: "Not scanned",
        tone: "warn",
        hint: "No malware scanner is configured, so this file has not been checked.",
      };
  }
}
