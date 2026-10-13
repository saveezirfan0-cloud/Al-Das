import { cleanNarration, type VoucherType } from "@/lib/accounting/journal";
import { fils, fromFils, LineSet, type LineDims } from "@/lib/accounting/posting/lines";
import { payerKindOf, Resolver } from "@/lib/accounting/posting/rules";
import type {
  BuildResult,
  PostingContext,
  PostingSource,
  TaxCodeRow,
} from "@/lib/accounting/posting/types";
import { vatOn } from "@/lib/accounting/tax";

/**
 * The posting builders (Phase 22D, pure, unit-tested with synthetic fixtures): one per sub-ledger, each turning one
 * sanitised source record (acc_posting_load, migration 20261109000100) and the rules into balanced journal lines, or the
 * list of reasons it cannot. They never see a patient's PIN or name; an invoice number is an id. Dimensions that are not
 * in the reference data (an unknown doctor, branch or payer) are left off a line rather than refusing the posting.
 */

// ---- records (the shapes acc_posting_load returns) ---------------------------------------------------------------

type Num = number | string | null;

export type UniteInvoiceRecord = {
  id: string;
  date: string | null;
  branch: string | null;
  department: string | null;
  doctor: string | null;
  inv_type: string | null;
  is_package: boolean;
  is_deleted: boolean;
  total: Num;
  write_off: Num;
  credit_note: Num;
  lines: Array<{ category: string | null; discount: Num; net: Num; vat: Num }>;
  claims: Array<{ payer_id: string | null; amount: Num }>;
};

export type UnitePaymentRecord = {
  id: string;
  part: "payment" | "refund";
  invoice: string;
  inv_type: string | null;
  branch: string | null;
  is_current: boolean;
  invoice_deleted: boolean;
  mode: string;
  paid: Num;
  advance: Num;
  refund: Num;
  date: string | null;
};

export type RemittanceRecord = {
  id: string;
  payer_id: string | null;
  date: string | null;
  bank_account_id: string | null;
  lines: Array<{ payer_id: string | null; paid: Num }>;
};

export type DenialRecord = {
  id: string;
  status: string;
  payer_id: string | null;
  amount: Num;
  date: string | null;
};

export type SupplierInvoiceRecord = {
  id: string;
  number: string;
  supplier_id: string;
  date: string | null;
  category: string;
  net: Num;
  vat: Num;
  currency: string;
  branch: string | null;
  doctor: string | null;
  status: string;
};

export type VoucherRecord = {
  id: string;
  voucher_no: string;
  status: string;
  date: string | null;
  amount: Num;
  currency: string;
  supplier_id: string | null;
  category: string;
  branch: string | null;
  pay_from: string | null;
  method: string;
};

export type RevshareRecord =
  | {
      id: string;
      part: "run";
      month: string;
      status: string;
      lines: Array<{ doctor: string; payout: Num }>;
    }
  | {
      id: string;
      part: "payout";
      month: string;
      status: string;
      doctor: string;
      payout: Num;
      paid_on: string | null;
    };

export type LabStatementRecord = {
  id: string;
  month: string;
  status: string;
  provider_kind: string;
  allocation: Array<{ doctor: string | null; branch: string | null; cost: Num }>;
};

export type CashupRecord = {
  id: string;
  branch: string;
  date: string;
  status: string;
  lines: Array<{ mode: string; variance: Num }>;
};

export type SettlementRecord = {
  id: string;
  matched: boolean;
  kind: "collection" | "payout";
  mode: string;
  date: string | null;
  bank_account_id: string | null;
  bank_amount: Num;
  gross: Num;
};

// ---- helpers ------------------------------------------------------------------------------------------------------

const money = (f: number) => fromFils(f).toFixed(2);

