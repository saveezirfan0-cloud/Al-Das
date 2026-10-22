import { dayNumber } from "@/lib/documents/expiry";

/**
 * Lab and external-referral reconciliation (slice 20E; pure, deterministic). Every threshold comes from the settings
 * (fin_ref_finance_settings.lab_*) and the provider's tests (fin_ref_provider_tests); nothing is hardcoded here.
 *
 *   1. Matching: a provider line and a current Unite invoice line are candidates when the Unite PIN is the same, the
 *      code is the same (the Unite line's item code, its CPT, or the CPT of its item in reference data) and the dates
 *      are within the window. Pass 1 pairs same-day candidates, pass 2 the rest within the window; a pair is made only
 *      when it is the ONLY candidate on both sides. Anything else is never guessed.
 *   2. Outputs: matched pairs (score and reasons), done but not billed (on the file, nothing in Unite: revenue leakage),
 *      billed but not on the file (send-out labs only: Unite billed a test the lab has no record of), price variances
 *      against the agreed price, turnaround against the expected days.
 *   3. Cost per doctor and branch: invoice amounts, or for the in-house lab its fixed monthly fee shared by test count
 *      or by billed revenue (largest remainder, so the shares add up to the fee exactly). The branch is the Unite bill's
 *      (Q42), else the lab file's.
 *   4. Every unmatched line and every billed test missing from the file needs a reason before the review.
 */

export type ProviderKind = "in_house_lab" | "send_out_lab" | "hospital" | "radiology" | "other";
export type AllocationBasis = "test_count" | "revenue";

export const PROVIDER_KINDS: Record<ProviderKind, string> = {
  in_house_lab: "In-house lab (fixed monthly fee)",
  send_out_lab: "Send-out lab",
  hospital: "Hospital",
  radiology: "Radiology",
  other: "Other third party",
};
export const isProviderKind = (v: unknown): v is ProviderKind =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, v);

/** The file kind each provider sends: the in-house lab an activity report, everyone else an invoice. */
export const fileKindFor = (kind: ProviderKind): "lab_activity" | "provider_invoice" =>
  kind === "in_house_lab" ? "lab_activity" : "provider_invoice";
/** Where the cost lands in the doctor's charges (20F): labs as "lab", hospitals, radiology and others as "referral". */
export const chargeKindFor = (kind: ProviderKind): "lab" | "referral" =>
  kind === "in_house_lab" || kind === "send_out_lab" ? "lab" : "referral";

export const LAB_REASONS = {
  billed_other_month: "Billed in another month",
  not_billable: "Not billable (package, free or internal)",
  billed_other_code: "Billed under another code",
  billing_to_correct: "Missed in Unite: billing to correct",
  provider_error: "Provider's error (query raised)",
  checked_by_hand: "Checked by hand (no PIN or several fit)",
  other: "Other (explain)",
} as const;
export type LabReasonCode = keyof typeof LAB_REASONS;
export const isLabReasonCode = (v: unknown): v is LabReasonCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(LAB_REASONS, v);

export type LabSettings = { windowDays: number; priceTolerance: number };

export type Provider = {
  id: string;
  kind: ProviderKind;
  fixedFee: number | null;
  basis: AllocationBasis;
};

export type ProviderLine = {
  id: string;
  serviceDate: string;
  code: string;
  pin: string | null;
  doctor: string | null;
  branch: string | null;
  resultDate: string | null;
  amount: number | null;
};

export type UniteLine = {
  id: string; // invoice line id
  invoiceId: string;
  pin: string | null;
  date: string;
  itemCode: string | null;
  lineCpt: string | null;
  refCpt: string | null;
  net: number;
  branch: string | null;
  doctor: string | null; // per the configured doctor basis
};

export type ProviderTest = {
  code: string;
  expectedDays: number | null;
  agreedPrice: number | null;
};
export type LabNote = { itemKey: string; code: string; note: string | null };

export type StatementInput = {
  provider: Provider;
  month: string; // yyyy-mm-01
  lines: ProviderLine[];
  unite: UniteLine[];
  tests: ProviderTest[];
  notes: LabNote[];
  settings: LabSettings;
  today: string;
};

export type MatchedPair = {
  line: ProviderLine;
  unite: UniteLine;
  score: number;
  reasons: string[];
};
export type NotBilled = {
  line: ProviderLine;
  key: string;
  why: "no_pin" | "no_candidate" | "ambiguous";
  candidates: number;
  note: LabNote | null;
};
export type NotOnFile = { unite: UniteLine; key: string; note: LabNote | null };
export type PriceVariance = { line: ProviderLine; agreed: number; diff: number };
export type LateResult = {
  line: ProviderLine;
  expectedDays: number;
  days: number; // actual days, or days so far while the result is pending
  pending: boolean;
};
export type AllocationRow = {
  doctor: string | null;
  branch: string | null;
  tests: number;
  cost: number;
};
export type DoctorCost = { doctor_dha_id: string; amount: number };

