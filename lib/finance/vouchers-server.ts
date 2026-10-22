import "server-only";

import { can, type MemberLike } from "@/lib/auth/can";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { CertificateEvent, VoucherCertificate } from "@/lib/finance/voucher-certificate";
import {
  canReadVoucher,
  DEFAULT_TALLY_APPROVAL_MAX,
  parseApprovalMode,
  voucherReadAccess,
  type ApprovalMode,
  type ApprovalTier,
  type PaymentMethod,
  type ReportSettings,
  type SpecialCategory,
  type VoucherReportRow,
  type VoucherStatus,
} from "@/lib/finance/vouchers";
import type { TallyLedgerRow, TallyPayment, TallyPurchase } from "@/lib/finance/tally-xml";

/** Server side of payables and vouchers: loaders for pages, routes and actions. Service role; callers have run can(). */

export type PayablesSettings = ReportSettings & {
  approvalMode: ApprovalMode;
  /** Split mode: routine vouchers up to this amount are approved in Tally. */
  tallyApprovalMax: number;
  tallyCompany: string | null;
  tallyCostCategory: string;
};

export async function loadPayablesSettings(
  admin: AdminClient,
  orgId: string,
): Promise<PayablesSettings> {
  const { data } = await admin
    .from("fin_ref_finance_settings")
    .select(
      "approval_mode, tally_approval_max, voucher_duplicate_window_days, voucher_mismatch_tolerance, voucher_large_amount, tally_company_name, tally_cost_category",
    )
    .eq("org_id", orgId)
    .maybeSingle();
  return {
    approvalMode: parseApprovalMode(data?.approval_mode),
    tallyApprovalMax: Number(data?.tally_approval_max ?? DEFAULT_TALLY_APPROVAL_MAX),
    duplicateWindowDays: data?.voucher_duplicate_window_days ?? 30,
    mismatchTolerance: Number(data?.voucher_mismatch_tolerance ?? 1),
    largeAmount: Number(data?.voucher_large_amount ?? 50000),
    tallyCompany: data?.tally_company_name ?? null,
    tallyCostCategory: data?.tally_cost_category ?? "Primary Cost Category",
  };
}

export async function loadTiers(admin: AdminClient, orgId: string): Promise<ApprovalTier[]> {
  const { data } = await admin
    .from("fin_ref_approval_tiers")
    .select(
      "code, label, special_category, min_amount, max_amount, needs_dept_head, needs_ceo, bulk_allowed, active, description, sort_order",
    )
    .eq("org_id", orgId)
    .order("sort_order");
  return (data ?? []).map((t) => ({
    code: t.code,
    label: t.label,
    specialCategory: (t.special_category as ApprovalTier["specialCategory"]) ?? null,
    minAmount: t.min_amount === null ? null : Number(t.min_amount),
    maxAmount: t.max_amount === null ? null : Number(t.max_amount),
    needsDeptHead: t.needs_dept_head,
    needsCeo: t.needs_ceo,
    bulkAllowed: t.bulk_allowed,
    active: t.active,
    description: t.description,
    sortOrder: t.sort_order,
  }));
}

/** Display names for profile ids ("A former member" when the profile is gone). */
export async function peopleNames(
  admin: AdminClient,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data } = await admin
    .from("profiles")
    .select("id, first_name, last_name")
    .in("id", unique);
  for (const p of data ?? [])
    out.set(p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "A member");
  return out;
}

export const nameOf = (names: Map<string, string>, id: string | null | undefined) =>
  id ? (names.get(id) ?? "A former member") : "-";

/**
 * Which vouchers a member may read (the server-side mirror of row level security, app.fin_can_read_voucher; the rule is
 * canReadVoucher in lib/finance/vouchers.ts). `special`: special-category vouchers too. `ids`: only these (a department
 * head: Tier 2 vouchers waiting for a department head or that they decided); null = no list restriction. Null result:
 * no voucher at all. Every voucher loader below takes the scope.
 */
export type VoucherScope = { special: boolean; ids: string[] | null };

