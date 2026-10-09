/**
 * The enquiry and task services and the reminder jobs, end to end against a real
 * Postgres through PostgREST. Runs only when TEST_DATABASE_URL, TEST_POSTGREST_URL
 * and TEST_SERVICE_JWT are set (see supabase/test/README.md). Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bulkApply,
  createEnquiry,
  deleteEnquiries,
  EnquiryError,
  moveStage,
  movePipeline,
  setStatus,
  updateEnquiry,
  type Ctx,
} from "@/lib/enquiries/service";
import { on } from "@/lib/events/emit";
import { handleScheduled } from "@/lib/jobs/handlers/reminders";
import { createTask, setTasksDone, updateTask } from "@/lib/tasks/service";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "enquiry + task services through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let ctx: Ctx;
    let org: string;
    let alice: string;
    let carol: string;
    let main: { id: string; s1: string; s2: string; s3: string };
    let second: { id: string; s1: string };
    const events: string[] = [];

    async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
      const { rows } = await c.query(sql, params);
      return rows[0] as T;
    }

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";

      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      carol = await createAuthUser(c, "carol@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      const role = await one<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [org],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, carol, role.id],
      );

      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      });
      ctx = { admin, orgId: org, userId: alice };

      const p1 = await one<{ id: string }>(
        "insert into public.pipelines (org_id, name, is_default, sla_minutes) values ($1, 'Reception', true, 30) returning id",
        [org],
      );
      const stage = async (pipeline: string, name: string, sort: number) =>
        (
          await one<{ id: string }>(
            "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, $3, $4) returning id",
            [org, pipeline, name, sort],
          )
        ).id;
      main = {
        id: p1.id,
        s1: await stage(p1.id, "New", 0),
        s2: await stage(p1.id, "Contacted", 1),
        s3: await stage(p1.id, "Booked", 2),
      };
      const p2 = await one<{ id: string }>(
        "insert into public.pipelines (org_id, name) values ($1, 'Insurance') returning id",
        [org],
      );
      second = { id: p2.id, s1: await stage(p2.id, "Review", 0) };

      on("*", (e) => {
        events.push(e.name);
      });
    });

    afterAll(async () => {
      await c?.end();
    });

    it("creates a numbered enquiry in the first stage, schedules its SLA, and records history", async () => {
      const created = await createEnquiry(ctx, {
        title: "Knee consult",
        pipelineId: main.id,
        assigneeId: null,
      });
      expect(created.number).toBe(1);
      const row = await one<{
        stage_id: string;
        sla_due_at: Date;
        created_at: Date;
        status: string;
      }>("select stage_id, sla_due_at, created_at, status from public.enquiries where id = $1", [
        created.id,
      ]);
      expect(row.stage_id).toBe(main.s1);
      expect(row.status).toBe("open");
      expect(row.sla_due_at.getTime() - row.created_at.getTime()).toBeGreaterThan(29 * 60_000);
      expect(row.sla_due_at.getTime() - row.created_at.getTime()).toBeLessThan(31 * 60_000);
      const job = await one<{ kind: string; dedupe_key: string }>(
        "select kind, dedupe_key from public.scheduled_jobs where dedupe_key = $1",
        [`enquiry_sla:${created.id}`],
      );
      expect(job.kind).toBe("enquiry.sla");
      const tl = await one<{ type: string }>(
        "select type from public.timeline_events where enquiry_id = $1",
        [created.id],
      );
      expect(tl.type).toBe("enquiry.created");
      expect(
        (
          await one<{ n: string }>(
            "select count(*)::text n from public.audit_log where action = 'enquiry.created'",
          )
        ).n,
      ).toBe("1");
      expect(events).toContain("enquiry.created");
    });

    it("rejects a stage from another pipeline or a missing pipeline", async () => {
      await expect(
        createEnquiry(ctx, { title: "x", pipelineId: main.id, stageId: second.s1 }),
      ).rejects.toBeInstanceOf(EnquiryError);
      await expect(
        createEnquiry(ctx, { title: "x", pipelineId: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toBeInstanceOf(EnquiryError);
    });

    it("auto-assigns by rule and notifies the new assignee (but not the actor)", async () => {
      await c.query(
        `insert into public.enquiry_assignment_rules (org_id, name, sort, conditions, action)
         values ($1, 'Phone → Carol', 0, '{"sources":["Phone call"]}', jsonb_build_object('type','user','user_id',$2::text)),
                ($1, 'Everything else → Alice', 9, '{}', jsonb_build_object('type','user','user_id',$3::text))`,
        [org, carol, alice],
      );
      const phone = await createEnquiry(ctx, {
        title: "Called in",
        pipelineId: main.id,
        source: "Phone call",
      });
      const other = await createEnquiry(ctx, {
        title: "Web form",
        pipelineId: main.id,
        source: "Website",
      });
      const rows = await c.query<{ id: string; assignee_id: string }>(
        "select id, assignee_id from public.enquiries where id = any($1)",
        [[phone.id, other.id]],
      );
      expect(rows.rows.find((r) => r.id === phone.id)?.assignee_id).toBe(carol);
      expect(rows.rows.find((r) => r.id === other.id)?.assignee_id).toBe(alice);

      const notes = await c.query<{ user_id: string; type: string }>(
        "select user_id, type from public.notifications where type = 'enquiry.assigned'",
      );
      expect(notes.rows.map((n) => n.user_id)).toContain(carol);
      expect(notes.rows.map((n) => n.user_id)).not.toContain(alice); // alice was the actor
    });

    it("moves stage: touches the enquiry, logs it, and refuses foreign stages", async () => {
      const e = await createEnquiry(ctx, {
        title: "Move me",
        pipelineId: main.id,
        assigneeId: null,
      });
      expect(
        (
          await one<{ first_touch_at: Date | null }>(
            "select first_touch_at from public.enquiries where id = $1",
            [e.id],
          )
        ).first_touch_at,
      ).toBeNull();
      await moveStage(ctx, e.id, main.s2);
      const row = await one<{ stage_id: string; first_touch_at: Date | null }>(
        "select stage_id, first_touch_at from public.enquiries where id = $1",
        [e.id],
      );
      expect(row.stage_id).toBe(main.s2);
      expect(row.first_touch_at).not.toBeNull();
      const tl = await one<{ payload: { from_name: string; to_name: string } }>(
        "select payload from public.timeline_events where enquiry_id = $1 and type = 'enquiry.stage_changed'",
        [e.id],
      );
      expect(tl.payload).toMatchObject({ from_name: "New", to_name: "Contacted" });
      await expect(moveStage(ctx, e.id, second.s1)).rejects.toBeInstanceOf(EnquiryError);
      await expect(moveStage(ctx, "00000000-0000-4000-8000-000000000000", main.s2)).rejects.toThrow(
        /not found/i,
      );
    });

    it("enforces status rules and reopening", async () => {
      const e = await createEnquiry(ctx, {
        title: "Status",
        pipelineId: main.id,
        assigneeId: null,
      });
      await expect(setStatus(ctx, e.id, "lost")).rejects.toThrow(/reason is required/i);
      await setStatus(ctx, e.id, "lost", "  Too far away ");
      let row = await one<{ status: string; lost_reason: string; closed_at: Date | null }>(
        "select status, lost_reason, closed_at from public.enquiries where id = $1",
        [e.id],
      );
      expect(row).toMatchObject({ status: "lost", lost_reason: "Too far away" });
      expect(row.closed_at).not.toBeNull();
      await setStatus(ctx, e.id, "open");
      row = await one("select status, lost_reason, closed_at from public.enquiries where id = $1", [
        e.id,
      ]);
      expect(row).toMatchObject({ status: "open", lost_reason: null, closed_at: null });
      expect(events).toContain("enquiry.status_changed");
    });

    it("moves between pipelines into the first stage", async () => {
      const e = await createEnquiry(ctx, { title: "Cross", pipelineId: main.id, assigneeId: null });
      await movePipeline(ctx, e.id, second.id);
      const row = await one<{ pipeline_id: string; stage_id: string }>(
        "select pipeline_id, stage_id from public.enquiries where id = $1",
        [e.id],
      );
      expect(row).toEqual({ pipeline_id: second.id, stage_id: second.s1 });
    });

    it("updates details with a field diff and rejects foreign references", async () => {
      const e = await createEnquiry(ctx, { title: "Edit", pipelineId: main.id, assigneeId: null });
      await updateEnquiry(ctx, e.id, { title: "Edited", estValue: 1500.5, source: "Referral" });
      const row = await one<{ title: string; est_value: string }>(
        "select title, est_value from public.enquiries where id = $1",
        [e.id],
      );
      expect(row).toEqual({ title: "Edited", est_value: "1500.50" });
      const tl = await one<{ payload: { fields: string[] } }>(
        "select payload from public.timeline_events where enquiry_id = $1 and type = 'enquiry.updated'",
        [e.id],
      );
      expect(tl.payload.fields.sort()).toEqual(["est_value", "source", "title"]);
      const org2User = await createAuthUser(c, "mallory@example.test");
      await expect(updateEnquiry(ctx, e.id, { assigneeId: org2User })).rejects.toBeInstanceOf(
        EnquiryError,
      );
    });

    it("applies bulk operations per enquiry and reports failures", async () => {
      const a = await createEnquiry(ctx, {
        title: "Bulk A",
        pipelineId: main.id,
        assigneeId: null,
      });
      const b = await createEnquiry(ctx, {
        title: "Bulk B",
        pipelineId: main.id,
        assigneeId: null,
      });
      const res = await bulkApply(ctx, [a.id, b.id, "00000000-0000-4000-8000-000000000000"], {
        type: "status",
        status: "disqualified",
        reason: "Not a patient",
      });
      expect(res.updated).toBe(2);
      expect(res.failed).toHaveLength(1);
      const rows = await c.query("select status from public.enquiries where id = any($1)", [
        [a.id, b.id],
      ]);
      expect(rows.rows.every((r) => r.status === "disqualified")).toBe(true);
      const assigned = await bulkApply(ctx, [a.id, b.id], { type: "assign", assigneeId: carol });
      expect(assigned.updated).toBe(2);
    });

    it("raises an SLA breach exactly once, and only while untouched", async () => {
      const e = await createEnquiry(ctx, { title: "SLA", pipelineId: main.id, assigneeId: carol });
      const env = {
        kind: "enquiry.sla",
        org_id: org,
        scheduled_job_id: "j1",
        payload: { enquiry_id: e.id },
      };
      // Not due yet.
      expect(await handleScheduled(env, admin)).toBe("skipped");
      await c.query(
        "update public.enquiries set sla_due_at = now() - interval '1 minute' where id = $1",
        [e.id],
      );
      expect(await handleScheduled(env, admin)).toBe("breached");
      expect(await handleScheduled(env, admin)).toBe("skipped"); // already raised
      const note = await c.query(
        "select 1 from public.notifications where type = 'enquiry.sla_breached' and user_id = $1",
        [carol],
      );
      expect(note.rowCount).toBe(1);
      expect(events).toContain("enquiry.sla_breached");

      const touched = await createEnquiry(ctx, {
        title: "SLA touched",
        pipelineId: main.id,
        assigneeId: carol,
      });
      await moveStage(ctx, touched.id, main.s2);
      await c.query(
        "update public.enquiries set sla_due_at = now() - interval '1 minute' where id = $1",
        [touched.id],
      );
      expect(await handleScheduled({ ...env, payload: { enquiry_id: touched.id } }, admin)).toBe(
        "skipped",
      );
    });

    it("schedules a task reminder, notifies once, and drops stale reminders", async () => {
      const due = new Date(Date.now() + 3600_000);
      const t = await createTask(
        { admin, orgId: org, userId: alice },
        { type: "call", subject: "Call back", dueAt: due.toISOString(), assigneeId: carol },
      );
      const job = await one<{ kind: string; payload: { due_at: string } }>(
        "select kind, payload from public.scheduled_jobs where dedupe_key = $1",
        [`task_due:${t.id}:${due.getTime()}`],
      );
      expect(job.kind).toBe("task.due");

      const env = (dueAt: string) => ({
        kind: "task.due",
        org_id: org,
        scheduled_job_id: "j2",
        payload: { task_id: t.id, due_at: dueAt },
      });
      expect(await handleScheduled(env(due.toISOString()), admin)).toBe("notified");
      expect(
        (
          await c.query(
            "select 1 from public.notifications where type = 'task.due' and user_id = $1",
            [carol],
          )
        ).rowCount,
      ).toBe(1);
      expect(await handleScheduled(env(due.toISOString()), admin)).toBe("already_notified");

      // Moving the due time makes the old reminder stale and schedules a new one.
      const later = new Date(due.getTime() + 86_400_000);
      await updateTask({ admin, orgId: org, userId: alice }, t.id, { dueAt: later.toISOString() });
      expect(await handleScheduled(env(due.toISOString()), admin)).toBe("skipped");
      expect(
        (
          await c.query("select 1 from public.scheduled_jobs where dedupe_key = $1", [
            `task_due:${t.id}:${later.getTime()}`,
          ])
        ).rowCount,
      ).toBe(1);

      // Completed tasks never notify.
      expect(await setTasksDone({ admin, orgId: org, userId: carol }, [t.id], true)).toBe(1);
      expect(await handleScheduled(env(later.toISOString()), admin)).toBe("skipped");
      const done = await one<{ done: boolean; done_at: Date; completed_by: string }>(
        "select done, done_at, completed_by from public.tasks where id = $1",
        [t.id],
      );
      expect(done.done).toBe(true);
      expect(done.completed_by).toBe(carol);
      expect(events).toContain("task.completed");
      expect(await setTasksDone({ admin, orgId: org, userId: carol }, [t.id], true)).toBe(0); // idempotent
    });

    it("does not remind about tasks created already overdue", async () => {
      const before = (
        await one<{ n: string }>(
          "select count(*)::text n from public.scheduled_jobs where kind = 'task.due'",
        )
      ).n;
      await createTask(
        { admin, orgId: org, userId: alice },
        { type: "other", subject: "Past", dueAt: new Date(Date.now() - 3600_000).toISOString() },
      );
      expect(
        (
          await one<{ n: string }>(
            "select count(*)::text n from public.scheduled_jobs where kind = 'task.due'",
          )
        ).n,
      ).toBe(before);
    });

    it("soft-deletes enquiries and hides them from the search RPC", async () => {
      const e = await createEnquiry(ctx, {
        title: "Delete me",
        pipelineId: main.id,
        assigneeId: null,
      });
      expect(await deleteEnquiries(ctx, [e.id])).toBe(1);
      expect(await deleteEnquiries(ctx, [e.id])).toBe(0);
      const { data } = await admin.rpc("enquiries_search", {
        p_org_id: org,
        p_where: "true",
        p_params: [] as never,
      });
      expect((data ?? []).map((r) => r.id)).not.toContain(e.id);
      await expect(moveStage(ctx, e.id, main.s2)).rejects.toThrow(/not found/i);
    });
  },
);
