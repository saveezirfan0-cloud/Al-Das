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

export const metadata = { title: "Claims" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MATCH_VARIANT = {
  matched: "success",
  ambiguous: "warning",
  unmatched: "destructive",
} as const;

type Search = {
  q?: string;
  status?: string;
  payer?: string;
  denial?: string;
  match?: string;
  page?: string;
};

// PostgREST filter values must not carry grammar characters.
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 80);

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePerm("finance.claims.view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient(); // the member's own client: RLS decides what they see

  let query = supabase
    .from("ins_claim_activities")
    .select(
      "id, claim_activity_number, invoice_no, transaction_date, cpt_code, payer_id, net, remitted, rejected, claim_status, denial_type, match_status, match_reason",
      { count: "exact" },
    )
    .order("transaction_date", { ascending: false, nullsFirst: false })
    .order("claim_activity_number")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const q = safe(sp.q);
  if (q) query = query.or(`claim_activity_number.ilike.%${q}%,invoice_no.ilike.%${q}%`);
  if (safe(sp.status)) query = query.eq("claim_status", safe(sp.status));
  if (safe(sp.payer)) query = query.eq("payer_id", safe(sp.payer));
  if (safe(sp.denial)) query = query.eq("denial_type", safe(sp.denial));
  if (["matched", "ambiguous", "unmatched"].includes(sp.match ?? ""))
    query = query.eq("match_status", sp.match as string);

  const { data, count } = await query;
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const params = new URLSearchParams(
      Object.entries({ ...sp, page: String(p) }).filter(([, v]) => v) as [string, string][],
    );
    return `/finance/claims?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Claims"
        description={`${total.toLocaleString()} claim activities from Diligence, matched to Unite invoices.`}
      />
      <form className="grid gap-2 sm:grid-cols-6">
        <Input
          name="q"
          placeholder="Claim or invoice no."
          defaultValue={sp.q}
          className="sm:col-span-2"
        />
        <Input name="status" placeholder="Claim status" defaultValue={sp.status} />
        <Input name="payer" placeholder="Payer ID" defaultValue={sp.payer} />
        <Input name="denial" placeholder="Denial type" defaultValue={sp.denial} />
        <select
          name="match"
          defaultValue={sp.match ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Any match</option>
          <option value="matched">Matched</option>
          <option value="ambiguous">Ambiguous</option>
          <option value="unmatched">Unmatched</option>
        </select>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent className="pt-6">
          {(data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No claims found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim activity</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Match</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        href={`/finance/claims/${c.id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {c.claim_activity_number}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.invoice_no}</TableCell>
                    <TableCell className="text-xs">{c.transaction_date ?? "—"}</TableCell>
                    <TableCell className="text-xs">{c.cpt_code}</TableCell>
                    <TableCell className="text-xs">{c.payer_id ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.net?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.remitted?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.rejected?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{c.claim_status ?? "—"}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          MATCH_VARIANT[c.match_status as keyof typeof MATCH_VARIANT] ?? "secondary"
                        }
                        title={c.match_reason ?? undefined}
                      >
                        {c.match_reason && c.match_reason !== "ok"
                          ? c.match_reason.replaceAll("_", " ")
                          : c.match_status}
                      </Badge>
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
