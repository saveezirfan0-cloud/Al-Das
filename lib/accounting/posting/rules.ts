import type {
  PayerKind,
  PostingContext,
  Reason,
  ReasonCode,
  RuleKind,
  RuleRow,
  TaxCodeRow,
} from "@/lib/accounting/posting/types";

/**
 * Posting rules (Phase 22D, pure): which account (and tax code) each kind of amount posts to. Rules are data
 * (acc_posting_rules); there is no formula language. A rule is (kind, key, qualifier); '*' means "any". The most specific
 * rule wins: (key, qualifier), then (key, *), then (*, qualifier), then (*, *). Keys match without regard to case or
 * repeated spaces.
 */

export type RuleKindInfo = {
  label: string;
  /** What the key is (null: the kind has one rule for everything, key '*'). */
  key: string | null;
  /** What the qualifier narrows by (null: no qualifier). */
  qualifier: string | null;
  /** account, tax code, or an account with an optional tax code */
  target: "account" | "tax" | "account_tax";
  help: string;
};

export const RULE_KINDS: Record<RuleKind, RuleKindInfo> = {
  revenue: {
    label: "Revenue",
    key: "Service category",
    qualifier: "Branch",
    target: "account",
    help: "Unite invoice lines, credited by service category (and branch when a branch has its own revenue account).",
  },
  service_tax: {
    label: "VAT per service category",
    key: "Service category",
    qualifier: "Who pays (insurance, self_pay, corporate)",
    target: "tax",
    help: "The VAT code of a service category, decided by the tax adviser (OQ-120). Without one the invoice waits; it is never guessed.",
  },
  receivable: {
    label: "Receivable",
    key: "Payer kind (insurance, self_pay, corporate)",
    qualifier: "Payer id",
    target: "account",
    help: "Insurer share per payer, the patient share and corporate invoices.",
  },
  patient_advance: {
    label: "Patient advances",
    key: null,
    qualifier: null,
    target: "account",
    help: "Money a patient leaves as an advance or deposit (a liability until used).",
  },
  payment_mode: {
    label: "Payment mode",
    key: "Unite payment mode",
    qualifier: "Branch",
    target: "account",
    help: "Where a Unite payment lands: cash per branch, card, Tabby and EPG clearing.",
  },
  discount: {
    label: "Discounts",
    key: null,
    qualifier: null,
    target: "account",
    help: "Line discounts on Unite invoices.",
  },
  write_off: {
    label: "Invoice write-offs",
    key: null,
    qualifier: null,
    target: "account",
    help: "Amounts Unite wrote off on an invoice.",
  },
  credit_note: {
    label: "Credit notes",
    key: null,
    qualifier: null,
    target: "account",
    help: "Credit notes on Unite invoices.",
  },
  rounding: {
    label: "Rounding",
    key: null,
    qualifier: null,
    target: "account",
    help: "A small difference between an invoice total and its lines (up to the tolerance).",
  },
  vat_output: {
    label: "VAT output",
    key: null,
    qualifier: null,
    target: "account",
    help: "Used when a tax code has no output VAT account of its own.",
  },
  vat_input: {
    label: "VAT input",
    key: null,
    qualifier: null,
    target: "account",
    help: "Used when a tax code has no input VAT account of its own, and for supplier VAT without a tax code.",
  },
  expense: {
    label: "Expense",
    key: "Supplier or voucher category",
    qualifier: "Branch",
    target: "account_tax",
    help: "Supplier bills and payments without a supplier. An optional tax code says how the bill's VAT is treated (blocked, reverse charge).",
  },
  payable: {
    label: "Supplier payable",
    key: "Supplier id",
    qualifier: null,
    target: "account",
    help: "The payable control account (one for all suppliers unless one has its own).",
  },
  bank: {
    label: "Bank or cash paid from / into",
    key: "Pay-from key, payment method or bank account id",
    qualifier: "Branch",
    target: "account",
    help: "Vouchers and payouts paid from, remittances and settlements paid into.",
  },
  revshare_expense: {
    label: "Doctor revenue share (expense)",
    key: "Doctor (DHA id)",
    qualifier: null,
    target: "account",
    help: "The month's revenue share, accrued when the run is approved.",
  },
  revshare_payable: {
    label: "Doctor revenue share (payable)",
    key: "Doctor (DHA id)",
    qualifier: null,
    target: "account",
    help: "What the clinic owes the doctor until the payout.",
  },
  provider_cost: {
    label: "Lab and referral cost",
    key: "Provider kind",
    qualifier: null,
    target: "account",
    help: "A posted lab or referral statement's cost, by doctor and branch.",
  },
  provider_cost_offset: {
    label: "Lab and referral cost (offset)",
    key: "Provider kind",
    qualifier: null,
    target: "account",
    help: "The other side of the statement. The default is the same cost account (the bill already booked the cost; the statement only spreads it by doctor and branch); an accrual account books it instead.",
  },
  cashup_over_short: {
    label: "Cash over and short",
    key: null,
    qualifier: "Branch",
    target: "account",
    help: "The difference a submitted cash-up found between what was counted and what Unite recorded.",
  },
  bank_charges: {
    label: "Bank and card charges",
    key: "Payment mode",
    qualifier: null,
    target: "account_tax",
    help: "The fee taken from a card, Tabby or EPG settlement. With a 5% tax code the fee is split into the charge and input VAT.",
  },
  denial_writeoff: {
    label: "Denials written off",
    key: "Payer id",
    qualifier: null,
    target: "account",
    help: "An insurance denial accepted as final.",
  },
  denial_allowance: {
    label: "Expected-rejection allowance",
    key: "Payer id",
    qualifier: null,
    target: "account",
    help: "Used instead of the write-off account only when the allowance setting is on (OQ-126).",
  },
};

