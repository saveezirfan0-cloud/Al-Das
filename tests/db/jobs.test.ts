/**
 * Scheduler claim (FOR UPDATE SKIP LOCKED) and pgmq wrappers against a real database.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asServiceRole, connect, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("jobs framework (db)", () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
  });
  beforeEach(async () => {
    await resetDb(c);
  });
  afterAll(async () => {
    await c?.end();
  });

  it("claims only due, unlocked jobs; two workers never get the same row", async () => {
    await c.query(`
      insert into public.scheduled_jobs (kind, run_at, attempts, max_attempts, locked_at) values
        ('a', now() - interval '2 minutes', 0, 5, null),
        ('b', now() - interval '1 minute', 0, 5, null),
        ('future', now() + interval '1 hour', 0, 5, null),
        ('exhausted', now() - interval '1 minute', 5, 5, null),
        ('fresh-lock', now() - interval '1 minute', 1, 5, now() - interval '1 minute'),
        ('stale-lock', now() - interval '1 minute', 1, 5, now() - interval '10 minutes')
    `);

    const w1 = await connect();
    const w2 = await connect();
    try {
      await w1.query("set role service_role");
      await w2.query("set role service_role");
      await w1.query("begin");
      const first = await w1.query<{ kind: string; attempts: number; locked_by: string }>(
        "select kind, attempts, locked_by from public.claim_scheduled_jobs(1, 'w1')",
      );
      expect(first.rows.map((r) => r.kind)).toEqual(["a"]);
      expect(first.rows[0]).toMatchObject({ attempts: 1, locked_by: "w1" });

      // While w1 holds its row (uncommitted), w2 skips it and gets the rest.
      const second = await w2.query<{ kind: string }>(
        "select kind from public.claim_scheduled_jobs(10, 'w2')",
      );
      expect(second.rows.map((r) => r.kind).sort()).toEqual(["b", "stale-lock"]);
      await w1.query("commit");

      // Nothing left to claim.
      const third = await w2.query("select kind from public.claim_scheduled_jobs(10, 'w2')");
      expect(third.rowCount).toBe(0);
    } finally {
      await w1.end();
      await w2.end();
    }
  });

  it("complete / fail / dead-letter lifecycle", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "insert into public.scheduled_jobs (kind, run_at, max_attempts) values ('x', now() - interval '1 minute', 2) returning id",
      );
      const id = rows[0].id;

      let claimed = await c.query("select id from public.claim_scheduled_jobs(5, 'w')");
      expect(claimed.rowCount).toBe(1);
      await c.query("select public.fail_scheduled_job($1, 'boom', interval '0 seconds')", [id]);
      let job = (
        await c.query(
          "select attempts, locked_at, last_error, done_at from public.scheduled_jobs where id = $1",
          [id],
        )
      ).rows[0];
      expect(job).toMatchObject({
        attempts: 1,
        locked_at: null,
        last_error: "boom",
        done_at: null,
      });

      claimed = await c.query("select id from public.claim_scheduled_jobs(5, 'w')");
      expect(claimed.rowCount).toBe(1);
      await c.query("select public.fail_scheduled_job($1, 'boom again', interval '0 seconds')", [
        id,
      ]);
      job = (
        await c.query("select attempts, done_at from public.scheduled_jobs where id = $1", [id])
      ).rows[0];
      expect(job.attempts).toBe(2);
      expect(job.done_at).not.toBeNull();

      const dl = await c.query(
        "select id, queue, scheduled_job_id, error, attempts, payload from public.dead_letters",
      );
      expect(dl.rowCount).toBe(1);
      expect(dl.rows[0]).toMatchObject({
        queue: "scheduled_jobs",
        scheduled_job_id: id,
        error: "boom again",
        attempts: 2,
      });
      expect(dl.rows[0].payload.kind).toBe("x");

      // Retrying a scheduled_jobs dead letter re-creates the job.
      await c.query("select public.job_retry_dead_letter($1)", [dl.rows[0].id]);
      expect(
        (
          await c.query(
            "select count(*)::int as n from public.scheduled_jobs where done_at is null and kind = 'x'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await c.query("select resolution from public.dead_letters")).rows[0].resolution).toBe(
        "retried",
      );

      // Completing marks done and clears the lock.
      const { rows: again } = await c.query("select id from public.claim_scheduled_jobs(5, 'w')");
      await c.query("select public.complete_scheduled_job($1)", [again[0].id]);
      expect(
        (
          await c.query("select done_at, locked_at from public.scheduled_jobs where id = $1", [
            again[0].id,
          ])
        ).rows[0],
      ).toMatchObject({ locked_at: null });
    });
  });

  it("dedupe_key allows one pending job per key", async () => {
    await c.query("insert into public.scheduled_jobs (kind, dedupe_key) values ('x', 'k1')");
    await expect(
      c.query("insert into public.scheduled_jobs (kind, dedupe_key) values ('x', 'k1')"),
    ).rejects.toThrow(/duplicate key/);
    await c.query("update public.scheduled_jobs set done_at = now() where dedupe_key = 'k1'");
    await c.query("insert into public.scheduled_jobs (kind, dedupe_key) values ('x', 'k1')"); // allowed again
  });

  it("pgmq wrappers: enqueue, read, archive, dead-letter, metrics", async () => {
    await asServiceRole(c, async () => {
      const { rows: sent } = await c.query<{ id: string }>(
        "select public.job_enqueue('outbound', '{\"to\":\"x\"}'::jsonb) as id",
      );
      await c.query("select public.job_enqueue('outbound', '{\"to\":\"y\"}'::jsonb, 3600)"); // delayed: not visible yet

      const read = await c.query(
        "select msg_id, read_ct, message from public.job_read('outbound', 30, 10)",
      );
      expect(read.rowCount).toBe(1);
      expect(read.rows[0]).toMatchObject({ msg_id: sent[0].id, read_ct: 1, message: { to: "x" } });

      // Hidden by the visibility timeout now.
      expect(
        (await c.query("select msg_id from public.job_read('outbound', 30, 10)")).rowCount,
      ).toBe(0);

      const archived = await c.query("select public.job_archive('outbound', $1::bigint[]) as n", [
        [sent[0].id],
      ]);
      expect(archived.rows[0].n).toBe(1);

      const metrics = await c.query(
        "select queue_name, queue_length from public.job_queue_metrics() where queue_name = 'outbound'",
      );
      expect(metrics.rows[0].queue_length).toBe("1"); // the delayed one

      // Dead-letter a message, then retry it back onto the queue.
      const { rows: poison } = await c.query<{ id: string }>(
        "select public.job_enqueue('notifications', '{\"type\":\"nope\"}'::jsonb) as id",
      );
      const { rows: dl } = await c.query<{ id: string }>(
        "select public.job_dead_letter('notifications', $1, '{\"type\":\"nope\"}'::jsonb, 'invalid', 5) as id",
        [poison[0].id],
      );
      // pgmq's own tables are only readable by the owner; peek as superuser.
      await c.query("reset role");
      expect((await c.query("select count(*)::int as n from pgmq.q_notifications")).rows[0].n).toBe(
        0,
      );
      expect((await c.query("select count(*)::int as n from pgmq.a_notifications")).rows[0].n).toBe(
        1,
      );
      await c.query("set role service_role");
      // Idempotent: same (queue, msg_id) → same dead letter.
      const { rows: dl2 } = await c.query<{ id: string }>(
        "select public.job_dead_letter('notifications', $1, '{}'::jsonb, 'again', 6) as id",
        [poison[0].id],
      );
      expect(dl2[0].id).toBe(dl[0].id);

      await c.query("select public.job_retry_dead_letter($1)", [dl[0].id]);
      expect(
        (await c.query("select message from public.job_read('notifications', 1, 10)")).rows[0]
          .message,
      ).toEqual({ type: "nope" });
      expect(
        (await c.query("select resolution from public.dead_letters where id = $1", [dl[0].id]))
          .rows[0].resolution,
      ).toBe("retried");
    });
  });

  it("cron schedules exist for every queue plus scheduler and housekeeping", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ jobname: string }>(
        "select jobname from public.job_cron_status()",
      );
      const names = rows.map((r) => r.jobname.replace("pulse:", "")).sort();
      expect(names).toEqual([
        "appointments",
        "appointments_sweep",
        "campaign_fanout",
        "clinical_evaluate",
        "finance_capture",
        "finance_capture_tick",
        "finance_maintenance",
        "flow_recurring",
        "flow_steps",
        "housekeeping",
        "housekeeping_phase3",
        "housekeeping_rate_limits",
        "inbox_housekeeping",
        "kb_ingest",
        "media_fetch",
        "meta_events",
        "notifications",
        "outbound",
        "outbound_priority",
        "parallel_run",
        "recall_run",
        "scheduler",
        "unite_enqueue",
        "unite_housekeeping",
        "unite_nightly",
        "unite_sync",
        "webhooks_out",
      ]);
    });
  });
});
