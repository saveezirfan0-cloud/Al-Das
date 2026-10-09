import * as React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleSlash,
  Hourglass,
  Loader2,
} from "lucide-react";

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
import { flowGraphSchema, NODE_META } from "@/lib/flow-engine/types";
import { createClient } from "@/lib/supabase/server";

import { AutoRefresh } from "../../../campaigns/auto-refresh";
import { StopRunButton } from "./stop-button";

export const metadata = { title: "Flow logs" };
export const dynamic = "force-dynamic";

const PAGE = 25;
const STATUSES = ["all", "running", "waiting", "completed", "failed", "cancelled"] as const;
type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const STATUS_BADGE: Record<
  string,
  {
    variant: "default" | "secondary" | "outline" | "success" | "warning" | "destructive";
    label: string;
  }
> = {
  running: { variant: "default", label: "Running" },
  waiting: { variant: "secondary", label: "Waiting" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "destructive", label: "Failed" },
  cancelled: { variant: "outline", label: "Stopped" },
};

const CANCEL_REASON: Record<string, string> = {
  takeover: "A person took over the conversation",
  conversation_closed: "The conversation was closed",
  stopped_manually: "Stopped from this page",
  flow_deleted: "The flow was deleted",
};

export default async function FlowLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("flows.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const status = (STATUSES as readonly string[]).includes(one(sp.status)) ? one(sp.status) : "all";
  const page = Math.max(1, Number.parseInt(one(sp.page), 10) || 1);
  const openId = one(sp.run);

  const supabase = await createClient();
  const [{ data: flow }, { data: org }] = await Promise.all([
    supabase
      .from("flows")
      .select("id, name, version")
      .eq("id", id)
      .eq("org_id", member.orgId)
      .maybeSingle(),
    supabase.from("orgs").select("timezone").eq("id", member.orgId).maybeSingle(),
  ]);
  if (!flow) notFound();
  const tz = org?.timezone ?? "Asia/Dubai";
  const when = (v: string | null) =>
    v ? formatInTimeZone(new Date(v), tz, "d MMM, HH:mm:ss") : "—";

  let q = supabase
    .from("flow_runs")
    .select(
      "id, status, started_at, finished_at, step_count, error, cancel_reason, flow_version, contacts(first_name, last_name)",
      { count: "exact" },
    )
    .eq("org_id", member.orgId)
    .eq("flow_id", id)
    .order("started_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (status !== "all") q = q.eq("status", status);
  const { data: runs, count } = await q;
  const anyLive = (runs ?? []).some((r) => r.status === "running" || r.status === "waiting");

  const href = (patch: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged = {
      status: status === "all" ? null : status,
      page: page > 1 ? page : null,
      run: openId || null,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== "") p.set(k, String(v));
    const s = p.toString();
    return `/flows/${id}/logs${s ? `?${s}` : ""}`;
  };

  // Selected run: its steps, with node labels taken from the version it ran.
  let detail: null | {
    run: NonNullable<typeof runs>[number];
    steps: Array<{
      seq: number;
      node_id: string;
      node_type: string;
      status: string;
      handle: string | null;
      detail: unknown;
      error: string | null;
      started_at: string;
    }>;
    labels: Map<string, string>;
    vars: Record<string, unknown>;
  } = null;
  if (openId && /^[0-9a-f-]{36}$/i.test(openId)) {
    const run = (runs ?? []).find((r) => r.id === openId);
    const { data: full } = await supabase
      .from("flow_runs")
      .select("vars, flow_version")
      .eq("id", openId)
      .eq("org_id", member.orgId)
      .eq("flow_id", id)
      .maybeSingle();
    if (full) {
      const [{ data: steps }, { data: ver }, runRow] = await Promise.all([
        supabase
          .from("flow_run_steps")
          .select("seq, node_id, node_type, status, handle, detail, error, started_at")
          .eq("run_id", openId)
          .order("seq"),
        supabase
          .from("flow_versions")
          .select("graph")
          .eq("flow_id", id)
          .eq("version", full.flow_version)
          .maybeSingle(),
        run
          ? Promise.resolve({ data: run })
          : supabase
              .from("flow_runs")
              .select(
                "id, status, started_at, finished_at, step_count, error, cancel_reason, flow_version, contacts(first_name, last_name)",
              )
              .eq("id", openId)
              .maybeSingle(),
      ]);
      const parsed = flowGraphSchema.safeParse(ver?.graph);
      const labels = new Map<string, string>();
      if (parsed.success)
        for (const n of parsed.data.nodes) labels.set(n.id, NODE_META[n.type].label);
      if (runRow.data)
        detail = {
          run: runRow.data as never,
          steps: steps ?? [],
          labels,
          vars: (full.vars ?? {}) as Record<string, unknown>,
        };
    }
  }

  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));

  return (
    <div className="space-y-4">
      <AutoRefresh active={anyLive} seconds={8} />
      <PageHeader
        title={`${flow.name}: run logs`}
        description="Every run, step by step. Message text is not stored here, only what each step did."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`/flows/${id}`}>
            <ArrowLeft className="size-4" />
            Builder
          </Link>
        </Button>
      </PageHeader>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter runs by status">
        {STATUSES.map((s) => (
          <Button key={s} asChild size="sm" variant={s === status ? "default" : "outline"}>
            <Link
              href={href({ status: s === "all" ? null : s, page: null, run: null })}
              role="tab"
              aria-selected={s === status}
            >
              {s === "all" ? "All" : STATUS_BADGE[s].label}
            </Link>
          </Button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runs ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground h-24 text-center">
                    No runs
                    {status !== "all"
                      ? ` that are ${STATUS_BADGE[status].label.toLowerCase()}`
                      : " yet"}
                    .
                  </TableCell>
                </TableRow>
              ) : (
                (runs ?? []).map((r) => {
                  const c = r.contacts as { first_name?: string; last_name?: string } | null;
                  const name =
                    `${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim() || "No patient";
                  const b = STATUS_BADGE[r.status] ?? STATUS_BADGE.completed;
                  return (
                    <TableRow key={r.id} data-state={r.id === openId ? "selected" : undefined}>
                      <TableCell>
                        <Link href={href({ run: r.id })} className="font-medium hover:underline">
                          {when(r.started_at)}
                        </Link>
                        <div className="text-muted-foreground text-xs">v{r.flow_version}</div>
                      </TableCell>
                      <TableCell>{name}</TableCell>
                      <TableCell className="tabular-nums">{r.step_count}</TableCell>
                      <TableCell>
                        <Badge variant={b.variant}>{b.label}</Badge>
                        {r.error ? (
                          <div className="text-destructive max-w-56 truncate pt-0.5 text-xs">
                            {r.error}
                          </div>
                        ) : null}
                        {r.cancel_reason ? (
                          <div className="text-muted-foreground max-w-56 truncate pt-0.5 text-xs">
                            {CANCEL_REASON[r.cancel_reason] ?? r.cancel_reason}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {pages > 1 ? (
            <div className="flex items-center justify-between border-t p-2 text-sm">
              <span className="text-muted-foreground">
                Page {page} of {pages}
              </span>
              <div className="flex gap-1.5">
                <Button asChild size="sm" variant="outline" disabled={page <= 1}>
                  <Link href={href({ page: page - 1 || null })} aria-disabled={page <= 1}>
                    Previous
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline" disabled={page >= pages}>
                  <Link href={href({ page: page + 1 })} aria-disabled={page >= pages}>
                    Next
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div>
          {detail ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">Run trace</h3>
                  <p className="text-muted-foreground text-xs">
                    {when(detail.run.started_at)} →{" "}
                    {detail.run.finished_at ? when(detail.run.finished_at) : "in progress"}
                  </p>
                </div>
                {detail.run.status === "running" || detail.run.status === "waiting" ? (
                  <StopRunButton runId={detail.run.id} />
                ) : null}
              </div>
              {detail.run.error ? (
                <p className="text-destructive text-sm">{detail.run.error}</p>
              ) : null}
              <ol className="space-y-1.5">
                {detail.steps.length === 0 ? (
                  <li className="text-muted-foreground text-sm">No steps ran.</li>
                ) : null}
                {detail.steps.map((s) => (
                  <li key={s.seq} className="flex items-start gap-2 rounded border p-2 text-sm">
                    <span className="mt-0.5">
                      {s.status === "ok" ? (
                        <CheckCircle2 className="size-4 text-emerald-600" aria-label="Done" />
                      ) : s.status === "failed" ? (
                        <AlertTriangle className="text-destructive size-4" aria-label="Failed" />
                      ) : s.status === "waiting" ? (
                        <Hourglass className="text-muted-foreground size-4" aria-label="Waiting" />
                      ) : (
                        <CircleSlash className="size-4" aria-label="Skipped" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium">
                          {s.seq}.{" "}
                          {detail!.labels.get(s.node_id) ??
                            NODE_META[s.node_type as keyof typeof NODE_META]?.label ??
                            s.node_type}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {formatInTimeZone(new Date(s.started_at), tz, "HH:mm:ss")}
                        </span>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {s.status === "waiting"
                          ? "waiting for the patient or a timer"
                          : s.handle
                            ? `left through “${s.handle.replace("option:", "")}”`
                            : ""}
                        {Object.keys((s.detail as object) ?? {}).length
                          ? ` · ${Object.entries(s.detail as Record<string, unknown>)
                              .map(([k, v]) => `${k}: ${typeof v === "object" ? "…" : String(v)}`)
                              .join(", ")}`
                          : ""}
                      </div>
                      {s.error ? <div className="text-destructive text-xs">{s.error}</div> : null}
                    </div>
                  </li>
                ))}
              </ol>
              {Object.keys(detail.vars).length ? (
                <div>
                  <h4 className="pb-1 text-xs font-medium uppercase tracking-wide">
                    Variables at the end
                  </h4>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    {Object.entries(detail.vars).map(([k, v]) => (
                      <React.Fragment key={k}>
                        <dt className="text-muted-foreground font-mono">{k}</dt>
                        <dd className="truncate">{typeof v === "object" ? "…" : String(v)}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full min-h-32 items-center justify-center rounded-md border border-dashed p-4 text-center text-sm">
              {anyLive ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Select a run to see its steps.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