export type StatementResult = {
  matched: MatchedPair[];
  notBilled: NotBilled[];
  notOnFile: NotOnFile[];
  priceVariances: PriceVariance[];
  turnaround: { withExpectation: number; onTime: number; late: LateResult[] };
  allocation: AllocationRow[];
  doctors: DoctorCost[];
  summary: {
    lines: number;
    matched: number;
    notBilled: number;
    notOnFile: number;
    priceVariances: number;
    late: number;
    totalCost: number;
    allocated: number;
    unallocated: number;
  };
  problems: string[];
};

export const lineKey = (id: string) => `line|${id}`;
export const uniteKey = (id: string) => `unite|${id}`;

/** The PIN as the finance pages show it: the last three characters only. */
export function maskPin(pin: string | null | undefined): string {
  if (!pin) return "-";
  return pin.length <= 3 ? "•••" : `•••${pin.slice(-3)}`;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
/** Code-point order (never the locale), so the result is the same on every machine. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const LAST = "\uffff"; // rows without a doctor or branch sort last
const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;
const daysBetween = (a: string, b: string) => (dayNumber(b) ?? 0) - (dayNumber(a) ?? 0);

/** Which way a provider code matches a Unite line, or null. */
function codeMatch(code: string, u: UniteLine): string | null {
  const c = norm(code);
  if (!c) return null;
  if (norm(u.itemCode) === c) return "Same item code";
  if (norm(u.lineCpt) === c) return "Same CPT code";
  if (norm(u.refCpt) === c) return "CPT of the Unite item (reference data)";
  return null;
}

function isCandidate(line: ProviderLine, u: UniteLine, window: number): boolean {
  if (!line.pin || !u.pin || norm(line.pin) !== norm(u.pin)) return false;
  if (!codeMatch(line.code, u)) return false;
  return Math.abs(daysBetween(line.serviceDate, u.date)) <= window;
}

function scorePair(line: ProviderLine, u: UniteLine): { score: number; reasons: string[] } {
  const reasons = ["Same Unite PIN", codeMatch(line.code, u)!];
  const days = Math.abs(daysBetween(line.serviceDate, u.date));
  let score = 60 + Math.max(0, 30 - 10 * days);
  reasons.push(days === 0 ? "Same day" : `${days} day(s) apart`);
  if (line.doctor && u.doctor) {
    if (norm(line.doctor) === norm(u.doctor)) {
      score += 10;
      reasons.push("Same doctor");
    } else reasons.push(`Doctor differs (file ${line.doctor}, Unite ${u.doctor})`);
  }
  return { score: Math.min(score, 100), reasons };
}

/** Candidates of every open line among the open Unite lines, both ways. */
function candidateMaps(lines: ProviderLine[], unite: UniteLine[], window: number) {
  const byLine = new Map<string, UniteLine[]>();
  const byUnite = new Map<string, ProviderLine[]>();
  for (const l of lines) {
    const cs = unite.filter((u) => isCandidate(l, u, window));
    byLine.set(l.id, cs);
    for (const u of cs) byUnite.set(u.id, [...(byUnite.get(u.id) ?? []), l]);
  }
  return { byLine, byUnite };
}

/** Pairs made only where each side has exactly one candidate and it is the other. */
function uniquePairs(lines: ProviderLine[], unite: UniteLine[], window: number) {
  const { byLine, byUnite } = candidateMaps(lines, unite, window);
  const pairs: Array<[ProviderLine, UniteLine]> = [];
  for (const l of lines) {
    const cs = byLine.get(l.id) ?? [];
    if (cs.length !== 1) continue;
    const back = byUnite.get(cs[0].id) ?? [];
    if (back.length === 1 && back[0].id === l.id) pairs.push([l, cs[0]]);
  }
  return pairs;
}

/** Shares `totalCents` by weight with the largest remainder; ties go to the earlier row (input order is sorted). */
export function shareByWeight(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sum);
  const floors = exact.map(Math.floor);
  let left = totalCents - floors.reduce((a, c) => a + c, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors;
}

const lastDayOfMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export function reconcileStatement(input: StatementInput): StatementResult {
  const { provider, settings } = input;
  const window = Math.max(0, Math.floor(settings.windowDays));
  const lines = [...input.lines].sort(
    (a, b) => cmp(a.serviceDate, b.serviceDate) || cmp(a.id, b.id),
  );
  const unite = [...input.unite].sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id));
  const notes = new Map(input.notes.map((n) => [n.itemKey, n]));

  // 1. matching: same day first, then the window, each time only unique pairs
  const matchedLine = new Map<string, UniteLine>();
  const matchedUnite = new Set<string>();
  for (const w of window > 0 ? [0, window] : [0]) {
    const openLines = lines.filter((l) => !matchedLine.has(l.id));
    const openUnite = unite.filter((u) => !matchedUnite.has(u.id));
    for (const [l, u] of uniquePairs(openLines, openUnite, w)) {
      matchedLine.set(l.id, u);
      matchedUnite.add(u.id);
    }
  }
  const matched: MatchedPair[] = lines
    .filter((l) => matchedLine.has(l.id))
    .map((l) => {
      const u = matchedLine.get(l.id)!;
      return { line: l, unite: u, ...scorePair(l, u) };
    });

  const openLines = lines.filter((l) => !matchedLine.has(l.id));
  const openUnite = unite.filter((u) => !matchedUnite.has(u.id));
  const { byLine } = candidateMaps(openLines, openUnite, window);
  const stillCandidate = new Set([...byLine.values()].flat().map((u) => u.id));
  const notBilled: NotBilled[] = openLines.map((l) => {
    const n = byLine.get(l.id)?.length ?? 0;
    return {
      line: l,
      key: lineKey(l.id),
      why: !l.pin ? "no_pin" : n === 0 ? "no_candidate" : "ambiguous",
      candidates: n,
      note: notes.get(lineKey(l.id)) ?? null,
    };
  });

  // 2. billed but not on the file: send-out labs only, Unite lines of the month for the provider's own tests
  const testCodes = new Set(input.tests.map((t) => norm(t.code)));
  const monthEnd = lastDayOfMonth(input.month);
  const notOnFile: NotOnFile[] =
    provider.kind !== "send_out_lab"
      ? []
      : openUnite
          .filter(
            (u) =>
              u.date >= input.month &&
              u.date <= monthEnd &&
              !stillCandidate.has(u.id) &&
              [u.itemCode, u.lineCpt, u.refCpt].some((c) => c && testCodes.has(norm(c))),
          )
          .map((u) => ({ unite: u, key: uniteKey(u.id), note: notes.get(uniteKey(u.id)) ?? null }));

  // 3. price variances and turnaround
  const tests = new Map(input.tests.map((t) => [norm(t.code), t]));
  const tolerance = cents(settings.priceTolerance);
  const priceVariances: PriceVariance[] = [];
  const late: LateResult[] = [];
  let withExpectation = 0;
  let onTime = 0;
  for (const l of lines) {
    const t = tests.get(norm(l.code));
    if (t?.agreedPrice != null && l.amount != null) {
      const diff = cents(l.amount) - cents(t.agreedPrice);
      if (Math.abs(diff) > tolerance)
        priceVariances.push({ line: l, agreed: t.agreedPrice, diff: fromCents(diff) });
    }
    if (t?.expectedDays != null) {
      withExpectation++;
      const pending = !l.resultDate;
      const days = daysBetween(l.serviceDate, l.resultDate ?? input.today);
      if (days > t.expectedDays)
        late.push({ line: l, expectedDays: t.expectedDays, days, pending });
      else if (!pending) onTime++;
    }
  }

  // 4. cost per doctor and branch
  const problems: string[] = [];
  const groups = new Map<string, AllocationRow & { weight: number; costCents: number }>();
  for (const l of lines) {
    const u = matchedLine.get(l.id);
    const doctor = u?.doctor ? norm(u.doctor) : l.doctor ? norm(l.doctor) : null;
    // Q42 (Finance, 22 Oct 2026): lab cost follows the branch on the Unite bill; the lab file's branch only when the
    // line is unmatched or the bill has none
    const branch = u?.branch ?? l.branch ?? null;
    const k = `${doctor ?? ""}|${branch ?? ""}`;
    const g = groups.get(k) ?? { doctor, branch, tests: 0, cost: 0, weight: 0, costCents: 0 };
    g.tests++;
    g.weight += provider.basis === "revenue" ? Math.max(0, cents(u?.net ?? 0)) : 1;
    g.costCents += cents(l.amount ?? 0);
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort(
    (a, b) => cmp(a.doctor ?? LAST, b.doctor ?? LAST) || cmp(a.branch ?? LAST, b.branch ?? LAST),
  );
  if (provider.kind === "in_house_lab") {
    if (provider.fixedFee == null)
      problems.push("Set the in-house lab's monthly fee in the settings.");
    else if (rows.length > 0) {
      const shares = shareByWeight(
        cents(provider.fixedFee),
        rows.map((r) => r.weight),
      );
      if (shares.every((s) => s === 0))
        problems.push(
          "No billed revenue to share the fee by; match the lines or share it by test count.",
        );
      rows.forEach((r, i) => (r.costCents = shares[i]));
    }
  }
  const allocation: AllocationRow[] = rows.map((r) => ({
    doctor: r.doctor,
    branch: r.branch,
    tests: r.tests,
    cost: fromCents(r.costCents),
  }));
  const perDoctor = new Map<string, number>();
  for (const r of rows)
    if (r.doctor) perDoctor.set(r.doctor, (perDoctor.get(r.doctor) ?? 0) + r.costCents);
  const doctors: DoctorCost[] = [...perDoctor.entries()]
    .filter(([, c]) => c > 0)
    .sort(([a], [b]) => cmp(a, b))
    .map(([doctor_dha_id, c]) => ({ doctor_dha_id, amount: fromCents(c) }));
  const totalCents = rows.reduce((a, r) => a + r.costCents, 0);
  const allocatedCents = [...perDoctor.values()].reduce((a, c) => a + c, 0);

  if (lines.length === 0) problems.push("Upload the provider's file first.");
  const lineReasons = notBilled.filter((n) => !n.note).length;
  if (lineReasons > 0) problems.push(`${lineReasons} line(s) not matched to Unite need a reason.`);
  const uniteReasons = notOnFile.filter((n) => !n.note).length;
  if (uniteReasons > 0)
    problems.push(`${uniteReasons} billed test(s) missing from the file need a reason.`);

  return {
    matched,
    notBilled,
    notOnFile,
    priceVariances,
    turnaround: { withExpectation, onTime, late },
    allocation,
    doctors,
    summary: {
      lines: lines.length,
      matched: matched.length,
      notBilled: notBilled.length,
      notOnFile: notOnFile.length,
      priceVariances: priceVariances.length,
      late: late.length,
      totalCost: fromCents(totalCents),
      allocated: fromCents(allocatedCents),
      unallocated: fromCents(totalCents - allocatedCents),
    },
    problems,
  };
}

