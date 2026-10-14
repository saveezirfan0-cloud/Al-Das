import "server-only";

import type { AccountNature, AccountRow, ControlKind } from "@/lib/accounting/accounts";
import type { JournalStatus, VoucherType } from "@/lib/accounting/journal";
import type { DayBookData, LedgerData, TrialBalanceData } from "@/lib/accounting/reports";
import { peopleNames } from "@/lib/finance/vouchers-server";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Server side of Accounting (Phase 22A): loaders for pages, routes and actions. Service role; every caller has run can()
 * for the permission of what it shows. Reports are aggregated in SQL (acc_trial_balance, acc_ledger, acc_day_book).
 */

export { peopleNames };

export type EntityView = {
  id: string;
  name: string;
  trn: string | null;
  base_currency: string;
  fiscal_year_start_month: number;
  is_default: boolean;
  active: boolean;
};

export async function loadEntities(admin: AdminClient, orgId: string): Promise<EntityView[]> {
  const { data } = await admin
    .from("acc_entities")
    .select("id, name, trn, base_currency, fiscal_year_start_month, is_default, active")
    .eq("org_id", orgId)
    .order("is_default", { ascending: false })
    .order("name");
  return data ?? [];
}

export type AccountView = AccountRow & {
  entity_id: string | null;
  currency: string | null;
  description: string | null;
  tally_group: string | null;
  affects_gross_profit: boolean;
  sort_order: number;
  cash_flow_class: string | null;
  requires_branch: boolean;
  requires_cost_centre: boolean;
  ct_treatment: string | null;
};

export async function loadAccounts(admin: AdminClient, orgId: string): Promise<AccountView[]> {
  // Every row, read in pages (PostgREST returns at most 1,000 per request).
  const { data } = await fetchAll((from, to) =>
    admin
      .from("acc_accounts")
      .select(
        "id, parent_id, code, name, nature, is_group, is_active, is_system, control, allow_manual, entity_id, currency, description, tally_group, affects_gross_profit, sort_order, cash_flow_class, requires_branch, requires_cost_centre, ct_treatment",
      )
      .eq("org_id", orgId)
      .order("code")
      .order("id")
      .range(from, to),
  );
  return (data ?? []).map((a) => ({
    ...a,
    nature: a.nature as AccountNature,
    control: (a.control as ControlKind | null) ?? null,
  }));
}

export type JournalOptions = {
  entities: EntityView[];
  accounts: AccountView[];
  taxCodes: Array<{ id: string; code: string; name: string; active: boolean }>;
  costCentres: Array<{ id: string; code: string; name: string; active: boolean }>;
  branches: Array<{ code: string; name: string }>;
  doctors: Array<{ id: string; name: string }>;
  payers: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
};

/** Everything the journal form offers (reference data only; no patient data). */
export async function loadJournalOptions(
  admin: AdminClient,
  orgId: string,
): Promise<JournalOptions> {
  const [entities, accounts, tax, cc, branches, doctors, payers, suppliers] = await Promise.all([
    loadEntities(admin, orgId),
    loadAccounts(admin, orgId),
    admin.from("acc_tax_codes").select("id, code, name, active").eq("org_id", orgId).order("code"),
    admin
      .from("acc_cost_centres")
      .select("id, code, name, active")
      .eq("org_id", orgId)
      .order("code"),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", orgId).order("code"),
    admin
      .from("fin_ref_doctors")
      .select("dha_id, name")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name")
      .limit(1000),
    admin
      .from("fin_ref_payers")
      .select("payer_id, payer_name")
      .eq("org_id", orgId)
      .order("payer_name")
      .limit(1000),
    admin
      .from("fin_suppliers")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name")
      .limit(1000),
  ]);
  return {
    entities,
    accounts,
    taxCodes: tax.data ?? [],
    costCentres: cc.data ?? [],
    branches: branches.data ?? [],
    doctors: (doctors.data ?? []).map((d) => ({ id: d.dha_id, name: d.name ?? d.dha_id })),
    payers: (payers.data ?? []).map((p) => ({ id: p.payer_id, name: p.payer_name ?? p.payer_id })),
    suppliers: suppliers.data ?? [],
  };
}

export type JournalListRow = {
  id: string;
  number: string | null;
  journal_date: string;
  voucher_type: VoucherType;
  narration: string;
  status: JournalStatus;
  total: number;
  source_kind: string | null;
  submitted_at: string | null;
  returned_at: string | null;
  prepared_by: string | null;
  entity_id: string;
};

export type JournalFilter = {
  status: JournalStatus | "waiting" | null;
  type: VoucherType | null;
  from: string | null;
  to: string | null;
};

export const JOURNAL_LIST_LIMIT = 300;

