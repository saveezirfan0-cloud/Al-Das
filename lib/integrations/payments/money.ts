/**
 * Money in integer minor units (pure). Amounts are never floating point: a decimal string is parsed digit by digit, and anything
 * with more decimals than the currency has (other than trailing zeros) is rejected rather than rounded.
 */

const EXPONENT: Record<string, number> = {
  AED: 2,
  SAR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  QAR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

/** Hard ceiling for one payment link: 1,000,000 in major units. Larger amounts are a typo or fraud. */
export const MAX_MAJOR_UNITS = 1_000_000;

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXPONENT, code);
}

export function currencyExponent(code: string): number {
  const e = EXPONENT[code];
  if (e === undefined) throw new Error(`unsupported currency ${code}`);
  return e;
}

/** "123.45" (or the number 123.45) in `currency` -> 12345. Null for anything that is not a plain positive amount. */
export function majorToMinor(input: string | number, currency: string): number | null {
  if (!isSupportedCurrency(currency)) return null;
  const exp = currencyExponent(currency);
  const text =
    typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : input.trim();
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp))) return null;
  const minor = Number(m[1]) * 10 ** exp + Number(frac.slice(0, exp).padEnd(exp, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_MAJOR_UNITS * 10 ** exp)
    return null;
  return minor;
}

/** 12345 AED -> "123.45". */
export function minorToMajor(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  if (exp === 0) return `${sign}${abs}`;
  const whole = Math.floor(abs / 10 ** exp);
  const frac = String(abs % 10 ** exp).padStart(exp, "0");
  return `${sign}${whole}.${frac}`;
}

/** "AED 123.45" */
export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${minorToMajor(minor, currency)}`;
}
