/**
 * Phase F (docs/34_CLINIC_OS_PLAN.md): inbox, Patient 360 and tasks v2, on real Postgres.
 *   - RLS: task lines, comments and files follow their task (branch rule, bin); templates follow their branch; another
 *     org sees nothing; browsers cannot write
 *   - tasks status and the old done flag stay in step (tasks_status_sync)
 *   - task_spawn_next is idempotent (one task per series and due time, none once a later one exists)
 *   - task_generate_checklists makes one task per template and local day, only after the generate time, with the lines
 *   - snooze: a new patient message or a close clears it (trigger)
 *   - search_messages: the caller's own RLS decides, at least 3 characters, a short snippet, campaign-only chats hidden
 *   - media_asset_usage counts a file on an open task as in use; record history covers checklist templates
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase F: inbox, Patient 360 and tasks v2", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let stranger: string;
  let desk: string;
  let deskMembership: string;
  let viewer: string;
  const loc: Record<string, string> = {};

  const one = async (sql: string, p: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", p)).rows[0].id;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const countAs = async (user: string, sql: string, p: unknown[] = []) =>
    asUser(c, user, async () => Number((await c.query<{ n: string }>(`select count(*)::text as n from (${sql}) t`, p)).rows[0].n));

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-pf@example.test");
    stranger = await createAuthUser(c, "stranger-pf@example.test");
    desk = await createAuthUser(c, "desk-pf@example.test");
    viewer = await createAuthUser(c, "viewer-pf@example.test");
    org = await createOrg(c, "Org PF", "org-pf", owner);
    otherOrg = await createOrg(c, "Org PF2", "org-pf2", stranger);
    await svc(async () => {
      const deskRole = await one(
        `insert into public.roles (org_id, name, permissions)
         values ($1, 'Desk PF', '["tasks.view","tasks.manage","inbox.send","contacts.view"]'::jsonb)`,
        [org],
      );
      deskMembership = await one(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, desk, deskRole],
      );
      const noTasks = await one(
        `insert into public.roles (org_id, name, permissions) values ($1, 'Inbox only PF', '["inbox.send"]'::jsonb)`,
        [org],
      );
      await one("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
        org,
        viewer,
        noTasks,
      ]);
      for (const name of ["North", "South"])
        loc[name] = await one(
          "insert into public.locations (org_id, name, timezone) values ($1, $2, 'Asia/Dubai')",
          [org, name],
        );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  async function task(fields: Record<string, unknown> = {}): Promise<string> {
    const cols = ["org_id", "subject", "due_at", ...Object.keys(fields)];
    const vals = [org, "Synthetic task", "2026-10-20T05:00:00Z", ...Object.values(fields)];
    return svc(() =>
      one(
        `insert into public.tasks (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        vals,
      ),
    );
  }

  describe("RLS", () => {
    it("shows lines, comments and files with their task, hides them with a hidden branch, and never to another org", async () => {
      const north = await task({ location_id: loc.North });
      const south = await task({ location_id: loc.South });
      await svc(async () => {
        for (const t of [north, south]) {
          await c.query("insert into public.task_checklist_items (org_id, task_id, title) values ($1, $2, 'Line')", [org, t]);
          await c.query("insert into public.task_comments (org_id, task_id, author_id, body) values ($1, $2, $3, 'Note')", [org, t, owner]);
        }
        await c.query(
          `insert into public.task_checklist_templates (org_id, location_id, name, items) values ($1, $2, 'South opening', '["A"]'::jsonb)`,
          [org, loc.South],
        );
        await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [deskMembership]);
        await c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, deskMembership, loc.North],
        );
      });
      const items = "select task_id from public.task_checklist_items where task_id = any($1::uuid[])";
      expect(await countAs(owner, items, [[north, south]])).toBe(2);
      expect(await countAs(desk, items, [[north, south]])).toBe(1);
      expect(await countAs(desk, "select id from public.task_comments where task_id = $1", [south])).toBe(0);
      expect(
        await countAs(desk, "select id from public.task_checklist_templates where location_id = $1", [loc.South]),
      ).toBe(0);
      expect(await countAs(owner, "select id from public.task_checklist_templates where location_id = $1", [loc.South])).toBe(1);
      // No tasks.view: nothing, even in an unrestricted branch.
      expect(await countAs(viewer, items, [[north, south]])).toBe(0);
      // Another organisation's admin.
      expect(await countAs(stranger, items, [[north, south]])).toBe(0);
      expect(await countAs(stranger, "select id from public.task_comments")).toBe(0);
      // A task in the bin hides its lines too.
      await svc(() => c.query("update public.tasks set deleted_at = now() where id = $1", [north]));
      expect(await countAs(owner, items, [[north]])).toBe(0);
      await svc(async () => {
        await c.query("update public.tasks set deleted_at = null where id = $1", [north]);
        await c.query("delete from public.membership_locations where membership_id = $1", [deskMembership]);
        await c.query("update public.memberships set branch_scope = 'all' where id = $1", [deskMembership]);
      });
    });

    it("gives browsers no write path on the new tables", async () => {
      const t = await task();
      await asUser(c, owner, async () => {
        await expect(
          c.query("insert into public.task_comments (org_id, task_id, body) values ($1, $2, 'x')", [org, t]),
        ).rejects.toThrow();
        await expect(
          c.query("insert into public.task_checklist_items (org_id, task_id, title) values ($1, $2, 'x')", [org, t]),
        ).rejects.toThrow();
        await expect(
          c.query(
            `insert into public.task_checklist_templates (org_id, location_id, name, items) values ($1, $2, 'x', '["a"]'::jsonb)`,
            [org, loc.North],
          ),
        ).rejects.toThrow();
      });
    });

    it("refuses a line on another organisation's task and a template with bad lines", async () => {
      const t = await task();
      await svc(async () => {
        await expect(
          c.query("insert into public.task_checklist_items (org_id, task_id, title) values ($1, $2, 'x')", [otherOrg, t]),
        ).rejects.toThrow();
        await expect(
          c.query(
            `insert into public.task_checklist_templates (org_id, location_id, name, items) values ($1, $2, 'Empty', '[]'::jsonb)`,
            [org, loc.North],
          ),
        ).rejects.toThrow();
        await expect(
          c.query(
            `insert into public.task_checklist_templates (org_id, location_id, name, items) values ($1, $2, 'Numbers', '[1, 2]'::jsonb)`,
            [org, loc.North],
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe("status and done", () => {
    it("keeps status and the done flag in step both ways", async () => {
      const t = await task();
      const read = () =>
        svc(async () => (await c.query<{ status: string; done: boolean; done_at: string | null }>(
          "select status, done, done_at from public.tasks where id = $1",
          [t],
        )).rows[0]);
      await svc(() => c.query("update public.tasks set status = 'in_progress' where id = $1", [t]));
      expect(await read()).toMatchObject({ status: "in_progress", done: false });
      await svc(() => c.query("update public.tasks set status = 'done' where id = $1", [t]));
      const done = await read();
      expect(done).toMatchObject({ status: "done", done: true });
      expect(done.done_at).not.toBeNull();
      await svc(() => c.query("update public.tasks set done = false, done_at = null where id = $1", [t]));
      expect(await read()).toMatchObject({ status: "todo", done: false });
      await svc(() => c.query("update public.tasks set done = true, done_at = now() where id = $1", [t]));
      expect(await read()).toMatchObject({ status: "done", done: true });
      // Inserting a finished task sets both.
      const finished = await task({ done: true, done_at: "2026-10-01T00:00:00Z" });
      const row = await svc(async () => (await c.query("select status from public.tasks where id = $1", [finished])).rows[0]);
      expect(row.status).toBe("done");
    });
  });

  describe("recurrence", () => {
    it("spawns one next task per series and due time, and none once a later one exists", async () => {
      const t = await task({ recurrence: "daily", priority: "high", location_id: loc.North });
      await svc(() => c.query("insert into public.task_checklist_items (org_id, task_id, title, done, done_at) values ($1, $2, 'Step', true, now())", [org, t]));
      const next = "2026-10-21T05:00:00Z";
      const first = await svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [org, t, next])).rows[0].id);
      const again = await svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [org, t, next])).rows[0].id);
      expect(first).toBeTruthy();
      expect(again).toBeNull();
      // A different time from the same (older) task is refused too: a later task of the series exists.
      const other = await svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [org, t, "2026-10-22T05:00:00Z"])).rows[0].id);
      expect(other).toBeNull();
      const rows = await svc(async () => (await c.query<{ id: string; series_id: string | null; priority: string; location_id: string | null; done: boolean }>(
        "select id::text, series_id::text, priority, location_id::text, done from public.tasks where id = $1 or series_id = $1 order by due_at",
        [t],
      )).rows);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ series_id: t, priority: "high", location_id: loc.North, done: false });
      // The new task's checklist starts unticked.
      const lines = await svc(async () => (await c.query<{ done: boolean }>("select done from public.task_checklist_items where task_id = $1", [first])).rows);
      expect(lines).toEqual([{ done: false }]);
      // The next of the new one works, and is idempotent as well.
      const third = await svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [org, first, "2026-10-22T05:00:00Z"])).rows[0].id);
      expect(third).toBeTruthy();
      const thirdAgain = await svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [org, first, "2026-10-22T05:00:00Z"])).rows[0].id);
      expect(thirdAgain).toBeNull();
    });

    it("does nothing for a task that does not repeat, is in the bin, or a time not after its due time", async () => {
      const plain = await task();
      const binned = await task({ recurrence: "weekly" });
      await svc(() => c.query("update public.tasks set deleted_at = now() where id = $1", [binned]));
      const early = await task({ recurrence: "daily" });
      const call = (id: string, at: string) =>
        svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [org, id, at])).rows[0].id);
      expect(await call(plain, "2026-10-21T05:00:00Z")).toBeNull();
      expect(await call(binned, "2026-10-27T05:00:00Z")).toBeNull();
      expect(await call(early, "2026-10-20T05:00:00Z")).toBeNull();
      // Another org cannot spawn from this one.
      const foreign = await svc(async () => (await c.query<{ id: string | null }>("select public.task_spawn_next($1, $2, $3)::text as id", [otherOrg, early, "2026-10-21T05:00:00Z"])).rows[0].id);
      expect(foreign).toBeNull();
    });

    it("is service-role only", async () => {
      await asUser(c, owner, async () => {
        await expect(c.query("select public.task_spawn_next($1, $2, now())", [org, org])).rejects.toThrow();
        await expect(c.query("select * from public.task_generate_checklists($1)", [org])).rejects.toThrow();
      });
    });
  });

  describe("daily checklists", () => {
    it("makes one task per template and local day after the generate time, with its lines", async () => {
      const tpl = await svc(() =>
        one(
          `insert into public.task_checklist_templates (org_id, location_id, name, items, generate_at, due_time)
           values ($1, $2, 'North opening', '["Lights on","Fridge temperature","Cash float"]'::jsonb, '06:00', '09:00')`,
          [org, loc.North],
        ),
      );
      const off = await svc(() =>
        one(
          `insert into public.task_checklist_templates (org_id, location_id, name, items, active) values ($1, $2, 'Off', '["x"]'::jsonb, false)`,
          [org, loc.North],
        ),
      );
      const gen = (at: string) =>
        svc(async () => (await c.query<{ task_id: string }>("select task_id::text from public.task_generate_checklists($1, $2)", [org, at])).rows);
      const mine = (rows: Array<{ task_id: string }>) =>
        svc(async () => (await c.query<{ checklist_template_id: string }>(
          "select checklist_template_id::text from public.tasks where id = any($1::uuid[])",
          [rows.map((r) => r.task_id)],
        )).rows.filter((r) => r.checklist_template_id === tpl).length);
      // 05:30 in Dubai is 01:30Z: before the generate time.
      expect(await mine(await gen("2026-11-02T01:30:00Z"))).toBe(0);
      // 06:30 in Dubai.
      const made = await gen("2026-11-02T02:30:00Z");
      expect(await mine(made)).toBe(1);
      // The next hourly run, or a retry, makes nothing.
      expect(await mine(await gen("2026-11-02T03:30:00Z"))).toBe(0);
      expect(await mine(await gen("2026-11-02T02:30:00Z"))).toBe(0);
      const row = await svc(async () => (await c.query<{ id: string; due_at: Date; location_id: string; subject: string }>(
        "select id::text, due_at, location_id::text, subject from public.tasks where checklist_template_id = $1",
        [tpl],
      )).rows);
      expect(row).toHaveLength(1);
      expect(row[0].location_id).toBe(loc.North);
      expect(row[0].subject).toBe("North opening");
      expect(new Date(row[0].due_at).toISOString()).toBe("2026-11-02T05:00:00.000Z");
      const lines = await svc(async () => (await c.query<{ title: string }>(
        "select title from public.task_checklist_items where task_id = $1 order by sort_order",
        [row[0].id],
      )).rows.map((r) => r.title));
      expect(lines).toEqual(["Lights on", "Fridge temperature", "Cash float"]);
      // The next local day makes the next one.
      expect(await mine(await gen("2026-11-03T02:30:00Z"))).toBe(1);
      // An inactive template, and a template of an inactive branch, make nothing.
      const offTasks = await svc(async () => Number((await c.query<{ n: string }>("select count(*)::text as n from public.tasks where checklist_template_id = $1", [off])).rows[0].n));
      expect(offTasks).toBe(0);
      await svc(() => c.query("update public.locations set active = false where id = $1", [loc.North]));
      expect(await mine(await gen("2026-11-04T02:30:00Z"))).toBe(0);
      await svc(() => c.query("update public.locations set active = true where id = $1", [loc.North]));
      // Deleting a made task keeps the day claimed (it is not made again).
      await svc(() => c.query("update public.tasks set deleted_at = now() where checklist_template_id = $1", [tpl]));
      expect(await mine(await gen("2026-11-03T04:30:00Z"))).toBe(0);
    });

    it("keeps history of template changes for people who may see tasks", async () => {
      const tpl = await svc(() =>
        one(
          `insert into public.task_checklist_templates (org_id, location_id, name, items) values ($1, $2, 'South closing', '["Lock up"]'::jsonb)`,
          [org, loc.South],
        ),
      );
      await svc(() => c.query("update public.task_checklist_templates set name = 'South close' where id = $1", [tpl]));
      const ok = await asUser(c, owner, async () =>
        (await c.query<{ ok: boolean }>("select app.can_view_record_history($1, 'task_checklist_templates') as ok", [org])).rows[0].ok,
      );
      expect(ok).toBe(true);
      const no = await asUser(c, viewer, async () =>
        (await c.query<{ ok: boolean }>("select app.can_view_record_history($1, 'task_checklist_templates') as ok", [org])).rows[0].ok,
      );
      expect(no).toBe(false);
      const n = await svc(async () => Number((await c.query<{ n: string }>(
        "select count(*)::text as n from public.record_history where table_name = 'task_checklist_templates' and record_id = $1",
        [tpl],
      )).rows[0].n));
      expect(n).toBeGreaterThanOrEqual(2);
    });
  });

  describe("snooze and search", () => {
    let channel: string;
    let contact: string;
    let conv: string;

    beforeAll(async () => {
      await svc(async () => {
        channel = await one(
          "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main PF', 'waba-pf', 'pn-pf')",
          [org],
        );
        contact = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', 'Demo-31', '+447700900931')",
          [org],
        );
        conv = await one(
          "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now() - interval '1 hour')",
          [org, channel, contact],
        );
      });
    });

    it("clears a snooze when the patient writes again or the chat is closed", async () => {
      const snooze = () =>
        svc(() => c.query("update public.conversations set snoozed_until = now() + interval '1 day', snoozed_by = $2 where id = $1", [conv, owner]));
      const read = () =>
        svc(async () => (await c.query<{ snoozed_until: string | null }>("select snoozed_until from public.conversations where id = $1", [conv])).rows[0].snoozed_until);
      await snooze();
      expect(await read()).not.toBeNull();
      // Another update (an agent's reply) keeps it.
      await svc(() => c.query("update public.conversations set last_outbound_at = now() where id = $1", [conv]));
      expect(await read()).not.toBeNull();
      await svc(() => c.query("update public.conversations set last_inbound_at = now() where id = $1", [conv]));
      expect(await read()).toBeNull();
      await snooze();
      await svc(() => c.query("update public.conversations set status = 'closed', closed_at = now() where id = $1", [conv]));
      expect(await read()).toBeNull();
      await svc(() => c.query("update public.conversations set status = 'open', closed_at = null where id = $1", [conv]));
    });

    it("searches message text under the caller's own RLS, with a short snippet only", async () => {
      const long = `${"x".repeat(300)} the fasting blood test result is ready ${"y".repeat(300)}`;
      await svc(async () => {
        await c.query(
          "insert into public.messages (org_id, conversation_id, direction, kind, body) values ($1, $2, 'in', 'text', $3), ($1, $2, 'out', 'text', 'Your BLOOD test is booked')",
          [org, conv, long],
        );
        const other = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Omar', 'Demo-32', '+447700900932')",
          [org],
        );
        const hidden = await one(
          "insert into public.conversations (org_id, channel_id, contact_id, campaign_only) values ($1, $2, $3, true)",
          [org, channel, other],
        );
        await c.query(
          "insert into public.messages (org_id, conversation_id, direction, kind, body) values ($1, $2, 'out', 'template', 'Blood test campaign')",
          [org, hidden],
        );
      });
      const search = (user: string, q: string, orgId = org) =>
        asUser(c, user, async () =>
          (await c.query<{ snippet: string; direction: string }>("select snippet, direction from public.search_messages($1, $2, 30)", [orgId, q])).rows,
        );
      const hits = await search(owner, "blood test");
      expect(hits).toHaveLength(2);
      for (const h of hits) expect(h.snippet.length).toBeLessThanOrEqual(130);
      expect(hits.some((h) => h.snippet.includes("fasting blood test"))).toBe(true);
      // Too short, nothing.
      expect(await search(owner, "bl")).toHaveLength(0);
      // LIKE wildcards are literal.
      expect(await search(owner, "%%%")).toHaveLength(0);
      // Another organisation's admin finds nothing, even naming this org.
      expect(await search(stranger, "blood test")).toHaveLength(0);
      // A member with inbox rights sees an unassigned chat (inbox RLS), one assigned to someone else is hidden.
      expect(await search(desk, "blood test")).toHaveLength(2);
      await svc(() => c.query("update public.conversations set assignee_user_id = $2 where id = $1", [conv, owner]));
      expect(await search(desk, "blood test")).toHaveLength(0);
      await svc(() => c.query("update public.conversations set assignee_user_id = null where id = $1", [conv]));
    });
  });

  describe("media library", () => {
    it("counts a file on an open task as in use, and on a finished one as not blocking", async () => {
      const t = await task();
      const asset = await svc(() =>
        one(
          "insert into public.media_assets (org_id, name, kind, mime_type, size_bytes, storage_path, status) values ($1::uuid, 'Synthetic PDF', 'document', 'application/pdf', 100, $1::uuid::text || '/' || gen_random_uuid()::text || '/original.pdf', 'ready')",
          [org],
        ),
      );
      await svc(() => c.query("insert into public.task_attachments (org_id, task_id, media_asset_id) values ($1, $2, $3)", [org, t, asset]));
      const usage = () =>
        svc(async () => (await c.query<{ kind: string; blocking: boolean }>("select kind, blocking from public.media_asset_usage($1, $2)", [org, asset])).rows);
      expect(await usage()).toEqual([{ kind: "task", blocking: true }]);
      await svc(() => c.query("update public.tasks set status = 'done' where id = $1", [t]));
      expect(await usage()).toEqual([{ kind: "task", blocking: false }]);
    });
  });
});
