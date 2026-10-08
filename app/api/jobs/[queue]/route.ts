import { NextResponse, type NextRequest } from "next/server";

import "@/lib/jobs/handlers";

import { serverEnv } from "@/lib/env";
import { dbDrainDeps, dbSchedulerDeps } from "@/lib/jobs/db";
import { isQueueName, SCHEDULER_QUEUE } from "@/lib/jobs/queues";
import { getHandler } from "@/lib/jobs/registry";
import { drainQueue } from "@/lib/jobs/runner";
import { secretMatches } from "@/lib/jobs/secret";
import { runScheduler } from "@/lib/jobs/scheduler";
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
