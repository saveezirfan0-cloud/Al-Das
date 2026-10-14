import type { JournalLineInput, PartyKind } from "@/lib/accounting/journal";

/**
 * Builds journal lines from signed amounts in fils (debit > 0, credit < 0), so sums never drift (Phase 22D, pure).
 * Amounts on the same account with the same dimensions are netted into one line; zero lines disappear. A null account
 * (a rule that is missing) is skipped: the builder returns its reasons instead of these lines.
 */

export type LineDims = {
  description?: string | null;
  tax_code?: string | null;
  branch_code?: string | null;
  department?: string | null;
  doctor_id?: string | null;
  payer_id?: string | null;
  supplier_id?: string | null;
  party_kind?: PartyKind | null;
  party_id?: string | null;
};

/** Amount in fils, rounded half away from zero without floating drift; null, blank or not a number is 0. */
export function fils(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
}

export const fromFils = (c: number) => c / 100;

const DIM_KEYS = [
  "description",
  "tax_code",
  "branch_code",
  "department",
  "doctor_id",
  "payer_id",
  "supplier_id",
  "party_kind",
  "party_id",
] as const;

export class LineSet {
  private readonly entries = new Map<string, { account: string; dims: LineDims; fils: number }>();

  add(account: string | null, amountFils: number, dims: LineDims = {}): void {
    if (!account || !Number.isFinite(amountFils) || amountFils === 0) return;
    const clean: LineDims = {};
    for (const k of DIM_KEYS) {
      const v = dims[k];
      if (v !== null && v !== undefined && v !== "")
        (clean as Record<string, string>)[k] = String(v);
    }
    if (!clean.party_kind || !clean.party_id) {
      delete clean.party_kind;
      delete clean.party_id;
    }
    const key = JSON.stringify([account, DIM_KEYS.map((k) => clean[k] ?? null)]);
    const prev = this.entries.get(key);
    if (prev) prev.fils += amountFils;
    else this.entries.set(key, { account, dims: clean, fils: amountFils });
  }

  /** Debits minus credits, in fils (0 when balanced). */
  balance(): number {
    let t = 0;
    for (const e of this.entries.values()) t += e.fils;
    return t;
  }

  /** The lines in the order they were first added, netted, without zero lines. */
  lines(): JournalLineInput[] {
    const out: JournalLineInput[] = [];
    for (const e of this.entries.values()) {
      if (e.fils === 0) continue;
      out.push({
        account_code: e.account,
        debit: e.fils > 0 ? e.fils / 100 : 0,
        credit: e.fils < 0 ? -e.fils / 100 : 0,
        ...e.dims,
      } as JournalLineInput);
    }
    return out;
  }
}