export async function loadVoucherScope(
  admin: AdminClient,
  member: MemberLike,
): Promise<VoucherScope | null> {
  const access = voucherReadAccess((p) => can(member, p));
  if (access.full) return { special: access.special, ids: null };
  if (!access.dept) return null;
  const [candidates, decided] = await Promise.all([
    // Every candidate and decision is read in pages (PostgREST returns at most 1,000 per request), so a voucher the
    // department head may read is never left out of the scope.
    fetchAll((from, to) =>
      admin
        .from("fin_payment_vouchers")
        .select("id, special_category, route, needs_dept, status")
        .eq("org_id", member.orgId)
        .eq("special_category", "none")
        .eq("route", "pulse")
        .eq("needs_dept", true)
        .order("id")
        .range(from, to),
    ),
    fetchAll((from, to) =>
      admin
        .from("fin_voucher_events")
        .select("voucher_id")
        .eq("org_id", member.orgId)
        .eq("actor_id", member.userId)
        .in("action", ["dept_approved", "rejected"])
        .order("id")
        .range(from, to),
    ),
  ]);
  const mine = new Set((decided.data ?? []).map((e) => e.voucher_id));
  const ids = (candidates.data ?? [])
    .filter((v) =>
      canReadVoucher(
        access,
        {
          special: v.special_category as SpecialCategory,
          route: (v.route as "pulse" | "tally" | null) ?? null,
          needsDept: !!v.needs_dept,
          status: v.status as VoucherStatus,
          deciders: mine.has(v.id) ? [member.userId] : [],
        },
        member.userId,
      ),
    )
    .map((v) => v.id);
  return { special: false, ids };
}

/** Does the scope include this voucher? */
export function inVoucherScope(
  scope: VoucherScope,
  v: { id: string; special_category: string },
): boolean {
  if (!scope.special && v.special_category !== "none") return false;
  return scope.ids === null || scope.ids.includes(v.id);
}

export type VoucherListRow = {
  id: string;
  voucher_no: string;
  voucher_date: string;
  payee_name: string;
  amount: number;
  currency: string;
  category: string;
  special_category: SpecialCategory;
  status: VoucherStatus;
  tier_code: string | null;
  needs_dept: boolean;
  needs_ceo: boolean;
  bulk_allowed: boolean;
  route: "pulse" | "tally" | null;
  content_sha256: string | null;
  submitted_at: string | null;
  prepared_by: string | null;
  rejection_remarks: string | null;
  tally_exported_at: string | null;
};

const LIST_COLUMNS =
  "id, voucher_no, voucher_date, payee_name, amount, currency, category, special_category, status, tier_code, needs_dept, needs_ceo, bulk_allowed, route, content_sha256, submitted_at, prepared_by, rejection_remarks, tally_exported_at";

export async function loadVoucherList(
  admin: AdminClient,
  orgId: string,
  statuses: readonly VoucherStatus[],
  scope: VoucherScope,
  limit = 200,
): Promise<VoucherListRow[]> {
  let query = admin
    .from("fin_payment_vouchers")
    .select(LIST_COLUMNS)
    .eq("org_id", orgId)
    .in("status", statuses as VoucherStatus[]);
  if (!scope.special) query = query.eq("special_category", "none");
  if (scope.ids) query = query.in("id", scope.ids);
  const { data } = await query
    .order("voucher_date", { ascending: false })
    .order("voucher_no", { ascending: false })
    .limit(limit);
  return (data ?? []).map((v) => ({
    ...v,
    amount: Number(v.amount),
    special_category: v.special_category as SpecialCategory,
    status: v.status as VoucherStatus,
    needs_dept: !!v.needs_dept,
    needs_ceo: !!v.needs_ceo,
    bulk_allowed: !!v.bulk_allowed,
    route: (v.route as VoucherListRow["route"]) ?? null,
  }));
}

export async function countVouchersByStatus(
  admin: AdminClient,
  orgId: string,
  scope: VoucherScope,
): Promise<Partial<Record<VoucherStatus, number>>> {
  const out: Partial<Record<VoucherStatus, number>> = {};
  const statuses: VoucherStatus[] = [
    "draft",
    "submitted",
    "checked",
    "dept_approved",
    "approved",
    "for_tally",
  ];
  await Promise.all(
    statuses.map(async (s) => {
      let query = admin
        .from("fin_payment_vouchers")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", s);
      if (!scope.special) query = query.eq("special_category", "none");
      if (scope.ids) query = query.in("id", scope.ids);
      const { count } = await query;
      out[s] = count ?? 0;
    }),
  );
  return out;
}

export type VoucherDocument = {
  id: string;
  kind: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  scan_status: string;
  via: "voucher" | "invoice";
};

