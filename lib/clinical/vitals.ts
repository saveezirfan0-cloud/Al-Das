/**
 * R-01 / R-02 / R-08: vitals parsing. NULL means "not recorded" and never compares true; a blank
 * numeric must never be read as zero.
 *
 * The plausibility windows are data-quality limits that mirror the CHECK constraints on `visits`
 * (a value outside them is a typo, not a clinical finding); they are not clinical thresholds.
 */
export const PLAUSIBLE = {
  bpSystolic: [30, 300],
  bpDiastolic: [10, 200],
  temp: [30, 45],
  pulse: [20, 250],
  spo2: [50, 100],
} as const;

type Range = readonly [number, number];

function within(n: number, [lo, hi]: Range): boolean {
  return n >= lo && n <= hi;
}

/** Strip everything but digits and dots, parse as a decimal; null when blank, unparseable or implausible. */
export function parseVital(raw: string | number | null | undefined, range: Range): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && within(n, range) ? n : null;
}

const num = (s: string): number | null => {
  const c = s.replace(/[^0-9.]/g, "");
  return /^\d+(\.\d+)?$/.test(c) ? Number(c) : null;
};

/**
 * Unite delivers blood pressure as one string such as "92/61", usually in the systolic field and
 * sometimes mirrored in the diastolic one. Take the first non-blank field, split on "/", systolic =
 * first part, diastolic = last. Both are rejected (null) if either part is empty, non-numeric or
 * implausible. Two separate plain numbers are accepted as systolic then diastolic. A lone number
 * ("120") is ambiguous and rejected.
 */
export function parseBp(
  systolicField: string | null | undefined,
  diastolicField: string | null | undefined,
): { systolic: number | null; diastolic: number | null } {
  const none = { systolic: null, diastolic: null };
  const a = (systolicField ?? "").trim();
  const b = (diastolicField ?? "").trim();
  const first = a || b;
  if (!first) return none;

  let sys: number | null;
  let dia: number | null;
  if (first.includes("/")) {
    const parts = first.split("/");
    sys = num(parts[0]);
    dia = num(parts[parts.length - 1]);
  } else if (a && b && !b.includes("/")) {
    sys = num(a);
    dia = num(b);
  } else return none;

  if (sys === null || dia === null) return none;
  if (!within(sys, PLAUSIBLE.bpSystolic) || !within(dia, PLAUSIBLE.bpDiastolic)) return none;
  return { systolic: sys, diastolic: dia };
}

export type Vitals = {
  tempC: number | null;
  pulse: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  spo2: number | null;
};

/** R-08: all of temperature, BP (both), SpO2 and pulse were recorded. */
export function vitalsComplete(v: Vitals): boolean {
  return (
    v.tempC !== null &&
    v.bpSystolic !== null &&
    v.bpDiastolic !== null &&
    v.spo2 !== null &&
    v.pulse !== null
  );
}
