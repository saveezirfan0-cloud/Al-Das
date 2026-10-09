import "server-only";

import { randomUUID } from "node:crypto";

import { createDbPorts } from "@/lib/flow-engine/ports-db";
import { runStep, type RunState, type StepOutcome, type WaitState } from "@/lib/flow-engine/runner";
import { buildScope, type RunRow } from "@/lib/flow-engine/scope";
import {
  enqueueStep,
  finishRun,
  loadGraph,
  startRun,
  type StepJob,
} from "@/lib/flow-engine/service";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const MAX_STEPS_JSON = 60_000;
const LOCK_TTL_SECONDS = 60;

/** Keep run state small: a chatty API response must not grow the run row without bound. */
export function capSteps(steps: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(steps).length <= MAX_STEPS_JSON) return steps;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(steps))
    out[k] = JSON.stringify(v).length > 8_000 ? { truncated: true } : v;
  return out;
}

export type StepResult = "done" | "stale" | "locked";

const isWaitState = (w: unknown): w is WaitState => {
  const o = obj(w);
  return (
    (o.type === "reply" || o.type === "time") &&
    typeof o.node_id === "string" &&
    typeof o.token === "number"
  );
};

/**
 * One node of one run. Safe to call twice for the same job: the (run, expect) check drops stale
 * deliveries, the lease serialises steps per conversation, and sends are keyed by step.
 */
export async function processStep(
  admin: AdminClient,
  job: StepJob,
  holder: string = randomUUID(),
): Promise<StepResult> {
  const load = async () =>
    (await admin.from("flow_runs").select("*").eq("id", job.run_id).maybeSingle()).data;
  let run = await load();
  const live = (r: RunRow | null): r is RunRow =>
    !!r && (r.status === "running" || r.status === "waiting") && r.step_count === job.expect;
  if (!live(run)) return "stale";

  const lockKey = run.conversation_id ?? run.id;
  const { data: got } = await admin.rpc("flow_lock_acquire", {
    p_key: lockKey,
    p_holder: holder,
    p_ttl_seconds: LOCK_TTL_SECONDS,
  });
  if (!got) return "locked";

  try {
    run = await load(); // re-read under the lease: another worker may have just finished this step
    if (!live(run)) return "stale";

    const wait = isWaitState(run.wait) ? run.wait : null;
    if (run.status === "waiting") {
      if (!wait || wait.token !== job.token || job.input.type === "start") return "stale";
    } else if (job.input.type !== "start") return "stale";

    const { data: flow } = await admin
      .from("flows")
      .select("id, created_by, published_by")
      .eq("id", run.flow_id)
      .maybeSingle();
    const graph = await loadGraph(admin, run.flow_id, run.flow_version);
    if (!flow || !graph) {
      await recordTrace(admin, run, run.step_count + 1, {
        nodeId: run.current_node_id ?? "?",
        nodeType: "unknown",
        status: "failed",
        handle: null,
        detail: {},
        error: "The flow or its published version is gone.",
      });
      await finishRun(admin, run, "failed", {
        error: "The flow or its published version is gone.",
      });
      return "done";
    }

    const scopeRun =
      job.input.type === "reply" && job.input.message_id
        ? { ...run, context: { ...obj(run.context), message_id: job.input.message_id } }
        : run;
    const { scope, timezone } = await buildScope(admin, scopeRun);
    const seq = run.step_count + 1;
    const ports = createDbPorts({
      admin,
      run,
      ownerId: flow.published_by ?? flow.created_by,
      timezone,
      seq,
      live: !!run.conversation_id,
    });

    const state: RunState = {
      currentNodeId: wait?.node_id ?? run.current_node_id,
      stepCount: run.step_count,
      waitSeq: run.wait_seq,
      vars: obj(run.vars),
      steps: obj(run.steps),
      context: obj(run.context) as Record<string, string>,
    };
    const outcome = await runStep(graph, state, job.input, () => ({ scope, ports }));

    await recordTrace(admin, run, seq, outcome.trace);
    await persist(admin, run, outcome, seq);
    return "done";
  } finally {
    await admin.rpc("flow_lock_release", { p_key: lockKey, p_holder: holder });
  }
}