export async function loadJournalList(
  admin: AdminClient,
  orgId: string,
  f: JournalFilter,
): Promise<JournalListRow[]> {
  let q = admin
    .from("acc_journals")
    .select(
      "id, number, journal_date, voucher_type, narration, status, total, source_kind, submitted_at, returned_at, prepared_by, entity_id",
    )
    .eq("org_id", orgId);
  if (f.status === "waiting") q = q.eq("status", "draft").not("submitted_at", "is", null);
  else if (f.status) q = q.eq("status", f.status);
  if (f.type) q = q.eq("voucher_type", f.type);
  if (f.from) q = q.gte("journal_date", f.from);
  if (f.to) q = q.lte("journal_date", f.to);
  const { data } = await q
    .order("journal_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(JOURNAL_LIST_LIMIT);
  return (data ?? []).map((j) => ({
    ...j,
    voucher_type: j.voucher_type as VoucherType,
    status: j.status as JournalStatus,
    total: Number(j.total),
  }));
}

export type JournalLineView = {
  id: string;
  line_no: number;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  description: string | null;
  tax_code_id: string | null;
  branch_code: string | null;
  department: string | null;
  doctor_id: string | null;
  payer_id: string | null;
  supplier_id: string | null;
  cost_centre_id: string | null;
};

export type JournalDetail = {
  id: string;
  entity_id: string;
  number: string | null;
  journal_date: string;
  voucher_type: VoucherType;
  narration: string;
  status: JournalStatus;
  total: number;
  source_kind: string | null;
  source_id: string | null;
  source_version: number | null;
  reversal_of: string | null;
  reversed_by: string | null;
  is_adjustment: boolean;
  auto_reverse_on: string | null;
  prepared_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  returned_by: string | null;
  returned_at: string | null;
  return_remarks: string | null;
  approved_by: string | null;
  posted_at: string | null;
  sha256: string | null;
  tally_guid: string | null;
  created_at: string;
  lines: JournalLineView[];
  /** The hash of the content now (drafts): what the checker approves. */
  currentHash: string | null;
  people: Map<string, string>;
  linked: Array<{ id: string; number: string | null }>;
};

export async function loadJournalDetail(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<JournalDetail | null> {
  const { data: j } = await admin
    .from("acc_journals")
    .select(
      "id, entity_id, number, journal_date, voucher_type, narration, status, total, source_kind, source_id, source_version, reversal_of, reversed_by, is_adjustment, auto_reverse_on, prepared_by, submitted_by, submitted_at, returned_by, returned_at, return_remarks, approved_by, posted_at, sha256, tally_guid, created_at",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!j) return null;
  const [{ data: lines }, hash, people, linked] = await Promise.all([
    admin
      .from("acc_journal_lines")
      .select(
        "id, line_no, account_id, debit, credit, description, tax_code_id, branch_code, department, doctor_id, payer_id, supplier_id, cost_centre_id, acc_accounts!inner(code, name)",
      )
      .eq("journal_id", j.id)
      .order("line_no"),
    j.status === "draft"
      ? admin.rpc("acc_journal_compute_hash", { p_journal_id: j.id })
      : Promise.resolve({ data: null }),
    peopleNames(admin, [j.prepared_by, j.submitted_by, j.returned_by, j.approved_by]),
    [j.reversal_of, j.reversed_by].some(Boolean)
      ? admin
          .from("acc_journals")
          .select("id, number")
          .eq("org_id", orgId)
          .in(
            "id",
            [j.reversal_of, j.reversed_by].filter((x): x is string => !!x),
          )
      : Promise.resolve({ data: [] as Array<{ id: string; number: string | null }> }),
  ]);
  return {
    ...j,
    voucher_type: j.voucher_type as VoucherType,
    status: j.status as JournalStatus,
    total: Number(j.total),
    lines: (lines ?? []).map((l) => {
      const acc = l.acc_accounts as unknown as { code: string; name: string };
      return {
        id: l.id,
        line_no: l.line_no,
        account_id: l.account_id,
        account_code: acc.code,
        account_name: acc.name,
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description,
        tax_code_id: l.tax_code_id,
        branch_code: l.branch_code,
        department: l.department,
        doctor_id: l.doctor_id,
        payer_id: l.payer_id,
        supplier_id: l.supplier_id,
        cost_centre_id: l.cost_centre_id,
      };
    }),
    currentHash: (hash.data as string | null) ?? null,
    people,
    linked: linked.data ?? [],
  };
}

export async function loadTrialBalance(
  admin: AdminClient,
  orgId: string,
  entityId: string | null,
  from: string,
  to: string,
): Promise<TrialBalanceData> {
  const { data, error } = await admin.rpc("acc_trial_balance", {
    p_org_id: orgId,
    p_entity_id: entityId as string,
    p_from: from,
    p_to: to,
  });
  if (error || !data) throw new Error("trial balance failed");
  return data as unknown as TrialBalanceData;
}

export async function loadLedger(
  admin: AdminClient,
  orgId: string,
  accountId: string,
  from: string,
  to: string,
  limit: number,
  offset: number,
): Promise<LedgerData | null> {
  const { data, error } = await admin.rpc("acc_ledger", {
    p_org_id: orgId,
    p_account_id: accountId,
    p_from: from,
    p_to: to,
    p_limit: limit,
    p_offset: offset,
  });
  if (error || !data) return null;
  return data as unknown as LedgerData;
}

export async function loadDayBook(
  admin: AdminClient,
  orgId: string,
  entityId: string | null,
  from: string,
  to: string,
): Promise<DayBookData> {
  const { data, error } = await admin.rpc("acc_day_book", {
    p_org_id: orgId,
    p_entity_id: entityId as string,
    p_from: from,
    p_to: to,
  });
  if (error || !data) throw new Error("day book failed");
  return data as unknown as DayBookData;
}

/** The default entity's fiscal year start month (7 when nothing is set up yet). */
export function defaultStartMonth(entities: readonly EntityView[]): number {
  return (entities.find((e) => e.is_default) ?? entities[0])?.fiscal_year_start_month ?? 7;
}
