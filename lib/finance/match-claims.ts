import { normalizeInvoiceNumber } from "@/lib/finance/keys";

/**
 * Match Diligence claim activities to Unite invoices and invoice lines. Pure and deterministic.
 *
 *  claim -> invoice : normalised InvoiceNo equals the invoice's inv_key (case/whitespace insensitive)
 *  claim -> line    : same invoice, claim CPT equals the line's CPT code OR item code, and the claim's
 *                     initial net equals the line net within 0.01
 *  several lines    : claims and lines that share the same candidate set are paired in order
 *                     (claims by activity date then number, lines by position), quantity first;
 *                     if the counts differ the whole group is `ambiguous` (never guessed)
 */

export type LineCandidate = {
  id: string;
  position: number;
  item_code: string | null;
  cpt_code: string | null;
  qty: number | null;
  line_net: number | null;
};

export type InvoiceCandidate = {
  id: string;
  inv_key: string;
  is_deleted: boolean;
  doctor_dha_id: string | null;
  lines: LineCandidate[]; // current lines only
};

export type ClaimToMatch = {
  id: string;
  claim_activity_number: string;
  invoice_no: string | null;
  cpt_code: string | null;
  initial_net: number | null;
  net: number | null;
  quantity: number | null;
  clinician_id: string | null;
  activity_start_date: string | null;
};

export type MatchStatus = "matched" | "ambiguous" | "unmatched";
export type MatchReason =
  | "ok"
  | "no_invoice"
  | "invoice_deleted"
  | "no_line"
  | "amount_mismatch"
  | "ambiguous"
  | "quantity_mismatch";

export type MatchResult = {
  claim_id: string;
  invoice_id: string | null;
  line_id: string | null;
  status: MatchStatus;
  reason: MatchReason;
  clinician_mismatch: boolean;
};

export const AMOUNT_TOLERANCE = 0.01;
/** Compare in whole cents so 100 vs 100.01 is exactly one cent (not 0.0100000000000051). */
const withinTolerance = (a: number, b: number) =>
  Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= Math.round(AMOUNT_TOLERANCE * 100);
const QTY_TOLERANCE = 0.001;

const code = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();
const sameQty = (a: number | null, b: number | null) =>
  a === null || b === null || Math.abs(a - b) < QTY_TOLERANCE;

function clinicianMismatch(claim: ClaimToMatch, invoice: InvoiceCandidate): boolean {
  const a = code(claim.clinician_id);
  const b = code(invoice.doctor_dha_id);
  return a !== "" && b !== "" && a !== b;
}

export function matchClaims(
  claims: readonly ClaimToMatch[],
  invoices: readonly InvoiceCandidate[],
): MatchResult[] {
  const byKey = new Map(invoices.map((i) => [i.inv_key, i]));
  const results = new Map<string, MatchResult>();
  const perInvoice = new Map<string, ClaimToMatch[]>();

  for (const claim of claims) {
    const invoice = byKey.get(normalizeInvoiceNumber(claim.invoice_no));
    if (!invoice) {
      results.set(claim.id, {
        claim_id: claim.id,
        invoice_id: null,
        line_id: null,
        status: "unmatched",
        reason: "no_invoice",
        clinician_mismatch: false,
      });
      continue;
    }
    if (invoice.is_deleted) {
      results.set(claim.id, {
        claim_id: claim.id,
        invoice_id: invoice.id,
        line_id: null,
        status: "unmatched",
        reason: "invoice_deleted",
        clinician_mismatch: clinicianMismatch(claim, invoice),
      });
      continue;
    }
    const list = perInvoice.get(invoice.id) ?? [];
    list.push(claim);
    perInvoice.set(invoice.id, list);
  }

  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  for (const [invoiceId, group] of perInvoice) {
    const invoice = invoiceById.get(invoiceId) as InvoiceCandidate;
    const sortedLines = [...invoice.lines].sort((a, b) => a.position - b.position);
    const sortedClaims = [...group].sort(
      (a, b) =>
        (a.activity_start_date ?? "").localeCompare(b.activity_start_date ?? "") ||
        a.claim_activity_number.localeCompare(b.claim_activity_number),
    );

    // candidate lines per claim, then bucket claims that share the same candidate set
    const buckets = new Map<string, { lines: LineCandidate[]; claims: ClaimToMatch[] }>();
    for (const claim of sortedClaims) {
      const claimCode = code(claim.cpt_code);
      const withCode = sortedLines.filter(
        (l) =>
          claimCode !== "" && (code(l.cpt_code) === claimCode || code(l.item_code) === claimCode),
      );
      const amount = claim.initial_net ?? claim.net;
      const candidates = withCode.filter(
        (l) => amount !== null && l.line_net !== null && withinTolerance(l.line_net, amount),
      );
      const mismatch = clinicianMismatch(claim, invoice);
      if (withCode.length === 0) {
        results.set(claim.id, {
          claim_id: claim.id,
          invoice_id: invoice.id,
          line_id: null,
          status: "unmatched",
          reason: "no_line",
          clinician_mismatch: mismatch,
        });
      } else if (candidates.length === 0) {
        results.set(claim.id, {
          claim_id: claim.id,
          invoice_id: invoice.id,
          line_id: null,
          status: "unmatched",
          reason: "amount_mismatch",
          clinician_mismatch: mismatch,
        });
      } else {
        const signature = candidates.map((l) => l.id).join(",");
        const bucket = buckets.get(signature) ?? { lines: candidates, claims: [] };
        bucket.claims.push(claim);
        buckets.set(signature, bucket);
      }
    }

    // lines reachable from more than one bucket would be double-assigned: treat all such buckets as ambiguous
    const lineUse = new Map<string, number>();
    for (const b of buckets.values())
      for (const l of b.lines) lineUse.set(l.id, (lineUse.get(l.id) ?? 0) + 1);

    for (const bucket of buckets.values()) {
      const shared = bucket.lines.some((l) => (lineUse.get(l.id) ?? 0) > 1);
      const markAll = (reason: MatchReason) => {
        for (const claim of bucket.claims)
          results.set(claim.id, {
            claim_id: claim.id,
            invoice_id: invoice.id,
            line_id: null,
            status: "ambiguous",
            reason,
            clinician_mismatch: clinicianMismatch(claim, invoice),
          });
      };
      if (shared || bucket.claims.length !== bucket.lines.length) {
        markAll("ambiguous");
        continue;
      }
      // quantity first, then position order for whatever is left
      const free = [...bucket.lines];
      const pairs = new Map<string, LineCandidate>();
      const pending: ClaimToMatch[] = [];
      for (const claim of bucket.claims) {
        const at = free.findIndex(
          (l) => l.qty !== null && claim.quantity !== null && sameQty(l.qty, claim.quantity),
        );
        if (at >= 0) pairs.set(claim.id, free.splice(at, 1)[0]);
        else pending.push(claim);
      }
      for (const claim of pending) pairs.set(claim.id, free.shift() as LineCandidate);
      for (const claim of bucket.claims) {
        const line = pairs.get(claim.id) as LineCandidate;
        results.set(claim.id, {
          claim_id: claim.id,
          invoice_id: invoice.id,
          line_id: line.id,
          status: "matched",
          reason: sameQty(line.qty, claim.quantity) ? "ok" : "quantity_mismatch",
          clinician_mismatch: clinicianMismatch(claim, invoice),
        });
      }
    }
  }

  return claims.map((c) => results.get(c.id) as MatchResult);
}
