import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountingErrorMessage } from "@/lib/accounting/errors";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { Balance } from "../ui";
import { YearEndControls } from "./controls";

export const metadata = { title: "Year-end close" };
export const dynamic = "force-dynamic";

type Preview = {
  fiscal_year: {
    id: string;
    label: string;
    start_date: string;
    end_date: string;
    status: string;
    closed_at: string | null;
  };
  months: Array<{ month: string; status: string }>;
  open_months: number;
  drafts: number;
  adjustment_period: string | null;
  retained_earnings: { code: string; name: string } | null;
  result: number;
  lines: Array<{ account_id: string; code: string; name: string; nature: string; balance: number }>;
  closing_journal: { id: string; number: string; status: string } | null;
  problems: string[];
};

export default async function YearEndPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, ["accounting.periods.manage", "accounting.view"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.periods.manage");
  const { fy } = await searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data: years } = await admin
    .from("acc_fiscal_years")
    .select("id, label, start_date, end_date, status, closed_at")
    .eq("org_id", member.orgId)
    .order("start_date", { ascending: false })
    .limit(30);
  const today = todayIn(member.org.timezone);
  const list = years ?? [];
  const chosen =
    list.find((y) => y.id === fy) ??
    [...list].reverse().find((y) => y.status === "open" && y.end_date < today) ??
    list[0];
  let preview: Preview | null = null;
  if (chosen) {
    const { data } = await admin.rpc("acc_year_end_preview", {
      p_org_id: member.orgId,
      p_fiscal_year_id: chosen.id,
    });
    preview = (data as unknown as Preview) ?? null;
  }
  const blocking = (preview?.problems ?? []).filter((p) => p !== "year_closed");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Year-end close"
        description="Closing a fiscal year moves every income and expense balance to retained earnings with one closing journal (in the year's adjustment period) and closes the year: nothing can be posted into it afterwards. Close the years in order. A closed year is re-opened only by reversing its closing journal."
      />
      <div className="flex flex-wrap gap-2 text-sm">
        {list.map((y) => (
          <Link
            key={y.id}
            href={`/accounting/year-end?fy=${y.id}`}
            className={`rounded-md border px-2 py-1 ${y.id === chosen?.id ? "bg-muted font-medium" : ""}`}
          >
            {y.label} {y.status === "closed" ? "(closed)" : ""}
          </Link>
        ))}
        {list.length === 0 && <span className="text-muted-foreground">No fiscal years yet.</span>}
      </div>

      {preview && chosen && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {preview.fiscal_year.label}
                <Badge variant={preview.fiscal_year.status === "closed" ? "secondary" : "success"}>
                  {preview.fiscal_year.status}
                </Badge>
              </CardTitle>
              <CardDescription>
                {preview.fiscal_year.start_date} to {preview.fiscal_year.end_date}.{" "}
                {preview.closing_journal && (
                  <>
                    Closing journal{" "}
                    <Link
                      href={`/accounting/journals/${preview.closing_journal.id}`}
                      className="underline"
                    >
                      {preview.closing_journal.number}
                    </Link>
                    .
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-1">
                {preview.months.map((m) => (
                  <Badge
                    key={m.month}
                    variant={
                      m.status === "open" || m.status === "missing" ? "warning" : "secondary"
                    }
                  >
                    {m.month} {m.status}
                  </Badge>
                ))}
                {preview.adjustment_period && (
                  <Badge variant="outline">Adjustment period {preview.adjustment_period}</Badge>
                )}
              </div>
              {preview.fiscal_year.status === "open" && blocking.length > 0 && (
                <Alert>
                  <AlertTitle>Before the year can be closed</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {blocking.map((p) => (
                        <li key={p}>{accountingErrorMessage(p, p)}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {manage && (
                <YearEndControls
                  id={chosen.id}
                  status={preview.fiscal_year.status}
                  canClose={preview.fiscal_year.status === "open" && blocking.length === 0}
                  monthsOpen={preview.open_months > 0}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                {Number(preview.result) <= 0 ? "Profit" : "Loss"} for the year:{" "}
                {money(Math.abs(Number(preview.result)))}
              </CardTitle>
              <CardDescription>
                The balances the closing journal moves to{" "}
                {preview.retained_earnings
                  ? `${preview.retained_earnings.code} ${preview.retained_earnings.name}`
                  : "retained earnings"}
                {preview.fiscal_year.status === "closed"
                  ? " (already moved: they show as zero)."
                  : "."}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Nature</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.lines.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-muted-foreground text-sm">
                        No income or expense balances in this year.
                      </TableCell>
                    </TableRow>
                  )}
                  {preview.lines.map((l) => (
                    <TableRow key={l.account_id}>
                      <TableCell>
                        <span className="text-muted-foreground mr-2 font-mono text-xs">
                          {l.code}
                        </span>
                        {l.name}
                      </TableCell>
                      <TableCell>{l.nature}</TableCell>
                      <TableCell className="text-right">
                        <Balance value={Number(l.balance)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