export type VoucherDetail = {
  voucher: {
    id: string;
    voucher_no: string;
    voucher_date: string;
    payee_name: string;
    supplier_id: string | null;
    supplier_name: string | null;
    amount: number;
    currency: string;
    category: string;
    special_category: SpecialCategory;
    branch_code: string | null;
    cost_centre: string | null;
    pay_from: string | null;
    payment_method: PaymentMethod;
    narration: string;
    status: VoucherStatus;
    route: "pulse" | "tally" | null;
    tier_code: string | null;
    needs_dept: boolean;
    needs_ceo: boolean;
    bulk_allowed: boolean;
    content_sha256: string | null;
    checked_by: string | null;
    dept_approved_by: string | null;
    ceo_approved_by: string | null;
    /** Step times (22C: a personal signature belongs to the step stored in the same transaction). */
    checked_at: string | null;
    dept_approved_at: string | null;
    ceo_approved_at: string | null;
    rejection_remarks: string | null;
    payment_date: string | null;
    payment_reference: string | null;
    tally_exported_at: string | null;
  };
  currentHash: string;
  makers: string[];
  invoices: Array<{
    id: string;
    invoice_number: string;
    invoice_date: string;
    total: number;
    supplier_id: string;
  }>;
  documents: VoucherDocument[];
  events: Array<{
    id: number;
    at: string;
    action: string;
    actor_id: string | null;
    actor: string;
    from_status: string | null;
    to_status: string | null;
    remarks: string | null;
    content_sha256: string | null;
  }>;
  locked: boolean;
};

const MAKER_ACTIONS = new Set([
  "created",
  "edited",
  "returned_to_draft",
  "submitted",
  "sent_to_tally",
  "reopened",
]);

export async function loadVoucherDetail(
  admin: AdminClient,
  orgId: string,
  id: string,
  scope: VoucherScope,
): Promise<VoucherDetail | null> {
  const { data: v } = await admin
    .from("fin_payment_vouchers")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!v || !inVoucherScope(scope, v)) return null;
  const [links, docLinks, events, hash, supplier, locked] = await Promise.all([
    admin
      .from("fin_voucher_invoices")
      .select(
        "supplier_invoice_id, fin_supplier_invoices(id, invoice_number, invoice_date, total, supplier_id, document_id)",
      )
      .eq("voucher_id", id),
    admin
      .from("fin_voucher_documents")
      .select("document_id, fin_documents(id, kind, sha256, size_bytes, mime_type, scan_status)")
      .eq("voucher_id", id),
    admin
      .from("fin_voucher_events")
      .select("id, at, action, actor_id, from_status, to_status, remarks, content_sha256")
      .eq("voucher_id", id)
      .order("id"),
    admin.rpc("fin_voucher_compute_hash", { p_voucher_id: id }),
    v.supplier_id
      ? admin.from("fin_suppliers").select("name").eq("id", v.supplier_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("fin_period_closes")
      .select("locked_at")
      .eq("org_id", orgId)
      .eq("month", `${v.voucher_date.slice(0, 7)}-01`)
      .maybeSingle(),
  ]);
  type InvoiceJoin = {
    id: string;
    invoice_number: string;
    invoice_date: string;
    total: number;
    supplier_id: string;
    document_id: string | null;
  };
  const invoices = (links.data ?? [])
    .map((l) => l.fin_supplier_invoices as unknown as InvoiceJoin | null)
    .filter((x): x is InvoiceJoin => !!x);
  const invoiceDocIds = invoices.map((i) => i.document_id).filter((x): x is string => !!x);
  const { data: invoiceDocs } = invoiceDocIds.length
    ? await admin
        .from("fin_documents")
        .select("id, kind, sha256, size_bytes, mime_type, scan_status")
        .in("id", invoiceDocIds)
    : { data: [] };
  type DocJoin = Omit<VoucherDocument, "via"> & { sha256: string | null };
  const documents: VoucherDocument[] = [];
  for (const d of (docLinks.data ?? []).map((l) => l.fin_documents as unknown as DocJoin | null))
    if (d?.sha256) documents.push({ ...d, sha256: d.sha256, via: "voucher" });
  for (const d of (invoiceDocs ?? []) as DocJoin[])
    if (d.sha256 && !documents.some((x) => x.id === d.id))
      documents.push({ ...d, sha256: d.sha256, via: "invoice" });

  const evs = events.data ?? [];
  const names = await peopleNames(
    admin,
    evs.map((e) => e.actor_id),
  );
  const makers = [
    ...new Set(
      [
        v.prepared_by,
        v.submitted_by,
        ...evs.filter((e) => MAKER_ACTIONS.has(e.action)).map((e) => e.actor_id),
      ].filter((x): x is string => !!x),
    ),
  ];
  return {
    voucher: {
      id: v.id,
      voucher_no: v.voucher_no,
      voucher_date: v.voucher_date,
      payee_name: v.payee_name,
      supplier_id: v.supplier_id,
      supplier_name: (supplier.data as { name: string } | null)?.name ?? null,
      amount: Number(v.amount),
      currency: v.currency,
      category: v.category,
      special_category: v.special_category as SpecialCategory,
      branch_code: v.branch_code,
      cost_centre: v.cost_centre,
      pay_from: v.pay_from,
      payment_method: v.payment_method as PaymentMethod,
      narration: v.narration,
      status: v.status as VoucherStatus,
      route: (v.route as VoucherDetail["voucher"]["route"]) ?? null,
      tier_code: v.tier_code,
      needs_dept: !!v.needs_dept,
      needs_ceo: !!v.needs_ceo,
      bulk_allowed: !!v.bulk_allowed,
      content_sha256: v.content_sha256,
      checked_by: v.checked_by,
      dept_approved_by: v.dept_approved_by,
      ceo_approved_by: v.ceo_approved_by,
      checked_at: v.checked_at,
      dept_approved_at: v.dept_approved_at,
      ceo_approved_at: v.ceo_approved_at,
      rejection_remarks: v.rejection_remarks,
      payment_date: v.payment_date,
      payment_reference: v.payment_reference,
      tally_exported_at: v.tally_exported_at,
    },
    currentHash: (hash.data as string | null) ?? "",
    makers,
    invoices: invoices.map((i) => ({
      id: i.id,
      invoice_number: i.invoice_number,
      invoice_date: i.invoice_date,
      total: Number(i.total),
      supplier_id: i.supplier_id,
    })),
    documents,
    events: evs.map((e) => ({ ...e, actor: nameOf(names, e.actor_id) })),
    locked: !!(locked.data as { locked_at: string | null } | null)?.locked_at,
  };
}

