import { z } from "zod";

/**
 * Recruitment viability calculator (M4 scenario, docs/23_PHASE_M4A_NOTES.md). Pure: the page, the save action and the
 * Excel export all call `computeRecruitment`, so the figures agree everywhere. Everything here is a SCENARIO: a
 * candidate's claimed revenue run through one cost model, never an actual and never pay.
 *
 * One pay engine, chosen by contract type (the HR Contract Generator's types, docs/finance/contract-rules-alignment.md):
 *   fixed_salary          pay = S                                  (generator `fixed-salary`, ordinary)
 *   salary_backed_share   pay = max(S, V)                          (`revenue-sharing`; salary and share are alternatives)
 *   share_only            pay = V                                  (`revenue-sharing` + `revenueShareOnly`)
 *   practitioner_share    pay = V, always on net revenue           (`revenue-sharing-practitioner`, aesthetics, dental)
 *   V = share% × (revenue − consumables − gateway), or share% × revenue when "share on gross revenue" is chosen.
 * The GP and Gynaecology incentive profiles are NOT modelled (their threshold basis is open, OQ-149); a clinic revenue
 * target (`minimumGuaranteeAed`) is never pay and has no input here.
 *
 * Chain: revenue (claimed × conservative %, plus equipment and nurse/coordinator revenue) → variable direct costs
 * (consumables %, gateway %) → gross margin → doctor pay → net margin → indirect monthly costs → profit.
 * Fixed salary and indirect costs are FIXED costs; consumables, gateway and a revenue share are VARIABLE. Breakeven is
 * the revenue at which profit reaches 0, solved per pay regime (piecewise for max(S, V)).
 *
 * Defaults (conservative %, consumables %, gateway %, minimum peer doctor-months) come from fin_ref_finance_settings;
 * nothing here is a business threshold.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The column defaults of the recruitment settings (fin_ref_finance_settings), for an org with no settings row yet. */
export const DEFAULT_RECRUIT_SETTINGS = {
  conservative: 70,
  consumables: 12,
  gateway: 1.5,
  minPeerMonths: 6,
} as const;