/** Keys match trimmed, case-insensitive, with repeated spaces collapsed. */
export function normKey(v: string | null | undefined): string {
  const t = (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return t === "" ? "*" : t;
}

/** The most specific active rule for (kind, key, qualifier), or null. */
export function findRule(
  rules: readonly RuleRow[],
  kind: RuleKind,
  key: string | null = "*",
  qualifier: string | null = "*",
): RuleRow | null {
  const k = normKey(key);
  const q = normKey(qualifier);
  const order: Array<[string, string]> = [
    [k, q],
    [k, "*"],
    ["*", q],
    ["*", "*"],
  ];
  const ofKind = rules.filter((r) => r.kind === kind);
  for (const [kk, qq] of order) {
    const hit = ofKind.find((r) => normKey(r.key) === kk && normKey(r.qualifier) === qq);
    if (hit) return hit;
  }
  return null;
}

/** Unite's invoice type as a payer kind: anything with INSUR is insurance, CORP corporate, everything else self-pay. */
export function payerKindOf(invType: string | null | undefined): PayerKind {
  const t = (invType ?? "").toUpperCase();
  if (t.includes("INSUR")) return "insurance";
  if (t.includes("CORP")) return "corporate";
  return "self_pay";
}

/**
 * Resolves rules for one item and collects every reason it cannot post (each missing rule once). A builder asks for
 * everything it needs, then returns the reasons when there are any.
 */
export class Resolver {
  readonly reasons: Reason[] = [];
  private readonly seen = new Set<string>();

  constructor(readonly ctx: PostingContext) {}

  miss(code: ReasonCode, detail: string): void {
    const k = `${code}\u0000${detail}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.reasons.push({ code, detail });
  }

  /** The rule, or null with a no_rule reason ("Revenue: Dermatology (P)"). */
  rule(kind: RuleKind, key: string | null = "*", qualifier: string | null = "*"): RuleRow | null {
    const r = findRule(this.ctx.rules, kind, key, qualifier);
    if (!r || (RULE_KINDS[kind].target !== "tax" && !r.account)) {
      const k = normKey(key) === "*" ? "" : `: ${key}`;
      const q = normKey(qualifier) === "*" ? "" : ` (${qualifier})`;
      this.miss("no_rule", `${RULE_KINDS[kind].label}${k}${q}`);
      return null;
    }
    return r;
  }

  account(kind: RuleKind, key: string | null = "*", qualifier: string | null = "*"): string | null {
    return this.rule(kind, key, qualifier)?.account ?? null;
  }

  /** A tax code by its code, or null with a reason (unknown or inactive). */
  taxCode(code: string | null, about: string): TaxCodeRow | null {
    if (!code) return null;
    const t = this.ctx.taxCodes.get(code.toUpperCase());
    if (!t || !t.active) {
      this.miss("no_tax_code", `${about}: tax code ${code} is unknown or inactive`);
      return null;
    }
    return t;
  }

  /** The VAT code of a service category for this payer kind; never guessed (OQ-120). */
  serviceTax(category: string, payerKind: PayerKind): TaxCodeRow | null {
    const r = findRule(this.ctx.rules, "service_tax", category, payerKind);
    if (!r?.tax_code) {
      this.miss("no_tax_code", `VAT code for ${category}`);
      return null;
    }
    return this.taxCode(r.tax_code, category);
  }

  /** The dimension when it exists in reference data, otherwise left off the line. */
  branch(v: string | null | undefined): string | null {
    const t = (v ?? "").trim().toUpperCase();
    return t && this.ctx.branches.has(t) ? t : null;
  }
  doctor(v: string | null | undefined): string | null {
    const t = (v ?? "").trim();
    if (!t) return null;
    if (this.ctx.doctors.has(t)) return t;
    const u = t.toUpperCase();
    return this.ctx.doctors.has(u) ? u : null;
  }
  payer(v: string | null | undefined): string | null {
    const t = (v ?? "").trim();
    return t && this.ctx.payers.has(t) ? t : null;
  }
}

// ---- what is not mapped yet (the Posting rules page) ---------------------------------------------------------------

export type NeededKeys = {
  service_categories: string[];
  payment_modes: string[];
  expense_categories: string[];
  provider_kinds: string[];
  branches: string[];
};

export type MissingMapping = { kind: RuleKind; key: string; qualifier: string; why: string };

const SINGLE_KINDS: RuleKind[] = [
  "patient_advance",
  "discount",
  "write_off",
  "credit_note",
  "rounding",
  "vat_output",
  "vat_input",
  "payable",
  "bank",
  "revshare_expense",
  "revshare_payable",
  "cashup_over_short",
  "bank_charges",
  "denial_writeoff",
];

/**
 * Every rule the sub-ledgers in use today need and do not have: revenue and the VAT code per service category (per payer
 * kind), each payment mode at each branch, each expense category, each provider kind, the receivables and every
 * single-account kind. The list is what Finance works through before (and after) the ledger start.
 */
export function missingMappings(
  needed: NeededKeys,
  rules: readonly RuleRow[],
  opts: { denialAllowance?: boolean } = {},
): MissingMapping[] {
  const out: MissingMapping[] = [];
  const has = (kind: RuleKind, key = "*", qualifier = "*") => {
    const r = findRule(rules, kind, key, qualifier);
    return !!r && (RULE_KINDS[kind].target === "tax" ? !!r.tax_code : !!r.account);
  };
  const branches = needed.branches.length ? needed.branches : ["*"];
  for (const cat of needed.service_categories) {
    const without = branches.filter((b) => !has("revenue", cat, b));
    if (without.length)
      out.push({
        kind: "revenue",
        key: cat,
        qualifier: without.length === branches.length ? "*" : without.join(", "),
        why: "Invoice lines of this category cannot post",
      });
    const kinds = (["insurance", "self_pay", "corporate"] as const).filter(
      (k) => !has("service_tax", cat, k),
    );
    if (kinds.length)
      out.push({
        kind: "service_tax",
        key: cat,
        qualifier: kinds.length === 3 ? "*" : kinds.join(", "),
        why: "No VAT code: invoices with this category wait (OQ-120)",
      });
  }
  for (const k of ["insurance", "self_pay", "corporate"] as const)
    if (!has("receivable", k))
      out.push({ kind: "receivable", key: k, qualifier: "*", why: "Invoices cannot post" });
  for (const mode of needed.payment_modes) {
    const without = branches.filter((b) => !has("payment_mode", mode, b));
    if (without.length)
      out.push({
        kind: "payment_mode",
        key: mode,
        qualifier: without.length === branches.length ? "*" : without.join(", "),
        why: "Payments in this mode cannot post",
      });
  }
  for (const cat of needed.expense_categories)
    if (!has("expense", cat))
      out.push({
        kind: "expense",
        key: cat,
        qualifier: "*",
        why: "Bills and vouchers of this category cannot post",
      });
  for (const kind of needed.provider_kinds) {
    if (!has("provider_cost", kind))
      out.push({ kind: "provider_cost", key: kind, qualifier: "*", why: "Statements cannot post" });
    if (!has("provider_cost_offset", kind))
      out.push({
        kind: "provider_cost_offset",
        key: kind,
        qualifier: "*",
        why: "Statements cannot post",
      });
  }
  for (const kind of [
    ...SINGLE_KINDS,
    ...(opts.denialAllowance ? ["denial_allowance" as const] : []),
  ])
    if (!has(kind))
      out.push({ kind, key: "*", qualifier: "*", why: "No account for everything else" });
  return out;
}
