import { z } from "zod";

import {
  coverageOf,
  round3,
  UNASSIGNED_LABEL,
  type Coverage,
  type DateRange,
} from "@/lib/finance/doctor-performance";
import {
  allocateOverheads,
  PROVISIONAL_LABEL,
  type OverheadRow,
} from "@/lib/finance/profitability";

/**
 * Contribution by doctor, department and clinic (M2A; docs/40 §2 levels L3, L5 and L6). Pure: it reads what
 * fin_contribution_inputs() returned and never a table.
 *
 *   L3 doctor contribution  = revenue − doctor pay actually loaded (fin_cost_doctor_comp) − doctor charges
 *   department              = Σ its doctors' L3 (L4 department cost pools do not exist yet)
 *   L5 clinic contribution  = Σ its doctors' L3 − the branch's own overheads
 *   L6 after allocation     = L5 − the shared overhead pools allocated by their basis (allocateOverheads), its own line
 *
 * Honesty rules:
 *   - pay is never calculated: only amounts Finance loaded count. A doctor whose report name is not linked to a DHA id
 *     shows "pay not linked", a linked doctor with no pay for the month (or a 0, which means unavailable) "pay not
 *     loaded"; neither is ever treated as zero pay. Their revenue is left out of every contribution and coverage says
 *     how much revenue is in;
 *   - a doctor's pay and charges are split over all that doctor's rows in the month (every branch, every department and
 *     every report spelling linked to the same DHA id) by revenue, so nothing is counted twice;
 *   - everything is Provisional until Finance approves the month AND every doctor with revenue has pay loaded (and the
 *     report covers the whole month);
 *   - without finance.costs.compensation no individual pay is shown: the pay column and every doctor's contribution are
 *     removed here (not just hidden on screen). A doctor's pay is split over every total they appear in by revenue, and
 *     revenue is on screen, so ANY two pay-inclusive totals that share doctors (two clinics, two departments, or the
 *     same total under two branch filters) form equations that give individual pay away. So without the permission the
 *     only pay-inclusive figure shown is the whole organisation's total, unfiltered (`wholeOrg`), and only when its pay
 *     comes from at least MIN_PAID_DOCTORS doctors; every department, clinic and filtered total is withheld.
 */

export { PROVISIONAL_LABEL };

/** A total that includes pay is withheld (without the compensation permission) when fewer doctors' pay is in it. */
export const MIN_PAID_DOCTORS = 2;

export type PayStatus = "linked" | "not_linked" | "not_loaded";
export const PAY_STATUS_LABEL: Record<PayStatus, string> = {
  linked: "Pay loaded",
  not_linked: "Pay not linked",
  not_loaded: "Pay not loaded",
};
export const UNMAPPED_BRANCH_LABEL = "Branch not mapped";

// ---------------------------------------------------------------------------------------------------------------------
// Inputs (the shape fin_contribution_inputs returns)
// ---------------------------------------------------------------------------------------------------------------------

const amount = z.coerce.number().finite();
const code = z.string().nullable();
export const contributionInputsSchema = z.object({
  month: z.string(),
  branch: z.string().nullable().optional(),
  coverage: z.array(z.object({ from: z.string(), to: z.string() })),
  period_approved: z.boolean(),
  rows: z.array(
    z.object({
      branch_code: code,
      department: code,
      doctor_key: z.string(),
      doctor_name: z.string(),
      dha_id: code,
      revenue: amount,
      visits: amount,
    }),
  ),
  doctor_weights: z.array(z.object({ dha_id: z.string(), revenue: amount, groups: amount })),
  comp: z.array(z.object({ dha_id: z.string(), amount })),
  charges: z.array(z.object({ dha_id: z.string(), amount })),
  branch_overheads: z.array(z.object({ branch_code: z.string(), amount })),
  shared_overheads: z.array(
    z.object({ pool: z.string(), amount, basis: z.enum(["revenue", "invoices", "equal"]) }),
  ),
  branch_weights: z.array(z.object({ branch_code: code, revenue: amount, visits: amount })),
});
export type ContributionInputs = z.infer<typeof contributionInputsSchema>;

