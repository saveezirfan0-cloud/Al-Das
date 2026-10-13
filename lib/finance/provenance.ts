/**
 * Every measure shows where it comes from, when it was refreshed, what period it covers and what is unresolved
 * (Integration Blueprint v2, p5: "management intelligence without false precision"). Pure.
 */

export type ProvenanceFacts = {
  lastCaptureAt: string | null;
  captureEnabled: boolean;
  lastImportAt: string | null;
  lastRemittanceAt: string | null;
  firstInvoiceDate: string | null;
  lastInvoiceDate: string | null;
  firstClaimDate: string | null;
  lastClaimDate: string | null;
  openExceptions: number;
  escalatedExceptions: number;
};

export type SourceKey = "unite" | "diligence" | "remittance" | "costs";

export type Provenance = {
  sources: Array<{ key: SourceKey; label: string; refreshedAt: string | null; note?: string }>;
  coverage: Array<{ label: string; from: string | null; to: string | null }>;
  openExceptions: number;
  escalatedExceptions: number;
  /** things that make the numbers incomplete for the chosen range */
  cautions: string[];
};

const LABEL: Record<SourceKey, string> = {
  unite: "Unite invoices",
  diligence: "Diligence claims",
  remittance: "Payer remittances",
  costs: "Finance costs",
};

/** `range` is the period shown (yyyy-mm-dd, inclusive). */
export function buildProvenance(
  f: ProvenanceFacts,
  uses: readonly SourceKey[],
  range?: { from: string; to: string },
): Provenance {
  const sources: Provenance["sources"] = [];
  const coverage: Provenance["coverage"] = [];
  const cautions: string[] = [];

  for (const key of uses) {
    if (key === "unite") {
      sources.push({
        key,
        label: LABEL.unite,
        refreshedAt: f.lastCaptureAt,
        note: f.captureEnabled ? undefined : "capture is off",
      });
      coverage.push({ label: "Invoices", from: f.firstInvoiceDate, to: f.lastInvoiceDate });
      if (!f.firstInvoiceDate) cautions.push("No invoices have been captured yet.");
      else if (range && range.from < f.firstInvoiceDate)
        cautions.push(
          `Invoices on record start on ${f.firstInvoiceDate}; earlier dates in this range are incomplete.`,
        );
    } else if (key === "diligence") {
      sources.push({ key, label: LABEL.diligence, refreshedAt: f.lastImportAt });
      coverage.push({ label: "Claims", from: f.firstClaimDate, to: f.lastClaimDate });
      if (!f.firstClaimDate) cautions.push("No Diligence claims file has been imported yet.");
      else if (range && range.from < f.firstClaimDate)
        cautions.push(
          `Claims on record start on ${f.firstClaimDate}; earlier dates in this range are incomplete.`,
        );
    } else if (key === "remittance") {
      sources.push({
        key,
        label: LABEL.remittance,
        refreshedAt: f.lastRemittanceAt,
        note: f.lastRemittanceAt ? undefined : "none reconciled yet",
      });
    } else {
      sources.push({ key, label: LABEL.costs, refreshedAt: null, note: "maintained by Finance" });
    }
  }
  return {
    sources,
    coverage,
    openExceptions: f.openExceptions,
    escalatedExceptions: f.escalatedExceptions,
    cautions,
  };
}
