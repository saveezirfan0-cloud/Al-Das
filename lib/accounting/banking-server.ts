import "server-only";

import type { ChequeStatus } from "@/lib/accounting/banking";
import { todayIn } from "@/lib/finance/action-support";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Server side of Banking and cash (Phase 22F): loaders for the pages. Service role; every caller has run can() first.
 * Amounts, codes, dates and ids only; a patient on a cheque is a Unite PIN.
 */

export async function orgToday(admin: AdminClient, orgId: string): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
  return todayIn(data?.timezone);
}

export type LedgerOption = {
  id: string;
  code: string;
  name: string;
  control: string | null;
  is_active: boolean;
};

/** Active ledgers (not groups). */
export async function loadLedgers(admin: AdminClient, orgId: string): Promise<LedgerOption[]> {
  const { data } = await admin
    .from("acc_accounts")
    .select("id, code, name, control, is_active")
    .eq("org_id", orgId)
    .eq("is_group", false)
    .order("code")
    .limit(5000);
  return data ?? [];
}

export const moneyLedgers = (all: LedgerOption[]) =>
  all.filter((a) => a.is_active && (a.control === "bank" || a.control === "cash"));

/** Expense, income and other ledgers a bank entry or petty cash expense may post to (no control accounts). */
export const plainLedgers = (all: LedgerOption[]) =>
  all.filter((a) => a.is_active && a.control === null);

/** The other side of a cheque: plain ledgers plus receivables, payables and clearing accounts. */
export const chequeLedgers = (all: LedgerOption[]) =>
  all.filter(
    (a) =>
      a.is_active &&
      (a.control === null ||
        a.control === "receivable" ||
        a.control === "payable" ||
        a.control === "clearing"),
  );

export type BankAccountOption = {
  id: string;
  name: string;
  bank_name: string;
  last4: string;
  currency: string;
  active: boolean;
  gl_account_id: string | null;
};

export async function loadBankAccounts(
  admin: AdminClient,
  orgId: string,
): Promise<BankAccountOption[]> {
  const { data } = await admin
    .from("fin_bank_accounts")
    .select("id, name, bank_name, last4, currency, active, gl_account_id")
    .eq("org_id", orgId)
    .order("name");
  return data ?? [];
}

export const bankLabel = (b: { name: string; last4: string }) => `${b.name} (••${b.last4})`;

export type TaxCodeOption = { id: string; code: string; name: string; kind: string; rate: number };

export async function loadTaxCodes(admin: AdminClient, orgId: string): Promise<TaxCodeOption[]> {
  const { data } = await admin
    .from("acc_tax_codes")
    .select("id, code, name, kind, rate")
    .eq("org_id", orgId)
    .eq("active", true)
    .neq("kind", "reverse_charge")
    .order("code");
  return (data ?? []).map((t) => ({ ...t, rate: Number(t.rate) }));
}

export async function loadBranches(
  admin: AdminClient,
  orgId: string,
): Promise<Array<{ code: string; name: string }>> {
  const { data } = await admin
    .from("fin_ref_branches")
    .select("code, name")
    .eq("org_id", orgId)
    .order("code");
  return data ?? [];
}

/** Ledger balances (debit minus credit) on a date. */
export async function loadBalances(
  admin: AdminClient,
  orgId: string,
  ids: string[],
  asOf: string,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { data } = await admin.rpc("acc_account_balances", {
    p_org_id: orgId,
    p_account_ids: ids,
    p_as_of: asOf,
  });
  return new Map(
    Object.entries((data ?? {}) as Record<string, number | string>).map(([k, v]) => [k, Number(v)]),
  );
}