/**
 * The figures frozen at review (the database stores their sha256): ids, codes, doctor ids and amounts only. Posting
 * reads `doctors` from the stored copy, never from a recomputation.
 */
export function statementFigures(
  r: StatementResult,
  meta: { statementId: string; providerId: string; providerKind: ProviderKind; month: string },
) {
  return {
    version: "labs-1",
    statement_id: meta.statementId,
    provider_id: meta.providerId,
    provider_kind: meta.providerKind,
    charge_kind: chargeKindFor(meta.providerKind),
    month: meta.month,
    summary: r.summary,
    allocation: r.allocation,
    doctors: r.doctors,
    matched: r.matched.map((m) => ({ line: m.line.id, unite: m.unite.id, score: m.score })),
    open: [
      ...r.notBilled.map((n) => ({ key: n.key, why: n.why, reason: n.note?.code ?? null })),
      ...r.notOnFile.map((n) => ({ key: n.key, why: "not_on_file", reason: n.note?.code ?? null })),
    ],
    problems: r.problems,
  };
}

/** Bulk lines for a provider's tests: "code, expected days, agreed price" per line (either number may be blank). */
export function parseTestList(
  raw: string,
): { ok: true; rows: ProviderTest[] } | { ok: false; error: string } {
  const rows: ProviderTest[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, error: "Enter at least one test." };
  if (lines.length > 2000) return { ok: false, error: "At most 2,000 tests at a time." };
  for (const [i, line] of lines.entries()) {
    const [codeRaw = "", daysRaw = "", priceRaw = "", ...rest] = line
      .split(/[,;\t]/)
      .map((s) => s.trim());
    const code = codeRaw.toUpperCase();
    const n = i + 1;
    if (rest.some((s) => s !== "")) return { ok: false, error: `Line ${n}: too many values.` };
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(code))
      return { ok: false, error: `Line ${n}: the code is not a CPT or item code.` };
    if (seen.has(code)) return { ok: false, error: `Line ${n}: ${code} appears twice.` };
    seen.add(code);
    const days = daysRaw === "" ? null : Number(daysRaw);
    if (days !== null && !(Number.isInteger(days) && days >= 0 && days <= 365))
      return { ok: false, error: `Line ${n}: expected days must be a whole number from 0 to 365.` };
    if (priceRaw !== "" && !/^\d{1,8}(\.\d{1,2})?$/.test(priceRaw))
      return {
        ok: false,
        error: `Line ${n}: the agreed price must be an amount such as 120 or 120.50 (no thousands separator).`,
      };
    const price = priceRaw === "" ? null : Number(priceRaw);
    if (days === null && price === null)
      return { ok: false, error: `Line ${n}: give the expected days, the agreed price, or both.` };
    rows.push({ code, expectedDays: days, agreedPrice: price });
  }
  return { ok: true, rows };
}