export function certificateFrom(
  d: VoucherDetail,
  org: { name: string; timezone: string | null },
): VoucherCertificate {
  const v = d.voucher;
  const events: CertificateEvent[] = d.events.map((e) => ({
    at: e.at,
    action: e.action,
    actor: e.actor,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    remarks: e.remarks,
    hash: e.content_sha256,
  }));
  return {
    org: org.name,
    voucherNo: v.voucher_no,
    voucherDate: v.voucher_date,
    payeeName: v.payee_name,
    supplierName: v.supplier_name,
    amount: v.amount,
    currency: v.currency,
    category: v.category,
    special: v.special_category,
    branchCode: v.branch_code,
    costCentre: v.cost_centre,
    payFrom: v.pay_from,
    paymentMethod: v.payment_method,
    narration: v.narration,
    status: v.status,
    route: v.route,
    tier: v.tier_code,
    needsDept: v.needs_dept,
    needsCeo: v.needs_ceo,
    contentHash: v.content_sha256,
    currentHash: d.currentHash,
    invoices: d.invoices.map((i) => ({
      number: i.invoice_number,
      date: i.invoice_date,
      total: i.total,
    })),
    documents: [...d.documents]
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))
      .map((x) => ({ kind: x.kind, sha256: x.sha256, sizeBytes: Number(x.size_bytes) })),
    events,
    payment:
      v.payment_date && v.payment_reference
        ? { date: v.payment_date, reference: v.payment_reference }
        : null,
    timezone: org.timezone || "UTC",
  };
}

/** Rows for the status and exception report: vouchers dated in [from, to]. */
export async function loadReportRows(
  admin: AdminClient,
  orgId: string,
  from: string,
  to: string,
  scope: VoucherScope,
): Promise<VoucherReportRow[]> {
  // The report totals every voucher in the range, so rows are read in pages (PostgREST returns at most 1,000 per request).
  const { data } = await fetchAll((lo, hi) => {
    let query = admin
      .from("fin_payment_vouchers")
      .select(
        "id, voucher_no, voucher_date, payee_name, supplier_id, amount, status, special_category, tier_code, submitted_at, approved_at, rejected_at, rejection_remarks",
      )
      .eq("org_id", orgId)
      .gte("voucher_date", from)
      .lte("voucher_date", to);
    if (!scope.special) query = query.eq("special_category", "none");
    if (scope.ids) query = query.in("id", scope.ids);
    return query.order("voucher_date").order("id").range(lo, hi);
  });
  const rows = data ?? [];
  const totals = new Map<string, number>();
  const ids = rows.map((r) => r.id);
  const paidVoucher = new Set(rows.filter((r) => r.status === "paid").map((r) => r.id));
  for (let i = 0; i < ids.length; i += 200) {
    const { data: links } = await admin
      .from("fin_voucher_invoices")
      .select("voucher_id, paid_amount, fin_supplier_invoices(total, paid_amount)")
      .in("voucher_id", ids.slice(i, i + 200));
    for (const l of links ?? []) {
      const inv = l.fin_supplier_invoices as unknown as {
        total: number;
        paid_amount: number;
      } | null;
      // part payments: a paid voucher is compared with what it paid, any other with the balance still owed
      const t =
        paidVoucher.has(l.voucher_id) && l.paid_amount !== null
          ? Number(l.paid_amount)
          : Number(inv?.total ?? 0) - Number(inv?.paid_amount ?? 0);
      totals.set(l.voucher_id, Math.round(((totals.get(l.voucher_id) ?? 0) + t) * 100) / 100);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    voucherNo: r.voucher_no,
    voucherDate: r.voucher_date,
    payeeName: r.payee_name,
    supplierId: r.supplier_id,
    amount: Number(r.amount),
    status: r.status as VoucherStatus,
    special: r.special_category as SpecialCategory,
    tier: r.tier_code,
    submittedAt: r.submitted_at,
    approvedAt: r.approved_at,
    rejectedAt: r.rejected_at,
    rejectionRemarks: r.rejection_remarks,
    invoicesTotal: totals.has(r.id) ? totals.get(r.id)! : null,
  }));
}

