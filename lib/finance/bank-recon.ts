import { dayNumber } from "@/lib/documents/expiry";

/**
 * Bank and settlement reconciliation (pure, deterministic). Every number it uses comes from the settings table
 * (fin_ref_finance_settings.bank_*) and the settlement rules (fin_ref_settlement_rules); nothing is hardcoded here.
 *
 *   1. Expected receipts for one bank account and period:
 *        collections  Unite collections (refunds subtracted) per payment mode and paid date, expected on paid date + lag
 *                     WORKING days, net of the expected fee %             (rule source "collections")
 *        payouts      the processor's payouts (settlement report) per mode, payout date and reference (source "settlement");
 *                     each day's Unite total is checked against the processor's gross ("gap" items, never matched)
 *        insurance    each remittance batch (sum paid) when the account receives insurance payments
 *   2. Candidates: bank credits on the account within the date window and the amount tolerance, scored 0-100 with reasons.
 *   3. A pair is matched automatically only when its score reaches the threshold AND it is the ONLY candidate on both
 *      sides. Everything else is a proposal for a person; ties are never guessed.
 *   4. Unmatched items are aged from their expected date; past the date window they need a reason. Unmatched bank
 *      credits in the period need a reason too.
 */

export type BankSettings = {
  weekendDays: number[]; // 0 = Sunday ... 6 = Saturday
  windowDays: number;
  toleranceAmount: number;
  tolerancePct: number; // percent
  autoAcceptScore: number;
  cutoffDay: number;
};

export type SettlementRule = {
  mode: string;
  lagDays: number | null;
  feePct: number | null; // percent
  accountId: string | null;
  settlesToBank: boolean;
  source: "collections" | "settlement";
};

export type Collection = {
  mode: string;
  date: string;
  paid: number;
  refunds: number;
  payments: number;
};
export type SettlementLine = {
  mode: string;
  txnDate: string;
  settlementDate: string;
  gross: number;
  fee: number;
  net: number;
  reference: string | null;
};
export type RemittanceBatch = {
  id: string;
  ref: string | null;
  payerId: string | null;
  date: string;
  amount: number;
};
export type BankLine = {
  id: string;
  valueDate: string;
  amount: number;
  reference: string | null;
  description: string | null;
};
export type Decision = {
  expectedKey: string;
  lineId: string;
  status: "matched" | "rejected";
  auto: boolean;
  score: number;
};
export type Note = { itemKey: string; code: string; note: string | null };

export type ExpectedKind = "collection" | "payout" | "insurance" | "gap";
export type ExpectedItem = {
  key: string;
  kind: ExpectedKind;
  mode: string | null; // payment mode, or the payer for insurance
  sourceDate: string; // paid date, payout date, remittance date or transaction date
  expectedDate: string;
  gross: number;
  fee: number;
  amount: number; // expected in the bank; for a gap: Unite minus the processor
  references: string[];
};

export type NotReconciled = { mode: string; gross: number; days: number; why: string };

export type Candidate = {
  lineId: string;
  score: number;
  reasons: string[];
  bankAmount: number;
  amountDiff: number; // bank minus expected
  dayDiff: number;
  ambiguous: boolean;
};

export type AgeBucket = "waiting" | "0-7" | "8-30" | "31-60" | "60+";
export const AGE_BUCKETS: readonly AgeBucket[] = ["waiting", "0-7", "8-30", "31-60", "60+"];

export const RECON_REASONS = {
  in_transit: "Not received yet (in transit)",
  fee_difference: "Fee or charge difference",
  chargeback: "Chargeback or dispute",
  refunded: "Refunded to the patient",
  unite_correction: "Unite entry to be corrected",
  bank_query: "Query raised with the bank or processor",
  other_account: "Paid into another account",
  other_period: "Belongs to another period",
  internal_transfer: "Transfer between our accounts",
  other_income: "Other income (not a Unite collection)",
  other: "Other (explain)",
} as const;
export type ReasonCode = keyof typeof RECON_REASONS;
export const isReasonCode = (v: unknown): v is ReasonCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(RECON_REASONS, v);

// ---- calendar ----------------------------------------------------------------

const DAY_MS = 86_400_000;
const isoOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const dn = (iso: string): number => {
  const n = dayNumber(iso);
  if (n === null) throw new Error("invalid date");
  return n;
};