/** The last day of the month a YYYY-MM-DD date is in. */
export function monthEnd(date: string): string {
  const [y, m] = date.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

function finish(
  r: Resolver,
  set: LineSet,
  date: string,
  voucherType: VoucherType,
  narration: string,
  amountFils: number | null,
): BuildResult {
  if (r.reasons.length)
    return {
      action: "reasons",
      reasons: r.reasons,
      date,
      amount: amountFils === null ? null : fromFils(amountFils),
    };
  const lines = set.lines();
  if (lines.length === 0) return { action: "nothing", date };
  if (set.balance() !== 0)
    return {
      action: "reasons",
      reasons: [
        { code: "unbalanced", detail: `Debits and credits differ by ${money(set.balance())}` },
      ],
      date,
      amount: amountFils === null ? null : fromFils(amountFils),
    };
  return {
    action: "post",
    journal: { date, voucherType, narration: cleanNarration(narration) ?? "Posting", lines },
  };
}

const noDate = (amount: number | null = null): BuildResult => ({
  action: "reasons",
  reasons: [{ code: "no_date", detail: "The item has no date" }],
  date: null,
  amount,
});

/** Is Unite's VAT on a line consistent with the line's tax code? */
function vatConsistent(
  tax: TaxCodeRow,
  netFils: number,
  vatFils: number,
  toleranceFils: number,
): boolean {
  if (tax.kind === "standard")
    return Math.abs(vatFils - fils(vatOn(fromFils(netFils), tax.rate))) <= toleranceFils;
  if (tax.kind === "zero" || tax.kind === "exempt" || tax.kind === "out_of_scope")
    return vatFils === 0;
  return false; // reverse charge and blocked VAT are purchase codes, never on a sale
}

// ---- Unite invoice ------------------------------------------------------------------------------------------------

/**
 * Sales journal for a Unite invoice:
 *   Cr revenue per line (service category, branch; gross = net + discount) with the category's VAT code
 *   Dr discounts (line discount)       Cr VAT output (Unite's VAT, checked against the code's rate)
 *   Dr receivables: on an insurance invoice the claims matched to it (Diligence, per payer) are the insurer share and the
 *      rest is the patient's; before any claim is matched the whole total is the insurer's (payer not yet known)
 *   Dr / Cr rounding for a difference between the invoice total and its lines up to the tolerance (beyond it: waits)
 *   Dr write-off and Dr credit notes against the main receivable.
 * A service category without a VAT code stops the posting (no_tax_code, OQ-120). A package invoice waits while packages
 * are held (OQ-127). A deleted invoice is withdrawn.
 */
export function buildUniteInvoice(rec: UniteInvoiceRecord, ctx: PostingContext): BuildResult {
  if (rec.is_deleted) return { action: "withdraw" };
  if (!rec.date) return noDate();
  const total0 = rec.total === null ? null : fils(rec.total);
  if (rec.is_package && ctx.settings.packageInvoices === "hold")
    return {
      action: "reasons",
      reasons: [
        {
          code: "package_deferral",
          detail: "Package invoices are held until packages are set up (OQ-127)",
        },
      ],
      date: rec.date,
      amount: total0 === null ? null : fromFils(total0),
    };
  const r = new Resolver(ctx);
  const set = new LineSet();
  const payerKind = payerKindOf(rec.inv_type);
  const branch = r.branch(rec.branch);
  const dims: LineDims = {
    branch_code: branch,
    department: rec.department?.trim().slice(0, 60) || null,
    doctor_id: r.doctor(rec.doctor),
  };
  const vatTol = fils(ctx.settings.vatTolerance);
  let linesTotal = 0;
  for (const line of rec.lines) {
    const category = line.category?.trim() || "Unmapped";
    const net = fils(line.net);
    const discount = fils(line.discount);
    const vat = fils(line.vat);
    const tax = r.serviceTax(category, payerKind);
    if (tax && !vatConsistent(tax, net, vat, vatTol))
      r.miss("vat_mismatch", `${category}: Unite VAT ${money(vat)} does not fit ${tax.code}`);
    set.add(r.account("revenue", category, branch ?? "*"), -(net + discount), {
      ...dims,
      tax_code: tax?.code,
    });
    if (discount !== 0) set.add(r.account("discount"), discount, dims);
    if (vat !== 0)
      set.add(tax?.output_account ?? r.account("vat_output"), -vat, {
        branch_code: branch,
        tax_code: tax?.code,
      });
    linesTotal += net + vat;
  }
  const total = total0 ?? linesTotal;
  const diff = total - linesTotal;
  if (Math.abs(diff) > fils(ctx.settings.roundingTolerance))
    r.miss("unbalanced", `The invoice total differs from its lines by ${money(diff)}`);
  else if (diff !== 0) set.add(r.account("rounding"), -diff, { branch_code: branch });

  // receivables
  const recvDims: LineDims = { branch_code: branch };
  let adjust: { account: string | null; dims: LineDims };
  if (payerKind === "insurance") {
    const claims = rec.claims.filter((c) => fils(c.amount) !== 0);
    if (claims.length === 0) {
      adjust = { account: r.account("receivable", "insurance"), dims: recvDims };
      set.add(adjust.account, total, recvDims);
    } else {
      const insurer = claims.reduce((a, c) => a + fils(c.amount), 0);
      if (insurer > total)
        r.miss(
          "claims_exceed_invoice",
          `Claims matched to it (${money(insurer)}) exceed the invoice (${money(total)})`,
        );
      let largest = { fils: -Infinity, account: null as string | null, dims: recvDims };
      for (const c of [...claims].sort((a, b) =>
        (a.payer_id ?? "").localeCompare(b.payer_id ?? ""),
      )) {
        const payer = r.payer(c.payer_id);
        const d = { ...recvDims, payer_id: payer };
        const account = r.account("receivable", "insurance", c.payer_id ?? "*");
        set.add(account, fils(c.amount), d);
        if (fils(c.amount) > largest.fils) largest = { fils: fils(c.amount), account, dims: d };
      }
      const patient = total - insurer;
      if (patient !== 0 && insurer <= total)
        set.add(r.account("receivable", "self_pay"), patient, recvDims);
      adjust = { account: largest.account, dims: largest.dims };
    }
  } else {
    adjust = { account: r.account("receivable", payerKind), dims: recvDims };
    set.add(adjust.account, total, recvDims);
  }
  const writeOff = fils(rec.write_off);
  if (writeOff !== 0) {
    set.add(r.account("write_off"), writeOff, dims);
    set.add(adjust.account, -writeOff, adjust.dims);
  }
  const creditNote = fils(rec.credit_note);
  if (creditNote !== 0) {
    set.add(r.account("credit_note"), creditNote, dims);
    set.add(adjust.account, -creditNote, adjust.dims);
  }
  return finish(r, set, rec.date, "sales", `Unite invoice ${rec.id}`, total);
}

// ---- Unite payment and refund ---------------------------------------------------------------------------------------

/**
 * Receipt: Dr the payment mode's account (cash of the branch, card / Tabby / EPG clearing) for what was paid plus any
 * advance left; Cr the patient (or corporate) receivable for what was paid, Cr patient advances for the advance. A copay
 * on an insurance invoice reduces the patient share. Refund (its own item, "refund:<id>"): Dr receivable, Cr the mode.
 * A payment Unite no longer delivers (not current) or on a deleted invoice is withdrawn.
 */
export function buildUnitePayment(rec: UnitePaymentRecord, ctx: PostingContext): BuildResult {
  if (!rec.is_current || rec.invoice_deleted) return { action: "withdraw" };
  const r = new Resolver(ctx);
  const set = new LineSet();
  const branch = r.branch(rec.branch);
  const dims: LineDims = { branch_code: branch };
  const kind = payerKindOf(rec.inv_type);
  const recvKey = kind === "corporate" ? "corporate" : "self_pay";
  if (rec.part === "refund") {
    const refund = fils(rec.refund);
    if (refund === 0) return { action: "nothing", date: rec.date };
    if (!rec.date) return noDate(fromFils(refund));
    set.add(r.account("receivable", recvKey), refund, dims);
    set.add(r.account("payment_mode", rec.mode, branch ?? "*"), -refund, dims);
    return finish(r, set, rec.date, "payment", `Unite refund on invoice ${rec.invoice}`, refund);
  }
  const paid = fils(rec.paid);
  const advance = fils(rec.advance);
  if (paid + advance === 0) return { action: "nothing", date: rec.date };
  if (!rec.date) return noDate(fromFils(paid + advance));
  set.add(r.account("payment_mode", rec.mode, branch ?? "*"), paid + advance, dims);
  set.add(r.account("receivable", recvKey), -paid, dims);
  if (advance !== 0) set.add(r.account("patient_advance"), -advance, dims);
  return finish(
    r,
    set,
    rec.date,
    "receipt",
    `Unite payment on invoice ${rec.invoice}`,
    paid + advance,
  );
}

// ---- insurance remittance -------------------------------------------------------------------------------------------

/** Dr the bank the insurers pay into; Cr each payer's insurance receivable with what the advice says it paid. */
export function buildRemittance(rec: RemittanceRecord, ctx: PostingContext): BuildResult {
  const total = rec.lines.reduce((a, l) => a + fils(l.paid), 0);
  if (total === 0) return { action: "nothing", date: rec.date };
  if (!rec.date) return noDate(fromFils(total));
  const r = new Resolver(ctx);
  const set = new LineSet();
  set.add(r.account("bank", rec.bank_account_id ?? "*"), total);
  for (const l of rec.lines) {
    const payerId = l.payer_id ?? rec.payer_id;
    set.add(r.account("receivable", "insurance", payerId ?? "*"), -fils(l.paid), {
      payer_id: r.payer(payerId),
    });
  }
  return finish(r, set, rec.date, "receipt", `Insurance remittance ${rec.id.slice(0, 8)}`, total);
}

// ---- final denial ---------------------------------------------------------------------------------------------------

export const FINAL_DENIAL_STATUSES = ["lost", "written_off"] as const;

/**
 * A denial accepted as final (lost or written off): Dr denials written off (or the expected-rejection allowance when that
 * setting is on, OQ-126), Cr the payer's insurance receivable. A case that is no longer final is withdrawn.
 */
export function buildDenial(rec: DenialRecord, ctx: PostingContext): BuildResult {
  if (!(FINAL_DENIAL_STATUSES as readonly string[]).includes(rec.status))
    return { action: "withdraw" };
  const amount = fils(rec.amount);
  if (amount === 0) return { action: "nothing", date: rec.date };
  if (!rec.date) return noDate(fromFils(amount));
  const r = new Resolver(ctx);
  const set = new LineSet();
  const d: LineDims = { payer_id: r.payer(rec.payer_id) };
  const key = rec.payer_id ?? "*";
  set.add(
    ctx.settings.denialAllowanceEnabled
      ? r.account("denial_allowance", key)
      : r.account("denial_writeoff", key),
    amount,
    d,
  );
  set.add(r.account("receivable", "insurance", key), -amount, d);
  return finish(
    r,
    set,
    rec.date,
    "journal",
    `Final insurance denial ${rec.id.slice(0, 8)}`,
    amount,
  );
}

// ---- supplier invoice (bill) ----------------------------------------------------------------------------------------

/**
 * Purchase journal: Dr the category's expense (net), Dr input VAT (the bill's VAT; recoverable unless the category's
 * tax code says blocked, when the VAT is part of the cost); a reverse-charge code books 5% both ways (Dr input, Cr
 * output); Cr the supplier payable (total). A VAT amount on a bill whose code is zero, exempt or out of scope waits
 * (vat_mismatch). A void bill is withdrawn; a bill in another currency waits (no rate is held).
 */
export function buildSupplierInvoice(rec: SupplierInvoiceRecord, ctx: PostingContext): BuildResult {
  if (rec.status === "void") return { action: "withdraw" };
  const net = fils(rec.net);
  const vat = fils(rec.vat);
  if (!rec.date) return noDate(fromFils(net + vat));
  if ((rec.currency || "AED").toUpperCase() !== "AED")
    return {
      action: "reasons",
      reasons: [{ code: "foreign_currency", detail: `The bill is in ${rec.currency}` }],
      date: rec.date,
      amount: fromFils(net + vat),
    };
  const r = new Resolver(ctx);
  const set = new LineSet();
  const branch = r.branch(rec.branch);
  const dims: LineDims = { branch_code: branch, doctor_id: r.doctor(rec.doctor) };
  const rule = r.rule("expense", rec.category, branch ?? "*");
  const tax = r.taxCode(rule?.tax_code ?? null, rec.category);
  const expense = rule?.account ?? null;
  if (tax?.kind === "blocked") {
    set.add(expense, net + vat, { ...dims, tax_code: tax.code });
  } else {
    set.add(expense, net, { ...dims, tax_code: tax?.code });
    if (vat !== 0) {
      if (tax && tax.kind !== "standard")
        r.miss("vat_mismatch", `${rec.category}: the bill has VAT but its code is ${tax.code}`);
      else set.add(tax?.input_account ?? r.account("vat_input"), vat, { tax_code: tax?.code });
    } else if (tax?.kind === "reverse_charge") {
      const rc = fils(vatOn(fromFils(net), tax.rate));
      set.add(tax.input_account ?? r.account("vat_input"), rc, { tax_code: tax.code });
      set.add(tax.output_account ?? r.account("vat_output"), -rc, { tax_code: tax.code });
    }
  }
  set.add(r.account("payable", rec.supplier_id), -(net + vat), {
    supplier_id: rec.supplier_id,
    party_kind: "supplier",
    party_id: rec.supplier_id,
  });
  return finish(r, set, rec.date, "purchase", `Supplier invoice ${rec.number}`, net + vat);
}

// ---- payment voucher ------------------------------------------------------------------------------------------------

/**
 * A paid voucher: Dr the supplier payable (a supplier's voucher: part payments and advances simply reduce the balance) or
 * the category's expense (a payee who is not a supplier); Cr the bank or cash it was paid from. Withdrawn while not paid.
 */
export function buildVoucher(rec: VoucherRecord, ctx: PostingContext): BuildResult {
  if (rec.status !== "paid") return { action: "withdraw" };
  const amount = fils(rec.amount);
  if (!rec.date) return noDate(fromFils(amount));
  if ((rec.currency || "AED").toUpperCase() !== "AED")
    return {
      action: "reasons",
      reasons: [{ code: "foreign_currency", detail: `The voucher is in ${rec.currency}` }],
      date: rec.date,
      amount: fromFils(amount),
    };
  const r = new Resolver(ctx);
  const set = new LineSet();
  const branch = r.branch(rec.branch);
  if (rec.supplier_id)
    set.add(r.account("payable", rec.supplier_id), amount, {
      supplier_id: rec.supplier_id,
      party_kind: "supplier",
      party_id: rec.supplier_id,
    });
  else set.add(r.account("expense", rec.category, branch ?? "*"), amount, { branch_code: branch });
  set.add(r.account("bank", rec.pay_from ?? rec.method, branch ?? "*"), -amount);
  return finish(r, set, rec.date, "payment", `Payment voucher ${rec.voucher_no}`, amount);
}

// ---- doctor revenue share -------------------------------------------------------------------------------------------

export const REVSHARE_ACCRUED = ["approved", "posted", "paid"] as const;

/**
 * The run (accrued on the month's last day once approved): Dr revenue share expense, Cr doctor payable, per doctor.
 * A payout ("payout:<line id>", once its payment is recorded): Dr doctor payable, Cr bank. Withdrawn otherwise.
 */
export function buildRevshare(rec: RevshareRecord, ctx: PostingContext): BuildResult {
  if (!(REVSHARE_ACCRUED as readonly string[]).includes(rec.status)) return { action: "withdraw" };
  const r = new Resolver(ctx);
  const set = new LineSet();
  const month = rec.month.slice(0, 7);
  if (rec.part === "run") {
    let total = 0;
    for (const l of rec.lines) {
      const p = fils(l.payout);
      total += p;
      const doctor = r.doctor(l.doctor);
      set.add(r.account("revshare_expense", l.doctor), p, { doctor_id: doctor });
      set.add(r.account("revshare_payable", l.doctor), -p, {
        doctor_id: doctor,
        party_kind: "doctor",
        party_id: l.doctor,
      });
    }
    return finish(r, set, monthEnd(rec.month), "journal", `Doctor revenue share ${month}`, total);
  }
  if (!rec.paid_on) return { action: "withdraw" };
  const p = fils(rec.payout);
  const doctor = r.doctor(rec.doctor);
  set.add(r.account("revshare_payable", rec.doctor), p, {
    doctor_id: doctor,
    party_kind: "doctor",
    party_id: rec.doctor,
  });
  set.add(r.account("bank", "revshare"), -p);
  return finish(r, set, rec.paid_on, "payment", `Doctor revenue share payout ${month}`, p);
}

// ---- lab and referral statement -------------------------------------------------------------------------------------

/**
 * A posted statement (20E), on the month's last day: Dr the provider kind's cost by doctor and branch (the frozen
 * allocation), Cr the offset account (by default the same cost account: the bill booked the cost, the statement spreads
 * it). Withdrawn when the statement is reopened.
 */
export function buildLabStatement(rec: LabStatementRecord, ctx: PostingContext): BuildResult {
  if (rec.status !== "posted") return { action: "withdraw" };
  const r = new Resolver(ctx);
  const set = new LineSet();
  let total = 0;
  for (const a of rec.allocation) {
    const cost = fils(a.cost);
    total += cost;
    set.add(r.account("provider_cost", rec.provider_kind), cost, {
      doctor_id: r.doctor(a.doctor),
      branch_code: r.branch(a.branch),
    });
  }
  set.add(r.account("provider_cost_offset", rec.provider_kind), -total);
  return finish(
    r,
    set,
    monthEnd(rec.month),
    "journal",
    `Lab and referral costs ${rec.month.slice(0, 7)}`,
    total,
  );
}

// ---- cash-up --------------------------------------------------------------------------------------------------------

/**
 * A submitted cash-up: each payment mode's variance (counted minus what Unite recorded) moves the mode's account at the
 * branch against cash over and short. No variance, nothing to post. Withdrawn when reopened.
 */
export function buildCashup(rec: CashupRecord, ctx: PostingContext): BuildResult {
  if (rec.status !== "submitted") return { action: "withdraw" };
  const r = new Resolver(ctx);
  const set = new LineSet();
  const branch = r.branch(rec.branch);
  let moved = 0;
  for (const l of rec.lines) {
    const v = fils(l.variance);
    if (v === 0) continue;
    moved += Math.abs(v);
    set.add(r.account("payment_mode", l.mode, rec.branch), v, { branch_code: branch });
    set.add(r.account("cashup_over_short", "*", rec.branch), -v, { branch_code: branch });
  }
  return finish(r, set, rec.date, "journal", `Cash-up ${rec.branch} ${rec.date}`, moved);
}

// ---- card and wallet settlement -------------------------------------------------------------------------------------

/**
 * A settlement matched on a signed bank reconciliation (20C): Dr the bank (what arrived), Dr bank charges (gross minus
 * what arrived; split into the charge and input VAT when the mode's charge rule carries a 5% code), Cr the mode's
 * clearing account (the gross collected). Withdrawn when the match is undone or the reconciliation reopened.
 */
export function buildSettlement(rec: SettlementRecord, ctx: PostingContext): BuildResult {
  if (!rec.matched) return { action: "withdraw" };
  const bank = fils(rec.bank_amount);
  const gross = rec.gross === null || rec.gross === undefined ? bank : fils(rec.gross);
  if (!rec.date) return noDate(fromFils(bank));
  const r = new Resolver(ctx);
  const set = new LineSet();
  set.add(r.account("bank", rec.bank_account_id ?? "*"), bank);
  set.add(r.account("payment_mode", rec.mode), -gross);
  const fee = gross - bank;
  if (fee !== 0) {
    const rule = r.rule("bank_charges", rec.mode);
    const tax = r.taxCode(rule?.tax_code ?? null, `charges on ${rec.mode}`);
    let vat = 0;
    if (tax && tax.kind === "standard" && tax.rate > 0) {
      vat = fils(vatOn(fromFils(fee) / (1 + tax.rate / 100), tax.rate));
      set.add(tax.input_account ?? r.account("vat_input"), vat, { tax_code: tax.code });
    }
    set.add(rule?.account ?? null, fee - vat, { tax_code: tax?.code });
  }
  return finish(r, set, rec.date, "receipt", `Settlement ${rec.mode} ${rec.date}`, gross);
}

// ---- dispatch -------------------------------------------------------------------------------------------------------

/** The builder for a source kind, on a record from acc_posting_load. */
export function buildFor(kind: PostingSource, rec: unknown, ctx: PostingContext): BuildResult {
  switch (kind) {
    case "unite_invoice":
      return buildUniteInvoice(rec as UniteInvoiceRecord, ctx);
    case "unite_payment":
      return buildUnitePayment(rec as UnitePaymentRecord, ctx);
    case "remittance":
      return buildRemittance(rec as RemittanceRecord, ctx);
    case "denial":
      return buildDenial(rec as DenialRecord, ctx);
    case "supplier_invoice":
      return buildSupplierInvoice(rec as SupplierInvoiceRecord, ctx);
    case "voucher":
      return buildVoucher(rec as VoucherRecord, ctx);
    case "revshare_run":
      return buildRevshare(rec as RevshareRecord, ctx);
    case "lab_charge":
      return buildLabStatement(rec as LabStatementRecord, ctx);
    case "cashup":
      return buildCashup(rec as CashupRecord, ctx);
    case "settlement":
      return buildSettlement(rec as SettlementRecord, ctx);
  }
}

/** One item for acc_posting_apply. */
export function applyItem(sourceId: string, r: BuildResult): Record<string, unknown> {
  switch (r.action) {
    case "post":
      return {
        source_id: sourceId,
        action: "post",
        date: r.journal.date,
        voucher_type: r.journal.voucherType,
        narration: r.journal.narration,
        lines: r.journal.lines,
      };
    case "reasons":
      return {
        source_id: sourceId,
        action: "reasons",
        reasons: r.reasons,
        date: r.date,
        amount: r.amount,
      };
    case "nothing":
      return { source_id: sourceId, action: "nothing", date: r.date };
    case "withdraw":
      return { source_id: sourceId, action: "withdraw" };
  }
}
