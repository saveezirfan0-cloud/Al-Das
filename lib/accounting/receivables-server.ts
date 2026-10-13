import "server-only";

import { loadEntities } from "@/lib/accounting/accounting-server";
import {
  buildAgeing,
  statementWithBalance,
  type AgeingRow,
  type CustomerKind,
  type SalesDocKind,
  type SalesStatus,
  type StatementEntry,
} from "@/lib/accounting/sales";
import { nameOf, peopleNames } from "@/lib/finance/vouchers-server";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Server side of receivables (Phase 22E): loaders for pages, routes and actions. Service role; every caller has run can()
 * first. Reports come from acc_ar_open_items / acc_ar_statement and are shaped by the pure rules in lib/accounting/sales.ts.
 * No patient data exists here: customers are insurers, corporates, tenants and other businesses.
 */

export type ArSettings = {
  issue_approval_threshold: number;
  simplified_invoice_limit: number;
  credit_note_days: number;
  invoice_prefix: string;
  credit_note_prefix: string;
  receipt_prefix: string;
  seller_address: string | null;
  payment_instructions: string | null;
};

export const DEFAULT_AR_SETTINGS: ArSettings = {
  issue_approval_threshold: 50000,
  simplified_invoice_limit: 10000,
  credit_note_days: 14,
  invoice_prefix: "SI",
  credit_note_prefix: "CN",
  receipt_prefix: "RV",
  seller_address: null,
  payment_instructions: null,
};

export async function loadArSettings(admin: AdminClient, orgId: string): Promise<ArSettings> {
  const { data } = await admin
    .from("acc_ar_settings")
    .select(
      "issue_approval_threshold, simplified_invoice_limit, credit_note_days, invoice_prefix, credit_note_prefix, receipt_prefix, seller_address, payment_instructions",
    )
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return DEFAULT_AR_SETTINGS;
  return {
    ...data,
    issue_approval_threshold: Number(data.issue_approval_threshold),
    simplified_invoice_limit: Number(data.simplified_invoice_limit),
  };
}

export type CustomerView = {
  id: string;
  kind: CustomerKind;
  name: string;
  trn: string | null;
  emirate: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country: string;
  email: string | null;
  credit_terms_days: number;
  connected_person: boolean;
  payer_id: string | null;
  receivable_account_id: string | null;
  active: boolean;
};

const CUSTOMER_COLS =
  "id, kind, name, trn, emirate, address_line1, address_line2, city, country, email, credit_terms_days, connected_person, payer_id, receivable_account_id, active";

export async function loadCustomers(admin: AdminClient, orgId: string): Promise<CustomerView[]> {
  const { data } = await admin
    .from("acc_customers")
    .select(CUSTOMER_COLS)
    .eq("org_id", orgId)
    .order("name")
    .limit(2000);
  return (data ?? []).map((c) => ({ ...c, kind: c.kind as CustomerKind }));
}

export async function loadCustomer(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<CustomerView | null> {
  const { data } = await admin
    .from("acc_customers")
    .select(CUSTOMER_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data ? { ...data, kind: data.kind as CustomerKind } : null;
}

export type Option = { id: string; label: string };

/** Receivables ledgers (for a customer's own receivable account) and the payers (for insurers). */
export async function loadCustomerOptions(admin: AdminClient, orgId: string) {
  const [acc, payers] = await Promise.all([
    admin
      .from("acc_accounts")
      .select("id, code, name")
      .eq("org_id", orgId)
      .eq("is_group", false)
      .eq("is_active", true)
      .eq("control", "receivable")
      .order("code"),
    admin
      .from("fin_ref_payers")
      .select("payer_id, payer_name")
      .eq("org_id", orgId)
      .order("payer_name")
      .limit(1000),
  ]);
  return {
    receivableAccounts: (acc.data ?? []).map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })),
    payers: (payers.data ?? []).map((p) => ({
      id: p.payer_id,
      label: p.payer_name ?? p.payer_id,
    })),
  };
}

export type SalesOptions = {
  customers: Array<{ id: string; name: string; kind: CustomerKind; trn: string | null; terms: number }>;
  incomeAccounts: Option[];
  taxCodes: Array<{ id: string; code: string; name: string; rate: number }>;
  branches: Array<{ code: string; name: string }>;
  costCentres: Option[];
};