async function recordTrace(
  admin: AdminClient,
  run: Pick<RunRow, "id" | "org_id">,
  seq: number,
  t: Omit<StepOutcome["trace"], "seq">,
): Promise<void> {
  const { error } = await admin.from("flow_run_steps").upsert(
    {
      org_id: run.org_id,
      run_id: run.id,
      seq,
      node_id: t.nodeId,
      node_type: t.nodeType,
      status: t.status === "failed" ? "failed" : t.status === "waiting" ? "waiting" : "ok",
      handle: t.handle,
      detail: t.detail as Json as NonNullable<Json>,
      error: t.error ? redactText(t.error, 300) : null,
    },
    { onConflict: "run_id,seq", ignoreDuplicates: true },
  );
  if (error) throw new Error(`flow trace: ${error.code}`);
}

async function persist(
  admin: AdminClient,
  run: RunRow,
  o: StepOutcome,
  seq: number,
): Promise<void> {
  const base = {
    vars: o.vars as Json as NonNullable<Json>,
    steps: capSteps(o.steps) as Json as NonNullable<Json>,
    context: o.context as Json as NonNullable<Json>,
    step_count: seq,
  };

  switch (o.next.kind) {
    case "continue": {
      await admin
        .from("flow_runs")
        .update({ ...base, status: "running", current_node_id: o.next.nodeId, wait: null })
        .eq("id", run.id);
      await enqueueStep({ type: "step", run_id: run.id, expect: seq, input: { type: "start" } });
      return;
    }
    case "wait": {
      const w = o.next.wait;
      await admin
        .from("flow_runs")
        .update({
          ...base,
          status: "waiting",
          current_node_id: w.node_id,
          wait: w as unknown as NonNullable<Json>,
          wait_seq: w.token,
        })
        .eq("id", run.id);
      if (w.expires_at) {
        await scheduleJob({
          kind: w.type === "reply" ? "flow.timeout" : "flow.wake",
          orgId: run.org_id,
          runAt: new Date(w.expires_at),
          payload: { run_id: run.id, token: w.token },
          dedupeKey: `flow:${run.id}:${w.token}`,
        });
      }
      return;
    }
    case "completed": {
      await admin
        .from("flow_runs")
        .update({ ...base, current_node_id: null })
        .eq("id", run.id);
      await finishRun(admin, run, "completed");
      return;
    }
    case "failed": {
      await admin
        .from("flow_runs")
        .update({ ...base })
        .eq("id", run.id);
      await finishRun(admin, run, "failed", { error: redactText(o.next.error, 300) });
      return;
    }
    case "transfer": {
      await admin
        .from("flow_runs")
        .update({ ...base, current_node_id: null })
        .eq("id", run.id);
      await finishRun(admin, run, "completed");
      const { data: target } = await admin
        .from("flows")
        .select("*")
        .eq("id", o.next.flowId)
        .eq("org_id", run.org_id)
        .maybeSingle();
      if (!target) {
        await admin
          .from("flow_runs")
          .update({ error: "Run flow: the target flow no longer exists." })
          .eq("id", run.id);
        return;
      }
      const r = await startRun(admin, target, {
        conversationId: run.conversation_id,
        contactId: run.contact_id,
        context: obj(run.context) as Record<string, string>,
        event: obj(run.event),
        parentRunId: run.id,
        depth: run.depth + 1,
        startedBy: run.started_by,
      });
      if (r.status === "skipped")
        await admin
          .from("flow_runs")
          .update({ error: `Run flow was skipped (${r.reason}).` })
          .eq("id", run.id);
      return;
    }
  }
}

/** The job gave up (dead-lettered): make the run's state match so it does not sit "running" forever. */
export async function failRunAfterRetries(
  admin: AdminClient,
  runId: string,
  reason: string,
): Promise<void> {
  const { data: run } = await admin
    .from("flow_runs")
    .select("id, org_id, conversation_id, status, step_count, current_node_id")
    .eq("id", runId)
    .maybeSingle();
  if (!run || (run.status !== "running" && run.status !== "waiting")) return;
  await recordTrace(admin, run, run.step_count + 1, {
    nodeId: run.current_node_id ?? "?",
    nodeType: "unknown",
    status: "failed",
    handle: null,
    detail: {},
    error: reason,
  });
  await finishRun(admin, run, "failed", { error: reason });
}
