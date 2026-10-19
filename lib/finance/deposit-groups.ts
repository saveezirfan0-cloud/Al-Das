import {
  depositGroupKey,
  depositGroupMembers,
  groupExpectedItem,
  scoreCandidate,
  type BankLine,
  type Candidate,
  type DepositGroupArgs,
  type DepositGroupResult,
  type ExpectedItem,
  type Proposal,
  type RemittanceBatch,
} from "@/lib/finance/bank-recon";
import {
  matchDeposit,
  type DepositCandidate,
  type DepositSettings,
  type InsurancePayment,
} from "@/lib/finance/deposit-match";

/**
 * Insurer payments in the monthly bank run (pure, deterministic). Two pieces:
 *
 * 1. `splitRemittanceByReference`: an insurer pays per payment REFERENCE, while an advice file can hold several. The
 *    run's insurance items used to be one per file (`ins|<batch id>`); a file whose committed lines carry several
 *    references (or payers) now gives one item per reference (`ins|<batch id>|<8 hex>`). A file with one reference
 *    keeps its key, so saved matches stay valid. It fails closed: when the parts do not add up to the file's total to
 *    the cent, two parts share an id, or a part is not a positive amount (a take-back), the file stays one item.
 *
 * 2. `depositGroupSearch`: for bank credits that no single item fits, `matchDeposit` looks for a group of insurer
 *    payments (2 to `maxParts`, one payer) whose total does. Every group is a PROPOSAL a person accepts or rejects in
 *    the run (the same decision path as any proposal); none is automatic. A credit that several groups fit, a group
 *    whose payment is also offered to another credit, or a credit a single payment might also explain is marked
 *    ambiguous ("Several fit"). `maxParts` and `maxPool` are fin_ref_finance_settings.bank_deposit_max_parts / _pool.
 */

export type RemittanceRefPart = {
  batchId: string;
  ref: string | null;
  payerId: string | null;
  paidOn: string | null;
  amount: number;
  lines: number;
};

export type SplitRemittance = RemittanceBatch & { batchId: string };

const cents = (n: number) => Math.round(n * 100);
const normPart = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** FNV-1a (32 bit) of the part's reference and payer: a short, stable suffix that needs no other part to compute. */
export function refPartSuffix(ref: string | null, payerId: string | null): string {
  const text = `${normPart(ref)}|${normPart(payerId)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function splitRemittanceByReference(
  batches: readonly RemittanceBatch[],
  parts: readonly RemittanceRefPart[],
): SplitRemittance[] {
  const byBatch = new Map<string, RemittanceRefPart[]>();
  for (const p of parts) byBatch.set(p.batchId, [...(byBatch.get(p.batchId) ?? []), p]);
  const out: SplitRemittance[] = [];
  for (const b of batches) {
    const mine = byBatch.get(b.id) ?? [];
    const whole: SplitRemittance = {
      ...b,
      batchId: b.id,
      ref: b.ref ?? (mine.length === 1 ? mine[0].ref : null),
      payerId: b.payerId ?? (mine.length === 1 ? mine[0].payerId : null),
    };
    if (mine.length < 2) {
      out.push(whole);
      continue;
    }
    const total = mine.reduce((a, p) => a + cents(p.amount), 0);
    const split = mine
      .map((p): SplitRemittance => ({
        id: `${b.id}|${refPartSuffix(p.ref, p.payerId)}`,
        batchId: b.id,
        ref: p.ref,
        payerId: p.payerId ?? b.payerId,
        date: p.paidOn ?? b.date,
        amount: p.amount,
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
    const ids = new Set(split.map((s) => s.id));
    const safe =
      total === cents(b.amount) && ids.size === split.length && mine.every((p) => p.amount > 0);
    out.push(...(safe ? split : [whole]));
  }
  return out;
}

const toPayment = (i: ExpectedItem): InsurancePayment => ({
  key: i.key,
  ref: i.references[0] ?? null,
  payerId: i.mode,
  date: i.expectedDate,
  amount: i.amount,
});

/** The run's group search with the org's settings (wired by bank-server.ts into reconcileRun). */
export function depositGroupSearch(s: DepositSettings) {
  return (args: DepositGroupArgs): DepositGroupResult => {
    const items = args.items.filter(
      (i) => i.kind === "insurance" && i.amount > 0 && !depositGroupMembers(i.key),
    );
    if (s.maxParts < 2 || items.length < 2) return { proposals: [], skippedLineIds: [] };
    const byKey = new Map(items.map((i) => [i.key, i]));
    const payments = items.map(toPayment);

    const found: Array<{ line: BankLine; groups: DepositCandidate[]; singles: boolean }> = [];
    const skipped: string[] = [];
    for (const line of [...args.lines].sort((a, b) => a.id.localeCompare(b.id))) {
      if (line.amount <= 0) continue;
      const r = matchDeposit(line, payments, s);
      if (r.poolTooLarge) skipped.push(line.id);
      if (r.status !== "matched" && r.status !== "combination" && r.status !== "ambiguous")
        continue; // review / unmatched: nothing to propose
      const groups = r.candidates.filter(
        (c) => c.keys.length >= 2 && !args.rejected.has(`${depositGroupKey(c.keys)}|${line.id}`),
      );
      if (groups.length === 0) continue;
      found.push({ line, groups, singles: r.candidates.some((c) => c.keys.length === 1) });
    }

    // a payment offered to several credits makes each of those groups ambiguous (accepting one changes the others)
    const offeredTo = new Map<string, Set<string>>();
    for (const f of found)
      for (const g of f.groups)
        for (const k of g.keys) offeredTo.set(k, (offeredTo.get(k) ?? new Set()).add(f.line.id));

    const proposals = new Map<string, Proposal>();
    for (const f of found) {
      for (const g of f.groups) {
        const item = groupExpectedItem(g.keys.map((k) => byKey.get(k)!));
        const scored = scoreCandidate(item, f.line, s);
        if (!scored) continue; // outside the run's own window or tolerance: not offered
        const candidate: Candidate = {
          ...scored,
          reasons: [
            `Total of ${g.keys.length} insurer payments of one payer (a proposal: the amounts alone prove nothing)`,
            `${g.refsFound} of ${g.keys.length} payment references found on the bank line`,
            ...scored.reasons.filter(
              (r) => !r.startsWith("Reference") && !r.startsWith("No reference"),
            ),
          ],
          ambiguous:
            f.groups.length > 1 ||
            f.singles ||
            g.keys.some((k) => (offeredTo.get(k)?.size ?? 0) > 1),
        };
        const p = proposals.get(item.key) ?? { item, candidates: [] };
        p.candidates.push(candidate);
        proposals.set(item.key, p);
      }
    }
    return {
      proposals: [...proposals.values()]
        .map((p) => ({
          item: p.item,
          candidates: p.candidates
            .map((c) => (p.candidates.length > 1 ? { ...c, ambiguous: true } : c))
            .sort(
              (a, b) =>
                b.score - a.score || a.dayDiff - b.dayDiff || a.lineId.localeCompare(b.lineId),
            ),
        }))
        .sort((a, b) => a.item.key.localeCompare(b.item.key)),
      skippedLineIds: skipped,
    };
  };
}
