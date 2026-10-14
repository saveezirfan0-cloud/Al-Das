/**
 * A naive, independent reference for fin_doctor_performance_inputs() (Phase 23B), written straight from the
 * definitions in docs/23_PHASE_23B_NOTES.md. Tests only: it checks the hand-written expected aggregates in the shared
 * fixture and the SQL function's branch scoping. Synthetic rows only.
 */

export type FixtureRow = {
  report_date: string;
  department: string | null;
  doctor_name: string;
  doctor_key: string;
  branch_code: string | null;
  patient_pin: string | null;
  patient_ref: string | null;
  visit_status: string | null;
  net: number;
  is_cancelled: boolean;
  is_current: boolean;
  upload: string;
};

type Agg = {
  revenue: number;
  visits: number;
  patients: number;
  unbilled_patients: number;
  new_visits: number;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

function aggregate(rows: FixtureRow[]): Agg {
  const perPatient = new Map<string, number>();
  for (const r of rows) {
    const pid = r.patient_ref ?? r.patient_pin ?? "row";
    perPatient.set(pid, (perPatient.get(pid) ?? 0) + Math.round(r.net * 100));
  }
  return {
    revenue: r2(rows.reduce((a, r) => a + Math.round(r.net * 100), 0) / 100),
    visits: rows.length,
    patients: perPatient.size,
    unbilled_patients: [...perPatient.values()].filter((v) => v <= 0).length,
    new_visits: rows.filter((r) => r.visit_status === "new").length,
  };
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

/** "C" collation order with nulls last, as the SQL sorts. */
const cmp = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

function names(rows: FixtureRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, list] of groupBy(rows, (r) => r.doctor_key)) {
    const counts = [...groupBy(list, (r) => r.doctor_name).entries()].map(([n, l]) => ({
      n,
      c: l.length,
    }));
    counts.sort((a, b) => b.c - a.c || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    out.set(key, counts[0].n);
  }
  return out;
}

function scope(rows: FixtureRow[], name: Map<string, string>) {
  const dk = (d: string | null) => JSON.stringify(d);
  const doctors = [...groupBy(rows, (r) => `${dk(r.department)}|${r.doctor_key}`).values()]
    .map((l) => ({
      department: l[0].department,
      doctor_key: l[0].doctor_key,
      doctor_name: name.get(l[0].doctor_key)!,
      ...aggregate(l),
    }))
    .sort((a, b) => cmp(a.department, b.department) || cmp(a.doctor_key, b.doctor_key));
  const departments = [...groupBy(rows, (r) => dk(r.department)).values()]
    .map((l) => ({
      department: l[0].department,
      doctors: new Set(l.map((r) => r.doctor_key)).size,
      ...aggregate(l),
    }))
    .sort((a, b) => cmp(a.department, b.department));
  return {
    doctors,
    departments,
    total: {
      doctors: new Set(rows.map((r) => r.doctor_key)).size,
      ...aggregate(rows),
      cancelled_visits: rows.filter((r) => r.is_cancelled).length,
    },
  };
}

const addMonths = (month: string, k: number) => {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 10);
};

/** The aggregate part of fin_doctor_performance_inputs (no coverage, no settings). */
export function referenceInputs(
  all: FixtureRow[],
  monthDate: string,
  opts: { branch?: string | null; branches?: string[] | null } = {},
) {
  const month = `${monthDate.slice(0, 7)}-01`;
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const rows = all.filter(
    (r) =>
      r.is_current &&
      r.report_date >= prev &&
      r.report_date < next &&
      (!opts.branches || r.branch_code === null || opts.branches.includes(r.branch_code)) &&
      (!opts.branch || r.branch_code === opts.branch),
  );
  const name = names(rows);
  return {
    month,
    previous_month: prev,
    current: scope(
      rows.filter((r) => r.report_date >= month),
      name,
    ),
    previous: scope(
      rows.filter((r) => r.report_date < month),
      name,
    ),
  };
}
