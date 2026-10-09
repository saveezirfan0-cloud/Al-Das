/**
 * Phase 5 tables: cross-org isolation, permission gates, org-integrity triggers,
 * per-org numbering, status bookkeeping and the search RPCs.
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

describe.skipIf(!TEST_DATABASE_URL)("enquiries + tasks RLS and SQL functions", () => {
  let c: Client;
  let alice: string; // admin A
  let carol: string; // desk A: enquiries.view/manage + tasks.view/manage
  let viewer: string; // A: enquiries.view + tasks.view only
  let nobody: string; // A: no enquiry/task permissions
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  const a: Record<string, string> = {};
  const b: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  async function seedOrg(org: string, ids: Record<string, string>, tag: string, owner: string) {
    ids.location = await insert("insert into public.locations (org_id, name) values ($1, $2)", [
      org,
      `Loc ${tag}`,
    ]);
    ids.department = await insert("insert into public.departments (org_id, name) values ($1, $2)", [
      org,
      `Dept ${tag}`,
    ]);
    ids.service = await insert(
      "insert into public.services (org_id, department_id, name) values ($1, $2, $3)",
      [org, ids.department, `Svc ${tag}`],
    );
    ids.specialist = await insert(
      "insert into public.specialists (org_id, name, department_id) values ($1, $2, $3)",
      [org, `Spec ${tag}`, ids.department],
    );
    ids.pipeline = await insert(
      "insert into public.pipelines (org_id, name, is_default) values ($1, $2, true)",
      [org, `Main ${tag}`],
    );
    ids.stage1 = await insert(
      "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
      [org, ids.pipeline],
    );
    ids.stage2 = await insert(
      "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'Contacted', 1)",
      [org, ids.pipeline],
    );
    ids.contact = await insert(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Pat', $2, $3)",
      [org, tag, tag === "A" ? "+971500000101" : "+971500000102"],
    );
    ids.enquiry = await insert(
      `insert into public.enquiries (org_id, pipeline_id, stage_id, contact_id, title, assignee_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $6)`,
      [org, ids.pipeline, ids.stage1, ids.contact, `Enquiry ${tag}`, owner],
    );
    ids.task = await insert(
      `insert into public.tasks (org_id, subject, due_at, enquiry_id, assignee_id)
       values ($1, $2, now() + interval '1 day', $3, $4)`,
      [org, `Task ${tag}`, ids.enquiry, owner],
    );
    ids.rule = await insert(
      `insert into public.enquiry_assignment_rules (org_id, name, action)
       values ($1, 'r', jsonb_build_object('type', 'user', 'user_id', $2::text))`,
      [org, owner],
    );
    ids.view = await insert(
      "insert into public.enquiry_views (org_id, owner_id, name, shared_all) values ($1, $2, 'mine', false)",
      [org, owner],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    viewer = await createAuthUser(c, "viewer@example.test");
    nobody = await createAuthUser(c, "nobody@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const roles: Record<string, string> = {};
      for (const [name, perms] of [
        ["Desk", ["enquiries.view", "enquiries.manage", "tasks.view", "tasks.manage"]],
        ["Viewer", ["enquiries.view", "tasks.view"]],
        ["Nothing", ["contacts.view"]],
      ] as const) {
        roles[name] = await insert(
          "insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb)",
          [orgA, name, JSON.stringify(perms)],
        );
      }
      for (const [u, role] of [
        [carol, "Desk"],
        [viewer, "Viewer"],
        [nobody, "Nothing"],
      ] as const) {
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
          [orgA, u, roles[role]],
        );
      }
      await seedOrg(orgA, a, "A", alice);
      await seedOrg(orgB, b, "B", bob);
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  const TABLES = [
    "locations",
    "departments",
    "services",
    "specialists",
    "pipelines",
    "stages",
    "enquiries",
    "enquiry_views",
    "enquiry_assignment_rules",
    "tasks",
  ];

  it("isolates every Phase 5 table by org for admins", async () => {
    await asUser(c, alice, async () => {
      for (const t of TABLES) {
        expect(await count(c, `select 1 from public.${t}`), t).toBeGreaterThan(0);
        expect(await count(c, `select 1 from public.${t} where org_id = $1`, [orgB]), t).toBe(0);
      }
    });
    await asUser(c, bob, async () => {
      for (const t of TABLES) {
        expect(await count(c, `select 1 from public.${t} where org_id = $1`, [orgA]), t).toBe(0);
      }
    });
  });

  it("keeps enquiry_counters server-only", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.enquiry_counters")).toBe(0);
    });
    await asServiceRole(c, async () => {
      expect(await count(c, "select 1 from public.enquiry_counters")).toBe(2);
    });
  });

  it("gates reads by permission", async () => {
    await asUser(c, nobody, async () => {
      expect(await count(c, "select 1 from public.enquiries")).toBe(0);
      expect(await count(c, "select 1 from public.tasks")).toBe(0);
      expect(await count(c, "select 1 from public.pipelines")).toBe(0);
      // lookups are visible to every member
      expect(await count(c, "select 1 from public.locations")).toBe(1);
    });
    await asUser(c, viewer, async () => {
      expect(await count(c, "select 1 from public.enquiries")).toBe(1);
      expect(await count(c, "select 1 from public.tasks")).toBe(1);
      expect(await count(c, "select 1 from public.enquiry_assignment_rules")).toBe(0);
    });
  });

  it("gates writes: view-only cannot write, desk can write but not delete", async () => {
    await asUser(c, viewer, async () => {
      await expect(
        c.query(
          "insert into public.enquiries (org_id, pipeline_id, stage_id, title) values ($1, $2, $3, 'x')",
          [orgA, a.pipeline, a.stage1],
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        (await c.query("update public.enquiries set title = 'hacked' where id = $1", [a.enquiry]))
          .rowCount,
      ).toBe(0);
      await expect(
        c.query("insert into public.tasks (org_id, subject, due_at) values ($1, 's', now())", [
          orgA,
        ]),
      ).rejects.toThrow(/row-level security/);
    });
    let deskEnquiry = "";
    await asUser(c, carol, async () => {
      const { rows } = await c.query<{ id: string }>(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, title) values ($1, $2, $3, 'desk made') returning id",
        [orgA, a.pipeline, a.stage1],
      );
      deskEnquiry = rows[0].id;
      expect(
        (
          await c.query("update public.enquiries set title = 'renamed' where id = $1", [
            deskEnquiry,
          ])
        ).rowCount,
      ).toBe(1);
      // enquiries.delete is a separate permission
      expect(
        (await c.query("delete from public.enquiries where id = $1", [deskEnquiry])).rowCount,
      ).toBe(0);
      // settings tables are admin-only
      await expect(
        c.query("insert into public.pipelines (org_id, name) values ($1, 'nope')", [orgA]),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(c, alice, async () => {
      expect(
        (await c.query("delete from public.enquiries where id = $1", [deskEnquiry])).rowCount,
      ).toBe(1);
    });
  });

  it("stops org B's admin from writing into org A even with valid org A references", async () => {
    await asUser(c, bob, async () => {
      // The consistency trigger runs as the caller, so it cannot even see org A's pipeline: it
      // refuses first. Either way nothing is written (the insert would also fail RLS).
      await expect(
        c.query(
          "insert into public.enquiries (org_id, pipeline_id, stage_id, title) values ($1, $2, $3, 'intruder')",
          [orgA, a.pipeline, a.stage1],
        ),
      ).rejects.toThrow(/row-level security|does not belong/);
      await expect(
        c.query(
          "insert into public.tasks (org_id, subject, due_at) values ($1, 'intruder', now())",
          [orgA],
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        (await c.query("update public.enquiries set title = 'x' where id = $1", [a.enquiry]))
          .rowCount,
      ).toBe(0);
      expect((await c.query("delete from public.tasks where id = $1", [a.task])).rowCount).toBe(0);
    });
  });

  it("rejects cross-org references even for admins", async () => {
    await asUser(c, alice, async () => {
      for (const [col, val] of [
        ["contact_id", b.contact],
        ["location_id", b.location],
        ["department_id", b.department],
        ["specialist_id", b.specialist],
        ["service_id", b.service],
      ] as const) {
        await expect(
          c.query(`update public.enquiries set ${col} = $1 where id = $2`, [val, a.enquiry]),
          col,
        ).rejects.toThrow(/does not belong to org|check_violation|belong/);
      }
      await expect(
        c.query("update public.enquiries set pipeline_id = $1, stage_id = $2 where id = $3", [
          b.pipeline,
          b.stage1,
          a.enquiry,
        ]),
      ).rejects.toThrow();
      await expect(
        c.query("update public.tasks set enquiry_id = $1 where id = $2", [b.enquiry, a.task]),
      ).rejects.toThrow(/does not belong to org/);
      await expect(
        c.query("update public.tasks set assignee_id = $1 where id = $2", [bob, a.task]),
      ).rejects.toThrow(/not a member/);
      await expect(
        c.query("update public.enquiries set assignee_id = $1 where id = $2", [bob, a.enquiry]),
      ).rejects.toThrow(/not a member/);
    });
  });

  it("requires the stage to belong to the enquiry's pipeline", async () => {
    await asServiceRole(c, async () => {
      const otherPipeline = await insert(
        "insert into public.pipelines (org_id, name) values ($1, 'Second')",
        [orgA],
      );
      const otherStage = await insert(
        "insert into public.stages (org_id, pipeline_id, name) values ($1, $2, 'S')",
        [orgA, otherPipeline],
      );
      await expect(
        c.query("update public.enquiries set stage_id = $1 where id = $2", [otherStage, a.enquiry]),
      ).rejects.toThrow(/does not belong to pipeline/);
      // moving pipeline + stage together is fine and restarts the stage clock
      const before = await c.query<{ t: Date }>(
        "select stage_entered_at as t from public.enquiries where id = $1",
        [a.enquiry],
      );
      await c.query("update public.enquiries set pipeline_id = $1, stage_id = $2 where id = $3", [
        otherPipeline,
        otherStage,
        a.enquiry,
      ]);
      const after = await c.query<{ t: Date }>(
        "select stage_entered_at as t from public.enquiries where id = $1",
        [a.enquiry],
      );
      expect(after.rows[0].t.getTime()).toBeGreaterThanOrEqual(before.rows[0].t.getTime());
      await c.query("update public.enquiries set pipeline_id = $1, stage_id = $2 where id = $3", [
        a.pipeline,
        a.stage1,
        a.enquiry,
      ]);
    });
  });

  it("numbers enquiries per org, starting at 1, without gaps between orgs", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ org_id: string; number: number }>(
        "select org_id, number from public.enquiries where id in ($1, $2)",
        [a.enquiry, b.enquiry],
      );
      expect(rows.find((r) => r.org_id === orgA)?.number).toBe(1);
      expect(rows.find((r) => r.org_id === orgB)?.number).toBe(1);
      const second = await insert(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, title) values ($1, $2, $3, 'second')",
        [orgA, a.pipeline, a.stage1],
      );
      const { rows: n } = await c.query<{ number: number }>(
        "select number from public.enquiries where id = $1",
        [second],
      );
      // earlier tests also created (and deleted) an enquiry, so numbers only ever go up
      expect(n[0].number).toBeGreaterThan(1);
      await expect(
        c.query(
          "insert into public.enquiries (org_id, number, pipeline_id, stage_id, title) values ($1, $4, $2, $3, 'dup')",
          [orgA, a.pipeline, a.stage1, n[0].number],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  it("keeps status, reason and closed_at consistent", async () => {
    await asServiceRole(c, async () => {
      const id = await insert(
        "insert into public.enquiries (org_id, pipeline_id, stage_id, title) values ($1, $2, $3, 'status test')",
        [orgA, a.pipeline, a.stage1],
      );
      await expect(
        c.query("update public.enquiries set status = 'lost' where id = $1", [id]),
      ).rejects.toThrow(/check/);
      await expect(
        c.query(
          "update public.enquiries set status = 'disqualified', lost_reason = '  ' where id = $1",
          [id],
        ),
      ).rejects.toThrow(/check/);
      await c.query(
        "update public.enquiries set status = 'lost', lost_reason = ' Price ' where id = $1",
        [id],
      );
      let row = (
        await c.query("select status, lost_reason, closed_at from public.enquiries where id = $1", [
          id,
        ])
      ).rows[0];
      expect(row.status).toBe("lost");
      expect(row.lost_reason).toBe("Price");
      expect(row.closed_at).not.toBeNull();
      await c.query("update public.enquiries set status = 'won' where id = $1", [id]);
      row = (
        await c.query("select status, lost_reason, closed_at from public.enquiries where id = $1", [
          id,
        ])
      ).rows[0];
      expect(row.lost_reason).toBeNull();
      expect(row.closed_at).not.toBeNull();
      await c.query("update public.enquiries set status = 'open' where id = $1", [id]);
      row = (
        await c.query("select status, lost_reason, closed_at from public.enquiries where id = $1", [
          id,
        ])
      ).rows[0];
      expect(row.closed_at).toBeNull();
    });
  });

  it("keeps task done and done_at in step", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query("update public.tasks set done = true where id = $1", [a.task]),
      ).rejects.toThrow(/check/);
      await c.query("update public.tasks set done = true, done_at = now() where id = $1", [a.task]);
      await c.query("update public.tasks set done = false, done_at = null where id = $1", [a.task]);
    });
  });

  it("allows timeline events for an enquiry without a contact, but not for nothing", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.timeline_events (org_id, enquiry_id, type) values ($1, $2, 'enquiry.created')",
        [orgA, a.enquiry],
      );
      await expect(
        c.query("insert into public.timeline_events (org_id, type) values ($1, 'x')", [orgA]),
      ).rejects.toThrow(/timeline_events_subject_check/);
      await expect(
        c.query(
          "insert into public.timeline_events (org_id, enquiry_id, type) values ($1, $2, 'x')",
          [orgA, b.enquiry],
        ),
      ).rejects.toThrow(/does not belong to org/);
    });
  });

  it("shares views with the owner, everyone or the owner's teams", async () => {
    await asServiceRole(c, async () => {
      await c.query("update public.enquiry_views set shared_all = false where id = $1", [a.view]);
    });
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.enquiry_views")).toBe(0);
    });
    await asServiceRole(c, async () => {
      await c.query("update public.enquiry_views set shared_all = true where id = $1", [a.view]);
    });
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.enquiry_views")).toBe(1);
    });
    await asUser(c, nobody, async () => {
      expect(await count(c, "select 1 from public.enquiry_views")).toBe(0);
    });
  });

  it("search RPCs are service-role only and pinned to the org", async () => {
    await asUser(c, alice, async () => {
      await expect(
        c.query("select * from public.enquiries_search($1, 'true', '[]'::jsonb)", [orgA]),
      ).rejects.toThrow(/permission denied/);
    });
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.enquiries_search($1, 'true', '[]'::jsonb)",
        [orgA],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.id)).not.toContain(b.enquiry);
      const byName = await c.query(
        "select id from public.enquiries_search($1, 'true', '[]'::jsonb, 'e.created_at desc', 50, 0, 'Pat')",
        [orgA],
      );
      expect(byName.rows.map((r) => r.id)).toContain(a.enquiry);
      const byPhone = await c.query(
        "select id from public.enquiries_search($1, 'true', '[]'::jsonb, 'e.created_at desc', 50, 0, '+9715000001')",
        [orgA],
      );
      expect(byPhone.rows.map((r) => r.id)).toContain(a.enquiry);
      const total = Number(
        (await c.query("select public.enquiries_count($1, 'true', '[]'::jsonb) as n", [orgA]))
          .rows[0].n,
      );
      expect(total).toBe(rows.length);
      const stages = await c.query<{ stage_id: string; total: string }>(
        "select * from public.enquiries_stage_counts($1, 'true', '[]'::jsonb)",
        [orgA],
      );
      expect(stages.rows.reduce((n, r) => n + Number(r.total), 0)).toBe(total);
      await expect(
        c.query(
          "select * from public.enquiries_search($1, 'true', '[]'::jsonb, 'e.id; drop table x')",
          [orgA],
        ),
      ).rejects.toThrow(/invalid order by/);
    });
  });

  it("applies the filter AST fragment with bound params", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.enquiries_search($1, '(e.status = ($1 ->> 0))', '[\"won\"]'::jsonb)",
        [orgA],
      );
      expect(rows).toHaveLength(0);
      const open = await c.query(
        "select id from public.enquiries_search($1, '(e.status = ($1 ->> 0))', '[\"open\"]'::jsonb)",
        [orgA],
      );
      expect(open.rows.length).toBeGreaterThan(0);
    });
  });

  it("leaves custom roles untouched by the permission backfill", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "select permissions from public.roles where org_id = $1 and name = 'Viewer'",
        [orgA],
      );
      expect(rows[0].permissions).toEqual(["enquiries.view", "tasks.view"]);
    });
  });
});
