import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canAny, ForbiddenError, can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import {
  isVoucherTab,
  SPECIAL_LABEL,
  VOUCHER_READ_PERMS,
  VOUCHER_TABS,
  waitingFor,
  type VoucherStatus,
  type VoucherTab,
} from "@/lib/finance/vouchers";
import {
  countVouchersByStatus,
  loadPayablesSettings,
  loadTiers,
  loadVoucherDetail,
  loadVoucherList,
  loadVoucherScope,
  type VoucherDetail,
} from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminClient } from "@/lib/supabase/admin";

import {
  BulkCheck,
  NewVoucherButton,
  StatusBadge,
  VoucherDrawer,
  VoucherLink,
  type VoucherFormOptions,
  type VoucherPerms,
} from "./voucher-ui";

export const metadata = { title: "Payment vouchers" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function formOptions(
  admin: AdminClient,
  orgId: string,
  today: string,
  includeInvoiceIds: string[],
): Promise<VoucherFormOptions> {
  const [suppliers, invoices, linked, branches, banks, cats, tiers, settings] = await Promise.all([
    admin
      .from("fin_suppliers")
      .select("id, name, default_category")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("name"),
    admin
      .from("fin_supplier_invoices")
      .select(
        "id, supplier_id, invoice_number, invoice_date, total, paid_amount, category, branch_code, document_id",
      )
      .eq("org_id", orgId)
      .eq("status", "open")
      .order("invoice_date", { ascending: false })
      .limit(300),
    includeInvoiceIds.length
      ? admin
          .from("fin_supplier_invoices")
          .select(
            "id, supplier_id, invoice_number, invoice_date, total, paid_amount, category, branch_code, document_id",
          )
          .eq("org_id", orgId)
          .in("id", includeInvoiceIds)
      : Promise.resolve({ data: [] as never[] }),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", orgId).order("code"),
    admin.from("fin_ref_tally_ledgers").select("key").eq("org_id", orgId).eq("kind", "bank"),
    admin.from("fin_ref_tally_ledgers").select("key").eq("org_id", orgId).eq("kind", "category"),
    loadTiers(admin, orgId),
    loadPayablesSettings(admin, orgId),
  ]);
  const allInvoices = [...(linked.data ?? []), ...(invoices.data ?? [])].filter(
    (x, i, arr) => arr.findIndex((y) => y.id === x.id) === i,
  );
  const docIds = allInvoices.map((i) => i.document_id).filter((x): x is string => !!x);
  const { data: docs } = docIds.length
    ? await admin
        .from("fin_documents")
        .select("id, kind, sha256, size_bytes, scan_status")
        .in("id", docIds)
    : { data: [] };
  const docById = new Map((docs ?? []).map((d) => [d.id, d]));
  const categories = new Set<string>();
  for (const c of cats.data ?? []) categories.add(c.key);
  for (const s of suppliers.data ?? []) if (s.default_category) categories.add(s.default_category);
  for (const i of allInvoices) categories.add(i.category);
  return {
    suppliers: suppliers.data ?? [],
    invoices: allInvoices.map((i) => {
      const d = i.document_id ? docById.get(i.document_id) : undefined;
      return {
        id: i.id,
        supplier_id: i.supplier_id,
        invoice_number: i.invoice_number,
        invoice_date: i.invoice_date,
        // what is still owed (a part-paid invoice shows its balance; the voucher pays at most that)
        total: Math.round((Number(i.total) - Number(i.paid_amount)) * 100) / 100,
        category: i.category,
        branch_code: i.branch_code,
        document:
          d && d.sha256
            ? {
                id: d.id,
                kind: d.kind,
                sha256: d.sha256,
                size: Number(d.size_bytes),
                scan: d.scan_status,
              }
            : null,
      };
    }),
    branches: branches.data ?? [],
    banks: [...new Set([...(banks.data ?? []).map((b) => b.key), "cash"])].sort(),
    categories: [...categories].sort(),
    tiers,
    approvalMode: settings.approvalMode,
    today,
  };
}

function defaultTab(perms: VoucherPerms): VoucherTab {
  if (perms.check) return "check";
  if (perms.ceo || perms.dept) return "approve";
  if (perms.prepare) return "drafts";
  return "approved";
}

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; v?: string; new?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VOUCHER_READ_PERMS)) throw new ForbiddenError("finance.payables.view");
  const perms: VoucherPerms = {
    prepare: can(member, "finance.vouchers.prepare"),
    check: can(member, "finance.vouchers.check"),
    dept: can(member, "finance.vouchers.approve_dept"),
    ceo: can(member, "finance.vouchers.approve_ceo"),
    pay: can(member, "finance.vouchers.pay"),
  };
  const sp = await searchParams;
  const tab: VoucherTab = isVoucherTab(sp.tab) ? sp.tab : defaultTab(perms);
  const today = todayIn(member.org.timezone);

  const admin = createAdminClient(); // service role AFTER the permission check
  // only the vouchers this person may read (a department head: their Tier 2 queue and decisions; special categories
  // need the checker, CEO or compensation key), as row level security
  const scope = (await loadVoucherScope(admin, member)) ?? { special: false, ids: [] };
  const [rows, counts, detail] = await Promise.all([
    loadVoucherList(admin, member.orgId, VOUCHER_TABS[tab].statuses, scope),
    countVouchersByStatus(admin, member.orgId, scope),
    sp.v && UUID.test(sp.v)
      ? loadVoucherDetail(admin, member.orgId, sp.v, scope)
      : Promise.resolve(null),
  ]);
  const newFromInvoice = sp.new && UUID.test(sp.new) ? sp.new : null;
  const options = perms.prepare
    ? await formOptions(admin, member.orgId, today, [
        ...(detail?.invoices.map((i) => i.id) ?? []),
        ...(newFromInvoice ? [newFromInvoice] : []),
      ])
    : null;
  const prefillInvoice = newFromInvoice
    ? options?.invoices.find((i) => i.id === newFromInvoice)
    : undefined;
  const prefillSupplier = prefillInvoice
    ? options?.suppliers.find((s) => s.id === prefillInvoice.supplier_id)
    : undefined;

  const tabCount = (t: VoucherTab) =>
    (VOUCHER_TABS[t].statuses as readonly VoucherStatus[]).reduce(
      (a, s) => a + (counts[s] ?? 0),
      0,
    );
  const href = (t: VoucherTab, v?: string) => `/finance/vouchers?tab=${t}${v ? `&v=${v}` : ""}`;
  const bulkRows =
    tab === "check" && perms.check
      ? rows
          .filter(
            (r) =>
              r.status === "submitted" &&
              r.bulk_allowed &&
              r.special_category === "none" &&
              r.content_sha256,
          )
          .map((r) => ({
            id: r.id,
            voucher_no: r.voucher_no,
            payee_name: r.payee_name,
            amount: r.amount,
            hash: r.content_sha256!,
          }))
      : [];
  const settings = await loadPayablesSettings(admin, member.orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Payment vouchers"
        description="Maker prepares with the backup attached, the Finance Manager verifies, the department head or CEO approves as the delegation of authority requires. Every step is a different person and is recorded with its remarks."
      >
        {perms.prepare && options && (
          <NewVoucherButton
            options={options}
            prefill={
              prefillInvoice
                ? {
                    open: true,
                    supplier_id: prefillInvoice.supplier_id,
                    payee_name: prefillSupplier?.name ?? "",
                    amount: prefillInvoice.total.toFixed(2),
                    category: prefillInvoice.category,
                    branch_code: prefillInvoice.branch_code ?? "",
                    narration: `Supplier invoice ${prefillInvoice.invoice_number}`,
                    invoiceIds: [prefillInvoice.id],
                  }
                : undefined
            }
          />
        )}
        <Button asChild variant="outline">
          <Link href="/finance/vouchers/report">Report</Link>
        </Button>
      </PageHeader>

      {settings.approvalMode === "tally" && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Approval mode is Tally (OQ-90): submitted vouchers are exported for authorisation in Tally
          and are not verified or approved in Pulse.
        </p>
      )}

      <nav className="flex flex-wrap gap-1" aria-label="Voucher stages">
        {(Object.keys(VOUCHER_TABS) as VoucherTab[]).map((t) => (
          <Button
            key={t}
            asChild
            variant={t === tab ? "default" : "outline"}
            size="sm"
            className="min-h-11"
          >
            <Link href={href(t)}>
              {VOUCHER_TABS[t].label}
              {t !== "paid" && t !== "rejected" && tabCount(t) > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {tabCount(t)}
                </Badge>
              )}
            </Link>
          </Button>
        ))}
      </nav>

      {bulkRows.length > 1 && <BulkCheck rows={bulkRows} />}

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const next = waitingFor({
              status: r.status,
              needsDept: r.needs_dept,
              needsCeo: r.needs_ceo,
            });
            return (
              <li key={r.id}>
                <VoucherLink href={href(tab, r.id)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{r.voucher_no}</span>
                    <StatusBadge status={r.status} />
                    {r.tier_code && <Badge variant="outline">{r.tier_code}</Badge>}
                    {r.special_category !== "none" && (
                      <Badge variant="warning">{SPECIAL_LABEL[r.special_category]}</Badge>
                    )}
                    <span className="ml-auto font-medium tabular-nums">AED {money(r.amount)}</span>
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-sm">
                    <span className="text-foreground">{r.payee_name}</span>
                    <span>{r.category}</span>
                    <span>{r.voucher_date}</span>
                    {next.step === "approve_dept" && <span>Waiting for a department head</span>}
                    {next.step === "approve_ceo" && <span>Waiting for the CEO</span>}
                  </div>
                  {r.status === "rejected" && r.rejection_remarks && (
                    <p className="mt-1 line-clamp-2 text-sm text-red-700 dark:text-red-300">
                      {r.rejection_remarks}
                    </p>
                  )}
                </VoucherLink>
              </li>
            );
          })}
        </ul>
      )}

      {detail && (
        <VoucherDrawer
          detail={detail as VoucherDetail}
          perms={perms}
          userId={member.userId}
          options={options}
          closeHref={href(tab)}
        />
      )}
    </div>
  );
}
