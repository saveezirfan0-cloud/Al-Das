import Link from "next/link";
import { notFound } from "next/navigation";

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
import { requirePerm } from "@/lib/auth/session";
import { money } from "@/lib/finance/format";
import { createClient } from "@/lib/supabase/server";

import { ReviewButton } from "./review-button";

export const metadata = { title: "Remittance lines" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const FLAG_LABEL: Record<string, string> = {
  short_paid: "Short paid",
  overpaid: "Overpaid",
  denied: "Denied",
  unmatched: "No claim found",
  ambiguous: "Several claims fit",
  payer_mismatch: "Payer differs",
  invoice_mismatch: "Invoice differs",
  billed_below_contract: "Billed below contract",
  billed_above_contract: "Billed above contract",
  duplicate_in_file: "Repeated line",
  taken_back: "Taken back",
};

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ show?: string; page?: string }>;
}) {
  await requirePerm("finance.remittance.manage");
  const { batchId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) notFound();
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const { data: batch } = await supabase
    .from("ins_remittance_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) notFound();
  let query = supabase
    .from("ins_remittance_lines")
    .select(
      "id, row_no, claim_activity_number, invoice_no, cpt_code, paid_amount, denied_amount, denial_code, expected_amount, expected_basis, short_amount, match_status, flags, reviewed_at, claim_activity_id",
      { count: "exact" },
    )
    .eq("batch_id", batchId)
    .order("row_no")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (sp.show === "short") query = query.contains("flags", ["short_paid"]);
  else if (sp.show === "unmatched") query = query.neq("match_status", "matched");
  else if (sp.show !== "all")
    query = query.or("short_amount.gt.0,match_status.neq.matched,flags.cs.{overpaid}");
  const { data: lines, count } = await query;
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const tab = (key: string, label: string) => (
    <Button asChild variant={(sp.show ?? "attention") === key ? "secondary" : "outline"} size="sm">
      <Link href={`/finance/remittance/${batchId}?show=${key}`}>{label}</Link>
    </Button>
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Advice ${batch.remittance_ref ?? "(several references)"}`}
        description={`${batch.payer_id ?? "Several payers"}. ${batch.line_count} line(s), ${money(batch.sum_paid)} paid, ${money(batch.sum_short)} short.`}
      >
        <Link href="/finance/remittance" className="text-sm underline-offset-2 hover:underline">
          All advices
        </Link>
      </PageHeader>
      <div className="flex flex-wrap gap-2">
        {tab("attention", "Needs attention")}
        {tab("short", "Short paid")}
        {tab("unmatched", "No single claim")}
        {tab("all", "Every line")}
      </div>
      <Card>
        <CardContent className="pt-6">
          {(lines ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No lines match.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Claim / invoice</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Denied</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Short</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lines ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs">{l.row_no}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {l.claim_activity_id ? (
                        <Link
                          className="underline-offset-2 hover:underline"
                          href={`/finance/claims/${l.claim_activity_id}`}
                        >
                          {l.claim_activity_number ?? `${l.invoice_no} ${l.cpt_code}`}
                        </Link>
                      ) : (
                        (l.claim_activity_number ?? `${l.invoice_no ?? ""} ${l.cpt_code ?? ""}`)
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(l.paid_amount)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {l.denied_amount
                        ? `${money(l.denied_amount)}${l.denial_code ? ` ${l.denial_code}` : ""}`
                        : "—"}
                    </TableCell>
                    <TableCell
                      className="text-right text-xs tabular-nums"
                      title={l.expected_basis.replace("_", " ")}
                    >
                      {l.expected_amount === null ? "—" : money(l.expected_amount)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {Number(l.short_amount) ? money(l.short_amount) : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="flex flex-wrap gap-1">
                        {l.flags.map((f) => (
                          <Badge
                            key={f}
                            variant={
                              f === "short_paid" || f === "unmatched" ? "warning" : "secondary"
                            }
                          >
                            {FLAG_LABEL[f] ?? f}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {l.reviewed_at ? (
                        <span className="text-muted-foreground text-xs">Reviewed</span>
                      ) : l.flags.length > 0 ? (
                        <ReviewButton id={l.id} />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="text-muted-foreground flex items-center justify-between text-sm">
        <span>
          Page {page} of {pages}
        </span>
        <span className="flex gap-2">
          {page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link
                href={`/finance/remittance/${batchId}?show=${sp.show ?? "attention"}&page=${page - 1}`}
              >
                Previous
              </Link>
            </Button>
          )}
          {page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link
                href={`/finance/remittance/${batchId}?show=${sp.show ?? "attention"}&page=${page + 1}`}
              >
                Next
              </Link>
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}
