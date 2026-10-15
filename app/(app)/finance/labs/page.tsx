import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { LAB_IMPORT_KINDS } from "@/lib/finance/import-kinds";
import { fileKindFor, isProviderKind, PROVIDER_KINDS } from "@/lib/finance/labs";
import { createAdminClient } from "@/lib/supabase/admin";

import { UploadForm } from "./forms";

export const metadata = { title: "Labs and referrals" };
export const dynamic = "force-dynamic";

const STATEMENT_STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  open: { label: "Open", variant: "outline" },
  reviewed: { label: "Reviewed, waiting to be posted", variant: "secondary" },
  posted: { label: "Posted to doctor charges", variant: "default" },
};

type Summary = {
  lines?: number;
  matched?: number;
  notBilled?: number;
  notOnFile?: number;
  totalCost?: number;
};

export default async function LabsPage() {
  const member = await requirePerm("finance.labs.view");
  const manage = can(member, "finance.labs.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: providers }, { data: formats }, { data: statements }] = await Promise.all([
    admin
      .from("fin_providers")
      .select("id, name, kind, fixed_monthly_fee, allocation_basis, active")
      .eq("org_id", member.orgId)
      .order("name"),
    admin
      .from("fin_import_formats")
      .select("id, kind, name")
      .eq("org_id", member.orgId)
      .in("kind", [...LAB_IMPORT_KINDS])
      .eq("active", true)
      .order("name"),
    admin
      .from("fin_provider_statements")
      .select("id, provider_id, month, status, figures")
      .eq("org_id", member.orgId)
      .order("month", { ascending: false })
      .limit(60),
  ]);
  const ids = (statements ?? []).map((s) => s.id);
  const { data: files } = ids.length
    ? await admin
        .from("fin_provider_files")
        .select("statement_id, row_count")
        .eq("org_id", member.orgId)
        .in("statement_id", ids)
    : { data: [] as Array<{ statement_id: string; row_count: number }> };
  const rowCount = new Map<string, number>();
  for (const f of files ?? [])
    rowCount.set(f.statement_id, (rowCount.get(f.statement_id) ?? 0) + f.row_count);
  const providerName = new Map((providers ?? []).map((p) => [p.id, p.name]));
  const activeProviders = (providers ?? [])
    .filter((p) => p.active && isProviderKind(p.kind))
    .map((p) => ({
      id: p.id,
      name: p.name,
      fileKind: fileKindFor(p.kind as keyof typeof PROVIDER_KINDS),
    }));
  const thisMonth = todayIn(member.org.timezone).slice(0, 7);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Labs and referrals"
        description="Each lab test and referral on a provider's monthly file is matched to what Unite billed (patient PIN, day and code) before its cost is charged to the doctor. Shows revenue leakage, tests billed without a lab record, price differences and late results."
      >
        {manage && (
          <Button asChild variant="outline">
            <Link href="/finance/labs/settings">Providers, tests and layouts</Link>
          </Button>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Providers</CardTitle>
        </CardHeader>
        <CardContent>
          {(providers ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No providers yet.{" "}
              {manage && (
                <Link className="underline" href="/finance/labs/settings">
                  Add them in Settings
                </Link>
              )}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Monthly fee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(providers ?? []).map((p) => (
                  <TableRow key={p.id} className={p.active ? "" : "opacity-60"}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>
                      {isProviderKind(p.kind) ? PROVIDER_KINDS[p.kind] : p.kind}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {p.kind === "in_house_lab"
                        ? `${money(p.fixed_monthly_fee)} (shared by ${p.allocation_basis === "revenue" ? "billed revenue" : "test count"})`
                        : "Per invoice"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {manage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload a provider&apos;s file</CardTitle>
            <CardDescription>
              Read once on the server and not kept: only the mapped columns are stored (dates,
              codes, amounts, the Unite PIN and the doctor&apos;s id). Names and ID numbers are
              never read. Several files (one per branch) can go into the same provider and month;
              the same file twice is refused.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UploadForm providers={activeProviders} formats={formats ?? []} month={thisMonth} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Statements</CardTitle>
          <CardDescription>One per provider and month. Open one to work it.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Lines</TableHead>
                <TableHead>Matched</TableHead>
                <TableHead>Not billed</TableHead>
                <TableHead>Not on file</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(statements ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <EmptyState
                      title="No statements yet"
                      description="Upload a provider's file to start one."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                (statements ?? []).map((s) => {
                  const sum = ((s.figures as { summary?: Summary } | null)?.summary ??
                    null) as Summary | null;
                  const st = STATEMENT_STATUS[s.status] ?? STATEMENT_STATUS.open;
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link className="underline" href={`/finance/labs/${s.id}`}>
                          {s.month.slice(0, 7)}
                        </Link>
                      </TableCell>
                      <TableCell>{providerName.get(s.provider_id)}</TableCell>
                      <TableCell className="tabular-nums">{rowCount.get(s.id) ?? 0}</TableCell>
                      <TableCell className="tabular-nums">{sum?.matched ?? "-"}</TableCell>
                      <TableCell className="tabular-nums">{sum?.notBilled ?? "-"}</TableCell>
                      <TableCell className="tabular-nums">{sum?.notOnFile ?? "-"}</TableCell>
                      <TableCell className="tabular-nums">
                        {sum ? money(sum.totalCost) : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <p className="text-muted-foreground mt-2 text-xs">
            Figures appear here once a statement is reviewed; open a statement to see them while it
            is being worked.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
