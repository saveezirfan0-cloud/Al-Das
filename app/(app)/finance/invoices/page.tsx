import Link from "next/link";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  Filter,
  RotateCcw,
} from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import {
  PAGE_SIZE,
  activeFilterCount,
  claimProgress,
  filterProblem,
  pageQuery,
  parseInvoiceFilters,
  type InvoiceSearch,
} from "@/lib/finance/invoice-list";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { ClaimProgressBadge } from "./claim-progress-badge";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const money = (n: number | null) =>
  n === null
    ? "—"
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<InvoiceSearch>;
}) {
  await requirePerm("finance.invoices.view");
  const f = parseInvoiceFilters(await searchParams);
  const problem = filterProblem(f);
  const active = activeFilterCount(f);
  const supabase = await createClient();

  async function fetchRows() {
    let q = supabase
      .from("v_fin_invoice_list")
      .select(
        "id, inv_display_number, transaction_date, branch_code, doctor_name, doctor_dha_id, inv_type, is_deleted, net, total, version, claim_count, claimed, remitted, rejected, paid",
        { count: "exact" },
      )
      .order("transaction_date", { ascending: false, nullsFirst: false })
      .order("inv_display_number", { ascending: false })
      .range((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE - 1);
    if (f.q) q = q.ilike("inv_display_number", `%${f.q}%`);
    if (f.from) q = q.gte("transaction_date", f.from);
    if (f.to) q = q.lte("transaction_date", f.to);
    if (f.branch) q = q.eq("branch_code", f.branch.toUpperCase());
    if (f.doctor) q = q.or(`doctor_name.ilike.%${f.doctor}%,doctor_dha_id.eq.${f.doctor}`);
    if (f.type) q = q.ilike("inv_type", `%${f.type}%`);
    const { data, count } = await q;
    return { rows: data ?? [], total: count ?? 0 };
  }

  const { rows, total } = problem ? { rows: [], total: 0 } : await fetchRows();

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const shownFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const shownTo = Math.min(page * PAGE_SIZE, total);
  const link = (p: number) => `/finance/invoices${pageQuery(f, p)}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        description={`${total.toLocaleString()} ${total === 1 ? "invoice" : "invoices"}${active > 0 ? " match your filters" : " captured from Unite"}, with claim progress from Diligence.`}
      />

      {/* A plain GET form: the filters live in the URL, so a view can be bookmarked or shared. */}
      <form action="/finance/invoices" aria-label="Filter invoices">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-q">Invoice no.</Label>
                <Input id="inv-q" name="q" placeholder="e.g. 10452" defaultValue={f.q} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-from">From</Label>
                <Input
                  id="inv-from"
                  name="from"
                  type="date"
                  defaultValue={f.from}
                  max={f.to || undefined}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-to">To</Label>
                <Input
                  id="inv-to"
                  name="to"
                  type="date"
                  defaultValue={f.to}
                  min={f.from || undefined}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-branch">Branch</Label>
                <Input
                  id="inv-branch"
                  name="branch"
                  placeholder="Any branch"
                  defaultValue={f.branch}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-doctor">Doctor</Label>
                <Input
                  id="inv-doctor"
                  name="doctor"
                  placeholder="Name or DHA ID"
                  defaultValue={f.doctor}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-type">Type</Label>
                <Input
                  id="inv-type"
                  name="type"
                  placeholder="e.g. Insurance"
                  defaultValue={f.type}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm">
                <Filter />
                Apply filters
              </Button>
              {active > 0 && (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/finance/invoices">
                    <RotateCcw />
                    Reset
                  </Link>
                </Button>
              )}
              {active > 0 && (
                <span className="text-muted-foreground text-sm">
                  {active} {active === 1 ? "filter" : "filters"} applied
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </form>

      {problem && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden py-0">
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <FileSearch className="size-6" aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <p className="font-medium">No invoices found</p>
                <p className="text-muted-foreground mx-auto max-w-sm text-sm">
                  {active > 0
                    ? "Nothing matches these filters. Try widening the dates or clearing a field."
                    : "Invoices appear here once they are captured from Unite."}
                </p>
              </div>
              {active > 0 && (
                <Button asChild variant="outline" size="sm">
                  <Link href="/finance/invoices">Reset filters</Link>
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Doctor</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Claim</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Claimed</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => {
                  const hasClaim = Number(i.claim_count) > 0;
                  return (
                    <TableRow
                      key={i.id ?? i.inv_display_number}
                      className={cn(i.is_deleted && "opacity-60")}
                    >
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        <Link
                          href={`/finance/invoices/${i.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {i.inv_display_number}
                        </Link>{" "}
                        {i.is_deleted && <Badge variant="destructive">deleted</Badge>}
                        {(i.version ?? 1) > 1 && <Badge variant="outline">v{i.version}</Badge>}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {i.transaction_date ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {i.branch_code ?? <Badge variant="warning">unknown</Badge>}
                      </TableCell>
                      <TableCell className="text-xs">
                        {i.doctor_name ?? i.doctor_dha_id ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{i.inv_type ?? "—"}</TableCell>
                      <TableCell>
                        <ClaimProgressBadge progress={claimProgress(i)} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(i.net)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(i.paid)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {hasClaim ? money(i.claimed) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {hasClaim ? money(i.remitted) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          hasClaim && Number(i.rejected) > 0 && "text-destructive font-medium",
                        )}
                      >
                        {hasClaim ? money(i.rejected) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <nav
        className="text-muted-foreground flex items-center justify-between gap-3 text-sm"
        aria-label="Pagination"
      >
        <p>
          Page {page} of {pages}
          {total > 0 &&
            ` · ${shownFrom.toLocaleString()}–${shownTo.toLocaleString()} of ${total.toLocaleString()}`}
        </p>
        <div className="flex gap-2">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page - 1)}>
                <ChevronLeft />
                Previous
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              <ChevronLeft />
              Previous
            </Button>
          )}
          {page < pages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page + 1)}>
                Next
                <ChevronRight />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Next
              <ChevronRight />
            </Button>
          )}
        </div>
      </nav>
    </div>
  );
}
