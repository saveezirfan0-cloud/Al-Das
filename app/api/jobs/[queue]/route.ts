import { NextResponse, type NextRequest } from "next/server";

import "@/lib/jobs/handlers";

import { serverEnv } from "@/lib/env";
import { dbDrainDeps, dbSchedulerDeps } from "@/lib/jobs/db";
import { isQueueName, SCHEDULER_QUEUE } from "@/lib/jobs/queues";
import { checkRateLimit, clientIp, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { getHandler } from "@/lib/jobs/registry";
import { consoleLogger, drainQueue, errorMessage } from "@/lib/jobs/runner";
import { secretMatches } from "@/lib/jobs/secret";
import { runScheduler } from "@/lib/jobs/scheduler";
import { getTask } from "@/lib/jobs/tasks";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/jobs/<queue>  (called by pg_cron via pg_net, or by `pnpm jobs:run`)
 * Header: X-Job-Secret: <JOB_SECRET>
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ queue: string }> },
) {
  const env = serverEnv();
  if (!secretMatches(request.headers.get("x-job-secret"), env.JOB_SECRET)) {
    const limited = await checkRateLimit(
      createAdminClient(),
      "jobs-bad-secret",
      clientIp(request.headers),
      RATE_RULES.jobsBadSecret,
    );
    if (!limited.allowed) return tooManyRequests(limited);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { queue } = await params;
  const admin = createAdminClient();

  if (queue === SCHEDULER_QUEUE) {
    const result = await runScheduler(dbSchedulerDeps(admin), {
      worker: `vercel:${process.env.VERCEL_REGION ?? "local"}`,
    });
    return NextResponse.json({ queue, ...result });
  }

  const task = getTask(queue);
  if (task) {
    const deps = dbDrainDeps(admin);
    const runId = await deps.startRun(queue, task.name);
    const started = Date.now();
    try {
      const result = await task.run(admin, consoleLogger);
      await deps.finishRun(runId, { processed: 1, failed: 0, meta: result });
      return NextResponse.json({ task: queue, runId, durationMs: Date.now() - started, result });
    } catch (err) {
      const error = errorMessage(err);
      await deps.finishRun(runId, { processed: 0, failed: 1, error });
      return NextResponse.json({ task: queue, runId, error }, { status: 500 });
    }
  }

  if (!isQueueName(queue)) {
    return NextResponse.json({ error: "unknown queue" }, { status: 404 });
  }
  if (!getHandler(queue)) {
    // Not an error: the queue exists but nothing drains it yet (later phase).
    return NextResponse.json(
      { queue, skipped: true, reason: "no handler registered" },
      { status: 200 },
    );
  }

  const result = await drainQueue(queue, dbDrainDeps(admin));
  return NextResponse.json(result, { status: result.error && result.read === 0 ? 500 : 200 });
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