/** What the sales invoice form offers: active customers, income ledgers, the sales tax codes, branches, cost centres. */
export async function loadSalesOptions(admin: AdminClient, orgId: string): Promise<SalesOptions> {
  const [cust, acc, tax, branches, cc] = await Promise.all([
    admin
      .from("acc_customers")
      .select("id, name, kind, trn, credit_terms_days")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name")
      .limit(2000),
    admin
      .from("acc_accounts")
      .select("id, code, name")
      .eq("org_id", orgId)
      .eq("is_group", false)
      .eq("is_active", true)
      .eq("nature", "income")
      .is("control", null)
      .order("code"),
    admin
      .from("acc_tax_codes")
      .select("id, code, name, rate, kind")
      .eq("org_id", orgId)
      .eq("active", true)
      .in("kind", ["standard", "zero", "exempt", "out_of_scope"])
      .order("code"),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", orgId).order("code"),
    admin
      .from("acc_cost_centres")
      .select("id, code, name")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("code"),
  ]);
  return {
    customers: (cust.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind as CustomerKind,
      trn: c.trn,
      terms: c.credit_terms_days,
    })),
    incomeAccounts: (acc.data ?? []).map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })),
    taxCodes: (tax.data ?? []).map((t) => ({ ...t, rate: Number(t.rate) })),
    branches: branches.data ?? [],
    costCentres: (cc.data ?? []).map((c) => ({ id: c.id, label: `${c.code} ${c.name}` })),
  };
}

export type SalesListRow = {
  id: string;
  kind: SalesDocKind;
  number: string | null;
  invoice_date: string;
  due_date: string | null;
  customer: string;
  total: number;
  amount_paid: number;
  amount_credited: number;
  status: SalesStatus;
  posting_status: string;
  approval_required: boolean;
};

export type SalesFilter = {
  kind: SalesDocKind;
  status?: SalesStatus | "approval" | null;
  customerId?: string | null;
  from?: string | null;
  to?: string | null;
};

export const SALES_LIST_LIMIT = 300;

export async function loadSalesList(
  admin: AdminClient,
  orgId: string,
  f: SalesFilter,
  threshold: number,
): Promise<SalesListRow[]> {
  let q = admin
    .from("acc_sales_invoices")
    .select(
      "id, kind, number, invoice_date, due_date, total, amount_paid, amount_credited, status, posting_status, approval_required, acc_customers!acc_sales_invoices_customer_id_fkey(name)",
    )
    .eq("org_id", orgId)
    .eq("kind", f.kind)
    .order("invoice_date", { ascending: false })
    .order("number", { ascending: false })
    .limit(SALES_LIST_LIMIT);
  if (f.status === "approval") q = q.eq("status", "draft").gt("total", threshold);
  else if (f.status) q = q.eq("status", f.status);
  if (f.customerId) q = q.eq("customer_id", f.customerId);
  if (f.from) q = q.gte("invoice_date", f.from);
  if (f.to) q = q.lte("invoice_date", f.to);
  const { data } = await q;
  return (data ?? []).map((d) => ({
    id: d.id,
    kind: d.kind as SalesDocKind,
    number: d.number,
    invoice_date: d.invoice_date,
    due_date: d.due_date,
    customer: (d.acc_customers as unknown as { name: string } | null)?.name ?? "-",
    total: Number(d.total),
    amount_paid: Number(d.amount_paid),
    amount_credited: Number(d.amount_credited),
    status: d.status as SalesStatus,
    posting_status: d.posting_status,
    approval_required: d.approval_required,
  }));
}

export type SalesLineView = {
  line_no: number;
  description: string;
  quantity: number;
  unit_price: number;
  discount: number;
  gross: number;
  net: number;
  vat_rate: number;
  vat_amount: number;
  line_total: number;
  income_account_id: string;
  income_account: string;
  tax_code_id: string;
  tax_code: string;
  branch_code: string | null;
  department: string | null;
  cost_centre_id: string | null;
};

export type SalesDetail = {
  id: string;
  entity_id: string;
  kind: SalesDocKind;
  number: string | null;
  invoice_date: string;
  supply_date: string | null;
  due_date: string | null;
  event_date: string | null;
  credit_reason: string | null;
  reference: string | null;
  notes: string | null;
  status: SalesStatus;
  invoice_form: "full" | "simplified" | null;
  subtotal: number;
  discount_total: number;
  net_total: number;
  vat_total: number;
  total: number;
  amount_paid: number;
  amount_credited: number;
  content_sha256: string | null;
  approval_required: boolean;
  posting_status: string;
  einvoice_status: string;
  journal: { id: string; number: string | null } | null;
  customer: CustomerView;
  original: { id: string; number: string | null; invoice_date: string; total: number } | null;
  creditNotes: Array<{ id: string; number: string | null; invoice_date: string; total: number; status: string }>;
  allocations: Array<{ receipt_id: string; number: string; receipt_date: string; amount: number }>;
  lines: SalesLineView[];
  people: {
    prepared: string;
    approved: string;
    issued: string;
    voided: string;
    preparedId: string | null;
  };
  issued_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
};

