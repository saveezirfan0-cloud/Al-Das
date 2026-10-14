import { z } from "zod";

/**
 * Doctor performance and month comparison (Phase 23B, docs/23_PHASE_23B_NOTES.md): the clinic's "Revenue comparison"
 * workbook, corrected. Pure: the sums and distinct-patient counts come from public.fin_doctor_performance_inputs()
 * (SQL); everything derived from them (revenue per patient, band, expected revenue, gap, achievement, change against
 * the previous month, follow-ups) is worked out here, so the page, the Excel download and the dashboard tiles agree.
 *
 * Department and total patients are DISTINCT patients at that level, as SQL counted them: never a sum of doctors
 * (a patient seen by two doctors is one patient of the clinic). Change % is always over the PREVIOUS month (the
 * workbook divided by the current month).
 */

export type PerfSettings = { target: number; near: number; moderate: number };
export const DEFAULT_PERF_SETTINGS: PerfSettings = { target: 750, near: 700, moderate: 650 };

export type Band = "achieved" | "near" | "moderate" | "below";
export const BAND_LABEL: Record<Band, string> = {
  achieved: "Achieved",
  near: "Near Target",
  moderate: "Moderate",
  below: "Below Target",
};

/** Half-open bands with no gaps: >= target Achieved, >= near Near Target, >= moderate Moderate, else Below Target. */
export function bandOf(value: number | null, s: PerfSettings): Band | null {
  if (value === null || !Number.isFinite(value)) return null;
  // judged on the figure people see (to the fils, half up), so the badge always agrees with the number shown;
  // rounded via millionths first so binary float noise (2100.3 / 3 = 700.0999…) cannot move a band edge
  const fils = (x: number) => Math.round(Math.round(x * 1e6) / 1e4);
  const v = fils(value);
  const at = (edge: number) => v >= fils(edge);
  if (at(s.target)) return "achieved";
  if (at(s.near)) return "near";
  if (at(s.moderate)) return "moderate";
  return "below";
}

// ---------------------------------------------------------------------------
// Inputs (the SQL function's jsonb, parsed)
// ---------------------------------------------------------------------------

export type Counts = {
  revenue: number;
  visits: number;
  patients: number;
  unbilledPatients: number;
  newVisits: number;
};
export type DoctorInput = Counts & {
  department: string | null;
  doctorKey: string;
  doctorName: string;
};
export type DepartmentInput = Counts & { department: string | null; doctors: number };
export type TotalInput = Counts & { doctors: number; cancelledVisits: number };
export type ScopeInput = {
  doctors: DoctorInput[];
  departments: DepartmentInput[];
  total: TotalInput;
};
export type DateRange = { from: string; to: string };

