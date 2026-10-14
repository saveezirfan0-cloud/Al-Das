/**
 * UAE VAT tax code kinds (pure). Which service category gets which code is the tax adviser's decision (OQ-120); the code
 * is never guessed. "blocked" is input VAT that may not be recovered (entertainment, some vehicles): it is part of the
 * cost, so it has no VAT account. Reverse charge books both output and input VAT.
 */
export const TAX_KINDS = [
  "standard",
  "zero",
  "exempt",
  "out_of_scope",
  "reverse_charge",
  "blocked",
] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const TAX_KIND_LABELS: Record<TaxKind, string> = {
  standard: "Standard rate",
  zero: "Zero-rated",
  exempt: "Exempt",
  out_of_scope: "Out of scope",
  reverse_charge: "Reverse charge",
  blocked: "Blocked input VAT",
};

/** Kinds that carry a rate above zero (the database checks the same). */
export function kindHasRate(kind: TaxKind): boolean {
  return kind === "standard" || kind === "reverse_charge" || kind === "blocked";
}

/** VAT on a net amount, rounded to fils (half away from zero). */
export function vatOn(net: number, rate: number): number {
  const v = (net * rate) / 100;
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round(Number((Math.abs(v) * 100).toPrecision(15)))) / 100;
}
