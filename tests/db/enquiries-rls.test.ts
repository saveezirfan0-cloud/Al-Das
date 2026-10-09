/**
 * Phase 5 tables: tenant isolation, permission gating, DB-level invariants (numbering, stage in
 * pipeline, closed_at / reasons, stage history, cross-org references) and view / task visibility.
 * Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("enquiries and tasks RLS + invariants", () => {
  let c: Client;
  let alice: string; // admin A ('*')
  let viewer: string; // A: enquiries.view only
  let agent: string; // A: Agent role, no enquiry permissions
  let worker: string; // A: tasks.manage via role? no, assignee only
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let pipeA: string;
  let stageA1: string;
  let stageA2: string;
  let pipeA2: string;
  let stageOther: string;
  let pipeB: string;
  let stageB: string;
  let contactA: string;
  let contactB: string;
  let enqA: string;
  let enqB: string;
  let team: string;

  async function one(sql: string, params: unknown[] = []): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-q@example.test");
    viewer = await createAuthUser(c, "viewer-q@example.test");
    agent = await createAuthUser(c, "agent-q@example.test");
    worker = await createAuthUser(c, "worker-q@example.test");
    bob = await createAuthUser(c, "bob-q@example.test");
    orgA = await createOrg(c, "Org A", "org-a-q", alice);
    orgB = await createOrg(c, "Org B", "org-b-q", bob);

    await asServiceRole(c, async () => {
      const roleId = await one(
        "insert into public.roles (org_id, name, permissions) values ($1, 'Viewer', '[\"enquiries.view\"]'::jsonb)",
        [orgA],
      );
      const { rows: agentRole } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3), ($1, $4, $5), ($1, $6, $5)",
        [orgA, viewer, roleId, agent, agentRole[0].id, worker],
      );
      team = await one("insert into public.teams (org_id, name) values ($1, 'Front desk')", [orgA]);
      await c.query(
        "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)",
        [orgA, team, agent],
      );

      pipeA = await one(
        "insert into public.pipelines (org_id, name, sort) values ($1, 'Reception', 10)",
        [orgA],
      );
      stageA1 = await one(
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 10)",
        [orgA, pipeA],
      );
      stageA2 = await one(
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'In progress', 20)",
        [orgA, pipeA],
      );
      pipeA2 = await one(
        "insert into public.pipelines (org_id, name, sort) values ($1, 'Pharmacy', 20)",
        [orgA],
      );
      stageOther = await one(
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 10)",
        [orgA, pipeA2],
      );
      pipeB = await one(
        "insert into public.pipelines (org_id, name, sort) values ($1, 'Reception', 10)",
        [orgB],
      );
      stageB = await one(
        "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 10)",
        [orgB, pipeB],
      );
      contactA = await one("insert into public.contacts (org_id, first_name) values ($1, 'Sara')", [
        orgA,
      ]);
      contactB = await one(
        "insert into public.contacts (org_id, first_name) values ($1, 'Other')",
        [orgB],
      );
      enqA = await one(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'A one')",
        [orgA, pipeA, stageA1, contactA],
      );
      enqB = await one(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, 'B one')",
        [orgB, pipeB, stageB, contactB],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("numbers enquiries per org starting at 1", async () => {
    await asServiceRole(c, async () => {
      const second = await one(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, contact_id) values ($1, $2, $3, $4)",
        [orgA, pipeA, stageA1, contactA],
      );
      const { rows } = await c.query<{ number: string }>(
        "select id, number from public.enquiries where org_id = $1 order by number",
        [orgA],
      );
      expect(rows.map((r) => Number(r.number))).toEqual([1, 2]);
      const { rows: b } = await c.query<{ number: string }>(
        "select number from public.enquiries where org_id = $1",
        [orgB],
      );
      expect(b.map((r) => Number(r.number))).toEqual([1]);
      await c.query("delete from public.enquiries where id = $1", [second]);
    });
  });

  it("isolates tenants on every new table", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.enquiries")).toBe(1);
      expect(await count(c, "select 1 from public.pipelines")).toBe(2);
      expect(await count(c, "select 1 from public.stages")).toBe(3);
      expect(await count(c, "select 1 from public.enquiries where id = $1", [enqB])).toBe(0);
      expect(await count(c, "select 1 from public.enquiry_stage_history")).toBeGreaterThan(0);
      expect(
        await count(c, "select 1 from public.enquiry_stage_history where org_id = $1", [orgB]),
      ).toBe(0);
    });
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.enquiries")).toBe(1);
      expect(await count(c, "select 1 from public.enquiries where id = $1", [enqA])).toBe(0);
      const upd = await c.query("update public.enquiries set title = 'hacked' where id = $1", [
        enqA,
      ]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query("delete from public.enquiries where id = $1", [enqA]);
      expect(del.rowCount).toBe(0);
      await expect(
        c.query(
          "insert into public.enquiries (org_id, pipeline_id, stage_id) values ($1, $2, $3)",
          [orgA, pipeA, stageA1],
        ),
      ).rejects.toThrow(/row-level security|does not belong/);
      await expect(
        c.query("insert into public.pipelines (org_id, name) values ($1, 'x')", [orgA]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("gates enquiry reads and writes by permission", async () => {
    await asUser(c, agent, async () => {
      expect(await count(c, "select 1 from public.enquiries")).toBe(0);
      await expect(
        c.query(
          "insert into public.enquiries (org_id, pipeline_id, stage_id) values ($1, $2, $3)",
          [orgA, pipeA, stageA1],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(c, viewer, async () => {
      expect(await count(c, "select 1 from public.enquiries")).toBe(1);
      await expect(
        c.query(
          "insert into public.enquiries (org_id, pipeline_id, stage_id) values ($1, $2, $3)",
          [orgA, pipeA, stageA1],
        ),
      ).rejects.toThrow(/row-level security/);
      const upd = await c.query("update public.enquiries set title = 'x' where id = $1", [enqA]);
      expect(upd.rowCount).toBe(0);
      // Pipelines and stages are readable by any member but writable only with settings.manage.
      expect(await count(c, "select 1 from public.pipelines")).toBe(2);
      await expect(
        c.query("insert into public.pipelines (org_id, name) values ($1, 'x')", [orgA]),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(c, alice, async () => {
      const upd = await c.query(
        "update public.enquiries set title = 'A one (edited)' where id = $1",
        [enqA],
      );
      expect(upd.rowCount).toBe(1);
      await c.query(
        "insert into public.pipelines (org_id, name, sort) values ($1, 'Escalation', 30)",
        [orgA],
      );
    });
  });

  it("keeps history append-only and the counter service-only", async () => {
    await asUser(c, alice, async () => {
      await expect(
        c.query(
          "insert into public.enquiry_stage_history (org_id, enquiry_id, stage_name) values ($1, $2, 'x')",
          [orgA, enqA],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(c.query("select * from public.enquiry_counters")).resolves.toMatchObject({
        rowCount: 0,
      });
      await expect(
        c.query("update public.enquiry_counters set last_number = 0"),
      ).resolves.toMatchObject({ rowCount: 0 });
    });
  });

  it("enforces stage-in-pipeline and org consistency in the database", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query("update public.enquiries set stage_id = $2 where id = $1", [enqA, stageOther]),
      ).rejects.toThrow(/stage does not belong/);
      await expect(
        c.query("update public.enquiries set stage_id = $2 where id = $1", [enqA, stageB]),
      ).rejects.toThrow();
      await expect(
        c.query("update public.enquiries set contact_id = $2 where id = $1", [enqA, contactB]),
      ).rejects.toThrow();
      await expect(
        c.query(
          "insert into public.enquiries (org_id, pipeline_id, stage_id) values ($1, $2, $3)",
          [orgA, pipeB, stageB],
        ),
      ).rejects.toThrow();
      await expect(
        c.query("update public.enquiries set status = 'unknown' where id = $1", [enqA]),
      ).rejects.toThrow(/check/);
      await expect(
        c.query("update public.enquiries set est_value = -1 where id = $1", [enqA]),
      ).rejects.toThrow(/check/);
      // Moving to another pipeline needs both columns to change together.
      await c.query("update public.enquiries set pipeline_id = $2, stage_id = $3 where id = $1", [
        enqA,
        pipeA2,
        stageOther,
      ]);
      await c.query("update public.enquiries set pipeline_id = $2, stage_id = $3 where id = $1", [
        enqA,
        pipeA,
        stageA1,
      ]);
    });
  });

  it("keeps closed_at, reasons and stage_entered_at consistent", async () => {
    await asServiceRole(c, async () => {
      const before = (
        await c.query("select stage_entered_at from public.enquiries where id = $1", [enqA])
      ).rows[0].stage_entered_at as Date;
      await c.query("select pg_sleep(0.01)");
      await c.query(
        "update public.enquiries set status = 'lost', lost_reason = 'Price' where id = $1",
        [enqA],
      );
      let row = (
        await c.query(
          "select status, lost_reason, closed_at, stage_entered_at from public.enquiries where id = $1",
          [enqA],
        )
      ).rows[0];
      expect(row.status).toBe("lost");
      expect(row.closed_at).not.toBeNull();
      expect(row.stage_entered_at).toEqual(before);
      await c.query("update public.enquiries set status = 'won' where id = $1", [enqA]);
      row = (
        await c.query("select lost_reason, closed_at from public.enquiries where id = $1", [enqA])
      ).rows[0];
      expect(row.lost_reason).toBeNull();
      expect(row.closed_at).not.toBeNull();
      await c.query(
        "update public.enquiries set status = 'open', lost_reason = 'ignored' where id = $1",
        [enqA],
      );
      row = (
        await c.query("select lost_reason, closed_at from public.enquiries where id = $1", [enqA])
      ).rows[0];
      expect(row).toEqual({ lost_reason: null, closed_at: null });

      await c.query("update public.enquiries set sla_alerted_at = now() where id = $1", [enqA]);
      await c.query("select pg_sleep(0.01)");
      await c.query("update public.enquiries set stage_id = $2 where id = $1", [enqA, stageA2]);
      row = (
        await c.query(
          "select stage_entered_at, sla_alerted_at from public.enquiries where id = $1",
          [enqA],
        )
      ).rows[0];
      expect(row.stage_entered_at.getTime()).toBeGreaterThan(before.getTime());
      expect(row.sla_alerted_at).toBeNull();
      const hist = (
        await c.query(
          "select stage_name, left_at from public.enquiry_stage_history where enquiry_id = $1 order by entered_at, stage_name",
          [enqA],
        )
      ).rows;
      expect(hist.filter((h) => h.left_at === null)).toHaveLength(1);
      await c.query("update public.enquiries set stage_id = $2 where id = $1", [enqA, stageA1]);
    });
  });

  it("shows saved views to their owner, teams or everyone", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.enquiry_views (org_id, owner_id, name) values ($1, $2, 'Private')",
        [orgA, alice],
      );
      await c.query(
        "insert into public.enquiry_views (org_id, owner_id, name, shared_team_ids) values ($1, $2, 'Team', array[$3]::uuid[])",
        [orgA, alice, team],
      );
      await c.query(
        "insert into public.enquiry_views (org_id, owner_id, name, shared_with_all) values ($1, $2, 'Everyone', true)",
        [orgA, alice],
      );
    });
    const names = async () =>
      (
        await c.query<{ name: string }>("select name from public.enquiry_views order by name")
      ).rows.map((r) => r.name);
    await asUser(c, alice, async () =>
      expect(await names()).toEqual(["Everyone", "Private", "Team"]),
    );
    await asUser(c, viewer, async () => expect(await names()).toEqual(["Everyone"]));
    await asUser(c, bob, async () => expect(await names()).toEqual([]));
    await asUser(c, viewer, async () => {
      await expect(
        c.query(
          "insert into public.enquiry_views (org_id, owner_id, name) values ($1, $2, 'Spoof')",
          [orgA, alice],
        ),
      ).rejects.toThrow(/row-level security/);
      const upd = await c.query(
        "update public.enquiry_views set name = 'x' where name = 'Everyone'",
      );
      expect(upd.rowCount).toBe(0);
      await c.query(
        "insert into public.enquiry_views (org_id, owner_id, name) values ($1, $2, 'Mine')",
        [orgA, viewer],
      );
    });
  });

  it("limits task visibility to task managers and the assignee", async () => {
    let taskId = "";
    await asServiceRole(c, async () => {
      taskId = await one(
        "insert into public.tasks (org_id, subject, assignee_id) values ($1, 'Call back', $2)",
        [orgA, worker],
      );
      await c.query("insert into public.tasks (org_id, subject) values ($1, 'Unassigned')", [orgA]);
      await c.query("insert into public.tasks (org_id, subject) values ($1, 'Org B task')", [orgB]);
    });
    await asUser(c, alice, async () =>
      expect(await count(c, "select 1 from public.tasks")).toBe(2),
    );
    await asUser(c, worker, async () => {
      expect(await count(c, "select 1 from public.tasks")).toBe(1);
      // Assignee can read but not edit without tasks.manage.
      const upd = await c.query("update public.tasks set done = true where id = $1", [taskId]);
      expect(upd.rowCount).toBe(0);
    });
    await asUser(c, viewer, async () =>
      expect(await count(c, "select 1 from public.tasks")).toBe(0),
    );
    await asUser(c, bob, async () => expect(await count(c, "select 1 from public.tasks")).toBe(1));
    await asUser(c, alice, async () => {
      const upd = await c.query(
        "update public.tasks set done = true, done_at = now() where id = $1",
        [taskId],
      );
      expect(upd.rowCount).toBe(1);
      await c.query("update public.tasks set done = false, done_at = null where id = $1", [taskId]);
      await expect(
        c.query("update public.tasks set done_at = now() where id = $1", [taskId]),
      ).rejects.toThrow(/check/);
    });
  });

  it("rejects tasks that point at another org's records", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query("insert into public.tasks (org_id, subject, contact_id) values ($1, 'x', $2)", [
          orgA,
          contactB,
        ]),
      ).rejects.toThrow();
      await expect(
        c.query("insert into public.tasks (org_id, subject, enquiry_id) values ($1, 'x', $2)", [
          orgA,
          enqB,
        ]),
      ).rejects.toThrow();
      await expect(
        c.query("insert into public.tasks (org_id, subject, type) values ($1, 'x', 'bogus')", [
          orgA,
        ]),
      ).rejects.toThrow(/check/);
      await expect(
        c.query("insert into public.tasks (org_id, subject) values ($1, '   ')", [orgA]),
      ).rejects.toThrow(/check/);
    });
  });
});
