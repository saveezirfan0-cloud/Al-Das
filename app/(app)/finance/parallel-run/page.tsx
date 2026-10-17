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
import { money } from "@/lib/finance/format";
import {
  AREA_BASIS,
  AREA_LABEL,
  type AreaStatus,
  type CompareState,
} from "@/lib/finance/parallel-run";
import { loadParallelView } from "@/lib/finance/parallel-run-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { DecisionButton, ManualFigureButton, ToleranceForm } from "./forms";

export const metadata = { title: "Parallel run" };
export const dynamic = "force-dynamic";

const STATUS: Record<AreaStatus, { label: string; variant: "secondary" | "warning" | "success" }> =
  {
    not_started: { label: "Not started", variant: "secondary" },
    running: { label: "Running in parallel", variant: "warning" },
    switched: { label: "Switched to Pulse", variant: "success" },
  };

const RESULT: Record<
  CompareState,
  { label: string; variant: "secondary" | "warning" | "success" }
> = {
  agrees: { label: "Agrees", variant: "success" },
  differs: { label: "Differs", variant: "warning" },
  no_manual: { label: "No manual figure yet", variant: "secondary" },
  no_pulse: { label: "Not available yet", variant: "secondary" },
};

export default async function ParallelRunPage() {
  // the Finance Manager runs the parallel run; each area is then shown only with its own report key (loadParallelView)
  const member = await requirePerm("finance.parallel_run.manage");

  const admin = createAdminClient(); // service role AFTER the permission checks
  const view = await loadParallelView(admin, member, todayIn(member.org.timezone));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Parallel run"
        description="Pulse's figure for each finished month beside the manual figure Finance produces today, the difference, and the decision to rely on Pulse. The manual process stays until an area is switched."
      />

      <Alert>
        <AlertTitle>Comparison only</AlertTitle>
        <AlertDescription>
          Nothing here posts to the books. {view.lockLabel} An area can be switched only when its
          two latest finished months, back to back, both agree (difference within{" "}
          {money(view.tolerance)} AED). Do not type patients&apos; names or numbers in any note.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tolerance</CardTitle>
          <CardDescription>
            How far apart the two figures may be and still agree. Currently {money(view.tolerance)}{" "}
            AED.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToleranceForm tolerance={view.tolerance} />
        </CardContent>
      </Card>

      {view.areas.map((a) => {
        const s = STATUS[a.status];
        return (
          <Card key={a.area}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-1.5">
                <CardTitle className="flex items-center gap-2 text-base">
                  {AREA_LABEL[a.area]} <Badge variant={s.variant}>{s.label}</Badge>
                </CardTitle>
                <CardDescription>Pulse figure: {AREA_BASIS[a.area]}</CardDescription>
                {a.decidedAt && a.status !== "not_started" && (
                  <CardDescription>
                    Decision by {a.decidedByName} on {a.decidedAt.slice(0, 10)}
                    {a.decisionNote ? `: ${a.decisionNote}` : ""}
                  </CardDescription>
                )}
              </div>
              {a.status === "switched" ? (
                <DecisionButton area={a.area} status="running" />
              ) : a.check.ok ? (
                <DecisionButton area={a.area} status="switched" />
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {a.warning && (
                <Alert variant="destructive">
                  <AlertTitle>Check this area</AlertTitle>
                  <AlertDescription>{a.warning}</AlertDescription>
                </Alert>
              )}
              {a.status !== "switched" && !a.check.ok && (
                <p className="text-muted-foreground text-sm">
                  Not ready to switch: {a.check.reason}
                </p>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Pulse</TableHead>
                      <TableHead className="text-right">Manual</TableHead>
                      <TableHead className="text-right">Difference</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Explanation</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.months.map((m) => (
                      <TableRow key={m.month}>
                        <TableCell className="whitespace-nowrap">{m.month}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {m.pulse === null ? "Not available yet" : money(m.pulse)}
                          {m.pulse !== null && m.provisional && (
                            <span className="text-muted-foreground block text-xs">Provisional</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {m.manual === null ? "No manual figure yet" : money(m.manual)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {m.difference === null ? "—" : money(m.difference)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={RESULT[m.state].variant}>{RESULT[m.state].label}</Badge>
                        </TableCell>
                        <TableCell className="max-w-64 truncate">{m.note ?? ""}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <ManualFigureButton
                            area={a.area}
                            month={m.month}
                            manual={m.manual}
                            note={m.note}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
