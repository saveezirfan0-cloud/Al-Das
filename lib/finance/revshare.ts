import { z } from "zod";

import { toCsv } from "@/lib/csv";
import { MAX_COST_ROWS, parseAmount, parseMonth, readCsv } from "@/lib/finance/cost-upload";

/**
 * Slice 20F: doctor revenue share (pure). The rule vocabulary is closed (no formula language, nothing is evaluated):
 *
 *   payout = max(minimum_guarantee or 0,
 *                Σ_category rate_c × net_c × eligible  −  Σ_kind deduction_k × charges_k,
 *                0)
 *
 * where rate_c is the category's own rate or the default rate, net_c the doctor's invoice-line net in that service
 * category for the month, and eligible = (base − threshold) / base when a threshold is set (only revenue above it earns a
 * share, pro rata over the categories; 0 when the base does not exceed it), otherwise 1. Every step is rounded to 2
 * decimals half away from zero with exact integer arithmetic, so the steps shown always add up to the payout.
 *
 * The same rule shape is checked in SQL (app.fin_revshare_rule_valid, migration 20261101000100). Synthetic data only in
 * tests; doctor ids, categories and amounts only, no patient data.
 */

export const CALC_VERSION = "revshare-1";

export const CHARGE_KINDS = ["lab", "referral", "consumables", "other"] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];
export const CHARGE_KIND_LABELS: Record<ChargeKind, string> = {
  lab: "Lab",
  referral: "External referral",
  consumables: "Consumables",
  other: "Other",
};
export const CHARGE_SOURCES = ["manual", "upload", "lab_recon", "referral_recon"] as const;

export const RUN_STATUSES = ["draft", "verified", "approved", "posted", "paid"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const SCHEME_STATUSES = ["draft", "verified", "approved", "retired"] as const;
export type SchemeStatus = (typeof SCHEME_STATUSES)[number];

export const MAX_CATEGORY_RATES = 30;
const MAX_AMOUNT = 1_000_000_000;

/** A doctor id as stored: trimmed, upper case, 1 to 40 characters, no control characters. */
export function normaliseDoctorId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return t.length >= 1 && t.length <= 40 && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
}

const decimals = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.abs(v * f - Math.round(v * f)) < 1e-6;
};
const rate = z
  .number({ message: "A rate must be a number." })
  .finite()
  .min(0, "A rate cannot be below 0 %.")
  .max(1, "A rate cannot be above 100 %.")
  .refine(
    (v) => decimals(v, 4),
    "A rate can have at most two decimals as a percentage (e.g. 33.25 %).",
  );
const amount = z
  .number({ message: "An amount must be a number." })
  .finite()
  .min(0, "An amount cannot be negative.")
  .max(MAX_AMOUNT, "That amount is too large.")
  .refine((v) => decimals(v, 2), "An amount can have at most two decimals.");

export const revshareRuleSchema = z.strictObject({
  basis: z.literal("net_revenue"),
  default_rate: rate,
  category_rates: z
    .record(z.string(), rate)
    .refine((r) => Object.keys(r).length <= MAX_CATEGORY_RATES, "At most 30 category rates.")
    .refine(
      (r) => Object.keys(r).every((k) => k === k.trim() && k.length >= 1 && k.length <= 60),
      "A category name must be 1 to 60 characters without spaces around it.",
    )
    .optional(),
  deductions: z.strictObject({
    lab: rate.optional(),
    referral: rate.optional(),
    consumables: rate.optional(),
    other: rate.optional(),
  }),
  threshold: amount.optional(),
  minimum_guarantee: amount.optional(),
});
export type RevshareRule = z.infer<typeof revshareRuleSchema>;

/** The starting point for a new scheme: lab and external-referral costs are charged to the doctor in full. */
export const DEFAULT_RULE: RevshareRule = {
  basis: "net_revenue",
  default_rate: 0,
  deductions: { lab: 1, referral: 1 },
};

export function parseRule(json: unknown): RevshareRule | null {
  const r = revshareRuleSchema.safeParse(json);
  return r.success ? r.data : null;
}

/** Drops undefined keys so the stored JSON is exactly what was validated. */
export function cleanRule(rule: RevshareRule): RevshareRule {
  return JSON.parse(JSON.stringify(rule)) as RevshareRule;
}

