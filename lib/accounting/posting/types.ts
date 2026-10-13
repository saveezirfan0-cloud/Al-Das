import type { JournalLineInput, VoucherType } from "@/lib/accounting/journal";
import type { TaxKind } from "@/lib/accounting/tax";

/**
 * The posting engine's shared shapes (Phase 22D, pure). Sources are the finance sub-ledgers the engine posts from; each
 * becomes one journal through acc_post_from_source (migration 20261109000100), or a preview before the ledger start.
 */

export const POSTING_SOURCES = [
  "unite_invoice",
  "unite_payment",
  "supplier_invoice",
  "voucher",
  "remittance",
  "denial",
  "revshare_run",
  "lab_charge",
  "cashup",
  "settlement",
] as const;
export type PostingSource = (typeof POSTING_SOURCES)[number];

export const POSTING_SOURCE_LABELS: Record<PostingSource, string> = {
  unite_invoice: "Unite invoice",
  unite_payment: "Unite payment or refund",
  supplier_invoice: "Supplier invoice",
  voucher: "Payment voucher",
  remittance: "Insurance remittance",
  denial: "Final insurance denial",
  revshare_run: "Doctor revenue share",
  lab_charge: "Lab and referral statement",
  cashup: "Cash-up",
  settlement: "Card and wallet settlement",
};

export function isPostingSource(v: string): v is PostingSource {
  return (POSTING_SOURCES as readonly string[]).includes(v);
}

export const RULE_KIND_LIST = [
  "revenue",
  "service_tax",
  "receivable",
  "patient_advance",
  "payment_mode",
  "discount",
  "write_off",
  "credit_note",
  "rounding",
  "vat_output",
  "vat_input",
  "expense",
  "payable",
  "bank",
  "revshare_expense",
  "revshare_payable",
  "provider_cost",
  "provider_cost_offset",
  "cashup_over_short",
  "bank_charges",
  "denial_writeoff",
  "denial_allowance",
] as const;
export type RuleKind = (typeof RULE_KIND_LIST)[number];

export type PayerKind = "insurance" | "self_pay" | "corporate";

export type RuleRow = {
  kind: RuleKind;
  key: string;
  qualifier: string;
  account: string | null; // account code
  tax_code: string | null;
};

export type TaxCodeRow = {
  code: string;
  kind: TaxKind;
  rate: number;
  active: boolean;
  output_account: string | null;
  input_account: string | null;
};

export type PostingSettings = {
  denialAllowanceEnabled: boolean;
  packageInvoices: "hold" | "post";
  roundingTolerance: number;
  vatTolerance: number;
  pausedSources: PostingSource[];
};

export const DEFAULT_SETTINGS: PostingSettings = {
  denialAllowanceEnabled: false,
  packageInvoices: "hold",
  roundingTolerance: 1,
  vatTolerance: 0.05,
  pausedSources: [],
};

export type PostingContext = {
  rules: readonly RuleRow[];
  taxCodes: ReadonlyMap<string, TaxCodeRow>;
  settings: PostingSettings;
  branches: ReadonlySet<string>;
  doctors: ReadonlySet<string>;
  payers: ReadonlySet<string>;
};

/** Why an item cannot post (a stable code, lib/accounting/errors.ts has the sentence) and what is missing. */
export const REASON_CODES = [
  "no_rule",
  "no_tax_code",
  "vat_mismatch",
  "unbalanced",
  "claims_exceed_invoice",
  "package_deferral",
  "no_date",
  "foreign_currency",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export type Reason = { code: ReasonCode; detail: string };

export type BuiltJournal = {
  date: string;
  voucherType: VoucherType;
  narration: string;
  lines: JournalLineInput[];
};

/**
 * post: the journal to post (or to preview before the ledger start); reasons: it waits, with every reason found;
 * nothing: there is no amount to post (a live journal is reversed); withdraw: the item no longer stands (deleted,
 * voided, reopened, not final), so a live journal is reversed.
 */
export type BuildResult =
  | { action: "post"; journal: BuiltJournal }
  | { action: "reasons"; reasons: Reason[]; date: string | null; amount: number | null }
  | { action: "nothing"; date: string | null }
  | { action: "withdraw" };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? fallback : n;
};

/** The jsonb from acc_posting_context() as a context. Unknown or broken entries are dropped. */
export function parseContext(json: unknown): PostingContext {
  const o = (json ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]) : ([] as unknown[]));
  const rules: RuleRow[] = [];
  for (const r of arr("rules") as Array<Record<string, unknown>>) {
    const kind = str(r?.kind);
    if (!kind || !(RULE_KIND_LIST as readonly string[]).includes(kind)) continue;
    rules.push({
      kind: kind as RuleKind,
      key: str(r.key) ?? "*",
      qualifier: str(r.qualifier) ?? "*",
      account: str(r.account),
      tax_code: str(r.tax_code),
    });
  }
  const taxCodes = new Map<string, TaxCodeRow>();
  for (const t of arr("tax_codes") as Array<Record<string, unknown>>) {
    const code = str(t?.code);
    if (!code) continue;
    taxCodes.set(code.toUpperCase(), {
      code: code.toUpperCase(),
      kind: (str(t.kind) ?? "out_of_scope") as TaxKind,
      rate: num(t.rate, 0),
      active: t.active !== false,
      output_account: str(t.output_account),
      input_account: str(t.input_account),
    });
  }
  const s = (o.settings ?? {}) as Record<string, unknown>;
  const paused = Array.isArray(s.paused_sources) ? (s.paused_sources as unknown[]) : [];
  const settings: PostingSettings = {
    denialAllowanceEnabled: s.denial_allowance_enabled === true,
    packageInvoices: s.package_invoices === "post" ? "post" : "hold",
    roundingTolerance: Math.max(0, num(s.rounding_tolerance, DEFAULT_SETTINGS.roundingTolerance)),
    vatTolerance: Math.max(0, num(s.vat_tolerance, DEFAULT_SETTINGS.vatTolerance)),
    pausedSources: paused.filter(
      (p): p is PostingSource => typeof p === "string" && isPostingSource(p),
    ),
  };
  const set = (k: string) =>
    new Set((arr(k).filter((x) => typeof x === "string") as string[]).map((x) => x.trim()));
  return {
    rules,
    taxCodes,
    settings,
    branches: set("branches"),
    doctors: set("doctors"),
    payers: set("payers"),
  };
}
