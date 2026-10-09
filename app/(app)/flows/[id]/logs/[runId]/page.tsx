import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, CircleDashed, Hourglass, MinusCircle, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { defFor } from "@/lib/flow-engine/catalog";
import { RUN_STATUS_LABELS } from "@/lib/flow-engine/labels";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Run trace" };

const ICON = {
  ok: <CheckCircle2 className="size-4 text-emerald-600" />,
  failed: <TriangleAlert className="size-4 text-amber-600" />,
  waiting: <Hourglass className="size-4 text-sky-600" />,
  running: <CircleDashed className="size-4 text-sky-600" />,
  skipped: <MinusCircle className="text-muted-foreground size-4" />,
} as const;

/** Strip engine internals and anything that looks like a secret before showing step output. */
function visibleOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const rest = { ...(output as Record<string, unknown>) };
  delete rest.__outcome;
  const text = JSON.stringify(rest, (k, v) =>
    /token|secret|authorization|password/i.test(k) ? "[hidden]" : v,
  );
  return text === "{}" ? null : text.slice(0, 600);
}

export default async function RunTracePage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const member = await requirePerm("flows.manage");
  const { id, runId } = await params;
  const admin = createAdminClient();
  const { data: run } = await admin
    .from("flow_runs")
    .select("*, flows(name), contacts(first_name, last_name)")
    .eq("id", runId)
    .eq("flow_id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!run) notFound();
  const { data: steps } = await admin
    .from("flow_run_steps")
    .select("*")
    .eq("run_id", runId)
    .eq("org_id", member.orgId)
    .order("seq");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Run trace — ${run.flows?.name ?? "Flow"}`}
        description={`${RUN_STATUS_LABELS[run.status] ?? run.status} · version ${run.flow_version} · ${run.step_count} steps`}
      >
        <Button variant="outline" asChild>
          <Link href={`/flows/${id}/logs`}>All runs</Link>
        </Button>
      </PageHeader>
      {run.error && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {run.error}
        </p>
      )}
      <ol className="flex flex-col">
        {(steps ?? []).map((s) => {
          const out = visibleOutput(s.output);
          return (
            <li key={s.id} className="flex gap-3 border-l pb-4 pl-4">
              <span className="-ml-[1.65rem] mt-0.5 rounded-full bg-background">
                {ICON[s.status as keyof typeof ICON]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">
                    {s.node_type === "trigger"
                      ? "Trigger"
                      : (defFor(s.node_type)?.label ?? s.node_type)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    #{s.seq} ·{" "}
                    {new Date(s.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai" })}
                    {s.finished_at
                      ? ` · ${Math.max(0, new Date(s.finished_at).getTime() - new Date(s.at).getTime())} ms`
                      : ""}
                  </span>
                </div>
                {s.error && <p className="text-sm text-amber-700 dark:text-amber-300">{s.error}</p>}
                {out && (
                  <pre className="text-muted-foreground mt-1 overflow-x-auto rounded-md bg-muted/50 p-2 text-xs">
                    {out}
                  </pre>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