export type DoctorPerformanceInputs = {
  month: string;
  previousMonth: string;
  branch: string | null;
  coverage: DateRange[];
  previousCoverage: DateRange[];
  settings: PerfSettings;
  current: ScopeInput;
  previous: ScopeInput;
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function counts(r: Raw): Counts {
  return {
    revenue: n(r.revenue),
    visits: n(r.visits),
    patients: n(r.patients),
    unbilledPatients: n(r.unbilled_patients),
    newVisits: n(r.new_visits),
  };
}

function scope(v: unknown): ScopeInput {
  const s = obj(v);
  const t = obj(s.total);
  return {
    doctors: arr(s.doctors).map((r) => ({
      ...counts(r),
      department: text(r.department),
      doctorKey: String(r.doctor_key ?? ""),
      doctorName: text(r.doctor_name) ?? String(r.doctor_key ?? ""),
    })),
    departments: arr(s.departments).map((r) => ({
      ...counts(r),
      department: text(r.department),
      doctors: n(r.doctors),
    })),
    total: { ...counts(t), doctors: n(t.doctors), cancelledVisits: n(t.cancelled_visits) },
  };
}

const ranges = (v: unknown): DateRange[] =>
  arr(v)
    .map((r) => ({ from: String(r.from ?? ""), to: String(r.to ?? "") }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to));

export function parseDoctorPerformanceInputs(raw: unknown): DoctorPerformanceInputs {
  const r = obj(raw);
  const s = obj(r.settings);
  return {
    month: String(r.month ?? ""),
    previousMonth: String(r.previous_month ?? ""),
    branch: text(r.branch),
    coverage: ranges(r.coverage),
    previousCoverage: ranges(r.previous_coverage),
    settings: {
      target: n(s.target) || DEFAULT_PERF_SETTINGS.target,
      near: n(s.near) || DEFAULT_PERF_SETTINGS.near,
      moderate: n(s.moderate) || DEFAULT_PERF_SETTINGS.moderate,
    },
    current: scope(r.current),
    previous: scope(r.previous),
  };
}

// ---------------------------------------------------------------------------
// Derived measures
// ---------------------------------------------------------------------------

export type Measures = Counts & {
  /** Revenue / patients, unrounded (the band is judged on it; screens round to 2 dp); null with no patients. */
  revenuePerPatient: number | null;
  band: Band | null;
  expectedRevenue: number;
  gap: number;
  /** Revenue / expected; null when expected is 0. */
  achievement: number | null;
  /** Visits − patients (repeat visits within the month), never negative. */
  followUps: number;
  followUpsPerPatient: number | null;
  unbilledShare: number | null;
  previous: Counts;
  change: number;
  /** Over the PREVIOUS month; null when it had no revenue. */
  changePct: number | null;
  patientsChangePct: number | null;
};

export type DoctorRow = Measures & { key: string; doctorKey: string; name: string };
export type DepartmentGroup = Measures & {
  key: string;
  department: string | null;
  label: string;
  doctors: number;
  previousDoctors: number;
  /** Department revenue / total revenue (this month); null when the total is 0. */
  share: number | null;
  doctorRows: DoctorRow[];
};
export type Coverage = { ranges: DateRange[]; full: boolean; label: string };

export type DoctorPerformance = {
  month: string;
  previousMonth: string;
  branch: string | null;
  settings: PerfSettings;
  departments: DepartmentGroup[];
  total: Measures & { doctors: number; cancelledVisits: number };
  coverage: Coverage;
  previousCoverage: Coverage;
  /** Sum of department revenue against the total over every current row; must match exactly (to Unite's 3 dp). */
  reconciliation: { departmentsSum: number; total: number; matches: boolean };
  hasData: boolean;
};

export const UNASSIGNED_LABEL = "Unassigned";
const ZERO: Counts = { revenue: 0, visits: 0, patients: 0, unbilledPatients: 0, newVisits: 0 };
/**
 * Unite keeps some amounts to three decimals, so sums are exact to 0.001 in SQL. Here amounts are only cleaned of
 * binary float noise at that precision (never rounded to the fil); screens and the workbook round for display.
 */
const mils = (v: number) => Math.round(v * 1000);
export const round3 = (v: number) => mils(v) / 1000;
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function measures(cur: Counts, prev: Counts, s: PerfSettings): Measures {
  const revenuePerPatient = cur.patients > 0 ? cur.revenue / cur.patients : null;
  const expectedRevenue = round3(cur.patients * s.target);
  const followUps = Math.max(0, cur.visits - cur.patients);
  return {
    ...cur,
    revenuePerPatient,
    band: bandOf(revenuePerPatient, s),
    expectedRevenue,
    gap: round3(cur.revenue - expectedRevenue),
    achievement: ratio(cur.revenue, expectedRevenue),
    followUps,
    followUpsPerPatient: ratio(followUps, cur.patients),
    unbilledShare: ratio(cur.unbilledPatients, cur.patients),
    previous: prev,
    change: round3(cur.revenue - prev.revenue),
    changePct: prev.revenue === 0 ? null : (cur.revenue - prev.revenue) / Math.abs(prev.revenue),
    patientsChangePct: prev.patients === 0 ? null : (cur.patients - prev.patients) / prev.patients,
  };
}

const only = (c: Counts): Counts => ({
  revenue: c.revenue,
  visits: c.visits,
  patients: c.patients,
  unbilledPatients: c.unbilledPatients,
  newVisits: c.newVisits,
});
const deptKey = (d: string | null) => (d === null ? "-" : `d:${d}`);

/** Revenue this month, then last month, then the label: the order of every list on the page. */
function byRevenue<T extends { revenue: number; previous: Counts; label?: string; name?: string }>(
  a: T,
  b: T,
) {
  return (
    b.revenue - a.revenue ||
    b.previous.revenue - a.previous.revenue ||
    (a.label ?? a.name ?? "").localeCompare(b.label ?? b.name ?? "")
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The last day of the month that starts on `month` (yyyy-mm-01). */
export function monthEnd(month: string): string {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** "1–30 Sep 2026"; "28 Aug – 3 Sep 2026" across months. */
export function rangeLabel(r: DateRange): string {
  const day = (iso: string) => String(Number(iso.slice(8, 10)));
  const mon = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";
  if (r.from === r.to) return `${day(r.from)} ${mon(r.from)} ${r.from.slice(0, 4)}`;
  if (r.from.slice(0, 7) === r.to.slice(0, 7))
    return `${day(r.from)}–${day(r.to)} ${mon(r.to)} ${r.to.slice(0, 4)}`;
  return `${day(r.from)} ${mon(r.from)} – ${day(r.to)} ${mon(r.to)} ${r.to.slice(0, 4)}`;
}

export function coverageOf(month: string, list: DateRange[]): Coverage {
  const full = list.length === 1 && list[0].from === month && list[0].to === monthEnd(month);
  return {
    ranges: list,
    full,
    label:
      list.length === 0 ? "No committed upload covers this month" : list.map(rangeLabel).join(", "),
  };
}

export function buildDoctorPerformance(inputs: DoctorPerformanceInputs): DoctorPerformance {
  const s = inputs.settings;

  // Doctors: merge this month and last month by (department, doctor key).
  const docs = new Map<
    string,
    { dept: string | null; doctorKey: string; name: string; cur: Counts; prev: Counts }
  >();
  const addDoc = (d: DoctorInput, which: "cur" | "prev") => {
    const key = `${deptKey(d.department)}|${d.doctorKey}`;
    const e = docs.get(key) ?? {
      dept: d.department,
      doctorKey: d.doctorKey,
      name: d.doctorName,
      cur: ZERO,
      prev: ZERO,
    };
    e[which] = only(d);
    if (which === "cur") e.name = d.doctorName;
    docs.set(key, e);
  };
  for (const d of inputs.current.doctors) addDoc(d, "cur");
  for (const d of inputs.previous.doctors) addDoc(d, "prev");

  // Departments: the same, with the department's own distinct patients from SQL.
  const depts = new Map<
    string,
    { dept: string | null; cur: DepartmentInput | null; prev: DepartmentInput | null }
  >();
  const addDept = (d: DepartmentInput, which: "cur" | "prev") => {
    const key = deptKey(d.department);
    const e = depts.get(key) ?? { dept: d.department, cur: null, prev: null };
    e[which] = d;
    depts.set(key, e);
  };
  for (const d of inputs.current.departments) addDept(d, "cur");
  for (const d of inputs.previous.departments) addDept(d, "prev");
  for (const d of docs.values()) {
    const key = deptKey(d.dept);
    if (!depts.has(key)) depts.set(key, { dept: d.dept, cur: null, prev: null });
  }

  const total = inputs.current.total;
  const departments: DepartmentGroup[] = [...depts.entries()]
    .map(([key, d]) => {
      const doctorRows: DoctorRow[] = [...docs.entries()]
        .filter(([, x]) => deptKey(x.dept) === key)
        .map(([k, x]) => ({
          ...measures(x.cur, x.prev, s),
          key: k,
          doctorKey: x.doctorKey,
          name: x.name,
        }))
        .sort(byRevenue);
      const cur = d.cur ? only(d.cur) : ZERO;
      return {
        ...measures(cur, d.prev ? only(d.prev) : ZERO, s),
        key,
        department: d.dept,
        label: d.dept ?? UNASSIGNED_LABEL,
        doctors: d.cur?.doctors ?? 0,
        previousDoctors: d.prev?.doctors ?? 0,
        share: ratio(cur.revenue, total.revenue),
        doctorRows,
      };
    })
    .sort(byRevenue);

  const departmentsSum = departments.reduce((acc, d) => acc + mils(d.revenue), 0) / 1000;
  return {
    month: inputs.month,
    previousMonth: inputs.previousMonth,
    branch: inputs.branch,
    settings: s,
    departments,
    total: {
      ...measures(only(total), only(inputs.previous.total), s),
      doctors: total.doctors,
      cancelledVisits: total.cancelledVisits,
    },
    coverage: coverageOf(inputs.month, inputs.coverage),
    previousCoverage: coverageOf(inputs.previousMonth, inputs.previousCoverage),
    reconciliation: {
      departmentsSum,
      total: round3(total.revenue),
      matches: mils(departmentsSum) === mils(total.revenue),
    },
    hasData: total.visits > 0 || inputs.previous.total.visits > 0,
  };
}

// ---------------------------------------------------------------------------
// Branch scope and settings
// ---------------------------------------------------------------------------

/**
 * The finance branch codes a member may see, from their branch filter (lib/branches branchView().filterIds) and the
 * org's locations (locations.branch_code). `null` = no restriction. A location without a finance code adds nothing, so
 * a member limited to such branches sees nothing; a row whose branch is unknown is shown only when there is no
 * restriction (it fails closed, unlike app.location_visible_to(): here no branch means "not yet mapped").
 */
export function allowedBranchCodes(
  filterIds: readonly string[] | null,
  locations: readonly { id: string; branch_code: string | null }[],
): string[] | null {
  if (filterIds === null) return null;
  const codes = locations
    .filter((l) => filterIds.includes(l.id) && l.branch_code)
    .map((l) => l.branch_code as string);
  return [...new Set(codes)].sort();
}

/** The page's own branch choice, kept only when the member may see it. */
export function chosenBranch(
  raw: string | null | undefined,
  allowed: readonly string[] | null,
): string | null {
  const v = (raw ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();
  if (!v) return null;
  return allowed === null || allowed.includes(v) ? v : null;
}

/** "2026-09" or "2026-09-14" -> "2026-09-01"; anything else null. */
export function monthParam(raw: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw ?? "");
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 2000) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** The page's ?doctor= (a report doctor key, from the Doctors drawer): trimmed, at most 200 characters; else null. */
export function doctorParam(raw: string | string[] | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v && v.length <= 200 ? v : null;
}

const amount = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number.` })
    .positive(`${label} must be more than 0.`)
    .max(1_000_000, `${label} must be at most 1,000,000.`)
    .refine(
      (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
      `${label}: at most two decimals.`,
    );

/** Same ordering rule as the database check: 0 < moderate < near < target. */
export const perfSettingsSchema = z
  .object({
    perf_arpp_target: amount("Target"),
    perf_band_near: amount("Near Target"),
    perf_band_moderate: amount("Moderate"),
  })
  .refine((v) => v.perf_band_moderate < v.perf_band_near && v.perf_band_near < v.perf_arpp_target, {
    message: "The bands must go up: Moderate below Near Target, Near Target below the target.",
  });
