import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createClient } from "@/lib/supabase/server";

import { CashupForm } from "./cashup-form";
import { StartButton } from "./start-button";

export const metadata = { title: "Cash-up" };
export const dynamic = "force-dynamic";

type Search = { branch?: string; date?: string };

export default async function CashupPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.cashup.manage");
  const sp = await searchParams;
  const supabase = await createClient();
  const settings = await loadFinanceSettings(supabase, member.orgId);
  const today = todayIn(member.org.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date! : today;
  const { data: branches } = await supabase
    .from("fin_ref_branches")
    .select("code, name")
    .eq("active", true)
    .order("code");
  const branch = (branches ?? []).some((b) => b.code === sp.branch)
    ? sp.branch!
    : (branches?.[0]?.code ?? "");

  const { data: cashup } = branch
    ? await supabase
        .from("fin_cashups")
        .select("id, status, note, submitted_at")
        .eq("branch_code", branch)
        .eq("business_date", date)
        .maybeSingle()
    : { data: null };
  const { data: lines } = cashup
    ? await supabase
        .from("fin_cashup_lines")
        .select("payment_mode, expected_amount, counted_amount, reason")
        .eq("cashup_id", cashup.id)
        .order("payment_mode")
    : { data: [] };
  const { data: recent } = await supabase
    .from("fin_cashups")
    .select(
      "id, branch_code, business_date, status, fin_cashup_lines(expected_amount, counted_amount, variance)",
    )
    .gte("business_date", addDays(today, -21) ?? today)
    .order("business_date", { ascending: false })
    .limit(60);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="End-of-day cash-up"
        description="Count each payment mode at the end of the day and compare it with what Pulse recorded for that branch. Differences beyond the tolerance need a reason."
      />
      <form className="grid gap-2 sm:grid-cols-5">
        <select
          name="branch"
          defaultValue={branch}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          {(branches ?? []).map((b) => (
            <option key={b.code} value={b.code}>
              {b.name} ({b.code})
            </option>
          ))}
        </select>
        <Input name="date" type="date" defaultValue={date} max={today} aria-label="Business date" />
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {branch} on {date}{" "}
            {cashup && (
              <Badge variant={cashup.status === "submitted" ? "success" : "secondary"}>
                {cashup.status === "submitted" ? "Submitted" : "Draft"}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Expected = payments recorded in Unite for this branch and day, less refunds that day. If
            Unite capture has not run yet the expectation may be incomplete.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!branch ? (
            <p className="text-muted-foreground text-sm">
              No branches are set up. Add them under Reference data.
            </p>
          ) : cashup ? (
            <CashupForm
              key={`${cashup.id}-${cashup.status}`}
              id={cashup.id}
              status={cashup.status as "draft" | "submitted"}
              note={cashup.note}
              tolerance={settings.cashupVarianceTolerance}
              lines={(lines ?? []).map((l) => ({
                mode: l.payment_mode,
                expected: Number(l.expected_amount),
                counted: l.counted_amount === null ? null : Number(l.counted_amount),
                reason: l.reason,
              }))}
            />
          ) : (
            <StartButton branch={branch} date={date} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last three weeks</CardTitle>
        </CardHeader>
        <CardContent>
          {(recent ?? []).length === 0 ? (
            <EmptyState
              title="No cash-ups yet"
              description="Count the cash at the end of the day and record it above."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent ?? []).map((r) => {
                  const ls = r.fin_cashup_lines ?? [];
                  const e = ls.reduce((a, l) => a + Number(l.expected_amount), 0);
                  const c = ls.reduce((a, l) => a + Number(l.counted_amount ?? 0), 0);
                  const v = ls.reduce((a, l) => a + Number(l.variance ?? 0), 0);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">
                        <a
                          className="underline-offset-2 hover:underline"
                          href={`/finance/cashup?branch=${r.branch_code}&date=${r.business_date}`}
                        >
                          {r.business_date}
                        </a>
                      </TableCell>
                      <TableCell className="text-xs">{r.branch_code}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "submitted" ? "success" : "secondary"}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{money(e)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{money(c)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.status === "submitted" ? money(v) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
