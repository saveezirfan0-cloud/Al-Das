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
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { monthLabel } from "@/lib/finance/close-pack";
import { lastClosedMonth } from "@/lib/finance/close-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Group pack" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; variant: "secondary" | "warning" | "success" }> = {
  open: { label: "Provisional, not closed", variant: "secondary" },
  built: { label: "Provisional, pack built", variant: "warning" },
  finance_signed: { label: "Provisional, Finance signed", variant: "warning" },
  locked: { label: "Locked", variant: "success" },
};

const SHEETS: readonly (readonly [string, string])[] = [
  [
    "Entity P&L",
    "Month and year to date from the ledger (the Tally mirror), with Unite revenue beside it.",
  ],
  [
    "KPI Scorecard",
    "Revenue, patients, visits, new and repeat visits, revenue per patient against target, collections and insurance.",
  ],
  [
    "Clinic Branch Source Data",
    "The same figures for every branch (Shoreline, Meadows, Golden Mile), with the amounts not assigned to a branch.",
  ],
  [
    "Receivables and payables ageing",
    "Insurer receivables by age (Diligence) and supplier payables by age.",
  ],
  ["Close & Sign-off", "The month's close checklist and who signed for Finance and the CEO."],
];

/** docs/51: Al Das's submission for the Bindrai group reporting pack, as one Excel file per month. */
export default async function GroupPackPage() {
  const member = await requirePerm("finance.group_pack.export");
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data: closes } = await admin
    .from("fin_period_closes")
    .select("month, status")
    .eq("org_id", member.orgId)
    .order("month", { ascending: false })
    .limit(24);
  const byMonth = new Map((closes ?? []).map((c) => [c.month.slice(0, 7), c.status]));
  const months: string[] = [];
  let m = lastClosedMonth(todayIn(member.org.timezone));
  for (let i = 0; i < 12; i++) {
    months.push(m);
    m = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 2, 1))
      .toISOString()
      .slice(0, 7);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Group pack"
        description="Al Das's own part of the Bindrai group reporting pack, filled from Pulse's figures. The group consolidation, the other companies and the CEO scorecard stay in the group workbook."
      />

      <Alert>
        <AlertTitle>For the Finance Manager</AlertTitle>
        <AlertDescription>
          The file carries the clinic-wide profit and loss. Figures are provisional until the CEO
          sign-off locks the month. A blank figure means Pulse does not have it yet and says why; it
          is never zero. No patient data.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Download a month</CardTitle>
          <CardDescription>
            A month that has been built in Month-end close uses its frozen pack; any other month is
            built live for the download.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Excel</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((ym) => {
                const s = STATUS[byMonth.get(ym) ?? "open"] ?? STATUS.open;
                return (
                  <TableRow key={ym}>
                    <TableCell>{monthLabel(`${ym}-01`)}</TableCell>
                    <TableCell>
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <a
                        className="text-primary text-sm underline-offset-4 hover:underline"
                        href={`/api/finance/group-pack?month=${ym}`}
                      >
                        Download
                        <span className="sr-only">
                          {" "}
                          the group pack for {monthLabel(`${ym}-01`)}
                        </span>
                      </a>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What the file holds</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {SHEETS.map(([name, text]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{text}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
