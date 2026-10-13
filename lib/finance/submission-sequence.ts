/**
 * The submission sequence of one insurance claim activity (Phase 20I). Pure.
 *
 * Pulse stores the latest Diligence state of each claim activity (ins_claim_activities) and, for every later upload that
 * changed it, the fields that changed with their old and new values (ins_claim_activity_events). Diligence's "Claim Details
 * with Activity" report has no row per submission, so the sequence is RECONSTRUCTED:
 *
 *  - The state before the first stored change is rebuilt by undoing every change, newest first.
 *  - Submission 1 starts at the transaction date with the initial net. Each rise in resubmission_count starts a new step,
 *    dated by last_resubmission_date. A rise of more than one between two uploads adds steps whose figures were never seen
 *    (`inferred`), so the numbering stays right.
 *  - `remitted` in Diligence is cumulative. The amount remitted against a step is the rise in the cumulative figure while
 *    that step was current. A remittance that arrives in the same upload as a resubmission is given to the earlier step
 *    unless its remittance date is after the resubmission date.
 *  - Correction or plain resubmission is INFERRED, because the report has no resubmission-type column: a resubmission that
 *    claims more than the unpaid balance after something was paid is a correction (the whole amount goes back to the RA,
 *    including what was paid); one that claims the balance is a plain resubmission; with nothing paid yet the two look the
 *    same and the mode is "unknown". docs/20_PHASE_20I_NOTES.md lists the columns that would make this exact.
 *  - Cumulative remitted above the highest amount ever claimed is flagged: a correction's RA may repeat what was paid.
 *
 * Amounts and dates only. Nothing here reads or returns a patient detail.
 */

export type SequenceClaim = {
  transactionDate: string | null;
  initialNet: number | null;
  initialRejected: number | null;
  net: number | null;
  remitted: number | null;
  rejected: number | null;
  resubmissionCount: number | null;
  lastResubmissionDate: string | null;
  lastRemittanceDate: string | null;
};

export type SequenceEvent = {
  observedAt: string;
  changedFields: Record<string, { old: unknown; new: unknown }>;
};

export type StepMode = "first" | "correction" | "resubmission" | "unknown";

export type SequenceStep = {
  /** 1 = the first submission, 2 = the first resubmission, and so on. */
  n: number;
  mode: StepMode;
  /** Transaction date for the first submission, the resubmission date for later ones (null when never seen). */
  date: string | null;
  /** When the upload that first showed this step was committed (null = before the first stored upload). */
  observedAt: string | null;
  /** Net claimed in this step. */
  claimed: number | null;
  /** Cumulative remitted when this step ended (or now, for the current step). */
  remittedCumulative: number | null;
  /** Remitted while this step was current; null when the step began before Pulse saw the claim. */
  remittedInStep: number | null;
  /** Rejected amount when this step ended (or now). */
  rejected: number | null;
  /** The step is known only from the resubmission count: no upload captured its figures. */
  inferred: boolean;
  /** The net changed during the step without a resubmission (the payer or Diligence amended it). */
  amended: boolean;
  current: boolean;
};

export type Sequence = {
  steps: SequenceStep[];
  /** Number of steps whose figures were never captured. */
  gaps: number;
  /** Cumulative remitted is higher than anything claimed (a correction RA may repeat what was paid). */
  remittedExceedsClaimed: boolean;
  /** The history covers every submission (no gaps, first state observed from submission 1). */
  complete: boolean;
};

const TOL = 0.005;
const SEQ_FIELDS = [
  "net",
  "remitted",
  "rejected",
  "resubmission_count",
  "last_resubmission_date",
  "last_remittance_date",
] as const;
type Field = (typeof SEQ_FIELDS)[number];
type State = Record<Field, unknown>;

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const dateOrNull = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
const count = (s: State) => Math.max(0, Math.trunc(numOrNull(s.resubmission_count) ?? 0));
const round2 = (v: number) => Math.round(v * 100) / 100;
const sameNum = (a: unknown, b: unknown) => {
  const x = numOrNull(a);
  const y = numOrNull(b);
  return x === null || y === null ? x === y : Math.abs(x - y) <= TOL;
};

function modeOf(
  prevClaimed: number | null,
  paidBefore: number | null,
  newClaimed: number | null,
): StepMode {
  if (prevClaimed === null || newClaimed === null || paidBefore === null) return "unknown";
  if (paidBefore <= TOL) return "unknown"; // nothing paid yet: the whole amount and the balance are the same
  const balance = prevClaimed - paidBefore;
  if (Math.abs(newClaimed - balance) <= TOL || newClaimed < balance) return "resubmission";
  return "correction";
}

