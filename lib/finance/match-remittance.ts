import { normalizeInvoiceNumber } from "@/lib/finance/keys";
import type { RemitLine } from "@/lib/finance/parse-remittance";

/**
 * Remittance reconciliation (pure and deterministic): match every payment-advice line to a Diligence claim activity,
 * work out what the payer should have paid, and flag short payments against the payer's agreed price list.
 *
 * Matching: by claim activity number; otherwise by normalised invoice number plus CPT code, narrowed by quantity and the
 * claimed amount; still more than one candidate -> `ambiguous` (never guessed).
 *
 * Expectation (what the payer should have paid for the line):
 *   price list known  -> the agreed price x quantity, but never more than the amount claimed (a payer pays the lesser of
 *                        billed and agreed); basis `price_list`
 *   else              -> the claim's net amount (`claim_net`), else the amount claimed in the advice (`file`), else none
 * A line is SHORT when the expectation exceeds paid + denied by more than BOTH tolerances (an amount and a share of the
 * expectation, from fin_ref_finance_settings): a denied amount is explained by its denial (handled in denial management),
 * a short payment is the part nobody explained. Overpayments are flagged the same way. Money is compared in whole cents.
 * `paid_before` (optional, paid on earlier committed advice) is subtracted from the expectation, so a second payment that
 * completes a part-paid claim is not called short. A NEGATIVE paid amount is a payment taken back (recoupment): flagged
 * `taken_back`, never "short"; its claim goes back to open in lib/finance/claim-status.ts.
 */

export type RemitClaim = {
  id: string;
  claim_activity_number: string;
  invoice_no: string | null;
  cpt_code: string | null;
  payer_id: string | null;
  quantity: number | null;
  net: number | null;
  transaction_date: string | null;
  activity_start_date: string | null;
  /** Paid on earlier committed advice for this claim (a part payment, or a first payment before a resubmission). */
  paid_before?: number | null;
};

export type PriceRow = {
  payer_id: string;
  cpt_code: string;
  agreed_price: number;
  effective_from: string;
  effective_to: string | null;
};

export type RemitSettings = { toleranceAmount: number; tolerancePct: number };

export type MatchStatus = "matched" | "unmatched" | "ambiguous";
export type ExpectedBasis = "price_list" | "claim_net" | "file" | "none";
export type RemitFlag =
  | "short_paid"
  | "overpaid"
  | "denied"
  | "unmatched"
  | "ambiguous"
  | "payer_mismatch"
  | "invoice_mismatch"
  | "billed_below_contract"
  | "billed_above_contract"
  | "duplicate_in_file"
  | "taken_back";

export type ReconciledLine = RemitLine & {
  row_no: number;
  line_key: string;
  claim_activity_id: string | null;
  match_status: MatchStatus;
  match_reason: string;
  expected_amount: number | null;
  expected_basis: ExpectedBasis;
  short_amount: number;
  flags: RemitFlag[];
};

const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;
const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

export function priceFor(
  prices: readonly PriceRow[],
  payerId: string | null,
  cptCode: string | null,
  onDate: string | null,
): number | null {
  if (!payerId || !cptCode) return null;
  const rows = prices.filter(
    (p) => norm(p.payer_id) === norm(payerId) && norm(p.cpt_code) === norm(cptCode),
  );
  if (rows.length === 0) return null;
  const inWindow = rows
    .filter(
      (p) =>
        (onDate === null || p.effective_from <= onDate) &&
        (p.effective_to === null || onDate === null || p.effective_to >= onDate),
    )
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  return inWindow[0]?.agreed_price ?? null;
}

type Match = { status: MatchStatus; reason: string; claim: RemitClaim | null };

function matchLine(
  line: RemitLine,
  byNumber: Map<string, RemitClaim>,
  byInvoiceCpt: Map<string, RemitClaim[]>,
): Match {
  if (line.claim_activity_number) {
    const claim = byNumber.get(norm(line.claim_activity_number));
    if (claim) return { status: "matched", reason: "claim_number", claim };
    // an unknown claim number is not retried by invoice: the advice names a claim we do not hold
    return { status: "unmatched", reason: "no_claim", claim: null };
  }
  const key = `${normalizeInvoiceNumber(line.invoice_no)}|${norm(line.cpt_code)}`;
  let candidates = byInvoiceCpt.get(key) ?? [];
  if (candidates.length === 0) return { status: "unmatched", reason: "no_claim", claim: null };
  if (candidates.length > 1 && line.quantity !== null) {
    const q = candidates.filter(
      (c) => c.quantity !== null && Math.abs(c.quantity - line.quantity!) < 0.0005,
    );
    if (q.length > 0) candidates = q;
  }
  if (candidates.length > 1 && line.claimed_amount !== null) {
    const a = candidates.filter(
      (c) => c.net !== null && cents(c.net) === cents(line.claimed_amount!),
    );
    if (a.length > 0) candidates = a;
  }
  if (candidates.length === 1)
    return { status: "matched", reason: "invoice_and_code", claim: candidates[0] };
  return { status: "ambiguous", reason: "several_claims", claim: null };
}

