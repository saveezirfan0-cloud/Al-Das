import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { buildTallyXml, LEDGER_KIND_LABEL } from "@/lib/finance/tally-xml";
import {
  loadPayablesSettings,
  loadTallyCandidates,
  peopleNames,
  nameOf,
} from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { CreateTallyExportButton } from "./export-button";

export const metadata = { title: "Tally export" };
export const dynamic = "force-dynamic";

export default async function TallyExportPage() {
  const member = await requirePerm("finance.tally.export");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [cand, settings, { data: exports }] = await Promise.all([
    loadTallyCandidates(admin, member.orgId),
    loadPayablesSettings(admin, member.orgId),
    admin
      .from("fin_tally_exports")
      .select("id, voucher_count, invoice_count, total_amount, checksum, exported_by, created_at")
      .eq("org_id", member.orgId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const preview = buildTallyXml({
    company: settings.tallyCompany,
    costCategory: settings.tallyCostCategory,
    ledgers: cand.ledgers,
    purchases: cand.purchases,
    payments: cand.payments,
    supplierNames: cand.supplierNames,
  });
  const names = await peopleNames(
    admin,
    (exports ?? []).map((e) => e.exported_by),
  );
  const nothing = cand.payments.length === 0 && cand.purchases.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tally export"
        description="A TallyPrime import file of the approved payment vouchers and supplier invoices not yet exported. Import it in Tally (Gateway of Tally, Import, Transactions). One-way: Pulse never reads Tally."
      >
        <Button asChild variant="outline">
          <Link href="/finance/vouchers/settings">Tally ledgers</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Next file</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>
            {cand.payments.length} payment voucher(s) and {cand.purchases.length} supplier
            invoice(s) (purchases)
            {preview.ok ? `, AED ${money(preview.total)} in all.` : "."}
          </p>
          {!nothing && !preview.ok && (
            <div className="rounded-md border border-amber-300 dark:border-amber-500/30 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              <p className="font-medium">Map these to Tally first:</p>
              <ul className="list-disc pl-5">
                {preview.missing.map((m) => (
                  <li key={`${m.kind}|${m.key}`}>
                    {LEDGER_KIND_LABEL[m.kind]}: {m.label}
                    {m.kind === "supplier" && (
                      <span className="text-muted-foreground font-mono text-xs"> ({m.key})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <CreateTallyExportButton disabled={nothing || !preview.ok} />
          </div>
          <p className="text-muted-foreground text-xs">
            The file is built from TallyPrime&apos;s documented XML format and has not yet been
            tried on the clinic&apos;s Tally (OQ-92): import the first one into a test company.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Earlier files</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="text-right">Payments</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Checksum</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(exports ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <EmptyState
                      title="No exports yet"
                      description="Approved vouchers and close items appear here once they are exported for Tally."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                (exports ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">
                      {new Date(e.created_at).toLocaleString("en-GB")}
                    </TableCell>
                    <TableCell>{nameOf(names, e.exported_by)}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.voucher_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.invoice_count}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(e.total_amount)}
                    </TableCell>
                    <TableCell className="font-mono text-xs" title={e.checksum}>
                      {e.checksum.slice(0, 12)}…
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <a href={`/api/finance/tally/${e.id}`}>Download</a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
