import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

import { RemittanceUpload } from "./upload-flow";

export const metadata = { title: "Remittance" };
export const dynamic = "force-dynamic";

export default async function RemittancePage() {
  await requirePerm("finance.remittance.manage");
  const supabase = await createClient();
  const [{ data: batches }, { count: prices }, { count: unreviewed }] = await Promise.all([
    supabase
      .from("ins_remittance_batches")
      .select(
        "id, remittance_ref, payer_id, paid_on, line_count, matched_count, unmatched_count, short_count, sum_paid, sum_short, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(30),
    supabase.from("fin_ref_payer_prices").select("id", { count: "exact", head: true }),
    supabase
      .from("ins_remittance_lines")
      .select("id", { count: "exact", head: true })
      .is("reviewed_at", null)
      .or("match_status.neq.matched,short_amount.gt.0"),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Remittance"
        description="Match each payer's payment advice to your claims and see where the payer paid less than the agreed price."
      />
      {(prices ?? 0) === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm">
            No agreed prices are loaded, so short payments are judged against the claim&apos;s own
            net amount. Load the payer price lists in Finance, Workflow settings for a real check.
          </CardContent>
        </Card>
      )}
      <RemittanceUpload />
      <Card>
        <CardHeader>
          <CardTitle>Reconciled advices</CardTitle>
          <CardDescription>
            {unreviewed ?? 0} flagged line(s) still to review. Latest 30 shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(batches ?? []).length === 0 ? (
            <EmptyState
              title="Nothing reconciled yet"
              description="Upload a payer's payment advice to match it to claims."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Saved</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">Short</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Short amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(batches ?? []).map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="text-xs">
                      {new Date(b.created_at).toLocaleDateString("en-GB")}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/finance/remittance/${b.id}`}
                      >
                        {b.remittance_ref ?? "(several)"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">{b.payer_id ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {b.line_count}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {b.matched_count}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {b.short_count}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(b.sum_paid)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(b.sum_short)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