/** What the next Tally export would contain: approved / paid / for-Tally vouchers and live supplier invoices not yet exported. */
export async function loadTallyCandidates(
  admin: AdminClient,
  orgId: string,
): Promise<{
  payments: TallyPayment[];
  purchases: TallyPurchase[];
  ledgers: TallyLedgerRow[];
  supplierNames: Map<string, string>;
}> {
  const [vouchers, invoices, ledgers, suppliers] = await Promise.all([
    admin
      .from("fin_payment_vouchers")
      .select(
        "id, voucher_no, voucher_date, payment_date, payee_name, supplier_id, category, amount, branch_code, pay_from, payment_method, narration, payment_reference, route",
      )
      .eq("org_id", orgId)
      .in("status", ["approved", "paid", "for_tally"])
      .is("tally_export_id", null)
      .limit(1000),
    admin
      .from("fin_supplier_invoices")
      .select("id, supplier_id, invoice_number, invoice_date, category, net, vat, branch_code")
      .eq("org_id", orgId)
      .neq("status", "void")
      .is("tally_export_id", null)
      .limit(1000),
    admin.from("fin_ref_tally_ledgers").select("kind, key, ledger_name").eq("org_id", orgId),
    admin.from("fin_suppliers").select("id, name").eq("org_id", orgId),
  ]);
  const supplierNames = new Map((suppliers.data ?? []).map((s) => [s.id, s.name]));
  const vIds = (vouchers.data ?? []).map((v) => v.id);
  const numbers = new Map<string, string[]>();
  if (vIds.length) {
    const { data: links } = await admin
      .from("fin_voucher_invoices")
      .select("voucher_id, fin_supplier_invoices(invoice_number)")
      .in("voucher_id", vIds);
    for (const l of links ?? []) {
      const n = (l.fin_supplier_invoices as unknown as { invoice_number: string } | null)
        ?.invoice_number;
      if (n) numbers.set(l.voucher_id, [...(numbers.get(l.voucher_id) ?? []), n]);
    }
  }
  return {
    payments: (vouchers.data ?? []).map((v) => ({
      id: v.id,
      voucherNo: v.voucher_no,
      date: v.payment_date ?? v.voucher_date,
      payeeName: v.payee_name,
      supplierId: v.supplier_id,
      category: v.category,
      amount: Number(v.amount),
      branchCode: v.branch_code,
      payFrom: v.pay_from,
      paymentMethod: v.payment_method,
      narration: v.narration,
      paymentReference: v.payment_reference,
      invoiceNumbers: numbers.get(v.id) ?? [],
      approvedInPulse: v.route === "pulse",
    })),
    purchases: (invoices.data ?? []).map((i) => ({
      id: i.id,
      supplierId: i.supplier_id,
      supplierName: supplierNames.get(i.supplier_id) ?? "Supplier",
      invoiceNumber: i.invoice_number,
      invoiceDate: i.invoice_date,
      category: i.category,
      net: Number(i.net),
      vat: Number(i.vat),
      branchCode: i.branch_code,
    })),
    ledgers: (ledgers.data ?? []).map((l) => ({
      kind: l.kind as TallyLedgerRow["kind"],
      key: l.key,
      ledger_name: l.ledger_name,
    })),
    supplierNames,
  };
}
