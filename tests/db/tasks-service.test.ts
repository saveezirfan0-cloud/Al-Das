/**
 * Tasks, the enquiries housekeeping job (SLA alerts, due notices) and the Phase 6 reminder-failure
 * hook, against a real Postgres through PostgREST. Runs only when TEST_DATABASE_URL,
 * TEST_POSTGREST_URL and TEST_SERVICE_JWT are set. Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEnquiry,
  ensureDefaultPipelines,
  loadPipelines,
  moveStage,
} from "@/lib/enquiries/service";
import "@/lib/jobs/handlers/enquiries-housekeeping";
import { getTask } from "@/lib/jobs/tasks";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { taskFilterSchema, type TaskFilter } from "@/lib/tasks/schemas";
import {
  createReminderFailureTask,
  createTask,
  deleteTask,
  listTasks,
  openTasksFor,
  setTaskDone,
  updateTask,
  type Actor,
} from "@/lib/tasks/service";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "tasks and housekeeping (PostgREST)",
  () => {
    let c: Client;
    let admin: AdminClient;
    let orgA: string;
    let orgB: string;
    let alice: string;
    let bea: string;
    let bob: string;
    let actor: Actor;
    let contact: string;
    let contactB: string;

    const f = (o: object = {}): TaskFilter => taskFilterSchema.parse(o);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    async function sql<T = unknown>(q: string, params: unknown[] = []): Promise<T[]> {
      await c.query("set role service_role");
      try {
        return (await c.query(q, params)).rows as T[];
      } finally {
        await c.query("reset role");
      }
    }
    const runHousekeeping = () => getTask("enquiries_housekeeping")!.run(admin, log as never);

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice-t2@example.test");
      bea = await createAuthUser(c, "bea-t2@example.test");
      bob = await createAuthUser(c, "bob-t2@example.test");
      orgA = await createOrg(c, "Org A", "org-a-t2", alice);
      orgB = await createOrg(c, "Org B", "org-b-t2", bob);
      const roles = await sql<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await sql("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
        orgA,
        bea,
        roles[0].id,
      ]);
      contact = (
        await sql<{ id: string }>(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Sara', 'Example') returning id",
          [orgA],
        )
      )[0].id;
      contactB = (
        await sql<{ id: string }>(
          "insert into public.contacts (org_id, first_name) values ($1, 'Other') returning id",
          [orgB],
        )
      )[0].id;
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      });
      actor = { orgId: orgA, userId: alice };
    });

    afterAll(async () => {
      await c?.end();
    });

    let taskA: string;
    let taskB: string;

    it("creates tasks with links, defaults and notifications", async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const a = await createTask(admin, actor, {
        subject: "Call Sara back",
        type: "call",
        assignee_id: bea,
        contact_id: contact,
        due_at: past,
      });
      const b = await createTask(admin, actor, { subject: "Prepare insurance pack" });
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error("create failed");
      taskA = a.id;
      taskB = b.id;
      const notes = await sql<{ title: string }>(
        "select title from public.notifications where user_id = $1 and type = 'task.assigned'",
        [bea],
      );
      expect(notes).toHaveLength(1);
      const events = await sql<{ type: string }>(
        "select type from public.timeline_events where contact_id = $1",
        [contact],
      );
      expect(events.map((e) => e.type)).toEqual(["task.created"]);
      expect(await createTask(admin, actor, { subject: "x", assignee_id: bob })).toEqual({
        ok: false,
        error: "That user is not an active member of this workspace.",
      });
      expect(await createTask(admin, actor, { subject: "x", contact_id: contactB })).toEqual({
        ok: false,
        error: "That patient was not found.",
      });
      expect(
        await createTask(admin, actor, {
          subject: "x",
          enquiry_id: "00000000-0000-4000-8000-000000000000",
        }),
      ).toEqual({ ok: false, error: "That enquiry was not found." });
    });

    it("lists by scope, state, type and search", async () => {
      const mine = await listTasks(admin, { orgId: orgA, userId: bea }, f());
      expect(mine.rows.map((r) => r.id)).toEqual([taskA]);
      expect(mine.rows[0]).toMatchObject({
        patient: "Sara Example",
        type: "call",
        assignee_id: bea,
      });
      const all = await listTasks(admin, actor, f({ scope: "all" }));
      expect(all.total).toBe(2);
      expect(
        (await listTasks(admin, actor, f({ scope: "all", state: "overdue" }))).rows.map(
          (r) => r.id,
        ),
      ).toEqual([taskA]);
      expect(
        (await listTasks(admin, actor, f({ scope: "all", assignee_id: "unassigned" }))).rows.map(
          (r) => r.id,
        ),
      ).toEqual([taskB]);
      expect(
        (await listTasks(admin, actor, f({ scope: "all", type: "call" }))).rows.map((r) => r.id),
      ).toEqual([taskA]);
      expect(
        (await listTasks(admin, actor, f({ scope: "all", search: "insurance" }))).rows.map(
          (r) => r.id,
        ),
      ).toEqual([taskB]);
      expect((await listTasks(admin, actor, f({ scope: "all", search: "a%,zz" }))).total).toBe(0);
      expect(
        (await listTasks(admin, { orgId: orgB, userId: bob }, f({ scope: "all" }))).total,
      ).toBe(0);
      expect((await openTasksFor(admin, orgA, { contact_id: contact })).map((r) => r.id)).toEqual([
        taskA,
      ]);
    });

    it("notifies the assignee once when a task falls due", async () => {
      const first = await runHousekeeping();
      expect(first).toMatchObject({ task_notices: 1 });
      const notes = await sql(
        "select 1 from public.notifications where user_id = $1 and type = 'task.due'",
        [bea],
      );
      expect(notes).toHaveLength(1);
      expect(await runHousekeeping()).toMatchObject({ task_notices: 0 });
      // Moving the due time re-arms the notice.
      expect(
        await updateTask(admin, actor, taskA, {
          due_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ).toEqual({ ok: true });
      expect(await runHousekeeping()).toMatchObject({ task_notices: 1 });
    });

    it("completes, reopens and deletes inside the org only", async () => {
      expect(await setTaskDone(admin, actor, taskA, true)).toEqual({ ok: true });
      expect(
        (await listTasks(admin, actor, f({ scope: "all", state: "done" }))).rows.map((r) => r.id),
      ).toEqual([taskA]);
      expect((await listTasks(admin, actor, f({ scope: "all" }))).rows.map((r) => r.id)).toEqual([
        taskB,
      ]);
      const events = await sql<{ type: string }>(
        "select type from public.timeline_events where contact_id = $1 order by at",
        [contact],
      );
      expect(events.map((e) => e.type)).toContain("task.completed");
      expect(await setTaskDone(admin, actor, taskA, false)).toEqual({ ok: true });
      expect(await setTaskDone(admin, { orgId: orgB, userId: bob }, taskA, true)).toEqual({
        ok: false,
        error: "Task not found.",
      });
      expect(await deleteTask(admin, { orgId: orgB, userId: bob }, taskB)).toEqual({
        ok: true,
        deleted: 0,
      });
      expect(await deleteTask(admin, actor, taskB)).toEqual({ ok: true, deleted: 1 });
    });

    it("creates one open call task per failed reminder", async () => {
      const [{ id: location }] = await sql<{ id: string }>(
        "insert into public.locations (org_id, name) values ($1, 'Main') returning id",
        [orgA],
      );
      const [{ id: appt }] = await sql<{ id: string }>(
        "insert into public.appointments (org_id, contact_id, location_id, starts_at, ends_at) values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 30 minutes') returning id",
        [orgA, contact, location],
      );
      const args = {
        appointmentId: appt,
        contactId: contact,
        appointmentNumber: 7,
        reason: "Meta rejected the template for +971500000123",
      };
      const id1 = await createReminderFailureTask(admin, orgA, args);
      const id2 = await createReminderFailureTask(admin, orgA, args);
      expect(id1).toBeTruthy();
      expect(id2).toBe(id1);
      const rows = await sql<{ subject: string; notes: string; type: string }>(
        "select subject, notes, type from public.tasks where appointment_id = $1",
        [appt],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("call");
      expect(rows[0].subject).toContain("#7");
      expect(rows[0].notes).not.toContain("+971500000123");
      await setTaskDone(admin, actor, id1!, true);
      expect(await createReminderFailureTask(admin, orgA, args)).not.toBe(id1);
    });

    it("alerts once per stage visit when the SLA is breached", async () => {
      await ensureDefaultPipelines(admin, orgA);
      const pipelines = await loadPipelines(admin, orgA);
      const rec = pipelines[0];
      const e = await createEnquiry(admin, actor, {
        contact_id: contact,
        pipeline_id: rec.id,
        assignee_id: bea,
      });
      if (!e.ok) throw new Error("create failed");
      await sql(
        "update public.orgs set settings = jsonb_build_object('enquiries', jsonb_build_object('sla_hours', 2)) where id = $1",
        [orgA],
      );
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 0 }); // fresh enquiry

      await sql(
        "update public.enquiries set stage_entered_at = now() - interval '3 hours' where id = $1",
        [e.id],
      );
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 1 });
      const notes = await sql<{ title: string; body: string }>(
        "select title, body from public.notifications where user_id = $1 and type = 'enquiry.sla_breached'",
        [bea],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toMatch(/^Enquiry #\d+ passed its 2 h SLA$/);
      expect(notes[0].body).toBe("Reception");
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 0 });

      // A stage move starts a new visit: the alert re-arms.
      expect(await moveStage(admin, actor, e.id, rec.stages[1].id)).toEqual({ ok: true });
      await sql(
        "update public.enquiries set stage_entered_at = now() - interval '3 hours' where id = $1",
        [e.id],
      );
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 1 });

      // Unassigned breaches go to enquiries.manage holders; closed enquiries never alert.
      await sql(
        "update public.enquiries set assignee_id = null, sla_alerted_at = null where id = $1",
        [e.id],
      );
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 1 });
      expect(
        (
          await sql(
            "select 1 from public.notifications where user_id = $1 and type = 'enquiry.sla_breached'",
            [alice],
          )
        ).length,
      ).toBe(1);
      await sql("update public.enquiries set status = 'won', sla_alerted_at = null where id = $1", [
        e.id,
      ]);
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 0 });

      // No SLA configured: nothing fires.
      await sql(
        "update public.enquiries set status = 'open', sla_alerted_at = null where id = $1",
        [e.id],
      );
      await sql("update public.orgs set settings = '{}'::jsonb where id = $1", [orgA]);
      expect(await runHousekeeping()).toMatchObject({ sla_alerts: 0 });
    });
  },
);
