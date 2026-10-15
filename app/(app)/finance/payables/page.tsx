import Link from "next/link";

import { OpenDocumentButton } from "@/components/finance/finance-upload";
import { CappedNote, EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { InvoiceButton, VoidInvoiceButton, type InvoiceOptions, type InvoiceView } from "./forms";

export const metadata = { title: "Supplier invoices" };
export const dynamic = "force-dynamic";

const STATUS = {
  open: { label: "Unpaid", variant: "warning" },
  on_voucher: { label: "On a voucher", variant: "secondary" },
  paid: { label: "Paid", variant: "success" },
  void: { label: "Void", variant: "outline" },
} as const;
type Status = keyof typeof STATUS;
const FILTERS = ["unpaid", "paid", "all"] as const;

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, ["finance.payables.view", "finance.payables.manage"]))
    throw new ForbiddenError("finance.payables.view");
  const manage = can(member, "finance.payables.manage");
  const prepare = can(member, "finance.vouchers.prepare");
  const sp = await searchParams;
  const show = (FILTERS as readonly string[]).includes(sp.show ?? "")
    ? (sp.show as (typeof FILTERS)[number])
    : "unpaid";
  const statuses: Status[] =
    show === "unpaid"
      ? ["open", "on_voucher"]
      : show === "paid"
        ? ["paid"]
        : ["open", "on_voucher", "paid", "void"];

  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: invoices }, { data: suppliers }, { data: branches }] = await Promise.all([
    admin
      .from("fin_supplier_invoices")
      .select(
        "id, supplier_id, invoice_number, invoice_date, due_date, category, net, vat, total, paid_amount, branch_code, cost_centre, doctor_dha_id, document_id, status, tally_exported_at",
      )
      .eq("org_id", member.orgId)
      .in("status", statuses)
      .order("invoice_date", { ascending: false })
      .limit(300),
    admin
      .from("fin_suppliers")
      .select("id, name, default_category, active")
      .eq("org_id", member.orgId)
      .order("name"),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", member.orgId).order("code"),
  ]);
  const docIds = (invoices ?? []).map((i) => i.document_id).filter((x): x is string => !!x);
  const { data: docs } = docIds.length
    ? await admin
        .from("fin_documents")
        .select("id, kind, sha256, size_bytes, scan_status")
        .in("id", docIds)
    : { data: [] };
  const docById = new Map((docs ?? []).map((d) => [d.id, d]));
  const supplierName = new Map((suppliers ?? []).map((s) => [s.id, s.name]));
  const today = todayIn(member.org.timezone);
  const options: InvoiceOptions = {
    suppliers: (suppliers ?? []).filter((s) => s.active),
    branches: branches ?? [],
    categories: [
      ...new Set(
        [
          ...(suppliers ?? []).map((s) => s.default_category),
          ...(invoices ?? []).map((i) => i.category),
        ].filter((x): x is string => !!x),
      ),
    ].sort(),
    today,
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Supplier invoices"
        description="Every supplier invoice with its document stored digitally (from the accounts mailbox or a photo of the paper copy). Pay one with a voucher; approved invoices go to Tally as purchases."
      >
        {manage && options.suppliers.length > 0 && <InvoiceButton options={options} />}
        <Button asChild variant="outline">
          <Link href="/finance/suppliers">Suppliers</Link>
        </Button>
      </PageHeader>
      {manage && options.suppliers.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Add a supplier first (
          <Link className="underline" href="/finance/suppliers">
            Suppliers
          </Link>
          ).
        </p>
      )}
      <nav className="flex gap-1">
        {FILTERS.map((f) => (
          <Button key={f} asChild size="sm" variant={f === show ? "default" : "outline"}>
            <Link href={`/finance/payables?show=${f}`}>
              {f === "unpaid" ? "Unpaid" : f === "paid" ? "Paid" : "All"}
            </Link>
          </Button>
        ))}
      </nav>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Document</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(invoices ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <EmptyState
                      title="No supplier invoices here"
                      description="Change the filter, or add a supplier invoice."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                (invoices ?? []).map((i) => {
                  const d = i.document_id ? docById.get(i.document_id) : undefined;
                  const view: InvoiceView = {
                    id: i.id,
                    supplier_id: i.supplier_id,
                    invoice_number: i.invoice_number,
                    invoice_date: i.invoice_date,
                    due_date: i.due_date,
                    category: i.category,
                    net: Number(i.net),
                    vat: Number(i.vat),
                    branch_code: i.branch_code,
                    cost_centre: i.cost_centre,
                    doctor_dha_id: i.doctor_dha_id,
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
                  const status = i.status as Status;
                  const overdue = status === "open" && i.due_date && i.due_date < today;
                  // part payments: an invoice is open again with its balance until it is settled
                  const paidSoFar = Number(i.paid_amount);
                  const partPaid = status !== "paid" && paidSoFar > 0;
                  return (
                    <TableRow key={i.id}>
                      <TableCell>{supplierName.get(i.supplier_id) ?? "-"}</TableCell>
                      <TableCell className="font-mono text-xs">{i.invoice_number}</TableCell>
                      <TableCell className="text-xs">
                        {i.invoice_date}
                        {overdue && (
                          <Badge variant="destructive" className="ml-1">
                            overdue
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{i.category}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(i.total)}
                        {partPaid && (
                          <div className="text-muted-foreground text-xs">
                            balance {money(Number(i.total) - paidSoFar)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS[status].variant}>
                          {partPaid && status === "open" ? "Part paid" : STATUS[status].label}
                        </Badge>
                        {i.tally_exported_at && (
                          <Badge variant="outline" className="ml-1">
                            in Tally
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {view.document ? (
                          <OpenDocumentButton id={view.document.id} />
                        ) : (
                          <span className="text-xs text-amber-700 dark:text-amber-300">
                            missing
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {prepare && status === "open" && (
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/finance/vouchers?tab=drafts&new=${i.id}`}>
                              Pay with a voucher
                            </Link>
                          </Button>
                        )}
                        {manage && status === "open" && !partPaid && !i.tally_exported_at && (
                          <>
                            <InvoiceButton invoice={view} options={options} />
                            <VoidInvoiceButton id={i.id} />
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {(invoices ?? []).length >= 300 && <CappedNote shown={300} />}
        </CardContent>
      </Card>
    </div>
  );
}
