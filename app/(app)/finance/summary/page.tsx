import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import {
  REVENUE_GROUPS,
  SUMMARY_COLUMNS,
  currentMonth,
  groupRevenue,
  monthParam,
  monthsAgo,
  totals,
  type RevenueGroup,
  type RevenueRow,
  type SummaryRow,
} from "@/lib/finance/summary";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Monthly summary" };
export const dynamic = "force-dynamic";

type Search = {
  from?: string;
  to?: string;
  branch?: string;
  group?: string;
  department?: string;
  doctor?: string;
};
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 80);
const money = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HEAD: Record<(typeof SUMMARY_COLUMNS)[number], string> = {
  generated: "Generated",
  claimed: "Claimed",
  remitted: "Remitted",
  rejected: "Rejected",
  outstanding: "Outstanding",
  self_pay_collected: "Self-pay collected",
};

export default async function SummaryPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePerm("finance.view");
  const sp = await searchParams;
  const from = monthParam(sp.from, monthsAgo(11));
  const to = monthParam(sp.to, currentMonth());
  const group: RevenueGroup = REVENUE_GROUPS.some((g) => g.key === sp.group)
    ? (sp.group as RevenueGroup)
    : "department";
  const supabase = await createClient();

  let sq = supabase
    .from("v_fin_monthly_summary")
    .select(
      "month, branch_code, generated, claimed, remitted, rejected, outstanding, self_pay_collected",
    )
    .gte("month", `${from}-01`)
    .lte("month", `${to}-01`)
    .order("month", { ascending: false })
    .order("branch_code");
  if (safe(sp.branch)) sq = sq.eq("branch_code", safe(sp.branch).toUpperCase());

  let rq = supabase
    .from("v_fin_revenue_monthly")
    .select(
      "branch_code, department, doctor_name, doctor_dha_id, service_category, gross, discount, net, vat",
    )
    .gte("month", `${from}-01`)
    .lte("month", `${to}-01`)
    .limit(20_000);
  if (safe(sp.branch)) rq = rq.eq("branch_code", safe(sp.branch).toUpperCase());
  if (safe(sp.department)) rq = rq.ilike("department", `%${safe(sp.department)}%`);
  if (safe(sp.doctor))
    rq = rq.or(`doctor_name.ilike.%${safe(sp.doctor)}%,doctor_dha_id.eq.${safe(sp.doctor)}`);

  const [{ data: summary }, { data: revenue }] = await Promise.all([sq, rq]);
  const rows = (summary ?? []) as SummaryRow[];
  const sum = totals(rows);
  const groups = groupRevenue((revenue ?? []) as RevenueRow[], group);
  const csv = new URLSearchParams({
    from,
    to,
    ...(safe(sp.branch) ? { branch: safe(sp.branch) } : {}),
  }).toString();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Monthly summary"
        description="Generated, claimed, remitted, rejected and outstanding, by month and branch. One definition for every number."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`/api/finance/summary?${csv}`}>Download CSV</Link>
        </Button>
      </PageHeader>

      <form className="grid gap-2 sm:grid-cols-6">
        <Input name="from" type="month" defaultValue={from} aria-label="From month" />
        <Input name="to" type="month" defaultValue={to} aria-label="To month" />
        <Input name="branch" placeholder="Branch" defaultValue={sp.branch} />
        <Input name="department" placeholder="Department" defaultValue={sp.department} />
        <Input name="doctor" placeholder="Doctor" defaultValue={sp.doctor} />
        <select
          name="group"
          defaultValue={group}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          {REVENUE_GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              Revenue by {g.label.toLowerCase()}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" className="sm:w-32">
          Apply
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>By month and branch</CardTitle>
          <CardDescription>
            Generated = invoice net (not deleted). Claimed, remitted, rejected and outstanding come
            from Diligence claims, by transaction month.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No data in this range yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Branch</TableHead>
                  {SUMMARY_COLUMNS.map((c) => (
                    <TableHead key={c} className="text-right">
                      {HEAD[c]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.month}-${r.branch_code}`}>
                    <TableCell className="text-xs">{r.month.slice(0, 7)}</TableCell>
                    <TableCell className="text-xs">{r.branch_code ?? "unknown"}</TableCell>
                    {SUMMARY_COLUMNS.map((c) => (
                      <TableCell key={c} className="text-right tabular-nums">
                        {money(r[c])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="font-medium">
                    Total
                  </TableCell>
                  {SUMMARY_COLUMNS.map((c) => (
                    <TableCell key={c} className="text-right font-medium tabular-nums">
                      {money(sum[c])}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Revenue by {REVENUE_GROUPS.find((g) => g.key === group)?.label.toLowerCase()}
          </CardTitle>
          <CardDescription>
            Invoice lines of current, non-deleted invoices, in the same date range and filters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="text-muted-foreground text-sm">No revenue in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{REVENUE_GROUPS.find((g) => g.key === group)?.label}</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.slice(0, 200).map((g) => (
                  <TableRow key={g.label}>
                    <TableCell className="text-sm">{g.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.gross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.discount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.net)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(g.vat)}</TableCell>
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
