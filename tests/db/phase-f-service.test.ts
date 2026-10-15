/**
 * Phase F services against a real Postgres through PostgREST: the snooze job, recurring tasks (on completion and on
 * schedule, idempotent), the hourly daily-checklist run, task.assigned and task.mentioned notifications (ids only),
 * and the bulk paths. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT. Synthetic data only.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { handleScheduled } from "@/lib/jobs/handlers/reminders";
import { runTasksDaily } from "@/lib/jobs/handlers/tasks-daily";
import type { JobLogger } from "@/lib/jobs/types";
import { handleUnsnooze, setSnooze } from "@/lib/inbox/snooze-server";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { addTaskComment } from "@/lib/tasks/extras";
import { createTask, setTasksDone, updateTask } from "@/lib/tasks/service";

import { asServiceRole, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

const silent: JobLogger = { info: () => {}, warn: () => {}, error: () => {} } as JobLogger;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("phase F services", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let owner: string;
  let colleague: string;
  let outsider: string;
  let north: string;

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", params)).rows[0].id;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const rows = <T>(sql: string, p: unknown[] = []) => svc(async () => (await c.query(sql, p)).rows as T[]);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
    process.env.JOB_SECRET = "test-job-secret-0123456789";
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.APP_URL = "https://pulse.test";
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as AdminClient;
    owner = await createAuthUser(c, "owner-pfs@example.test");
    colleague = await createAuthUser(c, "colleague-pfs@example.test");
    outsider = await createAuthUser(c, "outsider-pfs@example.test");
    org = await createOrg(c, "Org PFS", "org-pfs", owner);
    await svc(async () => {
      await c.query("update public.orgs set timezone = 'Asia/Dubai' where id = $1", [org]);
      const role = await one(
        `insert into public.roles (org_id, name, permissions) values ($1, 'Desk PFS', '["tasks.view","tasks.manage"]'::jsonb)`,
        [org],
      );
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [org, colleague, role]);
      const noTasks = await one(
        `insert into public.roles (org_id, name, permissions) values ($1, 'Inbox PFS', '["inbox.send"]'::jsonb)`,
        [org],
      );
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [org, outsider, noTasks]);
      north = await one("insert into public.locations (org_id, name, timezone) values ($1, 'North PFS', 'Asia/Dubai')", [org]);
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const ctx = () => ({ admin, orgId: org, userId: owner });

  describe("snooze", () => {
    it("schedules a wake-up job and the job only clears the same snooze, once", async () => {
      const conv = await svc(async () => {
        const ch = await one("insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'PFS', 'waba-pfs', 'pn-pfs')", [org]);
        const ct = await one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-41', '+447700900941')", [org]);
        return one("insert into public.conversations (org_id, channel_id, contact_id, status) values ($1, $2, $3, 'waiting')", [org, ch, ct]);
      });
      const until = new Date(Date.now() + 3600_000);
      expect(await setSnooze(admin, { orgId: org, userId: owner, conversationId: conv, until })).toBe(true);
      const jobs = await rows<{ kind: string; payload: { until: string } }>(
        "select kind, payload from public.scheduled_jobs where org_id = $1 and kind = 'inbox.unsnooze'",
        [org],
      );
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0].payload.until).getTime()).toBe(until.getTime());
      // A job for an older snooze time does nothing.
      expect(
        await handleUnsnooze(admin, org, { conversation_id: conv, until: new Date(until.getTime() - 60_000).toISOString() }),
      ).toBe("stale");
      expect(await handleUnsnooze(admin, org, { conversation_id: conv, until: until.toISOString() })).toBe("woken");
      const after = await rows<{ snoozed_until: string | null; status: string }>(
        "select snoozed_until, status from public.conversations where id = $1",
        [conv],
      );
      expect(after[0]).toEqual({ snoozed_until: null, status: "open" });
      // A retry finds nothing to do; another org's job cannot touch it.
      expect(await handleUnsnooze(admin, org, { conversation_id: conv, until: until.toISOString() })).toBe("not_snoozed");
      // A closed chat cannot be snoozed.
      await svc(() => c.query("update public.conversations set status = 'closed', closed_at = now() where id = $1", [conv]));
      expect(await setSnooze(admin, { orgId: org, userId: owner, conversationId: conv, until })).toBe(false);
    });
  });

  describe("recurring tasks", () => {
    it("makes the next one on completion and on schedule, once", async () => {
      const due = new Date(Date.now() + 2 * 3600_000);
      const { id } = await createTask(ctx(), {
        type: "other",
        subject: "Check the fridge (synthetic)",
        dueAt: due.toISOString(),
        recurrence: "daily",
        locationId: north,
      });
      const recur = await rows<{ run_at: string }>(
        "select run_at from public.scheduled_jobs where org_id = $1 and kind = 'task.recur' and payload->>'task_id' = $2",
        [org, id],
      );
      expect(recur).toHaveLength(1);
      expect(new Date(recur[0].run_at).getTime()).toBe(due.getTime());
      expect(await setTasksDone(ctx(), [id], true)).toBe(1);
      const series = () =>
        rows<{ id: string; due_at: string; done: boolean }>(
          "select id::text, due_at, done from public.tasks where id = $1 or series_id = $1 order by due_at",
          [id],
        );
      let all = await series();
      expect(all).toHaveLength(2);
      expect(new Date(all[1].due_at).getTime() - due.getTime()).toBe(24 * 3600_000);
      // The scheduled job for the first one fires later: nothing more.
      const env = { kind: "task.recur", org_id: org, scheduled_job_id: "x", payload: { task_id: id, due_at: due.toISOString() } };
      expect(await handleScheduled(env, admin)).toBe("exists");
      // Reopening and completing again does not make another.
      await setTasksDone(ctx(), [id], false);
      await setTasksDone(ctx(), [id], true);
      all = await series();
      expect(all).toHaveLength(2);
      // The second one's job, on schedule (not ticked off), makes the third.
      const env2 = { ...env, payload: { task_id: all[1].id, due_at: new Date(all[1].due_at).toISOString() } };
      expect(await handleScheduled(env2, admin)).toBe("spawned");
      expect(await handleScheduled(env2, admin)).toBe("exists");
      expect(await series()).toHaveLength(3);
      // A job for a moved task does nothing (the move scheduled its own).
      expect(
        await handleScheduled({ ...env2, payload: { ...env2.payload, due_at: new Date(0).toISOString() } }, admin),
      ).toBe("moved");
    });
  });

  describe("daily checklists", () => {
    it("generates once per branch and day and schedules the due reminder", async () => {
      const tpl = await svc(() =>
        one(
          `insert into public.task_checklist_templates (org_id, location_id, name, items, generate_at, due_time)
           values ($1, $2, 'Opening PFS', '["Lights","Float"]'::jsonb, '06:00', '23:30')`,
          [org, north],
        ),
      );
      // 07:00 in Dubai tomorrow, so the 23:30 due time is ahead whatever time the test runs.
      const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", {
        timeZone: "Asia/Dubai",
      });
      const now = new Date(`${tomorrow}T03:00:00Z`);
      const first = await runTasksDaily(admin, silent, now);
      expect(first.created).toBe(1);
      expect((await runTasksDaily(admin, silent, now)).created).toBe(0);
      const made = await rows<{ id: string }>("select id::text from public.tasks where checklist_template_id = $1", [tpl]);
      expect(made).toHaveLength(1);
      const reminders = await rows<{ n: string }>(
        "select count(*)::text as n from public.scheduled_jobs where kind = 'task.due' and payload->>'task_id' = $1",
        [made[0].id],
      );
      expect(Number(reminders[0].n)).toBe(1);
    });
  });

  describe("notifications", () => {
    it("tells a new assignee (ids only) but not someone who assigns themselves", async () => {
      const { id } = await createTask(ctx(), {
        type: "call",
        subject: "Call Layla Demo-41 back",
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        assigneeId: colleague,
      });
      const notes = await rows<{ user_id: string; payload: Record<string, unknown> }>(
        "select user_id::text, payload from public.notifications where type = 'task.assigned' and org_id = $1",
        [org],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].user_id).toBe(colleague);
      expect(notes[0].payload).toEqual({ task_id: id });
      await updateTask(ctx(), id, { assigneeId: owner });
      const again = await rows("select id from public.notifications where type = 'task.assigned' and org_id = $1", [org]);
      expect(again).toHaveLength(1);
      // Someone without tasks.view is never told (they could not open it).
      await updateTask(ctx(), id, { assigneeId: outsider });
      const outsiders = await rows("select id from public.notifications where type = 'task.assigned' and user_id = $1", [outsider]);
      expect(outsiders).toHaveLength(0);
    });

    it("turns @mentions into plain text and a task.mentioned notification for people who can open the task", async () => {
      const { id } = await createTask(ctx(), {
        type: "other",
        subject: "Synthetic mention task",
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const r = await addTaskComment(
        ctx(),
        id,
        `Please check @[Colleague PFS](${colleague}) and @[Inbox PFS](${outsider})`,
        "Owner PFS",
      );
      expect(r.mentioned).toBe(1);
      const comments = await rows<{ body: string; mentioned_user_ids: string[] }>(
        "select body, mentioned_user_ids::text[] as mentioned_user_ids from public.task_comments where task_id = $1",
        [id],
      );
      expect(comments[0].body).toBe("Please check @Colleague PFS and @Inbox PFS");
      expect(comments[0].mentioned_user_ids).toEqual([colleague]);
      const notes = await rows<{ user_id: string; payload: Record<string, unknown> }>(
        "select user_id::text, payload from public.notifications where type = 'task.mentioned' and org_id = $1",
        [org],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].user_id).toBe(colleague);
      expect(Object.keys(notes[0].payload).sort()).toEqual(["comment_id", "task_id"]);
    });
  });
});
