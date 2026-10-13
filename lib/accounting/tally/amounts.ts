/**
 * Tally amounts (pure).
 *
 * =====================================================================================================================
 *  TALLY SIGN CONVENTION: A DEBIT IS NEGATIVE, A CREDIT IS POSITIVE.
 *
 *  - In a voucher, a debit entry is ISDEEMEDPOSITIVE = Yes with a NEGATIVE <AMOUNT>; a credit entry is
 *    ISDEEMEDPOSITIVE = No with a POSITIVE <AMOUNT>. The AMOUNTs of a voucher add up to zero.
 *  - A ledger's <OPENINGBALANCE> (and an opening bill's) follows the same rule: negative = Dr, positive = Cr.
 *  - Pulse's own exporter (lib/finance/tally-xml.ts) writes exactly this, and a unit test parses its output back.
 *  - Pulse stores balances the other way round (debit minus credit), so every conversion goes through
 *    `TALLY_DEBIT_SIGN` below and nowhere else.
 *
 *  The voucher rule is documented by several independent sources; the OPENINGBALANCE rule is not officially documented
 *  (research note 22I). Two checks stop a wrong guess from reaching the ledger: the importer refuses a voucher whose
 *  ISDEEMEDPOSITIVE flag disagrees with the sign, and refuses opening balances that do not net to zero. The
 *  reconciliation against Tally's own trial balance (Excel, explicit Dr and Cr columns) settles it per ledger.
 * =====================================================================================================================
 */
export const TALLY_DEBIT_SIGN = -1 as const;

/** True when a signed Tally amount (in fils / cents) is a debit. Zero is neither (callers skip it). */
export function tallyIsDebit(signedCents: number): boolean {
  return Math.sign(signedCents) === TALLY_DEBIT_SIGN;
}

/** A signed Tally amount as Pulse's balance (debit minus credit). */
export function tallyToDrMinusCr(signedCents: number): number {
  return signedCents === 0 ? 0 : signedCents * TALLY_DEBIT_SIGN;
}

export type TallyFx = { amountFx: number; currency: string | null; rate: number | null };
export type TallyAmount = { ok: true; cents: number; fx: TallyFx | null } | { ok: false };

const MAX_CENTS = 1e14;

/** "1,234.50" / "-367.25" / "(12.00)" -> signed cents; null when unreadable or more precise than 2 decimals. */
function readCents(raw: string): number | null {
  const neg = /-/.test(raw) || /\(.*\)/.test(raw);
  const digits = raw.replace(/[^\d.]/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const [whole, frac = ""] = digits.split(".");
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return null;
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents >= MAX_CENTS) return null;
  return neg && cents !== 0 ? -cents : cents;
}

/**
 * A Tally amount string in signed cents of the company's base currency. Accepts plain amounts ("-10500.00") and the
 * foreign-currency form "-100.00 USD @ AED 3.6725/USD = -367.25" (or with symbols: "-$100.00 @ AED 3.6725/$ =
 * -AED 367.25"): the base amount is the one after "="; the part before "@" and the rate are kept as information.
 * Blank is zero.
 */
export function parseTallyAmount(raw: string | null | undefined): TallyAmount {
  const s = (raw ?? "").trim();
  if (s === "") return { ok: true, cents: 0, fx: null };
  const eq = s.lastIndexOf("=");
  if (eq < 0) {
    if (/[@]/.test(s)) return { ok: false };
    const cents = readCents(s);
    return cents === null ? { ok: false } : { ok: true, cents, fx: null };
  }
  const cents = readCents(s.slice(eq + 1));
  if (cents === null) return { ok: false };
  const left = s.slice(0, eq);
  const at = left.indexOf("@");
  const fxPart = at < 0 ? left : left.slice(0, at);
  const ratePart = at < 0 ? "" : left.slice(at + 1);
  const fxCents = readCents(fxPart.replace(/[A-Za-z]{3}\b/g, ""));
  const iso = fxPart.match(/\b([A-Z]{3})\b/);
  const rateMatch = ratePart.match(/(\d+(?:\.\d+)?)/);
  const rate = rateMatch ? Number(rateMatch[1]) : null;
  return {
    ok: true,
    cents,
    fx:
      fxCents === null
        ? null
        : {
            amountFx: Math.abs(fxCents) / 100,
            currency: iso ? iso[1] : null,
            rate: rate && rate > 0 && Number.isFinite(rate) ? rate : null,
          },
  };
}

/** YYYYMMDD (Tally) -> YYYY-MM-DD, or null when it is not a real date. */
export function parseTallyDate(raw: string | null | undefined): string | null {
  const m = (raw ?? "").trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  if (y < 2000 || y > 2999) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Cents as a decimal number with two places (what acc_post_from_source takes). */
export const centsToAmount = (c: number) => Math.round(c) / 100;
