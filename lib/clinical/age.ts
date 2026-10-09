/**
 * R-06: full years between date of birth and the VISIT date (never today). Null when either date is
 * missing or unreadable, or the birth date is after the visit.
 */
function parts(d: string | null | undefined): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((d ?? "").trim());
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === day
    ? [y, mo, day]
    : null;
}

export function ageAtVisit(
  dob: string | null | undefined,
  visitDate: string | null | undefined,
): number | null {
  const b = parts(dob);
  const v = parts(visitDate);
  if (!b || !v) return null;
  let years = v[0] - b[0];
  if (v[1] < b[1] || (v[1] === b[1] && v[2] < b[2])) years--;
  return years < 0 ? null : years;
}
