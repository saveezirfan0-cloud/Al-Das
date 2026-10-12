import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/can";
import { todayIn } from "@/lib/finance/action-support";
import { lastClosedMonth } from "@/lib/finance/close-server";
import { monthLabel } from "@/lib/finance/close-pack";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Month-end close" };
export const dynamic = "force-dynamic";

const LABEL = {
  open: "Not built",
  built: "Built, not signed",
  finance_signed: "Waiting for the CEO",
  locked: "Locked",
} as const;
const VARIANT = {
  open: "outline",
  built: "secondary",
  finance_signed: "warning",
  locked: "success",
} as const;

export default async function ClosePage() {
  const member = await requireMember();
  if (
    !canAny(member, [
      "finance.close.view",
      "finance.close.manage",
      "finance.close.signoff.finance",
      "finance.close.signoff.ceo",
    ])
  )
    throw new ForbiddenError("finance.close.view");
  const supabase = await createClient();
  const { data: closes } = await supabase
    .from("fin_period_closes")
    .select("month, status, built_at, locked_at")
    .order("month", { ascending: false })
    .limit(60);
  const byMonth = new Map((closes ?? []).map((c) => [c.month.slice(0, 7), c]));
  // the last 18 finished months, newest first
  const months: string[] = [];
  let m = lastClosedMonth(todayIn(member.org.timezone));
  for (let i = 0; i < 18; i++) {
    months.push(m);
    const first = `${m}-01`;
    m = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 2, 1))
      .toISOString()
      .slice(0, 7);
  }
  for (const k of byMonth.keys()) if (!months.includes(k)) months.push(k);
  months.sort().reverse();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Month-end close"
        description="Build the pack for a finished month, have Finance and then the CEO (two different people) sign it, and the month is locked: the pack and the month's cash-ups can never change again."
      />
      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Built</TableHead>
                <TableHead>Locked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((k) => {
                const c = byMonth.get(k);
                const status = (c?.status ?? "open") as keyof typeof LABEL;
                return (
                  <TableRow key={k}>
                    <TableCell className="text-sm">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/finance/close/${k}`}
                      >
                        {monthLabel(`${k}-01`)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {c?.built_at ? new Date(c.built_at).toLocaleDateString("en-GB") : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c?.locked_at ? new Date(c.locked_at).toLocaleDateString("en-GB") : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
