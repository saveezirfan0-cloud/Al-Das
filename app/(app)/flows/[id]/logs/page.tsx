import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { RUN_STATUS_LABELS } from "@/lib/flow-engine/labels";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Flow logs" };

const STATUS_STYLE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  waiting: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  cancelled: "bg-muted text-muted-foreground",
};

export default async function FlowLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const member = await requirePerm("flows.manage");
  const { id } = await params;
  const { status } = await searchParams;
  const admin = createAdminClient();
  const { data: flow } = await admin
    .from("flows")
    .select("id, name")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!flow) notFound();
  let q = admin
    .from("flow_runs")
    .select(
      "id, status, started_at, ended_at, step_count, error, flow_version, contacts(first_name, last_name)",
    )
    .eq("flow_id", id)
    .eq("org_id", member.orgId)
    .order("started_at", { ascending: false })
    .limit(100);
  if (status && status in RUN_STATUS_LABELS) q = q.eq("status", status);
  const { data: runs } = await q;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Logs — ${flow.name}`}
        description="Every run with the steps it took. Latest 100."
      >
        <Button variant="outline" asChild>
          <Link href={`/flows/${id}`}>Back to builder</Link>
        </Button>
      </PageHeader>
      <div className="flex flex-wrap gap-2 text-sm">
        {[["", "All"], ...Object.entries(RUN_STATUS_LABELS)].map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/flows/${id}/logs?status=${value}` : `/flows/${id}/logs`}
            className={`rounded-full border px-3 py-1 ${(status ?? "") === value ? "bg-accent" : "hover:bg-accent/50"}`}
          >
            {label}
          </Link>
        ))}
      </div>
      {!runs?.length ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No runs yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Problem</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link href={`/flows/${id}/logs/${r.id}`} className="hover:underline">
                    {new Date(r.started_at).toLocaleString("en-GB", {
                      timeZone: "Asia/Dubai",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Link>
                </TableCell>
                <TableCell className="text-sm">
                  {r.contacts
                    ? `${r.contacts.first_name} ${r.contacts.last_name}`.trim() || "—"
                    : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={STATUS_STYLE[r.status]}>
                    {RUN_STATUS_LABELS[r.status] ?? r.status}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">{r.step_count}</TableCell>
                <TableCell>v{r.flow_version}</TableCell>
                <TableCell className="text-muted-foreground max-w-xs truncate text-sm">
                  {r.error ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
