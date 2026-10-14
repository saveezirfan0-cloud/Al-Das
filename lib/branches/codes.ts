/**
 * Finance branch codes on clinical branches (Phase B, docs/34_CLINIC_OS_PLAN.md). Pure: shared by Settings,
 * Appointments (where a location's code is set) and the ledger reports (where a branch filter is chosen).
 *
 * `locations.branch_code` points at `fin_ref_branches.code` (one to four capitals or digits, the same rule as the
 * finance table's CHECK). Journal lines carry that code in `acc_journal_lines.branch_code`, so a clinical branch and its
 * ledger figures meet through it.
 */

export const BRANCH_CODE_RE = /^[A-Z0-9]{1,4}$/;

/** The code as stored: trimmed and upper-cased; blank is null; anything else that breaks the rule is "invalid". */
export function normalizeBranchCode(raw: unknown): string | null | "invalid" {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return "invalid";
  const v = raw.trim().toUpperCase();
  if (!v) return null;
  return BRANCH_CODE_RE.test(v) ? v : "invalid";
}

/**
 * Why a code cannot be saved on a location, or null when it can. `known` is the org's finance branch codes; when the
 * finance list is empty (not set up yet) any well-formed code is accepted. `takenBy` names another location of the org
 * already using it (the database refuses it too: a unique index per org).
 */
export function branchCodeProblem(
  code: string | null | "invalid",
  known: readonly string[],
  takenBy: string | null = null,
): string | null {
  if (code === null) return null;
  if (code === "invalid") return "A branch code is one to four capital letters or digits, e.g. P.";
  if (known.length > 0 && !known.includes(code))
    return `There is no finance branch with the code ${code}. Choose one from the list.`;
  if (takenBy) return `${takenBy} already uses the branch code ${code}.`;
  return null;
}

export type FinanceBranch = { code: string; name: string };
export type CodedLocation = { id: string; name: string; branch_code: string | null };

export type BranchCodeOption = { code: string; label: string; locationId: string | null };

/**
 * The branch filter of a ledger report: every finance branch, labelled with the clinical branch that uses its code
 * when there is one ("P · Palm Jumeirah"), plus codes set on a location that the finance list does not hold yet.
 * Sorted by code.
 */
export function branchCodeOptions(
  finance: readonly FinanceBranch[],
  locations: readonly CodedLocation[],
): BranchCodeOption[] {
  const byCode = new Map<string, BranchCodeOption>();
  for (const f of finance) {
    const loc = locations.find((l) => l.branch_code === f.code) ?? null;
    byCode.set(f.code, {
      code: f.code,
      label: `${f.code} · ${loc && loc.name !== f.name ? `${loc.name} (${f.name})` : f.name}`,
      locationId: loc?.id ?? null,
    });
  }
  for (const l of locations) {
    if (!l.branch_code || byCode.has(l.branch_code)) continue;
    byCode.set(l.branch_code, {
      code: l.branch_code,
      label: `${l.branch_code} · ${l.name}`,
      locationId: l.id,
    });
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** A branch filter from a link: one of the offered codes, else null (every branch). */
export function pickBranchCode(
  raw: unknown,
  options: readonly Pick<BranchCodeOption, "code">[],
): string | null {
  const v = normalizeBranchCode(typeof raw === "string" ? raw : null);
  if (!v || v === "invalid") return null;
  return options.some((o) => o.code === v) ? v : null;
}