export const addDays = (iso: string, days: number) => isoOf(dn(iso) + days);
export const daysBetween = (from: string, to: string) => dn(to) - dn(from);
export const weekday = (iso: string) => new Date(dn(iso) * DAY_MS).getUTCDay();

/** `iso` plus `n` working days (weekend days skipped). n = 0 is the same day. */
export function addWorkingDays(iso: string, n: number, weekendDays: readonly number[]): string {
  if (weekendDays.length >= 7) throw new Error("every day is a weekend day");
  let day = dn(iso);
  let left = n;
  while (left > 0) {
    day++;
    if (!weekendDays.includes(new Date(day * DAY_MS).getUTCDay())) left--;
  }
  return isoOf(day);
}

const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/**
 * The reconciliation period of a month with a cut-off day: it ends on the cut-off (or the month's last day when the
 * month is shorter) and starts the day after the previous month's cut-off. Cut-off 30: Oct = 1-30 Oct, Nov = 31 Oct-30 Nov.
 */
export function periodFor(month: string, cutoffDay: number): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const end = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(cutoffDay, lastDayOf(y, m))).padStart(2, "0")}`;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const prevEnd = `${py}-${String(pm).padStart(2, "0")}-${String(Math.min(cutoffDay, lastDayOf(py, pm))).padStart(2, "0")}`;
  return { start: addDays(prevEnd, 1), end };
}

export function ageBucket(daysPast: number | null, windowDays: number): AgeBucket {
  if (daysPast === null || daysPast <= windowDays) return "waiting";
  if (daysPast <= 7) return "0-7";
  if (daysPast <= 30) return "8-30";
  if (daysPast <= 60) return "31-60";
  return "60+";
}

// ---- amounts and text ----------------------------------------------------------

const cents = (n: number) => Math.round(n * 100);
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + cents(x), 0) / 100;
export const modeKey = (m: string) => m.trim().toLowerCase();
const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Allowed difference in cents: the larger of the fixed amount and the percentage of the expected amount. */
export function toleranceCents(amount: number, s: BankSettings): number {
  return Math.max(
    cents(s.toleranceAmount),
    Math.round(Math.abs(cents(amount)) * (s.tolerancePct / 100)),
  );
}

/** Why a payment mode cannot be reconciled yet; null when its rule is complete. */
export function ruleProblem(rule: SettlementRule | undefined): string | null {
  if (!rule) return "No settlement rule for this payment mode";
  if (!rule.settlesToBank)
    return "Not paid into a bank as such (insurance is matched through remittances)";
  if (!rule.accountId) return "No bank account chosen";
  if (rule.source === "collections") {
    if (rule.lagDays === null) return "Settlement lag not set";
    if (rule.feePct === null) return "Fee % not set (enter 0 when there is no fee)";
  }
  return null;
}

// ---- expected receipts -----------------------------------------------------------

export type ExpectedInput = {
  accountId: string;
  receivesInsurance: boolean;
  period: { start: string; end: string };
  rules: readonly SettlementRule[];
  settings: BankSettings;
  collections: readonly Collection[];
  settlements: readonly SettlementLine[];
  remittances: readonly RemittanceBatch[];
};

const inPeriod = (d: string, p: { start: string; end: string }) => d >= p.start && d <= p.end;
const keyPart = (s: string) => s.replace(/\|/g, "/");

export function buildExpected(input: ExpectedInput): {
  items: ExpectedItem[];
  notReconciled: NotReconciled[];
} {
  const { period, settings } = input;
  const rules = new Map(input.rules.map((r) => [modeKey(r.mode), r]));
  const items: ExpectedItem[] = [];
  const unconfigured = new Map<string, NotReconciled>();

  const byModeDay = new Map<string, { mode: string; date: string; gross: number }>();
  for (const c of input.collections) {
    if (!inPeriod(c.date, period)) continue;
    const k = `${modeKey(c.mode)}|${c.date}`;
    const prev = byModeDay.get(k);
    byModeDay.set(k, {
      mode: prev?.mode ?? c.mode,
      date: c.date,
      gross: r2((prev?.gross ?? 0) + c.paid - c.refunds),
    });
  }

  for (const { mode, date, gross } of [...byModeDay.values()].sort((a, b) =>
    (a.mode + a.date).localeCompare(b.mode + b.date),
  )) {
    const rule = rules.get(modeKey(mode));
    if (rule && !rule.settlesToBank) continue; // e.g. insurance credit: reconciled through remittance batches
    const problem = ruleProblem(rule);
    if (problem) {
      if (gross === 0) continue;
      const u = unconfigured.get(modeKey(mode)) ?? { mode, gross: 0, days: 0, why: problem };
      u.gross = r2(u.gross + gross);
      u.days++;
      unconfigured.set(modeKey(mode), u);
      continue;
    }
    if (rule!.accountId !== input.accountId || rule!.source !== "collections") continue;
    if (gross <= 0) continue; // a day of net refunds: nothing to receive
    const fee = r2((gross * (rule!.feePct ?? 0)) / 100);
    items.push({
      key: `col|${keyPart(rule!.mode)}|${date}`,
      kind: "collection",
      mode: rule!.mode,
      sourceDate: date,
      expectedDate: addWorkingDays(date, rule!.lagDays ?? 0, settings.weekendDays),
      gross,
      fee,
      amount: r2(gross - fee),
      references: [],
    });
  }

  // modes whose processor report is the expectation
  for (const rule of input.rules) {
    if (ruleProblem(rule) || rule.accountId !== input.accountId || rule.source !== "settlement")
      continue;
    const mk = modeKey(rule.mode);
    const lines = input.settlements.filter((s) => modeKey(s.mode) === mk);
    const payouts = new Map<string, SettlementLine[]>();
    for (const l of lines.filter((l) => inPeriod(l.settlementDate, period))) {
      const k = `${l.settlementDate}|${l.reference ?? ""}`;
      payouts.set(k, [...(payouts.get(k) ?? []), l]);
    }
    for (const [k, group] of [...payouts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const net = sum(group.map((g) => g.net));
      if (net <= 0) continue;
      const ref = group[0].reference;
      items.push({
        key: `pay|${keyPart(rule.mode)}|${keyPart(k)}`,
        kind: "payout",
        mode: rule.mode,
        sourceDate: group[0].settlementDate,
        expectedDate: group[0].settlementDate,
        gross: sum(group.map((g) => g.gross)),
        fee: sum(group.map((g) => g.fee)),
        amount: net,
        references: ref ? [ref] : [],
      });
    }
    // Unite's total per day against the processor's gross: a difference is an item that needs a reason
    const days = new Set<string>();
    const uniteByDay = new Map<string, number>();
    for (const v of byModeDay.values())
      if (modeKey(v.mode) === mk) {
        days.add(v.date);
        uniteByDay.set(v.date, v.gross);
      }
    const procByDay = new Map<string, number>();
    for (const l of lines.filter((l) => inPeriod(l.txnDate, period))) {
      days.add(l.txnDate);
      procByDay.set(l.txnDate, r2((procByDay.get(l.txnDate) ?? 0) + l.gross));
    }
    for (const d of [...days].sort()) {
      const unite = uniteByDay.get(d) ?? 0;
      const proc = procByDay.get(d) ?? 0;
      const diff = r2(unite - proc);
      if (Math.abs(cents(diff)) <= toleranceCents(unite, settings)) continue;
      items.push({
        key: `gap|${keyPart(rule.mode)}|${d}`,
        kind: "gap",
        mode: rule.mode,
        sourceDate: d,
        expectedDate: addWorkingDays(d, rule.lagDays ?? 0, settings.weekendDays),
        gross: unite,
        fee: 0,
        amount: diff,
        references: [],
      });
    }
  }

  if (input.receivesInsurance)
    for (const b of input.remittances) {
      if (!inPeriod(b.date, period) || b.amount <= 0) continue;
      items.push({
        key: `ins|${b.id}`,
        kind: "insurance",
        mode: b.payerId,
        sourceDate: b.date,
        expectedDate: b.date,
        gross: r2(b.amount),
        fee: 0,
        amount: r2(b.amount),
        references: b.ref ? [b.ref] : [],
      });
    }

  return {
    items,
    notReconciled: [...unconfigured.values()].sort((a, b) => a.mode.localeCompare(b.mode)),
  };
}

// ---- scoring ---------------------------------------------------------------------

/**
 * Score of one bank line for one expected item, or null when it is not a candidate (not a credit, outside the amount
 * tolerance or the date window). Amount up to 50, date up to 30, reference 10, payment mode (or payer) named 10.
 */
export function scoreCandidate(
  item: ExpectedItem,
  line: BankLine,
  s: BankSettings,
): Omit<Candidate, "ambiguous"> | null {
  if (line.amount <= 0 || item.kind === "gap") return null;
  const diffC = Math.abs(cents(line.amount) - cents(item.amount));
  const tolC = toleranceCents(item.amount, s);
  if (diffC > tolC) return null;
  const dayDiff = Math.abs(daysBetween(item.expectedDate, line.valueDate));
  if (dayDiff > s.windowDays) return null;

  const reasons: string[] = [];
  let score = 0;
  if (diffC === 0) {
    score += 50;
    reasons.push("Amount exact");
  } else {
    score += 50 - Math.round((25 * diffC) / Math.max(tolC, 1));
    reasons.push(
      `Amount ${diffC / 100} ${line.amount > item.amount ? "more" : "less"} than expected (within tolerance)`,
    );
  }
  if (dayDiff === 0) {
    score += 30;
    reasons.push("On the expected date");
  } else {
    score += Math.round(30 * (1 - dayDiff / (s.windowDays + 1)));
    reasons.push(`${dayDiff} day(s) from the expected date`);
  }
  const text = norm(`${line.reference ?? ""} ${line.description ?? ""}`);
  const refs = item.references.map(norm).filter((r) => r.length >= 4);
  if (refs.length === 0) reasons.push("No reference to compare");
  else if (refs.some((r) => text.includes(r))) {
    score += 10;
    reasons.push("Reference found on the bank line");
  } else reasons.push("Reference not found on the bank line");
  const mode = norm(item.mode);
  if (mode.length >= 2 && text.includes(mode)) {
    score += 10;
    reasons.push(`Bank line mentions ${item.mode}`);
  }
  return {
    lineId: line.id,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    bankAmount: line.amount,
    amountDiff: r2(line.amount - item.amount),
    dayDiff,
  };
}

// ---- the run -------------------------------------------------------------------------

export type RunInput = ExpectedInput & {
  lines: readonly BankLine[]; // this account's lines around the period, plus every line matched in this run
  matchedElsewhere: ReadonlySet<string>; // line ids matched by another run
  decisions: readonly Decision[];
  notes: readonly Note[];
  today: string;
  statementEnd: string | null; // last value date imported for the account
};

export type MatchedPair = {
  item: ExpectedItem | null; // null: the expected item no longer exists
  line: BankLine | null;
  expectedKey: string;
  lineId: string;
  score: number;
  auto: boolean;
  changed: boolean; // the expected amount moved outside the tolerance since the match
};
export type OpenItem = {
  item: ExpectedItem;
  daysPast: number | null;
  bucket: AgeBucket;
  needsReason: boolean;
  note: Note | null;
};
export type OpenLine = { line: BankLine; note: Note | null };
export type Proposal = { item: ExpectedItem; candidates: Candidate[] };
export type AutoPair = { item: ExpectedItem; candidate: Candidate };

export type RunSummary = {
  expectedCount: number;
  expectedAmount: number;
  matchedCount: number;
  matchedExpected: number;
  matchedBank: number;
  matchedDifference: number; // bank minus expected over the matched pairs (fees beyond the expected %)
  autoReady: number;
  proposed: number;
  unmatched: Record<AgeBucket, { count: number; amount: number }>;
  gaps: { count: number; amount: number };
  bankUnmatched: { count: number; amount: number };
  bankDebits: { count: number; amount: number };
  notReconciled: { count: number; amount: number };
};

export type RunResult = {
  items: ExpectedItem[];
  matched: MatchedPair[];
  autoReady: AutoPair[];
  proposals: Proposal[];
  unmatched: OpenItem[];
  bankUnmatched: OpenLine[];
  notReconciled: NotReconciled[];
  asOf: string | null;
  summary: RunSummary;
  problems: string[];
};

export const bankItemKey = (lineId: string) => `bank|${lineId}`;

export function reconcileRun(input: RunInput): RunResult {
  const s = input.settings;
  const { items, notReconciled } = buildExpected(input);
  const itemByKey = new Map(items.map((i) => [i.key, i]));
  const lineById = new Map(input.lines.map((l) => [l.id, l]));
  const notes = new Map(input.notes.map((n) => [n.itemKey, n]));

  const matchedRows = input.decisions.filter((d) => d.status === "matched");
  const matchedKeys = new Set(matchedRows.map((d) => d.expectedKey));
  const matchedLines = new Set(matchedRows.map((d) => d.lineId));
  const rejected = new Set(
    input.decisions
      .filter((d) => d.status === "rejected")
      .map((d) => `${d.expectedKey}|${d.lineId}`),
  );

  const matched: MatchedPair[] = matchedRows.map((d) => {
    const item = itemByKey.get(d.expectedKey) ?? null;
    const line = lineById.get(d.lineId) ?? null;
    const changed =
      !!item &&
      !!line &&
      Math.abs(cents(line.amount) - cents(item.amount)) > toleranceCents(item.amount, s);
    return {
      item,
      line,
      expectedKey: d.expectedKey,
      lineId: d.lineId,
      score: d.score,
      auto: d.auto,
      changed,
    };
  });

  const available = input.lines
    .filter((l) => l.amount > 0 && !matchedLines.has(l.id) && !input.matchedElsewhere.has(l.id))
    .sort((a, b) => a.valueDate.localeCompare(b.valueDate) || a.id.localeCompare(b.id));
  const open = items.filter((i) => i.kind !== "gap" && !matchedKeys.has(i.key));

  const candidatesOf = new Map<string, Array<Omit<Candidate, "ambiguous">>>();
  const lineCount = new Map<string, number>();
  for (const item of open) {
    const list = available
      .filter((l) => !rejected.has(`${item.key}|${l.id}`))
      .map((l) => scoreCandidate(item, l, s))
      .filter((c): c is Omit<Candidate, "ambiguous"> => c !== null)
      .sort(
        (a, b) => b.score - a.score || a.dayDiff - b.dayDiff || a.lineId.localeCompare(b.lineId),
      );
    candidatesOf.set(item.key, list);
    for (const c of list) lineCount.set(c.lineId, (lineCount.get(c.lineId) ?? 0) + 1);
  }

  const autoReady: AutoPair[] = [];
  const proposals: Proposal[] = [];
  const asOf = input.statementEnd
    ? input.statementEnd < input.today
      ? input.statementEnd
      : input.today
    : null;
  const unmatched: OpenItem[] = [];
  const age = (item: ExpectedItem): OpenItem => {
    // a processor gap does not wait for the bank statement; everything else is aged against the statement's last date
    const ref = item.kind === "gap" ? input.today : asOf;
    const daysPast = ref ? daysBetween(item.expectedDate, ref) : null;
    const bucket = ageBucket(daysPast, s.windowDays);
    return {
      item,
      daysPast,
      bucket,
      needsReason: bucket !== "waiting",
      note: notes.get(item.key) ?? null,
    };
  };

  const candidateLines = new Set<string>();
  for (const item of open) {
    const list = candidatesOf.get(item.key)!;
    if (list.length === 0) {
      unmatched.push(age(item));
      continue;
    }
    const only = list.length === 1 && lineCount.get(list[0].lineId) === 1;
    if (only && list[0].score >= s.autoAcceptScore) {
      autoReady.push({ item, candidate: { ...list[0], ambiguous: false } });
    } else {
      proposals.push({
        item,
        candidates: list.map((c) => ({
          ...c,
          ambiguous: list.length > 1 || (lineCount.get(c.lineId) ?? 0) > 1,
        })),
      });
    }
    for (const c of list) candidateLines.add(c.lineId);
  }
  for (const gap of items.filter((i) => i.kind === "gap")) unmatched.push(age(gap));
  unmatched.sort(
    (a, b) =>
      a.item.expectedDate.localeCompare(b.item.expectedDate) ||
      a.item.key.localeCompare(b.item.key),
  );

  const bankUnmatched: OpenLine[] = available
    .filter((l) => inPeriod(l.valueDate, input.period) && !candidateLines.has(l.id))
    .map((line) => ({ line, note: notes.get(bankItemKey(line.id)) ?? null }));
  const debits = input.lines.filter((l) => l.amount < 0 && inPeriod(l.valueDate, input.period));

  const bucketTotals = Object.fromEntries(
    AGE_BUCKETS.map((b) => [b, { count: 0, amount: 0 }]),
  ) as RunSummary["unmatched"];
  for (const u of unmatched.filter((u) => u.item.kind !== "gap")) {
    bucketTotals[u.bucket].count++;
    bucketTotals[u.bucket].amount = r2(bucketTotals[u.bucket].amount + u.item.amount);
  }
  const gaps = unmatched.filter((u) => u.item.kind === "gap");
  const good = matched.filter((m) => m.item && m.line);
  const summary: RunSummary = {
    expectedCount: items.filter((i) => i.kind !== "gap").length,
    expectedAmount: sum(items.filter((i) => i.kind !== "gap").map((i) => i.amount)),
    matchedCount: good.length,
    matchedExpected: sum(good.map((m) => m.item!.amount)),
    matchedBank: sum(good.map((m) => m.line!.amount)),
    matchedDifference: r2(
      sum(good.map((m) => m.line!.amount)) - sum(good.map((m) => m.item!.amount)),
    ),
    autoReady: autoReady.length,
    proposed: proposals.length,
    unmatched: bucketTotals,
    gaps: { count: gaps.length, amount: sum(gaps.map((g) => g.item.amount)) },
    bankUnmatched: {
      count: bankUnmatched.length,
      amount: sum(bankUnmatched.map((b) => b.line.amount)),
    },
    bankDebits: { count: debits.length, amount: sum(debits.map((d) => -d.amount)) },
    notReconciled: { count: notReconciled.length, amount: sum(notReconciled.map((n) => n.gross)) },
  };

  const problems: string[] = [];
  if (!input.statementEnd) problems.push("Import a statement for this account first.");
  else if (input.statementEnd < input.period.end)
    problems.push(
      `The statements imported for this account end on ${input.statementEnd}, before the period ends (${input.period.end}).`,
    );
  const orphans = matched.filter((m) => !m.item || !m.line).length;
  if (orphans)
    problems.push(`Undo ${orphans} match(es) whose expected item or bank line no longer exists.`);
  const changed = matched.filter((m) => m.changed).length;
  if (changed)
    problems.push(
      `Undo or re-check ${changed} match(es) whose expected amount changed since they were made.`,
    );
  if (autoReady.length)
    problems.push(`Run matching to save ${autoReady.length} automatic match(es).`);
  if (proposals.length) problems.push(`Accept or reject ${proposals.length} proposed match(es).`);
  const noReason = unmatched.filter((u) => u.needsReason && !u.note).length;
  if (noReason) problems.push(`Give a reason for ${noReason} item(s) past their expected date.`);
  const lineNoReason = bankUnmatched.filter((b) => !b.note).length;
  if (lineNoReason) problems.push(`Explain ${lineNoReason} unmatched bank credit(s).`);

  return {
    items,
    matched,
    autoReady,
    proposals,
    unmatched,
    bankUnmatched,
    notReconciled,
    asOf,
    summary,
    problems,
  };
}

/** The frozen figures of a reviewed run (ids, codes, dates and amounts only). */
export function runFigures(
  r: RunResult,
  meta: { accountId: string; period: { start: string; end: string } },
) {
  return {
    account_id: meta.accountId,
    period: meta.period,
    as_of: r.asOf,
    summary: r.summary,
    problems: r.problems,
    matched: r.matched.map((m) => ({
      key: m.expectedKey,
      line: m.lineId,
      expected: m.item?.amount ?? null,
      bank: m.line?.amount ?? null,
      score: m.score,
      auto: m.auto,
    })),
    unmatched: r.unmatched.map((u) => ({
      key: u.item.key,
      amount: u.item.amount,
      expected_date: u.item.expectedDate,
      bucket: u.bucket,
      reason: u.note?.code ?? null,
    })),
    bank_unmatched: r.bankUnmatched.map((b) => ({
      line: b.line.id,
      date: b.line.valueDate,
      amount: b.line.amount,
      reason: b.note?.code ?? null,
    })),
    not_reconciled: r.notReconciled,
  };
}