export function buildSubmissionSequence(
  claim: SequenceClaim,
  events: readonly SequenceEvent[],
): Sequence {
  const ordered = [...events].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const now: State = {
    net: claim.net,
    remitted: claim.remitted,
    rejected: claim.rejected,
    resubmission_count: claim.resubmissionCount,
    last_resubmission_date: claim.lastResubmissionDate,
    last_remittance_date: claim.lastRemittanceDate,
  };
  // states[0] = before the first stored change; states[i] = after event i
  const states: State[] = [now];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const before: State = { ...states[0] };
    for (const f of SEQ_FIELDS) {
      const ch = ordered[i].changedFields?.[f];
      if (ch && typeof ch === "object" && "old" in ch) before[f] = ch.old;
    }
    states.unshift(before);
  }

  const steps: SequenceStep[] = [];
  const s0 = states[0];
  const c0 = count(s0);
  let startRemit: number | null;
  if (c0 === 0) {
    steps.push({
      n: 1,
      mode: "first",
      date: claim.transactionDate,
      observedAt: null,
      claimed: claim.initialNet ?? numOrNull(s0.net),
      remittedCumulative: numOrNull(s0.remitted),
      remittedInStep: null,
      rejected: numOrNull(s0.rejected),
      inferred: false,
      amended: false,
      current: false,
    });
    startRemit = 0;
  } else {
    // first seen after resubmissions: submission 1 from the initial figures, the middle ones unknown
    steps.push({
      n: 1,
      mode: "first",
      date: claim.transactionDate,
      observedAt: null,
      claimed: claim.initialNet,
      remittedCumulative: null,
      remittedInStep: null,
      rejected: claim.initialRejected,
      inferred: claim.initialNet === null,
      amended: false,
      current: false,
    });
    for (let n = 2; n <= c0; n++) steps.push(unknownStep(n));
    steps.push({
      n: c0 + 1,
      mode: "unknown",
      date: dateOrNull(s0.last_resubmission_date),
      observedAt: null,
      claimed: numOrNull(s0.net),
      remittedCumulative: numOrNull(s0.remitted),
      remittedInStep: null,
      rejected: numOrNull(s0.rejected),
      inferred: false,
      amended: false,
      current: false,
    });
    startRemit = null;
  }
  // the first step's remitted-in-step is known only when it starts at zero
  const close = (step: SequenceStep, endRemit: number | null, endRejected: number | null) => {
    step.remittedCumulative = endRemit;
    step.rejected = endRejected;
    step.remittedInStep =
      startRemit === null || endRemit === null ? null : round2(Math.max(endRemit - startRemit, 0));
  };
  close(steps[steps.length - 1], numOrNull(s0.remitted), numOrNull(s0.rejected));

  for (let i = 1; i < states.length; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    const last = steps[steps.length - 1];
    let rise = count(cur) - count(prev);
    if (rise <= 0 && count(cur) === 0 && numOrNull(cur.resubmission_count) === null) {
      // no count at all: a new resubmission date still means one more step
      const a = dateOrNull(prev.last_resubmission_date);
      const b = dateOrNull(cur.last_resubmission_date);
      if (b && b !== a) rise = 1;
    }
    if (rise > 0) {
      // A remittance in the same upload belongs to the old step unless it is dated after the resubmission. Without a
      // remittance in this upload the old step ends as the previous upload left it.
      const remitDate = dateOrNull(cur.last_remittance_date);
      const resubDate = dateOrNull(cur.last_resubmission_date);
      const raInUpload =
        !sameNum(prev.remitted, cur.remitted) ||
        dateOrNull(prev.last_remittance_date) !== remitDate;
      const raToOld = raInUpload && !(remitDate && resubDate && remitDate > resubDate);
      const endRemit = numOrNull((raToOld ? cur : prev).remitted);
      const endRejected = numOrNull((raToOld ? cur : prev).rejected);
      close(last, endRemit, endRejected);
      const prevClaimed = last.claimed;
      for (let k = 1; k < rise; k++) steps.push(unknownStep(last.n + k));
      const newClaimed = numOrNull(cur.net);
      steps.push({
        n: last.n + rise,
        mode: rise === 1 ? modeOf(prevClaimed, endRemit, newClaimed) : "unknown",
        date: resubDate,
        observedAt: ordered[i - 1].observedAt,
        claimed: newClaimed,
        remittedCumulative: null,
        remittedInStep: null,
        rejected: null,
        inferred: false,
        amended: false,
        current: false,
      });
      startRemit = endRemit;
      close(
        steps[steps.length - 1],
        numOrNull(cur.remitted),
        raToOld ? null : numOrNull(cur.rejected),
      );
    } else {
      const net = numOrNull(cur.net);
      if (net !== null && last.claimed !== null && Math.abs(net - last.claimed) > TOL) {
        last.claimed = net;
        last.amended = true;
      } else if (last.claimed === null && net !== null && !last.inferred) last.claimed = net;
      close(last, numOrNull(cur.remitted), numOrNull(cur.rejected));
    }
  }

  steps[steps.length - 1].current = true;
  const maxClaimed = Math.max(0, ...steps.map((s) => s.claimed ?? 0));
  const finalRemit = numOrNull(claim.remitted) ?? 0;
  const gaps = steps.filter((s) => s.inferred).length;
  return {
    steps,
    gaps,
    remittedExceedsClaimed: maxClaimed > 0 && finalRemit > maxClaimed + TOL,
    complete: gaps === 0 && c0 === 0,
  };
}

function unknownStep(n: number): SequenceStep {
  return {
    n,
    mode: "unknown",
    date: null,
    observedAt: null,
    claimed: null,
    remittedCumulative: null,
    remittedInStep: null,
    rejected: null,
    inferred: true,
    amended: false,
    current: false,
  };
}

export const MODE_LABELS: Record<StepMode, string> = {
  first: "First submission",
  correction: "Correction (whole amount re-sent, inferred)",
  resubmission: "Resubmission of the balance (inferred)",
  unknown: "Resubmission (mode not in the data)",
};

/** "1st", "2nd", "3rd", "4th" ... */
export function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
