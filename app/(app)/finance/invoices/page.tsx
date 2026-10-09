import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
type Search = {
  q?: string;
  from?: string;
  to?: string;
  branch?: string;
  doctor?: string;
  type?: string;
  page?: string;
};

// PostgREST filter values must not carry grammar characters.
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 80);
const day = (v: string | undefined) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? "") ? (v as string) : "");
const money = (n: number | null) =>
  n === null
    ? "—"
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePerm("finance.invoices.view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();

  let q = supabase
    .from("v_fin_invoice_list")
    .select(
      "id, inv_display_number, transaction_date, branch_code, doctor_name, doctor_dha_id, inv_type, is_deleted, net, total, version, claim_count, claimed, remitted, rejected, paid",
      { count: "exact" },
    )
    .order("transaction_date", { ascending: false, nullsFirst: false })
    .order("inv_display_number", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (safe(sp.q)) q = q.ilike("inv_display_number", `%${safe(sp.q)}%`);
  if (day(sp.from)) q = q.gte("transaction_date", day(sp.from));
  if (day(sp.to)) q = q.lte("transaction_date", day(sp.to));
  if (safe(sp.branch)) q = q.eq("branch_code", safe(sp.branch).toUpperCase());
  if (safe(sp.doctor))
    q = q.or(`doctor_name.ilike.%${safe(sp.doctor)}%,doctor_dha_id.eq.${safe(sp.doctor)}`);
  if (safe(sp.type)) q = q.ilike("inv_type", `%${safe(sp.type)}%`);

  const { data, count } = await q;
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const params = new URLSearchParams(
      Object.entries({ ...sp, page: String(p) }).filter(([, v]) => v) as [string, string][],
    );
    return `/finance/invoices?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        description={`${total.toLocaleString()} invoices captured from Unite, with claim progress from Diligence.`}
      />
      <form className="grid gap-2 sm:grid-cols-7">
        <Input name="q" placeholder="Invoice no." defaultValue={sp.q} className="sm:col-span-2" />
        <Input name="from" type="date" defaultValue={sp.from} aria-label="From date" />
        <Input name="to" type="date" defaultValue={sp.to} aria-label="To date" />
        <Input name="branch" placeholder="Branch" defaultValue={sp.branch} />
        <Input name="doctor" placeholder="Doctor" defaultValue={sp.doctor} />
        <Input name="type" placeholder="Type (insurance…)" defaultValue={sp.type} />
        <Button type="submit" variant="secondary" className="sm:col-span-7 sm:w-32">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent className="pt-6">
          {(data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No invoices found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Doctor</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Claimed</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((i) => (
                  <TableRow key={i.id ?? i.inv_display_number}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        href={`/finance/invoices/${i.id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {i.inv_display_number}
                      </Link>{" "}
                      {i.is_deleted && <Badge variant="destructive">deleted</Badge>}
                      {(i.version ?? 1) > 1 && <Badge variant="outline">v{i.version}</Badge>}
                    </TableCell>
                    <TableCell className="text-xs">{i.transaction_date ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {i.branch_code ?? <Badge variant="warning">unknown</Badge>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {i.doctor_name ?? i.doctor_dha_id ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{i.inv_type ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(i.net)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(i.paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(i.claim_count) > 0 ? money(i.claimed) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(i.claim_count) > 0 ? money(i.remitted) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(i.claim_count) > 0 ? money(i.rejected) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page - 1)}>Previous</Link>
            </Button>
          )}
          {page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page + 1)}>Next</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
