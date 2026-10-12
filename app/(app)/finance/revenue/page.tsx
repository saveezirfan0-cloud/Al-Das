import { HorizontalBars } from "@/components/finance/bars";
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
import { addDays } from "@/lib/documents/expiry";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import {
  DIMENSION_LABELS,
  parseRevenue,
  previousPeriod,
  REVENUE_DIMENSIONS,
  withComparison,
  type RevenueDimension,
} from "@/lib/finance/revenue";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Revenue" };
export const dynamic = "force-dynamic";

type Search = { dimension?: string; from?: string; to?: string; branch?: string; compare?: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function RevenuePage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.revenue.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const to = DATE.test(sp.to ?? "") ? sp.to! : today;
  const from = DATE.test(sp.from ?? "") ? sp.from! : (addDays(to, -29) ?? to);
  const dimension: RevenueDimension = (REVENUE_DIMENSIONS as readonly string[]).includes(
    sp.dimension ?? "",
  )
    ? (sp.dimension as RevenueDimension)
    : "category";
  const branch =
    (sp.branch ?? "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 4)
      .toUpperCase() || null;
  const compare = sp.compare === "1";
  const prevRange = compare ? previousPeriod(from, to) : null;

  const admin = createAdminClient(); // service role AFTER the permission check
  const run = async (f: string, t: string) =>
    parseRevenue(
      (
        await admin.rpc("fin_revenue_breakdown", {
          p_org_id: member.orgId,
          p_from: f,
          p_to: t,
          p_dimension: dimension,
          p_branch: branch ?? undefined,
          p_limit: 300,
        })
      ).data,
    );
  const current = await run(from, to);
  const previous = prevRange ? await run(prevRange.from, prevRange.to) : null;
  const rows = withComparison(current, previous);
  const total = current.reduce((a, r) => a + r.net, 0);
  const prevTotal = previous ? previous.reduce((a, r) => a + r.net, 0) : null;
  const exportParams = new URLSearchParams({
    dimension,
    from,
    to,
    ...(branch ? { branch } : {}),
    ...(compare ? { compare: "1" } : {}),
  }).toString();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Revenue"
        description="Net revenue from current invoice lines (deleted invoices excluded) by doctor, department, branch or service. The doctor is the one on the invoice; whether ordering or performing doctor should count is still to be decided with management."
      >
        <Button asChild variant="outline">
          <a href={`/api/finance/revenue?${exportParams}`}>Download CSV</a>
        </Button>
      </PageHeader>
      <form className="grid gap-2 sm:grid-cols-6">
        <select
          name="dimension"
          defaultValue={dimension}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          {REVENUE_DIMENSIONS.map((d) => (
            <option key={d} value={d}>
              By {DIMENSION_LABELS[d].toLowerCase()}
            </option>
          ))}
        </select>
        <Input name="from" type="date" defaultValue={from} aria-label="From" />
        <Input name="to" type="date" defaultValue={to} aria-label="To" />
        <Input name="branch" placeholder="Branch code" defaultValue={branch ?? ""} maxLength={4} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="compare" value="1" defaultChecked={compare} /> Compare
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      <p className="text-sm">
        <span className="font-semibold tabular-nums">{money(total)}</span> net in this period
        {prevTotal !== null && prevRange && (
          <span className="text-muted-foreground">
            {" "}
            versus {money(prevTotal)} in {prevRange.from} to {prevRange.to}
          </span>
        )}
        .
      </p>
      <Card>
        <CardContent className="flex flex-col gap-6 pt-6">
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No invoices in this period.</p>
          ) : (
            <>
              <HorizontalBars
                rows={rows.slice(0, 12).map((r) => ({ label: r.label ?? r.key, value: r.net }))}
              />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{DIMENSION_LABELS[dimension]}</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    {compare && <TableHead className="text-right">Previous</TableHead>}
                    {compare && <TableHead className="text-right">Change</TableHead>}
                    <TableHead className="text-right">Invoices</TableHead>
                    <TableHead className="text-right">Discount</TableHead>
                    <TableHead className="text-right">VAT</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="text-xs">
                        {r.label ?? r.key}
                        {r.label && (
                          <span className="text-muted-foreground ml-1 font-mono">{r.key}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(r.net)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {(r.share * 100).toFixed(1)}%
                      </TableCell>
                      {compare && (
                        <TableCell className="text-right text-xs tabular-nums">
                          {r.previousNet === null ? "—" : money(r.previousNet)}
                        </TableCell>
                      )}
                      {compare && (
                        <TableCell className="text-right text-xs">
                          {r.changePct === null ? (
                            <span className="text-muted-foreground">new</span>
                          ) : (
                            <Badge variant={r.changePct >= 0 ? "success" : "warning"}>
                              {r.changePct > 0 ? "+" : ""}
                              {r.changePct}%
                            </Badge>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.invoices}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(r.discount)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(r.vat)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