export async function loadSalesDetail(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<SalesDetail | null> {
  const { data: d } = await admin
    .from("acc_sales_invoices")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!d) return null;
  const [customer, lines, original, credits, allocs, journal, names] = await Promise.all([
    loadCustomer(admin, orgId, d.customer_id),
    admin
      .from("acc_sales_invoice_lines")
      .select(
        "line_no, description, quantity, unit_price, discount, gross, net, vat_rate, vat_amount, line_total, income_account_id, tax_code_id, branch_code, department, cost_centre_id, acc_accounts(code, name), acc_tax_codes(code)",
      )
      .eq("invoice_id", d.id)
      .order("line_no"),
    d.original_invoice_id
      ? admin
          .from("acc_sales_invoices")
          .select("id, number, invoice_date, total")
          .eq("id", d.original_invoice_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("acc_sales_invoices")
      .select("id, number, invoice_date, total, status")
      .eq("org_id", orgId)
      .eq("original_invoice_id", d.id)
      .order("invoice_date"),
    admin
      .from("acc_allocations")
      .select("amount, receipt_id, acc_receipts(number, receipt_date, status)")
      .eq("invoice_id", d.id),
    d.journal_id
      ? admin.from("acc_journals").select("id, number").eq("id", d.journal_id).maybeSingle()
      : Promise.resolve({ data: null }),
    peopleNames(admin, [d.prepared_by, d.approved_by, d.issued_by, d.voided_by]),
  ]);
  if (!customer) return null;
  return {
    id: d.id,
    entity_id: d.entity_id,
    kind: d.kind as SalesDocKind,
    number: d.number,
    invoice_date: d.invoice_date,
    supply_date: d.supply_date,
    due_date: d.due_date,
    event_date: d.event_date,
    credit_reason: d.credit_reason,
    reference: d.reference,
    notes: d.notes,
    status: d.status as SalesStatus,
    invoice_form: d.invoice_form as SalesDetail["invoice_form"],
    subtotal: Number(d.subtotal),
    discount_total: Number(d.discount_total),
    net_total: Number(d.net_total),
    vat_total: Number(d.vat_total),
    total: Number(d.total),
    amount_paid: Number(d.amount_paid),
    amount_credited: Number(d.amount_credited),
    content_sha256: d.content_sha256,
    approval_required: d.approval_required,
    posting_status: d.posting_status,
    einvoice_status: d.einvoice_status,
    journal: journal.data ? { id: journal.data.id, number: journal.data.number } : null,
    customer,
    original: original.data
      ? { ...original.data, total: Number(original.data.total) }
      : null,
    creditNotes: (credits.data ?? []).map((c) => ({ ...c, total: Number(c.total) })),
    allocations: (allocs.data ?? [])
      .map((a) => {
        const r = a.acc_receipts as unknown as {
          number: string;
          receipt_date: string;
          status: string;
        } | null;
        return r && r.status === "active"
          ? { receipt_id: a.receipt_id, number: r.number, receipt_date: r.receipt_date, amount: Number(a.amount) }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    lines: (lines.data ?? []).map((l) => {
      const acc = l.acc_accounts as unknown as { code: string; name: string } | null;
      const tax = l.acc_tax_codes as unknown as { code: string } | null;
      return {
        line_no: l.line_no,
        description: l.description,
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        discount: Number(l.discount),
        gross: Number(l.gross),
        net: Number(l.net),
        vat_rate: Number(l.vat_rate),
        vat_amount: Number(l.vat_amount),
        line_total: Number(l.line_total),
        income_account_id: l.income_account_id,
        income_account: acc ? `${acc.code} ${acc.name}` : "-",
        tax_code_id: l.tax_code_id,
        tax_code: tax?.code ?? "-",
        branch_code: l.branch_code,
        department: l.department,
        cost_centre_id: l.cost_centre_id,
      };
    }),
    people: {
      prepared: nameOf(names, d.prepared_by),
      approved: nameOf(names, d.approved_by),
      issued: nameOf(names, d.issued_by),
      voided: nameOf(names, d.voided_by),
      preparedId: d.prepared_by,
    },
    issued_at: d.issued_at,
    voided_at: d.voided_at,
    void_reason: d.void_reason,
  };
}

/** The seller block on a tax invoice: the entity's name and TRN, and the address from the settings. */
export async function loadSeller(admin: AdminClient, orgId: string, entityId: string | null) {
  const [entities, settings] = await Promise.all([
    loadEntities(admin, orgId),
    loadArSettings(admin, orgId),
  ]);
  const e = entities.find((x) => x.id === entityId) ?? entities.find((x) => x.is_default) ?? null;
  return {
    name: e?.name ?? "",
    trn: e?.trn ?? null,
    address: settings.seller_address,
    paymentInstructions: settings.payment_instructions,
    settings,
  };
}

export type ReceiptListRow = {
  id: string;
  number: string;
  receipt_date: string;
  customer: string;
  amount: number;
  amount_allocated: number;
  mode: string;
  reference: string | null;
  status: string;
  posting_status: string;
};

export async function loadReceiptList(
  admin: AdminClient,
  orgId: string,
  f: { customerId?: string | null; from?: string | null; to?: string | null },
): Promise<ReceiptListRow[]> {
  let q = admin
    .from("acc_receipts")
    .select(
      "id, number, receipt_date, amount, amount_allocated, mode, reference, status, posting_status, acc_customers!acc_receipts_customer_id_fkey(name)",
    )
    .eq("org_id", orgId)
    .order("receipt_date", { ascending: false })
    .order("number", { ascending: false })
    .limit(SALES_LIST_LIMIT);
  if (f.customerId) q = q.eq("customer_id", f.customerId);
  if (f.from) q = q.gte("receipt_date", f.from);
  if (f.to) q = q.lte("receipt_date", f.to);
  const { data } = await q;
  return (data ?? []).map((r) => ({
    id: r.id,
    number: r.number,
    receipt_date: r.receipt_date,
    customer: (r.acc_customers as unknown as { name: string } | null)?.name ?? "-",
    amount: Number(r.amount),
    amount_allocated: Number(r.amount_allocated),
    mode: r.mode,
    reference: r.reference,
    status: r.status,
    posting_status: r.posting_status,
  }));
}

export type ReceiptDetail = ReceiptListRow & {
  customer_id: string;
  account: string;
  notes: string | null;
  journal: { id: string; number: string | null } | null;
  void_reason: string | null;
  prepared: string;
  allocations: Array<{ invoice_id: string; number: string | null; invoice_date: string; amount: number }>;
};

export async function loadReceiptDetail(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<ReceiptDetail | null> {
  const { data: r } = await admin
    .from("acc_receipts")
    .select(
      "*, acc_customers!acc_receipts_customer_id_fkey(name), acc_accounts!acc_receipts_account_id_fkey(code, name)",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!r) return null;
  const [allocs, journal, names] = await Promise.all([
    admin
      .from("acc_allocations")
      .select("invoice_id, amount, acc_sales_invoices(number, invoice_date)")
      .eq("receipt_id", r.id),
    r.journal_id
      ? admin.from("acc_journals").select("id, number").eq("id", r.journal_id).maybeSingle()
      : Promise.resolve({ data: null }),
    peopleNames(admin, [r.prepared_by]),
  ]);
  const acc = r.acc_accounts as unknown as { code: string; name: string } | null;
  return {
    id: r.id,
    number: r.number,
    receipt_date: r.receipt_date,
    customer: (r.acc_customers as unknown as { name: string } | null)?.name ?? "-",
    customer_id: r.customer_id,
    amount: Number(r.amount),
    amount_allocated: Number(r.amount_allocated),
    mode: r.mode,
    reference: r.reference,
    status: r.status,
    posting_status: r.posting_status,
    account: acc ? `${acc.code} ${acc.name}` : "-",
    notes: r.notes,
    journal: journal.data ? { id: journal.data.id, number: journal.data.number } : null,
    void_reason: r.void_reason,
    prepared: nameOf(names, r.prepared_by),
    allocations: (allocs.data ?? [])
      .map((a) => {
        const i = a.acc_sales_invoices as unknown as { number: string | null; invoice_date: string } | null;
        return {
          invoice_id: a.invoice_id,
          number: i?.number ?? null,
          invoice_date: i?.invoice_date ?? "",
          amount: Number(a.amount),
        };
      })
      .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date)),
  };
}

/** Bank, cash and clearing ledgers a receipt may go into. */
export async function loadReceiptAccounts(admin: AdminClient, orgId: string): Promise<Option[]> {
  const { data } = await admin
    .from("acc_accounts")
    .select("id, code, name")
    .eq("org_id", orgId)
    .eq("is_group", false)
    .eq("is_active", true)
    .in("control", ["bank", "cash", "clearing"])
    .order("code");
  return (data ?? []).map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }));
}