export type PositionRow = {
  bank_account_id: string;
  name: string;
  bank_name: string;
  last4: string;
  currency: string;
  active: boolean;
  gl_account_id: string | null;
  gl_code: string | null;
  gl_name: string | null;
  gl_balance: number | null;
  statement_date: string | null;
  statement_balance: number | null;
  gl_at_statement: number | null;
  uncleared_issued: { count: number; amount: number };
  uncleared_received: { count: number; amount: number };
  post_dated: { count: number; issued: number; received: number };
  unmatched_lines: { count: number; credits: number; debits: number };
  last_statement_line: string | null;
  latest_rec: { id: string; month: string; status: string } | null;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadPosition(
  admin: AdminClient,
  orgId: string,
  asOf: string,
): Promise<PositionRow[]> {
  const { data } = await admin.rpc("acc_bank_position", { p_org_id: orgId, p_as_of: asOf });
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const pair = (v: unknown) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return { count: Number(o.count ?? 0), amount: Number(o.amount ?? 0) };
    };
    const pd = (r.post_dated ?? {}) as Record<string, unknown>;
    const ul = (r.unmatched_lines ?? {}) as Record<string, unknown>;
    return {
      bank_account_id: String(r.bank_account_id),
      name: String(r.name),
      bank_name: String(r.bank_name),
      last4: String(r.last4),
      currency: String(r.currency),
      active: !!r.active,
      gl_account_id: (r.gl_account_id as string | null) ?? null,
      gl_code: (r.gl_code as string | null) ?? null,
      gl_name: (r.gl_name as string | null) ?? null,
      gl_balance: num(r.gl_balance),
      statement_date: (r.statement_date as string | null) ?? null,
      statement_balance: num(r.statement_balance),
      gl_at_statement: num(r.gl_at_statement),
      uncleared_issued: pair(r.uncleared_issued),
      uncleared_received: pair(r.uncleared_received),
      post_dated: {
        count: Number(pd.count ?? 0),
        issued: Number(pd.issued ?? 0),
        received: Number(pd.received ?? 0),
      },
      unmatched_lines: {
        count: Number(ul.count ?? 0),
        credits: Number(ul.credits ?? 0),
        debits: Number(ul.debits ?? 0),
      },
      last_statement_line: (r.last_statement_line as string | null) ?? null,
      latest_rec: (r.latest_rec as PositionRow["latest_rec"]) ?? null,
    };
  });
}

export type ChequeRow = {
  id: string;
  direction: "issued" | "received";
  bank_account_id: string;
  cheque_no: string;
  cheque_date: string;
  recorded_on: string;
  post_dated: boolean | null;
  amount: number;
  party_kind: string;
  party_ref: string | null;
  party_name: string | null;
  counter_account_id: string;
  voucher_id: string | null;
  narration: string | null;
  status: ChequeStatus;
  posting: string;
  journal_id: string | null;
  presented_on: string | null;
  cleared_on: string | null;
  bounced_on: string | null;
  cancelled_on: string | null;
  stale_on: string | null;
  status_reason: string | null;
};

export async function loadCheques(admin: AdminClient, orgId: string): Promise<ChequeRow[]> {
  const { data } = await admin
    .from("acc_cheques")
    .select(
      "id, direction, bank_account_id, cheque_no, cheque_date, recorded_on, post_dated, amount, party_kind, party_ref, party_name, counter_account_id, voucher_id, narration, status, posting, journal_id, presented_on, cleared_on, bounced_on, cancelled_on, stale_on, status_reason",
    )
    .eq("org_id", orgId)
    .order("cheque_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);
  return (data ?? []).map((c) => ({
    ...c,
    direction: c.direction as ChequeRow["direction"],
    status: c.status as ChequeStatus,
    amount: Number(c.amount),
  }));
}

/** Cheques in the books that the bank has not cleared yet (posted, not cleared, bounced, cancelled or stale). */
export const isUncleared = (c: ChequeRow) =>
  c.posting === "posted" &&
  (c.status === "issued" || c.status === "received" || c.status === "presented");

/** Journal numbers for links. */
export async function journalNumbers(
  admin: AdminClient,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const { data } = await admin.from("acc_journals").select("id, number").in("id", unique);
  return new Map((data ?? []).map((j) => [j.id, j.number ?? ""]));
}