// ---------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------

export type RevenueRow = { category: string; net: number };
export type ChargeRow = { kind: ChargeKind; amount: number };

export type CategoryStep = {
  category: string;
  net: number;
  rate: number;
  rate_source: "category" | "default";
  /** rate × net, before the threshold */
  gross: number;
  /** rate × net × eligible, rounded: what the doctor earns from this category */
  earned: number;
};
export type DeductionStep = { kind: ChargeKind; charges: number; share: number; deducted: number };
export type Calculation = {
  base: number;
  threshold: number | null;
  /** (base − threshold) / base, 0 or 1; 6 decimals, for display (the steps use the exact fraction) */
  eligible_fraction: number;
  categories: CategoryStep[];
  share: number;
  deductions: DeductionStep[];
  total_deductions: number;
  before_guarantee: number;
  minimum_guarantee: number | null;
  payout: number;
  outcome: "calculated" | "guarantee" | "zero";
};

// BigInt literals need ES2020; the project targets ES2017, so the constants are built once.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN_K = BigInt(10000);
const MILLION = BigInt(1_000_000);
const cents = (n: number) => BigInt(Math.round(n * 100));
const bp = (r: number) => BigInt(Math.round(r * 10000));
const toNumber = (c: bigint) => Number(c) / 100;
const abs = (n: bigint) => (n < ZERO ? -n : n);
/** n / d rounded half away from zero (d > 0), as Postgres round() does. */
function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (TWO * abs(r) >= d) return n < ZERO ? q - ONE : q + ONE;
  return q;
}
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function calculatePayout(
  rule: RevshareRule,
  revenue: readonly RevenueRow[],
  charges: readonly ChargeRow[],
): Calculation {
  const netBy = new Map<string, bigint>();
  for (const r of revenue) netBy.set(r.category, (netBy.get(r.category) ?? ZERO) + cents(r.net));
  const cats = [...netBy.keys()].sort(byText);
  const base = cats.reduce((s, c) => s + netBy.get(c)!, ZERO);

  const thr = rule.threshold === undefined ? null : cents(rule.threshold);
  let fNum = ONE;
  let fDen = ONE;
  if (thr !== null) {
    if (base > thr) {
      fNum = base - thr;
      fDen = base;
    } else {
      fNum = ZERO;
    }
  }

  const categories: CategoryStep[] = cats.map((category) => {
    const net = netBy.get(category)!;
    const own = rule.category_rates?.[category];
    const r = bp(own ?? rule.default_rate);
    return {
      category,
      net: toNumber(net),
      rate: Number(r) / 10000,
      rate_source: own === undefined ? "default" : "category",
      gross: toNumber(roundDiv(net * r, TEN_K)),
      earned: toNumber(roundDiv(net * r * fNum, TEN_K * fDen)),
    };
  });
  const shareC = categories.reduce((s, c) => s + cents(c.earned), ZERO);

  const chargeBy = new Map<ChargeKind, bigint>();
  for (const c of charges) chargeBy.set(c.kind, (chargeBy.get(c.kind) ?? ZERO) + cents(c.amount));
  const deductions: DeductionStep[] = CHARGE_KINDS.filter(
    (k) => (chargeBy.get(k) ?? ZERO) !== ZERO,
  ).map((kind) => {
    const total = chargeBy.get(kind)!;
    const s = bp(rule.deductions[kind] ?? 0);
    return {
      kind,
      charges: toNumber(total),
      share: Number(s) / 10000,
      deducted: toNumber(roundDiv(total * s, TEN_K)),
    };
  });
  const dedC = deductions.reduce((s, d) => s + cents(d.deducted), ZERO);

  const before = shareC - dedC;
  const guarantee = rule.minimum_guarantee === undefined ? null : cents(rule.minimum_guarantee);
  let payout = before;
  let outcome: Calculation["outcome"] = "calculated";
  if (guarantee !== null && guarantee > ZERO && guarantee > payout) {
    payout = guarantee;
    outcome = "guarantee";
  }
  if (payout < ZERO) {
    payout = ZERO;
    outcome = "zero";
  }

  return {
    base: toNumber(base),
    threshold: thr === null ? null : toNumber(thr),
    eligible_fraction: Number(roundDiv(fNum * MILLION, fDen)) / 1_000_000,
    categories,
    share: toNumber(shareC),
    deductions,
    total_deductions: toNumber(dedC),
    before_guarantee: toNumber(before),
    minimum_guarantee: guarantee === null ? null : toNumber(guarantee),
    payout: toNumber(payout),
    outcome,
  };
}