type OpenItemsRaw = {
  as_of: string;
  invoices: Array<{
    id: string;
    customer_id: string;
    number: string;
    invoice_date: string;
    due_date: string | null;
    total: number;
    open: number;
    reference: string | null;
  }>;
  on_account: Array<{
    id: string;
    customer_id: string;
    number: string;
    receipt_date: string;
    unallocated: number;
    reference: string | null;
  }>;
};

export async function loadOpenItems(
  admin: AdminClient,
  orgId: string,
  customerId: string | null,
  asOf: string,
): Promise<OpenItemsRaw> {
  const { data, error } = await admin.rpc("acc_ar_open_items", {
    p_org_id: orgId,
    p_customer_id: customerId as string,
    p_as_of: asOf,
  });
  if (error || !data) throw new Error("open items failed");
  const raw = data as unknown as OpenItemsRaw;
  return {
    as_of: raw.as_of,
    invoices: raw.invoices.map((i) => ({ ...i, total: Number(i.total), open: Number(i.open) })),
    on_account: raw.on_account.map((r) => ({ ...r, unallocated: Number(r.unallocated) })),
  };
}

/** Invoices a receipt may be allocated to: everything of the customer still open, whatever its date. */
export async function loadOpenInvoices(admin: AdminClient, orgId: string, customerId: string) {
  const items = await loadOpenItems(admin, orgId, customerId, "2999-12-01");
  return items.invoices
    .filter((i) => i.open > 0)
    .map((i) => ({ id: i.id, number: i.number, invoiceDate: i.invoice_date, open: i.open, total: i.total }));
}