export function parseContributionInputs(raw: unknown): ContributionInputs {
  const p = contributionInputsSchema.safeParse(raw);
  if (!p.success) throw new Error("The contribution figures could not be read.");
  return { ...p.data, month: p.data.month.slice(0, 10) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------------------------------

export type DoctorLine = {
  key: string;
  doctorKey: string;
  name: string;
  dhaId: string | null;
  status: PayStatus;
  revenue: number;
  visits: number;
  /** null when not loaded, or not visible to the viewer */
  pay: number | null;
  /** null when the doctor is not linked (charges are kept by DHA id) */
  charges: number | null;
  /** L3; null when pay is not loaded or not visible to the viewer */
  contribution: number | null;
};

export type Level = {
  revenue: number;
  /** revenue of the doctors whose pay is loaded: the part that is in the contribution */
  coveredRevenue: number;
  /** coveredRevenue ÷ revenue, 0..1; null without positive revenue */
  coverage: number | null;
  /** Σ pay of the covered doctors; null when the viewer may not see pay */
  pay: number | null;
  /** Σ charges of the covered doctors */
  charges: number;
  /** Σ L3 of the covered doctors; null with no covered doctor, or withheld */
  contribution: number | null;
  /** doctors (DHA ids) whose pay is in this total */
  paidDoctors: number;
  /** a total withheld so that no individual pay can be worked out (viewer without the compensation permission) */
  withheld: boolean;
};

export type DepartmentGroup = Level & { key: string; label: string; doctors: DoctorLine[] };

export type ClinicLevels = {
  branchOverhead: number;
  /** L5 = contribution − branch overhead */
  l5: number | null;
  /** the shared pools allocated to this clinic */
  allocated: number;
  /** L6 = L5 − allocated */
  l6: number | null;
};

export type ClinicGroup = Level &
  ClinicLevels & {
    key: string;
    branchCode: string | null;
    label: string;
    departments: DepartmentGroup[];
  };

export type ContributionReport = {
  month: string;
  branch: string | null;
  hasData: boolean;
  canSeePay: boolean;
  periodApproved: boolean;
  dates: Coverage;
  clinics: ClinicGroup[];
  total: Level & ClinicLevels;
  provisional: boolean;
  reasons: string[];
  /** report doctors in view with no DHA link, by revenue (for the mapping screen) */
  unlinked: { doctorKey: string; name: string; revenue: number }[];
  /** report doctors in view with a DHA link (for the mapping screen) */
  linked: { doctorKey: string; name: string; dhaId: string }[];
};

// ---------------------------------------------------------------------------------------------------------------------

const pct = (v: number) => `${Math.floor(v * 1000) / 10}%`;
const byRevenue = <T extends { revenue: number; label?: string; name?: string }>(a: T, b: T) =>
  b.revenue - a.revenue || (a.label ?? a.name ?? "").localeCompare(b.label ?? b.name ?? "");

function level(
  doctors: readonly DoctorLine[],
  canSeePay: boolean,
  payOf: Map<string, number>,
): Level {
  let revenue = 0;
  let covered = 0;
  let pay = 0;
  let charges = 0;
  let contribution = 0;
  let any = false;
  const paid = new Set<string>();
  for (const d of doctors) {
    revenue += d.revenue;
    if (d.status !== "linked") continue;
    any = true;
    covered += d.revenue;
    const p = payOf.get(d.key) ?? 0;
    pay += p;
    charges += d.charges ?? 0;
    contribution += d.revenue - p - (d.charges ?? 0);
    if (p > 0 && d.dhaId) paid.add(d.dhaId);
  }
  return {
    revenue: round3(revenue),
    coveredRevenue: round3(covered),
    coverage: revenue > 0 ? Math.min(1, Math.max(0, covered / revenue)) : null,
    pay: canSeePay ? round3(pay) : null,
    charges: round3(charges),
    contribution: any ? round3(contribution) : null,
    paidDoctors: paid.size,
    withheld: false,
  };
}

/** A total with pay from 1 to MIN_PAID_DOCTORS − 1 doctors would show an individual's pay. */
const revealsOne = (l: Level) => l.paidDoctors > 0 && l.paidDoctors < MIN_PAID_DOCTORS;

function withhold<T extends Level & Partial<ClinicLevels>>(l: T): T {
  return {
    ...l,
    withheld: true,
    contribution: null,
    ...(l.l5 !== undefined ? { l5: null, l6: null } : {}),
  };
}

export function buildContribution(
  inputs: ContributionInputs,
  opts: {
    canSeePay: boolean;
    /** The view is the whole organisation: no branch restriction and no branch filter. */
    wholeOrg?: boolean;
    branchNames?: Readonly<Record<string, string>>;
  },
): ContributionReport {
  const { canSeePay } = opts;
  const wholeOrg = opts.wholeOrg === true;
  const month = inputs.month;
  const comp = new Map(inputs.comp.map((c) => [c.dha_id, c.amount]));
  const charges = new Map(inputs.charges.map((c) => [c.dha_id, c.amount]));
  const weights = new Map(inputs.doctor_weights.map((w) => [w.dha_id, w]));

  // L3 per (branch, department, doctor). Exact pay is kept apart so that it never reaches the result without permission.
  const payOf = new Map<string, number>();
  const doctors: (DoctorLine & { branchCode: string | null; department: string | null })[] =
    inputs.rows.map((r) => {
      const key = `${r.branch_code ?? "-"}|${r.department ?? "-"}|${r.doctor_key}`;
      const base = {
        key,
        doctorKey: r.doctor_key,
        name: r.doctor_name,
        dhaId: r.dha_id,
        branchCode: r.branch_code,
        department: r.department,
        revenue: round3(r.revenue),
        visits: r.visits,
      };
      if (!r.dha_id)
        return { ...base, status: "not_linked", pay: null, charges: null, contribution: null };
      const w = weights.get(r.dha_id);
      const share =
        w && w.revenue > 0
          ? Math.max(r.revenue, 0) / w.revenue
          : w && w.groups > 0
            ? 1 / w.groups
            : 1;
      const ch = round3((charges.get(r.dha_id) ?? 0) * share);
      const c = comp.get(r.dha_id);
      if (c === undefined || !(c > 0))
        return { ...base, status: "not_loaded", pay: null, charges: ch, contribution: null };
      const pay = round3(c * share);
      payOf.set(key, pay);
      return {
        ...base,
        status: "linked",
        pay: canSeePay ? pay : null,
        charges: ch,
        contribution: canSeePay ? round3(r.revenue - pay - ch) : null,
      };
    });

  // shared pools by their basis over EVERY branch of the month (allocateOverheads, F8)
  const shared: OverheadRow[] = inputs.shared_overheads.map((o) => ({
    month,
    branch_code: null,
    pool: o.pool,
    amount: o.amount,
    basis: o.basis,
  }));
  const { byCell, unallocated } = allocateOverheads(
    inputs.branch_weights.map((w) => ({
      month,
      branch_code: w.branch_code,
      department: null,
      doctor_dha_id: null,
      revenue_net: w.revenue,
      direct_cost: 0,
      costed_net: 0,
      lines: w.visits,
      uncosted_lines: 0,
    })),
    shared,
  );
  const branchOverhead = new Map(inputs.branch_overheads.map((o) => [o.branch_code, o.amount]));

  const clinicMap = new Map<string, typeof doctors>();
  for (const d of doctors) {
    const k = d.branchCode ?? "";
    clinicMap.set(k, [...(clinicMap.get(k) ?? []), d]);
  }
  const strip = (d: (typeof doctors)[number]): DoctorLine => ({
    key: d.key,
    doctorKey: d.doctorKey,
    name: d.name,
    dhaId: d.dhaId,
    status: d.status,
    revenue: d.revenue,
    visits: d.visits,
    pay: d.pay,
    charges: d.charges,
    contribution: d.contribution,
  });

  let clinics: ClinicGroup[] = [...clinicMap.entries()].map(([k, list]) => {
    const deptMap = new Map<string, typeof doctors>();
    for (const d of list) {
      const dk = d.department ?? "";
      deptMap.set(dk, [...(deptMap.get(dk) ?? []), d]);
    }
    let departments: DepartmentGroup[] = [...deptMap.entries()]
      .map(([dk, ds]) => ({
        ...level(ds, canSeePay, payOf),
        key: `${k || "-"}|${dk || "-"}`,
        label: dk || UNASSIGNED_LABEL,
        doctors: ds.map(strip).sort(byRevenue),
      }))
      .sort(byRevenue);
    if (!canSeePay) departments = departments.map(withhold);
    const l = level(list, canSeePay, payOf);
    const overhead = round3(k ? (branchOverhead.get(k) ?? 0) : 0);
    const allocated = round3(byCell.get(`${month}|${k}`) ?? 0);
    const l5 = l.contribution === null ? null : round3(l.contribution - overhead);
    return {
      ...l,
      key: k || "-",
      branchCode: k || null,
      label: k ? (opts.branchNames?.[k] ?? k) : UNMAPPED_BRANCH_LABEL,
      branchOverhead: overhead,
      l5,
      allocated,
      l6: l5 === null ? null : round3(l5 - allocated),
      departments,
    };
  });
  if (!canSeePay) clinics = clinics.map(withhold);
  clinics.sort(byRevenue);

  const all = level(doctors, canSeePay, payOf);
  const overheadSum = round3(clinics.reduce((a, c) => a + c.branchOverhead, 0));
  const allocatedSum = round3(clinics.reduce((a, c) => a + c.allocated, 0));
  const totalL5 = all.contribution === null ? null : round3(all.contribution - overheadSum);
  let total: Level & ClinicLevels = {
    ...all,
    branchOverhead: overheadSum,
    l5: totalL5,
    allocated: allocatedSum,
    l6: totalL5 === null ? null : round3(totalL5 - allocatedSum),
  };
  if (!canSeePay && (!wholeOrg || revealsOne(total))) total = withhold(total);

  // why the figures are not final
  const hasData = doctors.length > 0;
  const dates = coverageOf(month, inputs.coverage as DateRange[]);
  const reasons: string[] = [];
  if (!hasData) reasons.push("There is no Unite report revenue for this month.");
  if (!inputs.period_approved) reasons.push("Finance has not approved this month's costs.");
  const missing = doctors.filter((d) => d.status !== "linked" && d.revenue !== 0);
  if (missing.length > 0) {
    const notLinked = new Set(
      missing.filter((d) => d.status === "not_linked").map((d) => d.doctorKey),
    ).size;
    const notLoaded = new Set(
      missing.filter((d) => d.status === "not_loaded").map((d) => d.doctorKey),
    ).size;
    reasons.push(
      `Only ${all.coverage === null ? "part" : pct(all.coverage)} of revenue has doctor pay loaded` +
        ` (${[
          notLinked
            ? `${notLinked} ${notLinked === 1 ? "doctor" : "doctors"} not linked to a DHA id`
            : "",
          notLoaded ? `${notLoaded} without pay for the month` : "",
        ]
          .filter(Boolean)
          .join(", ")}); the rest is left out of contribution, never counted as zero pay.`,
    );
  }
  if (hasData && !dates.full)
    reasons.push(`The Unite report covers only part of the month (${dates.label}).`);
  if (unallocated > 0)
    reasons.push(
      `${unallocated.toFixed(2)} of shared overhead could not be allocated (no revenue this month).`,
    );
  const idle = inputs.branch_overheads.filter((o) => !clinicMap.has(o.branch_code));
  if (idle.length > 0)
    reasons.push(
      `Overheads of ${idle.map((o) => o.branch_code).join(", ")} are not shown: no report revenue there this month.`,
    );

  const unlinked = new Map<string, { doctorKey: string; name: string; revenue: number }>();
  const linked = new Map<string, { doctorKey: string; name: string; dhaId: string }>();
  for (const d of doctors) {
    if (d.dhaId) linked.set(d.doctorKey, { doctorKey: d.doctorKey, name: d.name, dhaId: d.dhaId });
    else {
      const u = unlinked.get(d.doctorKey) ?? { doctorKey: d.doctorKey, name: d.name, revenue: 0 };
      u.revenue = round3(u.revenue + d.revenue);
      unlinked.set(d.doctorKey, u);
    }
  }

  return {
    month,
    branch: inputs.branch ?? null,
    hasData,
    canSeePay,
    periodApproved: inputs.period_approved,
    dates,
    clinics,
    total,
    provisional: reasons.length > 0,
    reasons,
    unlinked: [...unlinked.values()].sort(byRevenue),
    linked: [...linked.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