// ---------------------------------------------------------------------------
// Inputs (fin_revshare_inputs) and the run snapshot
// ---------------------------------------------------------------------------

const num = z.coerce.number().finite();
const inputsSchema = z.object({
  month: z.string(),
  doctor_basis: z.string().nullable(),
  revenue: z.array(
    z.object({
      doctor_dha_id: z.string().nullable(),
      category: z.string(),
      net: num,
      lines: num,
      invoices: num,
    }),
  ),
  charges: z.array(
    z.object({
      id: z.string(),
      doctor_dha_id: z.string(),
      kind: z.enum(CHARGE_KINDS),
      amount: num,
      source: z.string(),
      reference: z.string().nullable(),
    }),
  ),
  schemes: z.array(
    z.object({
      doctor_dha_id: z.string(),
      scheme_id: z.string(),
      version: num,
      effective_from: z.string(),
      rule: z.unknown(),
      rule_hash: z.string(),
      verified_by: z.string().nullable(),
      verified_at: z.string().nullable(),
      approved_by: z.string().nullable(),
      approved_at: z.string().nullable(),
    }),
  ),
  doctors: z.array(z.object({ dha_id: z.string(), name: z.string().nullable() })),
});
export type RevshareInputs = z.infer<typeof inputsSchema>;

export function parseInputs(json: unknown): RevshareInputs {
  const r = inputsSchema.safeParse(json);
  if (!r.success) throw new Error("Unexpected revenue share inputs.");
  return r.data;
}

export type RunResult = {
  doctor_dha_id: string;
  doctor_name: string | null;
  scheme_id: string;
  scheme_version: number;
  effective_from: string;
  rule_hash: string;
  rule: RevshareRule;
  calc: Calculation;
  payout: number;
};
export type NoSchemeRow = {
  doctor_dha_id: string;
  doctor_name: string | null;
  revenue: number;
  charges: number;
};
export type RunSnapshot = {
  calc_version: string;
  month: string;
  /** exactly what fin_revshare_inputs returned (the database checks it on store and on verify) */
  inputs: unknown;
  results: RunResult[];
  no_scheme: NoSchemeRow[];
  unassigned_revenue: number;
  totals: { doctors: number; revenue: number; share: number; deducted: number; payout: number };
};

const sumCents = (xs: number[]) => toNumber(xs.reduce((s, x) => s + cents(x), ZERO));