export type AgeingView = {
  asOf: string;
  rows: Array<AgeingRow & { name: string; kind: CustomerKind }>;
  totals: AgeingRow;
};

export async function loadAgeing(admin: AdminClient, orgId: string, asOf: string): Promise<AgeingView> {
  const [items, customers] = await Promise.all([
    loadOpenItems(admin, orgId, null, asOf),
    loadCustomers(admin, orgId),
  ]);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const a = buildAgeing(
    [
      ...items.invoices.map((i) => ({
        customerId: i.customer_id,
        kind: "invoice" as const,
        dueDate: i.due_date ?? i.invoice_date,
        open: i.open,
      })),
      ...items.on_account.map((r) => ({
        customerId: r.customer_id,
        kind: "on_account" as const,
        dueDate: null,
        open: r.unallocated,
      })),
    ],
    asOf,
  );
  return {
    asOf,
    rows: a.rows
      .map((r) => ({
        ...r,
        name: byId.get(r.customerId)?.name ?? "-",
        kind: byId.get(r.customerId)?.kind ?? "other",
      }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    totals: a.totals,
  };
}

export type StatementView = ReturnType<typeof statementWithBalance> & {
  customer: CustomerView;
  from: string;
  to: string;
};

export async function loadStatement(
  admin: AdminClient,
  orgId: string,
  customerId: string,
  from: string,
  to: string,
): Promise<StatementView | null> {
  const customer = await loadCustomer(admin, orgId, customerId);
  if (!customer) return null;
  const { data, error } = await admin.rpc("acc_ar_statement", {
    p_org_id: orgId,
    p_customer_id: customerId,
    p_from: from,
    p_to: to,
  });
  if (error || !data) throw new Error("statement failed");
  const raw = data as unknown as {
    opening: number;
    entries: Array<Omit<StatementEntry, "debit" | "credit"> & { debit: number; credit: number }>;
  };
  const s = statementWithBalance(
    Number(raw.opening),
    raw.entries.map((e) => ({ ...e, debit: Number(e.debit), credit: Number(e.credit) })),
  );
  return { ...s, customer, from, to };
}

/** A customer's name, TRN and address lines as printed on documents. */
export function customerBlock(c: CustomerView): {
  name: string;
  trn: string | null;
  addressLines: string[];
} {
  return {
    name: c.name,
    trn: c.trn,
    addressLines: [
      c.address_line1,
      c.address_line2,
      [c.city, c.emirate].filter(Boolean).join(", "),
      c.country,
    ].filter((x): x is string => !!x && x.trim() !== ""),
  };
}

/** The seller's name, TRN and address lines (one per line of the settings text) as printed on documents. */
export function sellerBlock(s: { name: string; trn: string | null; address: string | null }) {
  return {
    name: s.name,
    trn: s.trn,
    addressLines: (s.address ?? "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 6),
  };
}