export function reconcileRemittance(
  lines: readonly RemitLine[],
  claims: readonly RemitClaim[],
  prices: readonly PriceRow[],
  settings: RemitSettings,
): ReconciledLine[] {
  const byNumber = new Map(claims.map((c) => [norm(c.claim_activity_number), c]));
  const byInvoiceCpt = new Map<string, RemitClaim[]>();
  for (const c of claims) {
    const k = `${normalizeInvoiceNumber(c.invoice_no)}|${norm(c.cpt_code)}`;
    const list = byInvoiceCpt.get(k) ?? [];
    list.push(c);
    byInvoiceCpt.set(k, list);
  }

  const seenKeys = new Map<string, number>();
  const seenClaims = new Set<string>();
  return lines.map((line, i): ReconciledLine => {
    const m = matchLine(line, byNumber, byInvoiceCpt);
    const claim = m.claim;
    const flags: RemitFlag[] = [];

    // idempotence key: the advice reference, what was paid for, the date, and the occurrence among identical lines
    const ident = line.claim_activity_number
      ? norm(line.claim_activity_number)
      : `${normalizeInvoiceNumber(line.invoice_no)}|${norm(line.cpt_code)}`;
    const base = `${norm(line.remittance_ref)}|${ident}|${line.paid_on ?? ""}`;
    const occurrence = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, occurrence);

    if (m.status === "unmatched") flags.push("unmatched");
    if (m.status === "ambiguous") flags.push("ambiguous");
    if (claim) {
      const once = `${norm(line.remittance_ref)}|${claim.id}`;
      if (seenClaims.has(once)) flags.push("duplicate_in_file");
      seenClaims.add(once);
      if (line.payer_id && claim.payer_id && norm(line.payer_id) !== norm(claim.payer_id))
        flags.push("payer_mismatch");
      if (
        line.claim_activity_number &&
        line.invoice_no &&
        claim.invoice_no &&
        normalizeInvoiceNumber(line.invoice_no) !== normalizeInvoiceNumber(claim.invoice_no)
      )
        flags.push("invoice_mismatch");
    }

    // expectation
    const payer = claim?.payer_id ?? line.payer_id;
    const cpt = claim?.cpt_code ?? line.cpt_code;
    const onDate = claim?.activity_start_date ?? claim?.transaction_date ?? line.paid_on;
    const qty = claim?.quantity ?? line.quantity ?? 1;
    const claimedCents =
      claim?.net != null
        ? cents(claim.net)
        : line.claimed_amount != null
          ? cents(line.claimed_amount)
          : null;
    const price = priceFor(prices, payer, cpt, onDate);
    let expectedCents: number | null = null;
    let basis: ExpectedBasis = "none";
    if (price !== null) {
      const contract = Math.round(cents(price) * qty);
      expectedCents = claimedCents !== null ? Math.min(contract, claimedCents) : contract;
      basis = "price_list";
      const tol = Math.max(
        cents(settings.toleranceAmount),
        Math.round(contract * settings.tolerancePct),
      );
      if (claimedCents !== null && claimedCents + tol < contract)
        flags.push("billed_below_contract");
      if (claimedCents !== null && claimedCents > contract + tol)
        flags.push("billed_above_contract");
    } else if (claim?.net != null) {
      expectedCents = cents(claim.net);
      basis = "claim_net";
    } else if (line.claimed_amount != null) {
      expectedCents = cents(line.claimed_amount);
      basis = "file";
    }

    // what earlier advice already paid is not expected again (a second payment completes a part-paid claim)
    if (expectedCents !== null && claim?.paid_before)
      expectedCents = Math.max(0, expectedCents - cents(claim.paid_before));
    const paidC = cents(line.paid_amount);
    const deniedC = cents(line.denied_amount);
    if (deniedC > 0 || line.denial_code) flags.push("denied");
    let shortC = 0;
    if (paidC < 0) flags.push("taken_back");
    else if (expectedCents !== null) {
      const tol = Math.max(
        cents(settings.toleranceAmount),
        Math.round(expectedCents * settings.tolerancePct),
      );
      const gap = expectedCents - (paidC + deniedC);
      if (gap > tol) {
        flags.push("short_paid");
        shortC = gap;
      } else if (-gap > tol) flags.push("overpaid");
    }

    return {
      ...line,
      row_no: i + 2,
      line_key: `${base}|${occurrence}`,
      claim_activity_id: claim?.id ?? null,
      match_status: m.status,
      match_reason: m.reason,
      expected_amount: expectedCents === null ? null : fromCents(expectedCents),
      expected_basis: basis,
      short_amount: fromCents(shortC),
      flags,
    };
  });
}

export type ReconciliationSummary = {
  lines: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  short: number;
  overpaid: number;
  sumPaid: number;
  sumExpected: number;
  sumShort: number;
};

export function summariseReconciliation(rows: readonly ReconciledLine[]): ReconciliationSummary {
  const c = (n: number) => Math.round(n * 100) / 100;
  return {
    lines: rows.length,
    matched: rows.filter((r) => r.match_status === "matched").length,
    unmatched: rows.filter((r) => r.match_status === "unmatched").length,
    ambiguous: rows.filter((r) => r.match_status === "ambiguous").length,
    short: rows.filter((r) => r.flags.includes("short_paid")).length,
    overpaid: rows.filter((r) => r.flags.includes("overpaid")).length,
    sumPaid: c(rows.reduce((a, r) => a + r.paid_amount, 0)),
    sumExpected: c(rows.reduce((a, r) => a + (r.expected_amount ?? 0), 0)),
    sumShort: c(rows.reduce((a, r) => a + r.short_amount, 0)),
  };
}
