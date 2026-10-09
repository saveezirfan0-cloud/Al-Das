/**
 * Maintenance tasks: cron-pinged routines that are not queue drains
 * (e.g. /api/jobs/inbox_housekeeping). They share job_runs logging with drains.
 */
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type TaskRunner = (admin: AdminClient, log: JobLogger) => Promise<Json>;

const tasks = new Map<string, { name: string; run: TaskRunner }>();

export function registerTask(key: string, def: { name: string; run: TaskRunner }): void {
  tasks.set(key, def);
}

export function getTask(key: string): { name: string; run: TaskRunner } | undefined {
  return tasks.get(key);
}

export function listTasks(): string[] {
  return [...tasks.keys()];
}

export function clearTasks(): void {
  tasks.clear();
}