/** Builds the snapshot of a month from the raw inputs JSON (kept as received, so the database can compare it). */
export function buildRunSnapshot(inputsJson: unknown): RunSnapshot {
  const inputs = parseInputs(inputsJson);
  const names = new Map(inputs.doctors.map((d) => [d.dha_id, d.name]));
  const results: RunResult[] = inputs.schemes.map((s) => {
    const rule = parseRule(s.rule);
    if (!rule) throw new Error(`The approved scheme of ${s.doctor_dha_id} has an invalid rule.`);
    const revenue = inputs.revenue
      .filter((r) => r.doctor_dha_id === s.doctor_dha_id)
      .map((r) => ({ category: r.category, net: r.net }));
    const charges = inputs.charges
      .filter((c) => c.doctor_dha_id === s.doctor_dha_id)
      .map((c) => ({ kind: c.kind, amount: c.amount }));
    const calc = calculatePayout(rule, revenue, charges);
    return {
      doctor_dha_id: s.doctor_dha_id,
      doctor_name: names.get(s.doctor_dha_id) ?? null,
      scheme_id: s.scheme_id,
      scheme_version: s.version,
      effective_from: s.effective_from,
      rule_hash: s.rule_hash,
      rule,
      calc,
      payout: calc.payout,
    };
  });
  results.sort((a, b) => byText(a.doctor_dha_id, b.doctor_dha_id));

  const withScheme = new Set(results.map((r) => r.doctor_dha_id));
  const other = new Map<string, { revenue: number[]; charges: number[] }>();
  const slot = (id: string) => {
    const s = other.get(id) ?? { revenue: [], charges: [] };
    other.set(id, s);
    return s;
  };
  for (const r of inputs.revenue)
    if (r.doctor_dha_id && !withScheme.has(r.doctor_dha_id))
      slot(r.doctor_dha_id).revenue.push(r.net);
  for (const c of inputs.charges)
    if (!withScheme.has(c.doctor_dha_id)) slot(c.doctor_dha_id).charges.push(c.amount);
  const no_scheme = [...other.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([id, v]) => ({
      doctor_dha_id: id,
      doctor_name: names.get(id) ?? null,
      revenue: sumCents(v.revenue),
      charges: sumCents(v.charges),
    }));

  return {
    calc_version: CALC_VERSION,
    month: inputs.month,
    inputs: inputsJson,
    results,
    no_scheme,
    unassigned_revenue: sumCents(inputs.revenue.filter((r) => !r.doctor_dha_id).map((r) => r.net)),
    totals: {
      doctors: results.length,
      revenue: sumCents(results.map((r) => r.calc.base)),
      share: sumCents(results.map((r) => r.calc.share)),
      deducted: sumCents(results.map((r) => r.calc.total_deductions)),
      payout: sumCents(results.map((r) => r.payout)),
    },
  };
}

/** Reads a stored snapshot for display; null when it is not one this code wrote. */
export function readSnapshot(json: unknown): RunSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const s = json as Partial<RunSnapshot>;
  if (s.calc_version !== CALC_VERSION || !Array.isArray(s.results) || !s.totals) return null;
  return s as RunSnapshot;
}

// ---------------------------------------------------------------------------
// Trail CSV (one row per step of each doctor's calculation, plus the run's sign-offs and payments)
// ---------------------------------------------------------------------------

export type RunTrail = {
  status: RunStatus;
  snapshot_hash: string;
  built_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_ref: string | null;
  posted_at: string | null;
  lines: Array<{ doctor_dha_id: string; paid_on: string | null; payment_ref: string | null }>;
};

const pct = (r: number) => `${Math.round(r * 1_000_000) / 10_000}%`;

export function runTrailCsv(snap: RunSnapshot, trail: RunTrail): string {
  const month = snap.month.slice(0, 7);
  const rows: unknown[][] = [];
  const run = (step: string, item: string, value: string | null) =>
    rows.push([month, "", "", "", "", step, item, value ?? "", "", ""]);
  run("run", "status", trail.status);
  run("run", "calculation", snap.calc_version);
  run("run", "snapshot sha256", trail.snapshot_hash);
  run("run", "built", trail.built_at);
  run(
    "run",
    "verified by",
    trail.verified_by ? `${trail.verified_by} ${trail.verified_at ?? ""}`.trim() : null,
  );
  run(
    "run",
    "approved by",
    trail.approved_by ? `${trail.approved_by} ${trail.approved_at ?? ""}`.trim() : null,
  );
  run(
    "run",
    "accounting reference",
    trail.posted_ref ? `${trail.posted_ref} ${trail.posted_at ?? ""}`.trim() : null,
  );
  const paid = new Map(trail.lines.map((l) => [l.doctor_dha_id, l]));
  for (const r of snap.results) {
    const c = r.calc;
    const row = (
      step: string,
      item: string,
      amount: number | null,
      rateText: string,
      result: number | string | null,
    ) =>
      rows.push([
        month,
        r.doctor_dha_id,
        r.doctor_name ?? "",
        r.scheme_version,
        r.rule_hash,
        step,
        item,
        amount ?? "",
        rateText,
        result ?? "",
      ]);
    for (const k of c.categories)
      row("revenue", k.category, k.net, `${pct(k.rate)} (${k.rate_source})`, k.gross);
    row("revenue", "total", c.base, "", sumCents(c.categories.map((x) => x.gross)));
    row(
      "threshold",
      "eligible share of revenue",
      c.threshold,
      String(c.eligible_fraction),
      c.share,
    );
    for (const k of c.categories)
      row("earned", k.category, k.gross, String(c.eligible_fraction), k.earned);
    for (const d of c.deductions)
      row("deduction", CHARGE_KIND_LABELS[d.kind], d.charges, pct(d.share), -d.deducted);
    row("deduction", "total", null, "", -c.total_deductions);
    row("before guarantee", "", null, "", c.before_guarantee);
    row("minimum guarantee", "", c.minimum_guarantee, "", c.minimum_guarantee);
    row("payout", c.outcome, null, "", r.payout);
    const p = paid.get(r.doctor_dha_id);
    row("payment", p?.payment_ref ?? "", null, p?.paid_on ?? "", p?.paid_on ? r.payout : null);
  }
  for (const n of snap.no_scheme)
    rows.push([
      month,
      n.doctor_dha_id,
      n.doctor_name ?? "",
      "",
      "",
      "no approved scheme",
      "revenue / charges",
      n.revenue,
      "",
      n.charges,
    ]);
  if (snap.unassigned_revenue !== 0)
    rows.push([month, "", "", "", "", "no doctor", "revenue", snap.unassigned_revenue, "", ""]);
  return toCsv(
    [
      "month",
      "doctor_dha_id",
      "doctor_name",
      "scheme_version",
      "rule_sha256",
      "step",
      "item",
      "amount",
      "rate",
      "result",
    ],
    rows,
  );
}