export const CONTRACT_TYPES = [
  "fixed_salary",
  "salary_backed_share",
  "share_only",
  "practitioner_share",
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_LABEL: Record<ContractType, string> = {
  fixed_salary: "Fixed salary",
  salary_backed_share: "Revenue sharing, salary-backed (higher of salary or share)",
  share_only: "Revenue sharing, share only",
  practitioner_share: "Practitioner agreement (share of net revenue)",
};

export const usesSalary = (t: ContractType) => t === "fixed_salary" || t === "salary_backed_share";
export const usesShare = (t: ContractType) => t !== "fixed_salary";

/**
 * Indirect monthly cost lines of the owner's model. `doctor` lines are the cost of employing the doctor and count in
 * cost to company; the rest are the cost of running the doctor's clinic. Each is entered as an amount over a number of
 * months (1 = monthly, 12 = yearly, 24 = a two-year visa) and spread evenly.
 */
export const INDIRECT_ITEMS = [
  { key: "dha_licence", label: "DHA licence", doctor: true },
  { key: "visa", label: "Visa", doctor: true },
  { key: "medical_insurance", label: "Medical insurance", doctor: true },
  { key: "malpractice", label: "Malpractice insurance", doctor: true },
  { key: "och_certificate", label: "OCH certificate", doctor: true },
  { key: "mohre", label: "MOHRE fees", doctor: true },
  { key: "gratuity", label: "Gratuity accrual", doctor: true },
  { key: "cancellation_provision", label: "Cancellation provision", doctor: false },
  { key: "room_rent", label: "Room rent", doctor: false },
  { key: "admin_overhead", label: "Admin overhead", doctor: false },
  { key: "nurse", label: "Nurse", doctor: false },
  { key: "coordinator", label: "Coordinator", doctor: false },
  { key: "equipment_maintenance", label: "Equipment maintenance", doctor: false },
  { key: "marketing", label: "Marketing", doctor: false },
  { key: "utilities", label: "Utilities", doctor: false },
] as const;
export type IndirectKey = (typeof INDIRECT_ITEMS)[number]["key"];
const INDIRECT_KEYS = INDIRECT_ITEMS.map((i) => i.key) as [IndirectKey, ...IndirectKey[]];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Percentages as typed (70 = 70 %). Read from fin_ref_finance_settings. */
export type RecruitSettings = {
  conservativePct: number;
  consumablesPct: number;
  gatewayPct: number;
  minPeerMonths: number;
};

/** The settings form (finance settings page). Field names are the column names. */
export const recruitSettingsSchema = z
  .object({
    recruit_conservative_pct: z.coerce
      .number({ message: "Conservative factor must be a number." })
      .gt(0, "Conservative factor must be above 0 %.")
      .max(100, "Conservative factor can be at most 100 %."),
    recruit_consumables_pct: z.coerce
      .number({ message: "Consumables must be a number." })
      .min(0, "Consumables cannot be negative.")
      .max(100, "Consumables can be at most 100 %."),
    recruit_gateway_pct: z.coerce
      .number({ message: "Gateway fee must be a number." })
      .min(0, "Gateway fee cannot be negative.")
      .max(100, "Gateway fee can be at most 100 %."),
    recruit_min_peer_months: z.coerce
      .number({ message: "Doctor-months must be a number." })
      .int("Doctor-months must be a whole number.")
      .min(1, "At least 1 doctor-month.")
      .max(1000, "At most 1,000 doctor-months."),
  })
  .refine((v) => v.recruit_consumables_pct + v.recruit_gateway_pct < 100, {
    message: "Consumables and gateway together must stay below 100 %.",
  });

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const MAX_AMOUNT = 1e9;
const amount = z.coerce
  .number({ message: "Enter an amount." })
  .min(0, "Amounts cannot be negative.")
  .max(MAX_AMOUNT, "That amount is too large.");
const pct = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number.` })
    .min(0, `${label} cannot be negative.`)
    .max(100, `${label} can be at most 100 %.`);

export const recruitmentInputsSchema = z
  .object({
    department: z
      .string()
      .trim()
      .max(80, "Department: at most 80 characters.")
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .default(null),
    contractType: z.enum(CONTRACT_TYPES, { message: "Choose a contract type." }),
    salary: amount.default(0),
    sharePct: pct("Share").default(0),
    shareBasis: z.enum(["net", "gross"]).default("net"),
    claimedRevenue: amount.default(0),
    equipmentRevenue: amount.default(0),
    staffRevenue: amount.default(0),
    conservativePct: pct("Conservative factor"),
    consumablesPct: pct("Consumables"),
    gatewayPct: pct("Gateway fee"),
    indirect: z
      .partialRecord(
        z.enum(INDIRECT_KEYS),
        z.object({
          amount,
          months: z.coerce
            .number()
            .int("Months must be a whole number.")
            .min(1, "Spread over at least 1 month.")
            .max(120, "Spread over at most 120 months."),
        }),
      )
      .default({}),
    setupCost: amount.default(0),
    startMonth: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .default(null)
      .refine((v) => v === null || monthStart(v) !== null, "Choose a valid start month."),
  })
  .transform((v) => normaliseInputs(v as RecruitmentInputs));

export type IndirectInput = { amount: number; months: number };
export type RecruitmentInputs = {
  department: string | null;
  contractType: ContractType;
  /** Monthly fixed package S (AED). Used by fixed salary and salary-backed only. */
  salary: number;
  /** Doctor's share in percent (40 = 40 %). Not used by fixed salary. */
  sharePct: number;
  /** "net": share of revenue after consumables and gateway (default); "gross": share of revenue. */
  shareBasis: "net" | "gross";
  /** Claimed monthly revenue (AED), before the conservative factor. */
  claimedRevenue: number;
  /** Monthly revenue from the candidate's equipment (AED), taken as entered. */
  equipmentRevenue: number;
  /** Monthly revenue from the candidate's nurse or coordinator (AED), taken as entered. */
  staffRevenue: number;
  conservativePct: number;
  consumablesPct: number;
  gatewayPct: number;
  indirect: Partial<Record<IndirectKey, IndirectInput>>;
  /** One-off cost of bringing the candidate in (AED). */
  setupCost: number;
  /** First month of work, yyyy-mm-01, or null. */
  startMonth: string | null;
};

/** Drops what the chosen contract type does not use, so a saved scenario holds only what it was calculated on. */
export function normaliseInputs(v: RecruitmentInputs): RecruitmentInputs {
  const indirect: Partial<Record<IndirectKey, IndirectInput>> = {};
  for (const k of INDIRECT_KEYS) {
    const it = v.indirect?.[k];
    if (it && it.amount > 0) indirect[k] = { amount: it.amount, months: it.months };
  }
  return {
    ...v,
    salary: usesSalary(v.contractType) ? v.salary : 0,
    sharePct: usesShare(v.contractType) ? v.sharePct : 0,
    shareBasis:
      v.contractType === "share_only" || v.contractType === "salary_backed_share"
        ? v.shareBasis
        : "net",
    startMonth: v.startMonth === null ? null : monthStart(v.startMonth),
    indirect,
  };
}

/** "2027-02" or "2027-02-15" -> "2027-02-01"; null when not a real month. */
export function monthStart(v: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** Inputs pre-filled from the clinic's settings (everything else blank). */
export function defaultInputs(s: RecruitSettings): RecruitmentInputs {
  return {
    department: null,
    contractType: "fixed_salary",
    salary: 0,
    sharePct: 0,
    shareBasis: "net",
    claimedRevenue: 0,
    equipmentRevenue: 0,
    staffRevenue: 0,
    conservativePct: s.conservativePct,
    consumablesPct: s.consumablesPct,
    gatewayPct: s.gatewayPct,
    indirect: {},
    setupCost: 0,
    startMonth: null,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type Viability = "viable" | "marginal" | "not_viable";
export const VIABILITY_LABEL: Record<Viability, string> = {
  viable: "Viable",
  marginal: "Marginal",
  not_viable: "Not viable",
};

/** One stretch of revenue over which doctor pay is `fixed + rate × revenue`. */
type PaySegment = { from: number; to: number; fixed: number; rate: number };

export type Breakeven = {
  /** Monthly revenue at which profit reaches 0; null = never (the margin cannot cover the fixed costs). */
  revenue: number | null;
  /** Fixed costs on the stretch where breakeven falls (indirect costs, plus the salary when it is the pay). */
  fixedCosts: number;
  /** Contribution margin ratio on that stretch: what each extra AED of revenue leaves after variable costs and pay. */
  contributionRatio: number;
  /** Breakeven ÷ expected revenue; null when there is no breakeven or no revenue. */
  pctOfRevenue: number | null;
  /** (Expected revenue − breakeven) ÷ expected revenue; null when there is no breakeven or no revenue. */
  safetyMargin: number | null;
};

export type RecruitmentResult = {
  revenue: {
    claimed: number;
    conservativeClaimed: number;
    equipment: number;
    staff: number;
    total: number;
  };
  consumables: number;
  gateway: number;
  grossMargin: number;
  grossMarginPct: number | null;
  /** The share V as calculated (also when the salary is higher). Null for fixed salary. */
  shareAmount: number | null;
  /** Which part of the contract pays this month: the salary or the share. */
  payBasis: "salary" | "share";
  doctorPay: number;
  netMargin: number;
  netMarginPct: number | null;
  indirect: { key: IndirectKey; label: string; doctor: boolean; monthly: number }[];
  indirectMonthly: number;
  profitMonthly: number;
  profitAnnual: number;
  profitMarginPct: number | null;
  /** Doctor pay plus the doctor's own employment costs (licence, visa, insurance, malpractice, certificates, gratuity). */
  costToCompany: number;
  ctcPctOfRevenue: number | null;
  /** Revenue ÷ doctor pay; null when nothing is paid. */
  revenuePerAedPaid: number | null;
  viability: Viability;
  breakeven: Breakeven;
  setupCost: number;
  /** Whole months of this profit needed to recover the setup cost; 0 with no setup cost; null when profit ≤ 0. */
  monthsToRecover: number | null;
};

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
/** Strips binary float noise (never rounds a figure people see; display rounds to 2 decimals). */
const clean = (x: number) => Math.round(x * 1e6) / 1e6;

function paySegments(i: RecruitmentInputs, variableRate: number): PaySegment[] {
  const share = i.sharePct / 100;
  // pay per AED of revenue in the share regime
  const k = share * (i.shareBasis === "gross" ? 1 : Math.max(0, 1 - variableRate));
  switch (i.contractType) {
    case "fixed_salary":
      return [{ from: 0, to: Infinity, fixed: i.salary, rate: 0 }];
    case "share_only":
    case "practitioner_share":
      return [{ from: 0, to: Infinity, fixed: 0, rate: k }];
    case "salary_backed_share": {
      if (k <= 0) return [{ from: 0, to: Infinity, fixed: i.salary, rate: 0 }];
      const sw = i.salary / k; // the revenue at which the share overtakes the salary
      return [
        { from: 0, to: sw, fixed: i.salary, rate: 0 },
        { from: sw, to: Infinity, fixed: 0, rate: k },
      ].filter((s) => s.to > s.from);
    }
  }
}

/**
 * The smallest revenue R ≥ 0 at which profit(R) = R × (1 − variable) − pay(R) − indirect ≥ 0. Profit is continuous and
 * piecewise linear with a falling slope (pay only ever moves from a fixed salary to a share), so each stretch is solved
 * in turn: the first stretch that reaches 0 inside its own bounds holds the answer; none means never.
 */
function solveBreakeven(
  segments: PaySegment[],
  variableRate: number,
  indirect: number,
): Omit<Breakeven, "pctOfRevenue" | "safetyMargin"> {
  for (const s of segments) {
    const slope = 1 - variableRate - s.rate;
    const fixed = s.fixed + indirect;
    const atStart = s.from * slope - fixed;
    // already at 0 here and not falling (with a falling slope any revenue above this point loses money)
    if (atStart >= -1e-9 && slope >= 0)
      return { revenue: s.from, fixedCosts: fixed, contributionRatio: slope };
    if (slope <= 0) continue;
    const r = fixed / slope;
    if (r <= s.to) return { revenue: r, fixedCosts: fixed, contributionRatio: slope };
  }
  const last = segments[segments.length - 1];
  return {
    revenue: null,
    fixedCosts: last.fixed + indirect,
    contributionRatio: 1 - variableRate - last.rate,
  };
}

export function computeRecruitment(raw: RecruitmentInputs): RecruitmentResult {
  const i = normaliseInputs(raw);
  const conservativeClaimed = i.claimedRevenue * (i.conservativePct / 100);
  const total = conservativeClaimed + i.equipmentRevenue + i.staffRevenue;
  const variableRate = (i.consumablesPct + i.gatewayPct) / 100;
  const consumables = total * (i.consumablesPct / 100);
  const gateway = total * (i.gatewayPct / 100);
  const grossMargin = total - consumables - gateway;

  const share = i.sharePct / 100;
  const shareAmount = usesShare(i.contractType)
    ? share * (i.shareBasis === "gross" ? total : Math.max(0, grossMargin))
    : null;
  let doctorPay: number;
  let payBasis: "salary" | "share";
  if (i.contractType === "fixed_salary") {
    doctorPay = i.salary;
    payBasis = "salary";
  } else if (i.contractType === "salary_backed_share") {
    payBasis = (shareAmount ?? 0) > i.salary ? "share" : "salary";
    doctorPay = Math.max(i.salary, shareAmount ?? 0);
  } else {
    doctorPay = shareAmount ?? 0;
    payBasis = "share";
  }
  const netMargin = grossMargin - doctorPay;

  const indirect = INDIRECT_ITEMS.map((it) => {
    const v = i.indirect[it.key];
    return {
      key: it.key,
      label: it.label,
      doctor: it.doctor,
      monthly: v ? v.amount / v.months : 0,
    };
  });
  const indirectMonthly = indirect.reduce((a, x) => a + x.monthly, 0);
  const profitMonthly = netMargin - indirectMonthly;
  const costToCompany =
    doctorPay + indirect.filter((x) => x.doctor).reduce((a, x) => a + x.monthly, 0);

  const viability: Viability =
    profitMonthly > 1e-9 ? "viable" : netMargin > 1e-9 ? "marginal" : "not_viable";

  const be = solveBreakeven(paySegments(i, variableRate), variableRate, indirectMonthly);
  const breakeven: Breakeven = {
    revenue: be.revenue === null ? null : clean(be.revenue),
    fixedCosts: clean(be.fixedCosts),
    contributionRatio: clean(be.contributionRatio),
    pctOfRevenue: be.revenue === null ? null : ratio(be.revenue, total),
    safetyMargin: be.revenue === null || total <= 0 ? null : (total - be.revenue) / total,
  };

  return {
    revenue: {
      claimed: clean(i.claimedRevenue),
      conservativeClaimed: clean(conservativeClaimed),
      equipment: clean(i.equipmentRevenue),
      staff: clean(i.staffRevenue),
      total: clean(total),
    },
    consumables: clean(consumables),
    gateway: clean(gateway),
    grossMargin: clean(grossMargin),
    grossMarginPct: ratio(grossMargin, total),
    shareAmount: shareAmount === null ? null : clean(shareAmount),
    payBasis,
    doctorPay: clean(doctorPay),
    netMargin: clean(netMargin),
    netMarginPct: ratio(netMargin, total),
    indirect: indirect.map((x) => ({ ...x, monthly: clean(x.monthly) })),
    indirectMonthly: clean(indirectMonthly),
    profitMonthly: clean(profitMonthly),
    profitAnnual: clean(profitMonthly * 12),
    profitMarginPct: ratio(profitMonthly, total),
    costToCompany: clean(costToCompany),
    ctcPctOfRevenue: ratio(costToCompany, total),
    revenuePerAedPaid: ratio(total, doctorPay),
    viability,
    breakeven,
    setupCost: clean(i.setupCost),
    monthsToRecover:
      i.setupCost <= 0
        ? 0
        : profitMonthly > 1e-9
          ? Math.ceil(clean(i.setupCost / profitMonthly))
          : null,
  };
}

// ---------------------------------------------------------------------------
// Benchmarks (the clinic's own Unite report data, public.fin_recruitment_benchmarks)
// ---------------------------------------------------------------------------

export type BenchmarkRow = {
  department: string | null;
  doctorMonths: number;
  doctors: number;
  median: number | null;
  p75: number | null;
};
export type Benchmarks = {
  settings: RecruitSettings;
  /** Calendar months (yyyy-mm-01) fully covered by committed uploads; only these are used. */
  months: string[];
  departments: BenchmarkRow[];
  clinic: BenchmarkRow;
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const num = (v: unknown, fallback: number) => {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? fallback : x;
};
const numOrNull = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
const row = (r: Raw): BenchmarkRow => ({
  department: typeof r.department === "string" && r.department !== "" ? r.department : null,
  doctorMonths: num(r.doctor_months, 0),
  doctors: num(r.doctors, 0),
  median: numOrNull(r.median),
  p75: numOrNull(r.p75),
});

/** Parses the SQL function's jsonb. Settings fall back to the column defaults the SQL already applied. */
export function parseBenchmarks(data: unknown): Benchmarks {
  const d = obj(data);
  const s = obj(d.settings);
  return {
    settings: {
      conservativePct: num(s.conservative_pct, NaN),
      consumablesPct: num(s.consumables_pct, NaN),
      gatewayPct: num(s.gateway_pct, NaN),
      minPeerMonths: num(s.min_peer_months, NaN),
    },
    months: Array.isArray(d.months)
      ? d.months.filter((m): m is string => typeof m === "string")
      : [],
    departments: Array.isArray(d.departments) ? d.departments.map((x) => row(obj(x))) : [],
    clinic: row(obj(d.clinic)),
  };
}

export type BenchmarkChoice =
  | { source: "department" | "clinic"; row: BenchmarkRow; reason: string | null }
  | { source: "none"; row: null; reason: string };

/**
 * A peer benchmark needs at least `minPeerMonths` doctor-months AND more than one doctor (one doctor's own history is
 * not a peer comparison, May-model defect 3). Otherwise the clinic-wide figures are used and the reason says so; with
 * too little clinic data there is no band at all (fail closed).
 */
export function pickBenchmark(b: Benchmarks, department: string | null): BenchmarkChoice {
  const min = b.settings.minPeerMonths;
  const ok = (r: BenchmarkRow) =>
    r.doctorMonths >= min && r.doctors >= 2 && r.median !== null && r.p75 !== null;
  const dept = department === null ? null : b.departments.find((r) => r.department === department);
  if (dept && ok(dept)) return { source: "department", row: dept, reason: null };
  const why =
    department === null
      ? "No department chosen"
      : !dept
        ? `No report data for ${department}`
        : dept.doctors < 2
          ? `${department} has only one doctor in the report data, which is not a peer comparison`
          : `${department} has ${dept.doctorMonths} doctor-months, fewer than the ${min} required`;
  if (ok(b.clinic))
    return { source: "clinic", row: b.clinic, reason: `${why}; clinic-wide figures are used.` };
  return {
    source: "none",
    row: null,
    reason: `${why}, and the clinic has ${b.clinic.doctorMonths} doctor-months from ${b.clinic.doctors} doctor(s) (at least ${min} doctor-months from two doctors are needed). No band is given.`,
  };
}

export type RecruitBand = "A" | "B" | "below";
export const RECRUIT_BAND_LABEL: Record<RecruitBand, string> = {
  A: "Band A (at or above the 75th percentile)",
  B: "Band B (at or above the median)",
  below: "Below the median",
};

/** Band of a monthly revenue against a benchmark: A ≥ p75, B ≥ median, else below. Null without a benchmark. */
export function recruitBand(revenue: number, r: BenchmarkRow | null): RecruitBand | null {
  if (!r || r.median === null || r.p75 === null || !Number.isFinite(revenue)) return null;
  const c = (x: number) => Math.round(x * 100);
  if (c(revenue) >= c(r.p75)) return "A";
  if (c(revenue) >= c(r.median)) return "B";
  return "below";
}

// ---------------------------------------------------------------------------
// Seasonality (dated events, fin_ref_calendar_events)
// ---------------------------------------------------------------------------

export const CALENDAR_KINDS = ["ramadan", "eid", "school_holiday", "summer", "other"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export const CALENDAR_KIND_LABEL: Record<CalendarKind, string> = {
  ramadan: "Ramadan",
  eid: "Eid",
  school_holiday: "School holiday",
  summer: "Summer",
  other: "Other",
};
export type CalendarEvent = {
  id: string;
  startsOn: string;
  endsOn: string;
  kind: CalendarKind;
  label: string;
  approximate: boolean;
};

/** The note covers the candidate's first three months of work (the plan's window, not a tunable threshold). */
export const SEASON_WINDOW_MONTHS = 3;

export function addMonths(month: string, k: number): string {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
}

/** Events that overlap the first `SEASON_WINDOW_MONTHS` months from `startMonth`, in date order. */
export function eventsInWindow(
  events: CalendarEvent[],
  startMonth: string | null,
): { from: string; to: string; events: CalendarEvent[] } | null {
  if (!startMonth) return null;
  const from = `${startMonth.slice(0, 7)}-01`;
  const end = addMonths(from, SEASON_WINDOW_MONTHS); // exclusive
  const to = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return {
    from,
    to,
    events: events
      .filter((e) => e.startsOn <= to && e.endsOn >= from)
      .sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0)),
  };
}

export const calendarEventSchema = z
  .object({
    starts_on: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the first day."),
    ends_on: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the last day."),
    kind: z.enum(CALENDAR_KINDS, { message: "Choose a kind." }),
    label: z
      .string()
      .trim()
      .min(1, "Give the event a name.")
      .max(80, "Name: at most 80 characters."),
    approximate: z.string().optional(),
  })
  .refine((v) => !Number.isNaN(Date.parse(`${v.starts_on}T00:00:00Z`)), "Enter a valid first day.")
  .refine((v) => !Number.isNaN(Date.parse(`${v.ends_on}T00:00:00Z`)), "Enter a valid last day.")
  .refine((v) => v.ends_on >= v.starts_on, "The last day cannot be before the first day.")
  .refine(
    (v) =>
      Date.parse(`${v.ends_on}T00:00:00Z`) - Date.parse(`${v.starts_on}T00:00:00Z`) <=
      366 * 86_400_000,
    "An event can last at most a year.",
  );

// ---------------------------------------------------------------------------
// The whole scenario (what the page shows, the save action stores and the export prints)
// ---------------------------------------------------------------------------

export const SCENARIO_ENGINE = "recruitment-v1";

export type ScenarioReport = {
  engine: typeof SCENARIO_ENGINE;
  result: RecruitmentResult;
  benchmark: {
    source: BenchmarkChoice["source"];
    reason: string | null;
    doctorMonths: number | null;
    doctors: number | null;
    median: number | null;
    p75: number | null;
    /** Calendar months of report data behind the figures. */
    months: number;
    band: RecruitBand | null;
  };
  season: {
    from: string;
    to: string;
    events: {
      label: string;
      kind: CalendarKind;
      startsOn: string;
      endsOn: string;
      approximate: boolean;
    }[];
  } | null;
};

export function buildScenarioReport(
  inputs: RecruitmentInputs,
  benchmarks: Benchmarks,
  events: CalendarEvent[],
): ScenarioReport {
  const result = computeRecruitment(inputs);
  const choice = pickBenchmark(benchmarks, inputs.department);
  const w = eventsInWindow(events, inputs.startMonth);
  return {
    engine: SCENARIO_ENGINE,
    result,
    benchmark: {
      source: choice.source,
      reason: choice.reason,
      doctorMonths: choice.row?.doctorMonths ?? null,
      doctors: choice.row?.doctors ?? null,
      median: choice.row?.median ?? null,
      p75: choice.row?.p75 ?? null,
      months: benchmarks.months.length,
      band: recruitBand(result.revenue.total, choice.row),
    },
    season: w && {
      from: w.from,
      to: w.to,
      events: w.events.map((e) => ({
        label: e.label,
        kind: e.kind,
        startsOn: e.startsOn,
        endsOn: e.endsOn,
        approximate: e.approximate,
      })),
    },
  };
}

/** Scenario titles are role labels, never a person's name. */
export const scenarioTitleSchema = z
  .string()
  .trim()
  .min(1, 'Give the scenario a title (a role label, e.g. "Dermatologist, Jumeirah").')
  .max(80, "Title: at most 80 characters.");
