import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
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
import { selectClass } from "@/components/finance/forms";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import {
  loadArSettings,
  loadCustomers,
  loadSalesList,
  SALES_LIST_LIMIT,
} from "@/lib/accounting/receivables-server";
import {
  SALES_STATUS_LABELS,
  SALES_STATUSES,
  type SalesDocKind,
  type SalesStatus,
} from "@/lib/accounting/sales";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { dateParam, RangeForm } from "../ui";
import { RetryPostings } from "./controls";

export type SalesSearch = { status?: string; customer?: string; from?: string; to?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sales invoices or credit notes (one list, two pages). Server component; reads after can(). */
export async function SalesList({ kind, sp }: { kind: SalesDocKind; sp: SalesSearch }) {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.sales.manage");
  const status =
    sp.status === "approval" || (SALES_STATUSES as readonly string[]).includes(sp.status ?? "")
      ? (sp.status as SalesStatus | "approval")
      : null;
  const customerId = UUID.test(sp.customer ?? "") ? sp.customer! : null;
  const from = sp.from ? dateParam(sp.from, "") || null : null;
  const to = sp.to ? dateParam(sp.to, "") || null : null;

  const admin = createAdminClient(); // service role AFTER the permission check
  const settings = await loadArSettings(admin, member.orgId);
  const [rows, customers] = await Promise.all([
    loadSalesList(
      admin,
      member.orgId,
      { kind, status, customerId, from, to },
      settings.issue_approval_threshold,
    ),
    loadCustomers(admin, member.orgId),
  ]);
  await recordAccess(admin, member, { entity: "accounting_receivable", action: "list" });
  const credit = kind === "credit_note";
  const manage = can(member, "accounting.sales.manage");
  const waiting = rows.some((r) => r.posting_status === "waiting_ledger_start");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={credit ? "Credit notes" : "Sales invoices"}
        description={
          credit
            ? "Tax credit notes against Pulse's own invoices. Open an invoice and press Credit note to raise one."
            : "Tax invoices Pulse issues to insurers, corporates, tenants and other businesses. Patient invoices come from Unite."
        }
      >
        {!credit && manage && (
          <Button asChild>
            <Link href="/accounting/sales-invoices/new">New invoice</Link>
          </Button>
        )}
      </PageHeader>
      <RangeForm from={from ?? ""} to={to ?? ""}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Status</span>
          <select name="status" defaultValue={status ?? ""} className={`${selectClass} w-48`}>
            <option value="">Any status</option>
            {!credit && <option value="approval">Waiting for approval</option>}
            {SALES_STATUSES.filter((s) => !credit || s === "draft" || s === "issued").map((s) => (
              <option key={s} value={s}>
                {SALES_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Customer</span>
          <select name="customer" defaultValue={customerId ?? ""} className={`${selectClass} w-56`}>
            <option value="">Any customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </RangeForm>
      {waiting && (manage || can(member, "accounting.receipts.manage")) && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
          <span>
            Some documents are dated before the ledger start: they are issued and kept in Tally, and post here once
            the start date allows it.
          </span>
          <RetryPostings />
        </div>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                {!credit && <TableHead>Due</TableHead>}
                <TableHead className="text-right">Total</TableHead>
                {!credit && <TableHead className="text-right">Open</TableHead>}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <EmptyState title="Nothing matches" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{r.invoice_date}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      <Link className="underline" href={`/accounting/sales-invoices/${r.id}`}>
                        {r.number ?? "Draft"}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-64 truncate">{r.customer}</TableCell>
                    {!credit && <TableCell className="whitespace-nowrap">{r.due_date ?? ""}</TableCell>}
                    <TableCell className="text-right tabular-nums">{money(r.total)}</TableCell>
                    {!credit && (
                      <TableCell className="text-right tabular-nums">
                        {r.status === "draft" || r.status === "void"
                          ? ""
                          : money(r.total - r.amount_credited - r.amount_paid)}
                      </TableCell>
                    )}
                    <TableCell>
                      <SalesStatusBadge
                        status={r.status}
                        needsApproval={r.status === "draft" && r.total > settings.issue_approval_threshold}
                      />
                      {r.posting_status === "waiting_ledger_start" && (
                        <span className="text-muted-foreground ml-2 text-xs">in Tally</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {rows.length === SALES_LIST_LIMIT && (
            <p className="text-muted-foreground mt-2 text-xs">
              Showing the latest {SALES_LIST_LIMIT}. Narrow the dates to see more.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SalesStatusBadge({
  status,
  needsApproval,
}: {
  status: SalesStatus;
  needsApproval?: boolean;
}) {
  if (status === "draft" && needsApproval) return <Badge variant="warning">Needs approval</Badge>;
  const variant =
    status === "paid"
      ? "success"
      : status === "void"
        ? "secondary"
        : status === "draft"
          ? "outline"
          : "default";
  return <Badge variant={variant}>{SALES_STATUS_LABELS[status]}</Badge>;
}