// ---------------------------------------------------------------------------
// Charges CSV: month, doctor_dha_id, kind, amount, [reference], [note]. All or nothing; unknown columns refused.
// ---------------------------------------------------------------------------

export type ChargeInputRow = {
  month: string;
  doctor_dha_id: string;
  kind: ChargeKind;
  amount: number;
  reference: string | null;
  note: string | null;
};
export const CHARGES_TEMPLATE = "month,doctor_dha_id,kind,amount,reference,note\n";
const CHARGE_REQUIRED = ["month", "doctor_dha_id", "kind", "amount"];
const CHARGE_OPTIONAL = ["reference", "note"];

export function parseChargesCsv(
  text: string,
): { ok: true; rows: ChargeInputRow[] } | { ok: false; errors: string[] } {
  const raw = readCsv(text);
  if (raw.length === 0) return { ok: false, errors: ["The file is empty."] };
  const header = raw[0].map((h) => h.trim().toLowerCase());
  const errors: string[] = [];
  for (const h of header)
    if (![...CHARGE_REQUIRED, ...CHARGE_OPTIONAL].includes(h))
      errors.push(
        `Unknown column "${h}". Expected: ${[...CHARGE_REQUIRED, ...CHARGE_OPTIONAL].join(", ")}.`,
      );
  for (const h of CHARGE_REQUIRED) if (!header.includes(h)) errors.push(`Missing column "${h}".`);
  if (new Set(header).size !== header.length) errors.push("A column name appears twice.");
  if (errors.length) return { ok: false, errors };
  if (raw.length - 1 > MAX_COST_ROWS)
    return { ok: false, errors: [`Too many rows (the limit is ${MAX_COST_ROWS}).`] };
  if (raw.length === 1) return { ok: false, errors: ["The file has no rows."] };
  const rows: ChargeInputRow[] = [];
  raw.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const r = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? "").trim()]));
    const month = parseMonth(r.month);
    const doctor = normaliseDoctorId(r.doctor_dha_id);
    const kind = r.kind.toLowerCase() as ChargeKind;
    const amt = parseAmount(r.amount);
    const reference = r.reference ? r.reference.slice(0, 80) : null;
    const note = r.note ? r.note.slice(0, 300) : null;
    if (!month) errors.push(`Row ${line}: month must look like 2026-09.`);
    if (!doctor) errors.push(`Row ${line}: doctor_dha_id is blank or too long.`);
    if (!CHARGE_KINDS.includes(kind))
      errors.push(`Row ${line}: kind must be ${CHARGE_KINDS.join(", ")}.`);
    if (amt === null || amt <= 0 || amt > MAX_AMOUNT)
      errors.push(`Row ${line}: amount must be above 0, like 250.00.`);
    if (
      month &&
      doctor &&
      CHARGE_KINDS.includes(kind) &&
      amt !== null &&
      amt > 0 &&
      amt <= MAX_AMOUNT
    )
      rows.push({ month, doctor_dha_id: doctor, kind, amount: amt, reference, note });
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, rows };
}

