/**
 * Insurance receivable control (docs/48, pure): the Diligence insurance receivable at a month end (claimed minus remitted
 * minus approved write-offs) beside Tally's insurer receivable at the same month end, as Pulse mirrors it (the Tally
 * import and connector journals, docs/22 22I / 22J). Tally stays the book of record; Pulse's own ledger is on hold.
 *
 * The SQL twin is `app.fin_ins_receivable_compare` (migration 20261223000300); both read the same inputs and must give
 * the same answer (parity-tested with tests/unit/finance/fixtures/ins-receivable-control.synthetic.json). The SQL one
 * freezes the result into the close snapshot and is what the finance sign-off re-checks; this one tests the rule and
 * cross-checks the snapshot when the pack is built.
 *
 * - Comparison is in whole cents, so 0.1 + 0.2 never decides anything.
 * - The tolerance is fin_ref_finance_settings.ins_receivable_tolerance, never a constant here. A tolerance that is not a
 *   finite number of zero or more counts as 0 (the strictest), so a broken setting cannot hide a difference.
 * - Per payer only when BOTH sides can be split: no amount on either side without a payer id. Otherwise in total.
 * - "No Tally data" (no insurer receivable ledger mapped, or nothing mirrored on it up to the month end) and "No
 *   Diligence data" are not differences: nothing to explain.
 * - Anything unreadable (an unknown Tally state, a list that is not a list, an amount that is not a finite number) is
 *   "differs": it fails closed, so the month needs a written explanation before Finance signs.
 */

export const TALLY_STATES = ["mirrored", "no_account", "no_data"] as const;
export type TallyState = (typeof TALLY_STATES)[number];

export type ControlStatus = "agrees" | "differs" | "no_tally_data" | "no_diligence_data";
export type ControlBasis = "per_payer" | "total" | "none";

export type PayerAmount = { payer_id: string | null; amount: number; claims?: number };

export type ControlInput = {
  tolerance: number;
  tally_state: string;
  /** Outstanding per Diligence payer id at the month end; null = no Diligence claim dated on or before the month end. */
  diligence: readonly PayerAmount[] | null;
  /** Tally's balance (debit minus credit) per payer at the month end; payer null = a ledger not tied to one payer. */
  tally: readonly PayerAmount[] | null;
};

export type PayerRow = {
  payer_id: string;
  diligence: number;
  tally: number;
  /** Tally minus Diligence. */
  difference: number;
  agrees: boolean;
};

export type ControlResult = {
  status: ControlStatus;
  basis: ControlBasis;
  diligence_total: number | null;
  tally_total: number | null;
  /** Tally minus Diligence; null unless both sides were compared. */
  difference: number | null;
  /** Amounts with no payer id (why a comparison is in total). Null unless both sides were compared. */
  unassigned_diligence: number | null;
  unassigned_tally: number | null;
  /** Filled only when the basis is per payer. */
  payers: PayerRow[];
};

const cents = (n: number): number => Math.round(n * 100);
const aed = (c: number): number => c / 100;
const payerKey = (v: unknown): string | null => {
  const t = v === null || v === undefined ? "" : String(v).trim();
  return t === "" ? null : t;
};

/** Sums per payer in cents; null when the list or an amount is unreadable (an amount must be a finite JSON number). */
function byPayer(rows: unknown): Map<string | null, number> | null {
  if (!Array.isArray(rows)) return null;
  const out = new Map<string | null, number>();
  for (const r of rows as unknown[]) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const { amount, payer_id } = r as { amount?: unknown; payer_id?: unknown };
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    const k = payerKey(payer_id);
    out.set(k, (out.get(k) ?? 0) + cents(amount));
  }
  return out;
}

const total = (m: Map<string | null, number>): number => [...m.values()].reduce((a, x) => a + x, 0);

const UNREADABLE: ControlResult = {
  status: "differs",
  basis: "none",
  diligence_total: null,
  tally_total: null,
  difference: null,
  unassigned_diligence: null,
  unassigned_tally: null,
  payers: [],
};

const notCompared = (
  status: "no_tally_data" | "no_diligence_data",
  diligence: number | null,
  tally: number | null,
): ControlResult => ({
  status,
  basis: "none",
  diligence_total: diligence,
  tally_total: tally,
  difference: null,
  unassigned_diligence: null,
  unassigned_tally: null,
  payers: [],
});

