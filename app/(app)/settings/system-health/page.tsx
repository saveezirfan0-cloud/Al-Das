import "@/lib/jobs/handlers";

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
import { getSystemHealth, type QueueHealth } from "@/lib/jobs/health";
import { createAdminClient } from "@/lib/supabase/admin";

import { AutoRefresh, DeadLetterActions, RunNowButton } from "./controls";

export const metadata = { title: "System health" };
export const dynamic = "force-dynamic";

const STATUS: Record<
  QueueHealth["status"],
  { label: string; variant: "secondary" | "success" | "warning" | "destructive" | "outline" }
> = {
  ok: { label: "OK", variant: "success" },
  idle: { label: "Idle", variant: "secondary" },
  backlog: { label: "Backlog", variant: "warning" },
  failing: { label: "Failing", variant: "destructive" },
  no_handler: { label: "No handler", variant: "outline" },
  unknown: { label: "Unknown", variant: "outline" },
};

function fmt(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default async function SystemHealthPage() {
  await requirePerm("settings.manage");
  const health = await getSystemHealth(createAdminClient());
  const problems =
    health.queues.filter((q) => q.status === "failing" || q.status === "backlog").length +
    health.deadLetters.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="System health"
        description="Queues, scheduled work, cron pings and failures. Refreshes every 15 seconds."
      >
        <AutoRefresh seconds={15} />
        <RunNowButton queue="scheduler" label="Run scheduler" />
      </PageHeader>

      {health.metricsError && (
        <Alert variant="destructive">
          <AlertTitle>Queue metrics unavailable</AlertTitle>
          <AlertDescription>{health.metricsError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat
          label="Attention"
          value={problems}
          hint={problems ? "queues or dead letters" : "all clear"}
          tone={problems ? "bad" : "good"}
        />
        <Stat
          label="Scheduled pending"
          value={health.scheduled.pending}
          hint={`${health.scheduled.locked} in progress`}
        />
        <Stat
          label="Scheduled overdue"
          value={health.scheduled.overdue}
          hint="> 1 min past due"
          tone={health.scheduled.overdue ? "bad" : undefined}
        />
        <Stat
          label="Dead letters"
          value={health.deadLetters.length}
          hint="unresolved"
          tone={health.deadLetters.length ? "bad" : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Queues</CardTitle>
          <CardDescription>pgmq depth and the last drain of each queue.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Depth</TableHead>
                <TableHead className="text-right">Oldest (s)</TableHead>
                <TableHead>Handler</TableHead>
                <TableHead>Last drain</TableHead>
                <TableHead className="text-right">OK / failed</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.queues.map((q) => (
                <TableRow key={q.queue}>
                  <TableCell className="font-mono text-xs">{q.queue}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS[q.status].variant}>{STATUS[q.status].label}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.depth ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.oldestAgeSec ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {q.handler ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {fmt(q.lastRun?.started_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {q.lastRun ? `${q.lastRun.processed} / ${q.lastRun.failed}` : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {q.handler && <RunNowButton queue={q.queue} label="Drain" size="sm" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cron pings</CardTitle>
            <CardDescription>
              {health.cronAvailable
                ? "pg_cron jobs calling /api/jobs/*"
                : "pg_cron is not available on this database (local dev)."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {health.cron.length === 0 ? (
              <p className="text-muted-foreground text-sm">No cron jobs found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.cron.map((c) => (
                    <TableRow key={c.jobname}>
                      <TableCell className="font-mono text-xs">
                        {c.jobname.replace("pulse:", "")}
                      </TableCell>
                      <TableCell className="text-xs">{c.schedule}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {fmt(c.last_start)}
                      </TableCell>
                      <TableCell>
                        {!c.active ? (
                          <Badge variant="outline">Paused</Badge>
                        ) : c.last_status === "failed" ? (
                          <Badge variant="destructive">Failed</Badge>
                        ) : c.last_status ? (
                          <Badge variant="success">{c.last_status}</Badge>
                        ) : (
                          <Badge variant="secondary">—</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>Latest job_runs rows (empty drains are not logged).</CardDescription>
          </CardHeader>
          <CardContent>
            {health.recentRuns.length === 0 ? (
              <p className="text-muted-foreground text-sm">No runs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Queue</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="text-right">OK</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.recentRuns.slice(0, 20).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.queue}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {fmt(r.started_at)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.processed}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.failed}</TableCell>
                      <TableCell
                        className="text-destructive max-w-56 truncate text-xs"
                        title={r.error ?? undefined}
                      >
                        {r.error ?? ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dead letters</CardTitle>
          <CardDescription>
            Messages that failed too many times. Retry re-queues them; discard marks them resolved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {health.deadLetters.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing here. Good.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.deadLetters.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.queue}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {fmt(d.created_at)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{d.attempts}</TableCell>
                    <TableCell className="max-w-72 truncate text-xs" title={d.error ?? undefined}>
                      {d.error ?? ""}
                    </TableCell>
                    <TableCell className="text-right">
                      <DeadLetterActions id={d.id} />
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

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone?: "good" | "bad";
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-3xl tabular-nums ${tone === "bad" ? "text-destructive" : tone === "good" ? "text-emerald-600" : ""}`}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">{hint}</CardContent>
    </Card>
  );
}
