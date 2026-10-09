import { DILIGENCE_FIELD_NAMES } from "@/lib/finance/diligence-mapping";
import type { ClaimRow } from "@/lib/finance/parse-diligence";

/**
 * Compare an incoming Diligence file with the stored claim activities. Used by BOTH the preview and
 * the commit, so the two cannot disagree. Pure.
 */

export type FieldChange = { old: unknown; new: unknown };
export type ChangedClaim = { row: ClaimRow; changes: Record<string, FieldChange> };

export type ClaimDiff = {
  newRows: ClaimRow[];
  changed: ChangedClaim[];
  unchanged: ClaimRow[];
  /** Claim numbers seen in the previous committed file but absent from this one. */
  missing: string[];
  changedFieldCounts: Record<string, number>;
};

const TOLERANCE = 0.005;
const IDENTITY = new Set(["claim_activity_number"]);

function same(a: unknown, b: unknown): boolean {
  const an = a === undefined ? null : a;
  const bn = b === undefined ? null : b;
  if (an === null || bn === null) return an === bn;
  if (typeof an === "number" && typeof bn === "number") return Math.abs(an - bn) < TOLERANCE;
  if (typeof an === "number" || typeof bn === "number") return Number(an) === Number(bn);
  return an === bn;
}

export function diffClaims(
  existing: ReadonlyMap<string, Partial<ClaimRow>>,
  incoming: readonly ClaimRow[],
  previousFileClaimNumbers: Iterable<string>,
): ClaimDiff {
  const newRows: ClaimRow[] = [];
  const changed: ChangedClaim[] = [];
  const unchanged: ClaimRow[] = [];
  const counts: Record<string, number> = {};
  const incomingNumbers = new Set<string>();

  for (const row of incoming) {
    incomingNumbers.add(row.claim_activity_number);
    const old = existing.get(row.claim_activity_number);
    if (!old) {
      newRows.push(row);
      continue;
    }
    const changes: Record<string, FieldChange> = {};
    for (const field of DILIGENCE_FIELD_NAMES) {
      if (IDENTITY.has(field)) continue;
      if (!same(old[field], row[field])) {
        changes[field] = { old: old[field] ?? null, new: row[field] ?? null };
        counts[field] = (counts[field] ?? 0) + 1;
      }
    }
    if (Object.keys(changes).length > 0) changed.push({ row, changes });
    else unchanged.push(row);
  }

  const missing: string[] = [];
  for (const n of previousFileClaimNumbers) if (!incomingNumbers.has(n)) missing.push(n);

  return { newRows, changed, unchanged, missing, changedFieldCounts: counts };
}

/** True when the new file is much smaller than the previous one, which usually means a filtered export. */
export function looksFiltered(
  missingCount: number,
  previousCount: number,
  threshold = 0.2,
): boolean {
  return previousCount > 0 && missingCount / previousCount > threshold;
}