// ---------------------------------------------------------------------------
// The scheme form: percentages typed by a person -> a rule (validated by the schema above)
// ---------------------------------------------------------------------------

/** "35" -> 0.35, "33.25" -> 0.3325; blank -> undefined; anything else -> NaN (the schema then refuses it). */
export function percentToRate(v: string | undefined): number | undefined {
  const t = (v ?? "").trim().replace(/%$/, "").trim();
  if (t === "") return undefined;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100) / 10000;
}
/** "12,000.50" -> 12000.5; blank -> undefined; anything else -> NaN. */
export function moneyInput(v: string | undefined): number | undefined {
  const t = (v ?? "").trim();
  if (t === "") return undefined;
  const n = parseAmount(t);
  return n === null ? Number.NaN : n;
}

/**
 * Field names: default_pct, ded_<kind>_pct, threshold, guarantee, cat_name_<i> / cat_pct_<i> (i = 0..29).
 * Category names must be one of `knownCategories` (the service categories in reference data, plus Unmapped).
 */
export function ruleFromForm(
  v: Record<string, string>,
  knownCategories: readonly string[],
): { ok: true; rule: RevshareRule } | { ok: false; error: string } {
  const known = new Set(knownCategories);
  const category_rates: Record<string, number> = {};
  for (let i = 0; i < MAX_CATEGORY_RATES; i++) {
    const name = (v[`cat_name_${i}`] ?? "").trim();
    const r = percentToRate(v[`cat_pct_${i}`]);
    if (!name && r === undefined) continue;
    if (!name) return { ok: false, error: "Choose the category for every category rate." };
    if (!known.has(name))
      return { ok: false, error: `"${name}" is not a service category in reference data.` };
    if (r === undefined) return { ok: false, error: `Give a rate for ${name}.` };
    if (name in category_rates) return { ok: false, error: `${name} has two rates.` };
    category_rates[name] = r;
  }
  const deductions: RevshareRule["deductions"] = {};
  for (const k of CHARGE_KINDS) {
    const r = percentToRate(v[`ded_${k}_pct`]);
    if (r !== undefined) deductions[k] = r;
  }
  const draft = {
    basis: "net_revenue" as const,
    default_rate: percentToRate(v.default_pct) ?? Number.NaN,
    ...(Object.keys(category_rates).length ? { category_rates } : {}),
    deductions,
    threshold: moneyInput(v.threshold),
    minimum_guarantee: moneyInput(v.guarantee),
  };
  const parsed = revshareRuleSchema.safeParse(cleanRule(draft as RevshareRule));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    const label = where.startsWith("default_rate")
      ? "Default rate"
      : where.startsWith("deductions")
        ? "Deductions"
        : where.startsWith("category_rates")
          ? "Category rates"
          : where.startsWith("threshold")
            ? "Threshold"
            : where.startsWith("minimum_guarantee")
              ? "Minimum guarantee"
              : "Rule";
    return { ok: false, error: `${label}: ${issue?.message ?? "check the value."}` };
  }
  return { ok: true, rule: parsed.data };
}

/** One line in words, for lists. */
export function ruleSummary(rule: RevshareRule): string {
  const parts = [`${pct(rule.default_rate)} of net revenue`];
  const cats = Object.entries(rule.category_rates ?? {});
  if (cats.length) parts.push(cats.map(([c, r]) => `${c} ${pct(r)}`).join(", "));
  if (rule.threshold !== undefined)
    parts.push(`above ${rule.threshold.toLocaleString("en-GB")} a month`);
  const ded = CHARGE_KINDS.filter((k) => (rule.deductions[k] ?? 0) > 0).map(
    (k) => `${CHARGE_KIND_LABELS[k].toLowerCase()} ${pct(rule.deductions[k]!)}`,
  );
  parts.push(ded.length ? `less ${ded.join(", ")}` : "no deductions");
  if (rule.minimum_guarantee !== undefined)
    parts.push(`at least ${rule.minimum_guarantee.toLocaleString("en-GB")} a month`);
  return parts.join("; ");
}

export const percentText = pct;