export function compareInsuranceReceivable(input: ControlInput): ControlResult {
  const tol =
    typeof input.tolerance === "number" && Number.isFinite(input.tolerance) && input.tolerance >= 0
      ? cents(input.tolerance)
      : 0;
  if (!(TALLY_STATES as readonly string[]).includes(input.tally_state)) return UNREADABLE;

  const dilIn = input.diligence ?? null;
  const dil = dilIn === null ? null : byPayer(dilIn);
  if (dilIn !== null && dil === null) return UNREADABLE;
  const dilTotal = dil === null ? null : aed(total(dil));

  if (input.tally_state !== "mirrored") return notCompared("no_tally_data", dilTotal, null);

  const tal = byPayer(input.tally ?? []);
  if (tal === null) return UNREADABLE;
  const talTotal = aed(total(tal));

  if (dil === null) return notCompared("no_diligence_data", null, talTotal);

  const diffCents = total(tal) - total(dil);
  const unD = dil.get(null) ?? 0;
  const unT = tal.get(null) ?? 0;
  const named = [...new Set([...dil.keys(), ...tal.keys()])]
    .filter((k): k is string => k !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const perPayer = unD === 0 && unT === 0 && named.length > 0;

  const payers: PayerRow[] = perPayer
    ? named.map((k) => {
        const d = dil.get(k) ?? 0;
        const t = tal.get(k) ?? 0;
        return {
          payer_id: k,
          diligence: aed(d),
          tally: aed(t),
          difference: aed(t - d),
          agrees: Math.abs(t - d) <= tol,
        };
      })
    : [];
  const agrees = Math.abs(diffCents) <= tol && payers.every((p) => p.agrees);
  return {
    status: agrees ? "agrees" : "differs",
    basis: perPayer ? "per_payer" : "total",
    diligence_total: dilTotal,
    tally_total: talTotal,
    difference: aed(diffCents),
    unassigned_diligence: aed(unD),
    unassigned_tally: aed(unT),
    payers,
  };
}

// ---- the block frozen in the close snapshot (controls.ins_receivable) ----------------------------------------------

export type InsReceivableBlock = {
  version: 1;
  month_end: string;
  tolerance: number;
  tally_state: TallyState;
  /** The Tally ledgers the insurance receivable posting rules point at; payer_id when the ledger is one payer's. */
  accounts: Array<{ code: string; name: string; payer_id: string | null }>;
  diligence: PayerAmount[] | null;
  tally: PayerAmount[] | null;
  /** When Pulse last mirrored a Tally voucher (any ledger), and the latest voucher date mirrored: the figure's freshness. */
  tally_last_mirrored_at: string | null;
  tally_last_voucher_date: string | null;
  /** Claims whose first remittance is dated after the month end: their remitted amount is added back (still owed then). */
  remitted_after: { claims: number; amount: number };
  /** Claims remitted both before and after the month end: Diligence keeps one remitted total, so all of it is deducted. */
  remitted_straddling: number;
  /** Payer names for display (reference data), keyed by payer id. */
  payer_names: Record<string, string>;
  result: ControlResult;
};

export const STATUS_LABEL: Record<ControlStatus, string> = {
  agrees: "Agrees",
  differs: "Differs",
  no_tally_data: "No Tally data",
  no_diligence_data: "No Diligence data",
};

export const TALLY_STATE_TEXT: Record<TallyState, string> = {
  mirrored: "mirrored from Tally",
  no_account:
    "no insurer receivable ledger is mapped (Accounting, Posting rules: Receivable, insurance)",
  no_data: "nothing mirrored from Tally on the insurer receivable ledger(s) up to the month end",
};

/** The stored block, or null when absent or not a version 1 block (packs built before this control). */
export function readInsReceivable(json: unknown): InsReceivableBlock | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Partial<InsReceivableBlock>;
  if (o.version !== 1 || !o.result || typeof o.result.status !== "string") return null;
  if (typeof o.tally_state !== "string" || typeof o.month_end !== "string") return null;
  return o as InsReceivableBlock;
}

/** Recomputes the result from the block's own inputs (the same check the database makes at the finance sign-off). */
export function recompute(block: InsReceivableBlock): ControlResult {
  return compareInsuranceReceivable({
    tolerance: typeof block.tolerance === "number" ? block.tolerance : 0,
    tally_state: block.tally_state,
    diligence: block.diligence,
    tally: block.tally,
  });
}

/**
 * The status the database would see for a stored snapshot's controls: null when the pack has no such control (built
 * before it), "differs" when the block is there but unreadable (fails closed, as app.fin_close_ins_status does).
 */
export function snapshotStatus(controlsJson: unknown): ControlStatus | null {
  if (!controlsJson || typeof controlsJson !== "object") return null;
  const raw = (controlsJson as { ins_receivable?: unknown }).ins_receivable;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "differs";
  const b = raw as Partial<InsReceivableBlock>;
  return compareInsuranceReceivable({
    tolerance: typeof b.tolerance === "number" ? b.tolerance : 0,
    tally_state: typeof b.tally_state === "string" ? b.tally_state : "",
    diligence: (b.diligence ?? null) as PayerAmount[] | null,
    tally: (b.tally ?? null) as PayerAmount[] | null,
  }).status;
}

export const EXPLANATION_MIN = 10;
export const EXPLANATION_MAX = 1000;

/** The words the page, Excel and PDF use for an explanation that is (or is not) for this build of the pack. */
export function explanationState(
  status: ControlStatus | null,
  note: { hash: string | null } | null,
  packHash: string | null,
): "not_needed" | "missing" | "stale" | "given" {
  if (status !== "differs") return "not_needed";
  if (!note || !note.hash) return "missing";
  return note.hash === packHash ? "given" : "stale";
}
