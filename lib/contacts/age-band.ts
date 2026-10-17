/**
 * Age band of a contact (docs/45 P5). Pure; the SQL twin is app.contact_age_band (parity-tested).
 * `dob` and `today` are YYYY-MM-DD; a missing, invalid or future date of birth is "unknown".
 */
export const AGE_BANDS = [
  "0_11",
  "12_17",
  "18_34",
  "35_49",
  "50_64",
  "65_plus",
  "unknown",
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  "0_11": "Child (0 to 11)",
  "12_17": "Teen (12 to 17)",
  "18_34": "18 to 34",
  "35_49": "35 to 49",
  "50_64": "50 to 64",
  "65_plus": "65 and over",
  unknown: "Unknown",
};

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(v: string | null): [number, number, number] | null {
  const m = v ? YMD.exec(v) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d
    ? [y, mo, d]
    : null;
}

export function ageBand(dob: string | null, today: string | null): AgeBand {
  const b = parts(dob);
  const t = parts(today);
  if (!b || !t) return "unknown";
  if (dob! > today!) return "unknown";
  let age = t[0] - b[0];
  if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) age -= 1;
  if (age < 12) return "0_11";
  if (age < 18) return "12_17";
  if (age < 35) return "18_34";
  if (age < 50) return "35_49";
  if (age < 65) return "50_64";
  return "65_plus";
}
