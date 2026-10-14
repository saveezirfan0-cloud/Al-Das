/**
 * Phase 15 (security, audit and access), database side: RLS and cross-org isolation for the new tables,
 * append-only guards, the shared record_history trigger, retention, erase_contact and offboard_member.
 * Runs only with TEST_DATABASE_URL (see supabase/test/README.md).
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import { HISTORY_TABLES } from "@/lib/security/history";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  PHASE15_TABLES,
  resetDb,
  seedSecurityRows,
  TEST_DATABASE_URL,
} from "./helpers";

type Err = { code?: string; message?: string };
/** Runs a statement that is expected to fail inside a throw-away transaction; returns the error, or null when it succeeded. */
async function fails(c: Client, sql: string, params: unknown[] = []): Promise<Err | null> {
  await c.query("begin");
  try {
    await c.query(sql, params);
    return null;
  } catch (e) {
    return e as Err;
  } finally {
    await c.query("rollback");
  }
}

describe.skipIf(!TEST_DATABASE_URL)("phase 15: RLS on the new tables", () => {
  let c: Client;
  let alice: string; // admin A ('*')
  let carol: string; // agent A (no settings access)
  let dave: string; // settings.manage only in A (not security.manage / privacy.manage)
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let a: Record<string, string>;
  let b: Record<string, string>;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    dave = await createAuthUser(c, "dave@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const { rows: agent } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, agent[0].id],
      );
      const { rows: manager } = await c.query<{ id: string }>(
        "insert into public.roles (org_id, name, permissions) values ($1, 'Settings only', '[\"settings.manage\"]'::jsonb) returning id",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, dave, manager[0].id],
      );
    });
    a = await seedSecurityRows(c, orgA, alice);
    b = await seedSecurityRows(c, orgB, bob);
    await asServiceRole(c, async () => {
      await c.query("select public.seed_portal_objects($1)", [orgA]);
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const visible = (table: string, org: string) =>
    count(c, `select 1 from public.${table} where org_id = $1`, [org]);

  it("has RLS and at least one policy on every new table", async () => {
    const { rows } = await c.query<{ name: string; rls: boolean; policies: number }>(
      `select c.relname as name, c.relrowsecurity as rls,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any ($1)`,
      [[...PHASE15_TABLES]],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...PHASE15_TABLES].sort());
    for (const r of rows) {
      expect(r.rls, `${r.name} RLS`).toBe(true);
      expect(r.policies, `${r.name} policies`).toBeGreaterThan(0);
    }
  });

  it("gives an org's admin its own rows and never the other org's, in every new table", async () => {
    await asUser(c, alice, async () => {
      for (const t of PHASE15_TABLES) {
        expect(await visible(t, orgA), `${t}: A sees A`).toBeGreaterThan(0);
        expect(await visible(t, orgB), `${t}: A sees B`).toBe(0);
      }
    });
    await asUser(c, bob, async () => {
      for (const t of PHASE15_TABLES) {
        expect(await visible(t, orgB), `${t}: B sees B`).toBeGreaterThan(0);
        expect(await visible(t, orgA), `${t}: B sees A`).toBe(0);
      }
    });
  });

  it("denies every write to signed-in users, including the org's own admin", async () => {
    await asUser(c, alice, async () => {
      const probes: Array<[string, string, unknown[]]> = [
        [
          "auth_events",
          "insert into public.auth_events (org_id, user_id, event_type) values ($1, $2, 'sign_in')",
          [orgA, alice],
        ],
        [
          "user_sessions",
          "insert into public.user_sessions (org_id, user_id, session_id) values ($1, $2, 'x')",
          [orgA, alice],
        ],
        [
          "record_access_log",
          "insert into public.record_access_log (org_id, user_id, entity, action) values ($1, $2, 'contact', 'view')",
          [orgA, alice],
        ],
        [
          "security_alerts",
          "insert into public.security_alerts (org_id, kind, dedupe_key, summary) values ($1, 'bulk_export', 'k', 's')",
          [orgA],
        ],
        [
          "api_read_log",
          "insert into public.api_read_log (org_id, api_key_id, resource, bucket) values ($1, $2, 'contacts', now())",
          [orgA, a.apiKey],
        ],
        [
          "access_reviews",
          "insert into public.access_reviews (org_id, period, snapshot) values ($1, '2026-Q1', '[]')",
          [orgA],
        ],
        [
          "privacy_requests",
          "insert into public.privacy_requests (org_id, kind, contact_id, reason) values ($1, 'erasure', $2, 'a real reason')",
          [orgA, a.contact],
        ],
        [
          "record_history",
          "insert into public.record_history (org_id, table_name, record_id, op) values ($1, 'tasks', gen_random_uuid(), 'update')",
          [orgA],
        ],
      ];
      for (const [table, sql, params] of probes) {
        const err = await fails(c, sql, params);
        expect(err?.code, `${table} insert`).toBe("42501");
        // update/delete: RLS hides the rows, so nothing is touched
        const u = await c.query(`update public.${table} set org_id = org_id where org_id = $1`, [
          orgA,
        ]);
        const d = await c
          .query(`delete from public.${table} where org_id = $1`, [orgA])
          .catch(() => ({ rowCount: 0 }));
        expect(u.rowCount, `${table} update`).toBe(0);
        expect(d.rowCount, `${table} delete`).toBe(0);
      }
    });
  });

  it("shows an agent only their own sign-in events and sessions, and none of the admin-only tables", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.auth_events (org_id, user_id, event_type) values ($1, $2, 'sign_in')",
        [orgA, carol],
      );
      await c.query(
        "insert into public.user_sessions (org_id, user_id, session_id) values ($1, $2, 'carol-sess')",
        [orgA, carol],
      );
    });
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.auth_events where user_id = $1", [carol])).toBe(
        1,
      );
      expect(await count(c, "select 1 from public.auth_events where user_id <> $1", [carol])).toBe(
        0,
      );
      expect(
        await count(c, "select 1 from public.user_sessions where user_id <> $1", [carol]),
      ).toBe(0);
      for (const t of [
        "record_access_log",
        "security_alerts",
        "api_read_log",
        "access_reviews",
        "privacy_requests",
        "record_history",
      ]) {
        expect(await visible(t, orgA), t).toBe(0);
      }
    });
  });

  it("lets settings.manage read the activity tables but not the security.manage / privacy.manage ones", async () => {
    await asUser(c, dave, async () => {
      for (const t of ["auth_events", "record_access_log", "security_alerts", "api_read_log"]) {
        expect(await visible(t, orgA), `${t} readable`).toBeGreaterThan(0);
      }
      expect(await visible("access_reviews", orgA)).toBe(0);
      expect(await visible("privacy_requests", orgA)).toBe(0);
    });
  });

  it("keeps a user's sign-in events visible to them across orgs but never to another org's admin", async () => {
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.auth_events where user_id = $1", [alice])).toBe(
        0,
      );
    });
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.auth_events where id = $1", [b.authEvent])).toBe(
        0,
      );
    });
  });

  it("scopes record_history to the permission that reads the record", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.record_history (org_id, table_name, record_id, op) values ($1, 'flows', gen_random_uuid(), 'update'), ($1, 'appointments', gen_random_uuid(), 'update'), ($1, 'website_entry_points', gen_random_uuid(), 'update')",
        [orgA],
      );
    });
    const seen = async (user: string) =>
      asUser(c, user, async () => {
        const { rows } = await c.query<{ table_name: string }>(
          "select distinct table_name from public.record_history where org_id = $1 order by 1",
          [orgA],
        );
        return rows.map((r) => r.table_name);
      });
    // acc_accounts: the chart every new org is seeded with (Phase 22A) is in the history too
    expect(await seen(alice)).toEqual([
      "acc_accounts",
      "appointments",
      "flows",
      "tasks",
      "website_entry_points",
    ]);
    expect(await seen(carol)).toEqual([]); // Agent here holds only inbox.send + contacts.view
    expect(await seen(dave)).toEqual([]);
  });

  it("creates roles with MFA off, and lets only settings.manage change the switch through the API roles", async () => {
    const { rows } = await c.query<{ require_mfa: boolean }>(
      "select require_mfa from public.roles where org_id = $1",
      [orgA],
    );
    expect(rows.every((r) => r.require_mfa === false)).toBe(true);
    await asUser(c, carol, async () => {
      const u = await c.query("update public.roles set require_mfa = true where org_id = $1", [
        orgA,
      ]);
      expect(u.rowCount).toBe(0);
    });
    await asUser(c, bob, async () => {
      const u = await c.query("update public.roles set require_mfa = true where org_id = $1", [
        orgA,
      ]);
      expect(u.rowCount).toBe(0);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 15: append-only guards", () => {
  let c: Client;
  let alice: string;
  let orgA: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    ids = await seedSecurityRows(c, orgA, alice);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("record_access_log refuses UPDATE and DELETE, even for the service role", async () => {
    await asServiceRole(c, async () => {
      for (const sql of [
        "update public.record_access_log set action = 'export'",
        "update public.record_access_log set detail = '{}'::jsonb",
        "delete from public.record_access_log",
      ]) {
        const err = await fails(c, sql);
        expect(err?.message, sql).toMatch(/append-only/);
      }
    });
  });

  it("auth_events refuses edits and deletes except the user null-out and the IP scrub", async () => {
    await asServiceRole(c, async () => {
      for (const sql of [
        "update public.auth_events set event_type = 'sign_out'",
        "update public.auth_events set ip_hash = 'tampered'",
        "update public.auth_events set ip_address = '10.0.0.1'",
        "update public.auth_events set at = now() - interval '1 year'",
        "delete from public.auth_events",
      ]) {
        const err = await fails(c, sql);
        expect(err?.message, sql).toMatch(/append-only/);
      }
      const scrub = await c.query("update public.auth_events set ip_address = null where id = $1", [
        ids.authEvent,
      ]);
      expect(scrub.rowCount).toBe(1);
    });
  });

  it("keeps rows when a user is removed (user_id becomes null) and removes them with the org", async () => {
    const bob = await createAuthUser(c, "bob@example.test");
    const orgB = await createOrg(c, "Org B", "org-b", bob);
    await seedSecurityRows(c, orgB, bob);
    await c.query("delete from auth.users where id = $1", [bob]);
    const { rows } = await c.query<{ n: string; nulls: string }>(
      "select count(*)::text as n, count(*) filter (where user_id is null)::text as nulls from public.record_access_log where org_id = $1",
      [orgB],
    );
    expect(rows[0]).toEqual({ n: "1", nulls: "1" });
    expect(
      await count(c, "select 1 from public.auth_events where org_id = $1 and user_id is null", [
        orgB,
      ]),
    ).toBe(1);
    await c.query("begin");
    try {
      await c.query("alter table public.roles disable trigger user");
      await c.query("delete from public.orgs where id = $1", [orgB]);
      expect(
        await count(c, "select 1 from public.record_access_log where org_id = $1", [orgB]),
      ).toBe(0);
    } finally {
      await c.query("rollback");
    }
  });

  it("makes a signed access review immutable", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        'update public.access_reviews set snapshot = \'[{"userId":"x"}]\'::jsonb where id = $1',
        [ids.review],
      ); // still open: fine
      await c.query(
        "update public.access_reviews set status = 'attested', attested_by = $2, attested_at = now(), attestation_name = 'Alice', signature = 'sig' where id = $1",
        [ids.review, alice],
      );
      for (const sql of [
        "update public.access_reviews set snapshot = '[]'::jsonb",
        "update public.access_reviews set signature = 'x'",
        "delete from public.access_reviews",
      ]) {
        expect((await fails(c, sql))?.message, sql).toMatch(/attested access review/);
      }
    });
  });

  it("requires attested_at exactly when the review is attested", async () => {
    await asServiceRole(c, async () => {
      const err = await fails(
        c,
        "insert into public.access_reviews (org_id, period, snapshot, status) values ($1, '2026-Q3', '[]', 'attested')",
        [orgA],
      );
      expect(err?.code).toBe("23514");
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 15: record_history trigger", () => {
  let c: Client;
  let alice: string;
  let carol: string;
  let orgA: string;
  let taskId: string;

  const asService = async <T>(
    headers: Record<string, string> | null,
    fn: () => Promise<T>,
  ): Promise<T> => {
    await c.query("set role service_role");
    await c.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    if (headers)
      await c.query("select set_config('request.headers', $1, false)", [JSON.stringify(headers)]);
    try {
      return await fn();
    } finally {
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', false)");
      await c.query("select set_config('request.headers', '', false)");
    }
  };
  const history = async (table: string, id: string) =>
    (
      await c.query<{
        op: string;
        actor_id: string | null;
        changes: Record<string, { from: unknown; to: unknown }>;
      }>(
        "select op, actor_id, changes from public.record_history where table_name = $1 and record_id = $2 order by id",
        [table, id],
      )
    ).rows;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("records create, field-level change and delete with the actor named in the service-role header", async () => {
    await asService({ "x-pulse-actor": alice }, async () => {
      taskId = (
        await c.query<{ id: string }>(
          "insert into public.tasks (org_id, subject, due_at) values ($1, 'Call back', now()) returning id",
          [orgA],
        )
      ).rows[0].id;
      await c.query(
        "update public.tasks set subject = 'Call back today', notes = 'ask about results' where id = $1",
        [taskId],
      );
      await c.query("delete from public.tasks where id = $1", [taskId]);
    });
    const rows = await history("tasks", taskId);
    expect(rows.map((r) => r.op)).toEqual(["insert", "update", "delete"]);
    expect(rows.every((r) => r.actor_id === alice)).toBe(true);
    expect(rows[1].changes).toEqual({
      subject: { from: "Call back", to: "Call back today" },
      notes: { from: null, to: "ask about results" },
    });
  });

  it("ignores noise: updated_at and other bookkeeping columns alone write nothing", async () => {
    const id = await asService(null, async () => {
      const r = (
        await c.query<{ id: string }>(
          "insert into public.tasks (org_id, subject, due_at) values ($1, 'Noise', now()) returning id",
          [orgA],
        )
      ).rows[0].id;
      await c.query(
        "update public.tasks set updated_at = now() + interval '1 minute', due_notified_for = now() where id = $1",
        [r],
      );
      return r;
    });
    expect((await history("tasks", id)).map((r) => r.op)).toEqual(["insert"]);
  });

  it("does not trust the actor header from a signed-in user, and treats a malformed or unknown actor as System", async () => {
    await c.query("set role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: alice, role: "authenticated" }),
    ]);
    await c.query("select set_config('request.headers', $1, false)", [
      JSON.stringify({ "x-pulse-actor": carol }),
    ]);
    const viaUser = await c
      .query<{ id: string }>(
        "insert into public.tasks (org_id, subject, due_at) values ($1, 'By Alice', now()) returning id",
        [orgA],
      )
      .catch((e: Err) => e);
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', false)");
    await c.query("select set_config('request.headers', '', false)");
    // The Agent policy for tasks may reject the insert; the point is that no forged actor was recorded.
    if ("rows" in viaUser) {
      const rows = await history("tasks", viaUser.rows[0].id);
      expect(rows[0].actor_id).toBe(alice); // auth.uid(), never the header
    }

    const unknown = await asService(
      { "x-pulse-actor": "00000000-0000-0000-0000-00000000dead" },
      async () =>
        (
          await c.query<{ id: string }>(
            "insert into public.tasks (org_id, subject, due_at) values ($1, 'Ghost actor', now()) returning id",
            [orgA],
          )
        ).rows[0].id,
    );
    expect((await history("tasks", unknown))[0].actor_id).toBeNull();
    const malformed = await asService(
      { "x-pulse-actor": "not-a-uuid" },
      async () =>
        (
          await c.query<{ id: string }>(
            "insert into public.tasks (org_id, subject, due_at) values ($1, 'Bad header', now()) returning id",
            [orgA],
          )
        ).rows[0].id,
    );
    expect((await history("tasks", malformed))[0].actor_id).toBeNull();
  });

  it("cuts long text and reduces large JSON to a marker", async () => {
    const flowId = await asService({ "x-pulse-actor": alice }, async () => {
      const id = (
        await c.query<{ id: string }>(
          "insert into public.flows (org_id, name) values ($1, 'Flow') returning id",
          [orgA],
        )
      ).rows[0].id;
      const big = JSON.stringify({
        nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, type: "send" })),
        edges: [],
      });
      await c.query("update public.flows set graph = $2::jsonb, description = $3 where id = $1", [
        id,
        big,
        "x".repeat(900),
      ]);
      return id;
    });
    const update = (await history("flows", flowId))[1];
    expect(update.changes.graph.to).toEqual({ changed: true });
    expect(String(update.changes.description.to).length).toBe(501);
    expect(String(update.changes.description.to).endsWith("…")).toBe(true);
  });

  it("covers every table the app lists, plus every portal object", async () => {
    const { rows } = await c.query<{ table_name: string }>(
      "select event_object_table as table_name from information_schema.triggers where trigger_name like '%\\_record\\_history' group by 1",
    );
    const have = new Set(rows.map((r) => r.table_name));
    for (const t of Object.keys(HISTORY_TABLES))
      expect(have.has(t), `${t} has the record_history trigger`).toBe(true);
    for (const o of PORTAL_OBJECTS) expect(have.has(o.table), `portal object ${o.key}`).toBe(true);
  });

  it("works for a portal table too", async () => {
    const id = await asService({ "x-pulse-actor": alice }, async () => {
      const r = (
        await c.query<{ id: string }>(
          "insert into public.website_entry_points (org_id, section, source_key) values ($1, 'General', 'k1') returning id",
          [orgA],
        )
      ).rows[0].id;
      await c.query(
        "update public.website_entry_points set route_to = 'Nursing team' where id = $1",
        [r],
      );
      return r;
    });
    expect((await history("website_entry_points", id))[1].changes).toEqual({
      route_to: { from: null, to: "Nursing team" },
    });
  });

  it("is append-only: no one edits or deletes history", async () => {
    await asServiceRole(c, async () => {
      expect(
        (await fails(c, "update public.record_history set changes = '{}'::jsonb"))?.message,
      ).toMatch(/append-only/);
      expect((await fails(c, "delete from public.record_history"))?.message).toMatch(/append-only/);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 15: retention (security_maintenance)", () => {
  let c: Client;
  let alice: string;
  let orgA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("nulls raw IPs after 30 days but keeps the hash and the event", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.auth_events (org_id, user_id, event_type, ip_address, ip_hash, at) values ($1, $2, 'sign_in', '203.0.113.1', 'h-old', now() - interval '31 days'), ($1, $2, 'sign_in', '203.0.113.2', 'h-new', now() - interval '29 days')",
        [orgA, alice],
      );
      const { rows } = await c.query("select public.security_maintenance() as r");
      expect(rows[0].r.raw_ips_scrubbed).toBe(1);
      const { rows: events } = await c.query<{ ip_hash: string; ip_address: string | null }>(
        "select ip_hash, ip_address from public.auth_events order by at",
      );
      expect(events).toEqual([
        { ip_hash: "h-old", ip_address: null },
        { ip_hash: "h-new", ip_address: "203.0.113.2" },
      ]);
    });
  });

  it("deletes auth events after 400 days", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.auth_events (org_id, user_id, event_type, at) values ($1, $2, 'sign_out', now() - interval '401 days')",
        [orgA, alice],
      );
      const { rows } = await c.query("select public.security_maintenance() as r");
      expect(rows[0].r.auth_events_deleted).toBe(1);
    });
  });

  it("applies each org's retention setting to the record access log, never below 30 days", async () => {
    const bob = await createAuthUser(c, "bob@example.test");
    const orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      await c.query(
        'update public.orgs set settings = \'{"security": {"access_log_retention_days": 90}}\'::jsonb where id = $1',
        [orgA],
      );
      await c.query(
        'update public.orgs set settings = \'{"security": {"access_log_retention_days": 1}}\'::jsonb where id = $1',
        [orgB],
      );
      for (const org of [orgA, orgB]) {
        await c.query(
          "insert into public.record_access_log (org_id, entity, action, at) values ($1, 'contact', 'view', now() - interval '20 days'), ($1, 'contact', 'view', now() - interval '60 days'), ($1, 'contact', 'view', now() - interval '120 days'), ($1, 'contact', 'view', now() - interval '400 days')",
          [org],
        );
      }
      await c.query("select public.security_maintenance()");
      // A: 90 days keeps the 20- and 60-day rows. B: 1 day is clamped to 30, which keeps only the 20-day row.
      expect(
        await count(c, "select 1 from public.record_access_log where org_id = $1", [orgA]),
      ).toBe(2);
      expect(
        await count(c, "select 1 from public.record_access_log where org_id = $1", [orgB]),
      ).toBe(1);
    });
  });

  it("clears stale sessions and old API read aggregates, and is callable by the service role only", async () => {
    await asServiceRole(c, async () => {
      const { rows: key } = await c.query<{ id: string }>(
        "insert into public.api_keys (org_id, name, key_prefix, key_hash) values ($1, 'k', 'pk_x', 'h-ret') returning id",
        [orgA],
      );
      await c.query(
        "insert into public.user_sessions (org_id, user_id, session_id, last_seen_at) values ($1, $2, 'old', now() - interval '91 days'), ($1, $2, 'fresh', now())",
        [orgA, alice],
      );
      await c.query(
        "insert into public.api_read_log (org_id, api_key_id, resource, bucket) values ($1, $2, 'contacts', now() - interval '91 days'), ($1, $2, 'tasks', date_trunc('hour', now()))",
        [orgA, key[0].id],
      );
      const { rows } = await c.query("select public.security_maintenance() as r");
      expect(rows[0].r.sessions_deleted).toBe(1);
      expect(rows[0].r.api_read_rows_deleted).toBe(1);
    });
    for (const role of ["anon", "authenticated"]) {
      await c.query(`set role ${role}`);
      const err = await fails(c, "select public.security_maintenance()");
      await c.query("reset role");
      expect(err?.code, role).toBe("42501");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 15: api_read_log_hit", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;
  let keyA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      keyA = (
        await c.query<{ id: string }>(
          "insert into public.api_keys (org_id, name, key_prefix, key_hash) values ($1, 'k', 'pk_a', 'h-a') returning id",
          [orgA],
        )
      ).rows[0].id;
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("aggregates per key, resource and hour, and returns the hour's total rows", async () => {
    await asServiceRole(c, async () => {
      const hit = async (resource: string, rows: number) =>
        (
          await c.query<{ t: number }>("select public.api_read_log_hit($1, $2, $3, $4) as t", [
            orgA,
            keyA,
            resource,
            rows,
          ])
        ).rows[0].t;
      expect(await hit("contacts", 10)).toBe(10);
      expect(await hit("contacts", 5)).toBe(15);
      expect(await hit("tasks", 1)).toBe(16);
      const { rows } = await c.query(
        "select resource, request_count, row_count from public.api_read_log where api_key_id = $1 order by resource",
        [keyA],
      );
      expect(rows).toEqual([
        { resource: "contacts", request_count: 2, row_count: 15 },
        { resource: "tasks", request_count: 1, row_count: 1 },
      ]);
    });
  });

  it("ignores a key that belongs to another org and rejects non-service callers", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "select public.api_read_log_hit($1, $2, 'contacts', 99) as t",
        [orgB, keyA],
      );
      expect(rows[0].t).toBe(0);
      expect(await count(c, "select 1 from public.api_read_log where org_id = $1", [orgB])).toBe(0);
    });
    await asUser(c, alice, async () => {
      expect(
        (await fails(c, "select public.api_read_log_hit($1, $2, 'contacts', 1)", [orgA, keyA]))
          ?.code,
      ).toBe("42501");
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "phase 15: privacy requests, erase_contact and offboard_member",
  () => {
    let c: Client;
    let alice: string; // admin A
    let carol: string; // agent A
    let erin: string; // second admin A
    let bob: string; // admin B
    let orgA: string;
    let orgB: string;
    let contact: string;
    let otherContact: string;
    let conv: string;
    let channel: string;
    let enquiry: string;

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      carol = await createAuthUser(c, "carol@example.test");
      erin = await createAuthUser(c, "erin@example.test");
      bob = await createAuthUser(c, "bob@example.test");
      orgA = await createOrg(c, "Org A", "org-a", alice);
      orgB = await createOrg(c, "Org B", "org-b", bob);
      await asServiceRole(c, async () => {
        const role = async (name: string) =>
          (
            await c.query<{ id: string }>(
              "select id from public.roles where org_id = $1 and name = $2",
              [orgA, name],
            )
          ).rows[0].id;
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3), ($1, $4, $5)",
          [orgA, carol, await role("Agent"), erin, await role("Admin")],
        );
        const ins = async (sql: string, params: unknown[]) =>
          (await c.query<{ id: string }>(sql + " returning id", params)).rows[0].id;
        contact = await ins(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, email, dob, custom, promotions_opt_in) values ($1, 'Layla', 'Haddad', '+971501112222', 'layla@example.test', '1990-05-05', '{\"nick\": \"Lulu\"}', true)",
          [orgA],
        );
        otherContact = await ins(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Omar', 'Said', '+971503334444')",
          [orgA],
        );
        await c.query(
          "insert into public.contact_phones (org_id, contact_id, phone_e164) values ($1, $2, '+971509998888')",
          [orgA, contact],
        );
        channel = await ins(
          "insert into public.channels (org_id, name, phone_number_id, waba_id) values ($1, 'Main', 'pn1', 'w1')",
          [orgA],
        );
        conv = await ins(
          "insert into public.conversations (org_id, channel_id, contact_id, summary, last_message_preview) values ($1, $2, $3, 'Asked about lab results', 'Thanks doctor')",
          [orgA, channel, contact],
        );
        await c.query(
          "insert into public.messages (org_id, conversation_id, direction, kind, body, media_path, payload) values ($1, $2, 'in', 'text', 'My results please', null, '{\"raw\":\"x\"}'), ($1, $2, 'in', 'image', null, $3, '{}')",
          [orgA, conv, `${orgA}/${conv}/m1.jpg`],
        );
        await c.query(
          "insert into public.timeline_events (org_id, contact_id, type, payload) values ($1, $2, 'note', '{\"text\": \"allergic to penicillin\"}')",
          [orgA, contact],
        );
        const appt = await ins(
          "insert into public.appointments (org_id, contact_id, starts_at, ends_at, notes, custom) values ($1, $2, now(), now() + interval '30 minutes', 'Fasting required', '{\"k\": 1}')",
          [orgA, contact],
        );
        const pipeline = await ins(
          "insert into public.pipelines (org_id, name, is_default) values ($1, 'Main', true)",
          [orgA],
        );
        const stage = await ins(
          "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
          [orgA, pipeline],
        );
        enquiry = await ins(
          "insert into public.enquiries (org_id, contact_id, title, pipeline_id, stage_id, lost_reason, custom) values ($1, $2, 'Knee pain consult', $3, $4, 'too expensive', '{\"k\": \"v\"}')",
          [orgA, contact, pipeline, stage],
        );
        await ins(
          "insert into public.tasks (org_id, contact_id, subject, notes, due_at) values ($1, $2, 'Call Layla about results', 'private note', now())",
          [orgA, contact],
        );
        await c.query(
          "insert into public.sync_reviews (org_id, source, entity, external_id, reason, status, resolved_contact_id, incoming) values ($1, 'unite', 'patient', 'PIN-9', 'ambiguous', 'resolved', $2, '{\"name\": \"Layla Haddad\"}')",
          [orgA, contact],
        );
        await c.query(
          "insert into public.visits (org_id, contact_id, external_id, source, visit_date, doctor_notes) values ($1, $2, 'V-1', 'unite', current_date, 'clinical note')",
          [orgA, contact],
        );
        // history rows for the appointment (as the trigger would have written them)
        await c.query(
          "update public.appointments set notes = 'Fasting required (updated)' where id = $1",
          [appt],
        );
      });
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    describe("privacy_requests", () => {
      it("refuses a decision by the person who raised the request (two-person rule in the database)", async () => {
        await asServiceRole(c, async () => {
          const id = (
            await c.query<{ id: string }>(
              "insert into public.privacy_requests (org_id, kind, contact_id, reason, requested_by) values ($1, 'erasure', $2, 'patient wrote in', $3) returning id",
              [orgA, contact, alice],
            )
          ).rows[0].id;
          expect(
            (
              await fails(
                c,
                "update public.privacy_requests set status = 'approved', decided_by = $2 where id = $1",
                [id, alice],
              )
            )?.code,
          ).toBe("23514");
          await c.query(
            "update public.privacy_requests set status = 'approved', decided_by = $2, decided_at = now() where id = $1",
            [id, erin],
          );
          expect(
            await count(
              c,
              "select 1 from public.privacy_requests where id = $1 and status = 'approved'",
              [id],
            ),
          ).toBe(1);
        });
      });
      it("requires a real reason, a valid kind, and a contact from the same org", async () => {
        await asServiceRole(c, async () => {
          expect(
            (
              await fails(
                c,
                "insert into public.privacy_requests (org_id, kind, contact_id, reason) values ($1, 'export', $2, 'abc')",
                [orgA, contact],
              )
            )?.code,
          ).toBe("23514");
          expect(
            (
              await fails(
                c,
                "insert into public.privacy_requests (org_id, kind, contact_id, reason) values ($1, 'delete', $2, 'long enough')",
                [orgA, contact],
              )
            )?.code,
          ).toBe("23514");
          expect(
            (
              await fails(
                c,
                "insert into public.privacy_requests (org_id, kind, contact_id, reason) values ($1, 'export', $2, 'long enough')",
                [orgB, contact],
              )
            )?.code,
          ).toBe("23514");
        });
      });
      it("is readable by privacy.manage holders in the org only", async () => {
        await asUser(c, erin, async () =>
          expect(
            await count(c, "select 1 from public.privacy_requests where org_id = $1", [orgA]),
          ).toBeGreaterThan(0),
        );
        await asUser(c, carol, async () =>
          expect(await count(c, "select 1 from public.privacy_requests")).toBe(0),
        );
        await asUser(c, bob, async () =>
          expect(await count(c, "select 1 from public.privacy_requests")).toBe(0),
        );
      });
    });

    describe("erase_contact", () => {
      it("is not callable by signed-in users", async () => {
        await asUser(c, alice, async () => {
          expect(
            (await fails(c, "select public.erase_contact($1, $2, $3)", [orgA, contact, alice]))
              ?.code,
          ).toBe("42501");
        });
      });

      it("refuses a contact from another org", async () => {
        await asServiceRole(c, async () => {
          const err = await fails(c, "select public.erase_contact($1, $2, $3)", [
            orgB,
            contact,
            bob,
          ]);
          expect(err?.message).toMatch(/not found/);
        });
        expect(
          await count(c, "select 1 from public.contacts where id = $1 and erased_at is null", [
            contact,
          ]),
        ).toBe(1);
      });

      it("anonymises the patient and everything that could name them, and leaves other patients alone", async () => {
        let result: Record<string, number> = {};
        await asServiceRole(c, async () => {
          result = (
            await c.query("select public.erase_contact($1, $2, $3) as r", [orgA, contact, alice])
          ).rows[0].r;
        });
        const {
          rows: [p],
        } = await c.query(
          "select first_name, last_name, phone_e164, email, dob, custom, promotions_opt_in, stop_marketing, clinical_messaging_consent, erased_at, deleted_at from public.contacts where id = $1",
          [contact],
        );
        expect(p).toMatchObject({
          first_name: "Erased",
          last_name: "patient",
          phone_e164: null,
          email: null,
          dob: null,
          custom: {},
          promotions_opt_in: false,
          stop_marketing: true,
          clinical_messaging_consent: false,
        });
        expect(p.erased_at).not.toBeNull();
        expect(p.deleted_at).not.toBeNull();
        expect(
          await count(c, "select 1 from public.contact_phones where contact_id = $1", [contact]),
        ).toBe(0);
        expect(
          await count(c, "select 1 from public.timeline_events where contact_id = $1", [contact]),
        ).toBe(0);
        const {
          rows: [t],
        } = await c.query("select subject, notes from public.tasks where contact_id = $1", [
          contact,
        ]);
        expect(t).toEqual({ subject: "Erased task", notes: null });
        const {
          rows: [a],
        } = await c.query("select notes, custom from public.appointments where contact_id = $1", [
          contact,
        ]);
        expect(a).toEqual({ notes: null, custom: {} });
        const { rows: msgs } = await c.query(
          "select body, payload, media_path from public.messages where conversation_id = $1",
          [conv],
        );
        expect(msgs).toHaveLength(2); // the rows stay for counts
        expect(
          msgs.every(
            (m) => m.body === null && m.media_path === null && Object.keys(m.payload).length === 0,
          ),
        ).toBe(true);
        const {
          rows: [cv],
        } = await c.query(
          "select summary, last_message_preview from public.conversations where id = $1",
          [conv],
        );
        expect(cv).toEqual({ summary: null, last_message_preview: null });
        const {
          rows: [e],
        } = await c.query("select title, lost_reason, custom from public.enquiries where id = $1", [
          enquiry,
        ]);
        expect(e).toEqual({ title: "Erased enquiry", lost_reason: null, custom: {} });
        const {
          rows: [review],
        } = await c.query(
          "select incoming, candidates from public.sync_reviews where resolved_contact_id = $1",
          [contact],
        );
        expect(review).toEqual({ incoming: {}, candidates: [] });
        // The field history of the patient's records repeated the notes: gone.
        expect(
          await count(
            c,
            "select 1 from public.record_history where table_name in ('appointments', 'tasks', 'enquiries') and changes::text ilike '%Fasting%'",
          ),
        ).toBe(0);
        // Clinical records are retained and reported.
        expect(await count(c, "select 1 from public.visits where contact_id = $1", [contact])).toBe(
          1,
        );
        expect(result.retained_visits).toBe(1);
        // Another patient is untouched.
        const {
          rows: [o],
        } = await c.query(
          "select first_name, phone_e164, erased_at from public.contacts where id = $1",
          [otherContact],
        );
        expect(o).toEqual({ first_name: "Omar", phone_e164: "+971503334444", erased_at: null });
        // And the audit row names no personal data.
        const {
          rows: [audit],
        } = await c.query(
          "select action, diff from public.audit_log where entity = 'contact' and entity_id = $1 and action = 'contact.erased'",
          [contact],
        );
        expect(audit.action).toBe("contact.erased");
        expect(JSON.stringify(audit.diff)).not.toMatch(/Layla|Haddad|layla@|9715011/);
      });

      it("cannot erase the same patient twice", async () => {
        await asServiceRole(c, async () => {
          expect(
            (await fails(c, "select public.erase_contact($1, $2, $3)", [orgA, contact, alice]))
              ?.message,
          ).toMatch(/already erased/);
        });
      });

      it("frees the phone number for a new patient record", async () => {
        await asServiceRole(c, async () => {
          await c.query(
            "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'New', '+971501112222')",
            [orgA],
          );
        });
      });
    });

    describe("offboard_member", () => {
      let membershipId: string;
      let keyId: string;
      let teamId: string;
      let convId: string;
      let frank: string; // second (suspended) admin of org B
      let grace: string; // agent of org A with one open task

      beforeAll(async () => {
        frank = await createAuthUser(c, "frank@example.test");
        grace = await createAuthUser(c, "grace@example.test");
        await asServiceRole(c, async () => {
          membershipId = (
            await c.query<{ id: string }>(
              "select id from public.memberships where org_id = $1 and user_id = $2",
              [orgA, carol],
            )
          ).rows[0].id;
          keyId = (
            await c.query<{ id: string }>(
              "insert into public.api_keys (org_id, name, key_prefix, key_hash, created_by) values ($1, 'carol key', 'pk_c', 'h-carol', $2) returning id",
              [orgA, carol],
            )
          ).rows[0].id;
          teamId = (
            await c.query<{ id: string }>(
              "insert into public.teams (org_id, name) values ($1, 'Front desk') returning id",
              [orgA],
            )
          ).rows[0].id;
          await c.query(
            "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)",
            [orgA, teamId, carol],
          );
          await c.query(
            "insert into public.tasks (org_id, subject, due_at, assignee_id) values ($1, 'Carol open', now(), $2), ($1, 'Carol done', now(), $2)",
            [orgA, carol],
          );
          await c.query(
            "update public.tasks set done = true, done_at = now() where subject = 'Carol done'",
          );
          await c.query(
            "insert into public.user_sessions (org_id, user_id, session_id) values ($1, $2, 'carol-phone')",
            [orgA, carol],
          );
          convId = (
            await c.query<{ id: string }>(
              "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id, status) values ($1, $2, $3, $4, 'open') returning id",
              [orgA, channel, otherContact, carol],
            )
          ).rows[0].id;
          await c.query(
            "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id, status, closed_at) values ($1, $2, $3, $4, 'closed', now())",
            [orgA, channel, otherContact, carol],
          );
        });
      });

      it("is not callable by signed-in users", async () => {
        await asUser(c, alice, async () => {
          expect(
            (
              await fails(c, "select public.offboard_member($1, $2, $3, null)", [
                orgA,
                membershipId,
                alice,
              ])
            )?.code,
          ).toBe("42501");
        });
      });

      it("refuses yourself, another org's member, an outsider as hand-over target, and the last administrator", async () => {
        await asServiceRole(c, async () => {
          const mine = (
            await c.query<{ id: string }>(
              "select id from public.memberships where org_id = $1 and user_id = $2",
              [orgA, alice],
            )
          ).rows[0].id;
          expect(
            (await fails(c, "select public.offboard_member($1, $2, $3, null)", [orgA, mine, alice]))
              ?.message,
          ).toMatch(/yourself/);
          expect(
            (
              await fails(c, "select public.offboard_member($1, $2, $3, null)", [
                orgB,
                membershipId,
                bob,
              ])
            )?.message,
          ).toMatch(/not found/);
          expect(
            (
              await fails(c, "select public.offboard_member($1, $2, $3, $4)", [
                orgA,
                membershipId,
                alice,
                bob,
              ])
            )?.message,
          ).toMatch(/not an active member/);
          // Bob is the only admin of org B.
          const bobM = (
            await c.query<{ id: string }>(
              "select id from public.memberships where org_id = $1 and user_id = $2",
              [orgB, bob],
            )
          ).rows[0].id;
          const adminRole = (
            await c.query<{ id: string }>(
              "select id from public.roles where org_id = $1 and name = 'Admin'",
              [orgB],
            )
          ).rows[0].id;
          await c.query(
            "insert into public.memberships (org_id, user_id, role_id, status) values ($1, $2, $3, 'active')",
            [orgB, frank, adminRole],
          );
          await c.query(
            "update public.memberships set status = 'suspended' where org_id = $1 and user_id = $2",
            [orgB, frank],
          );
          expect(
            (await fails(c, "select public.offboard_member($1, $2, $3, null)", [orgB, bobM, frank]))
              ?.message,
          ).toMatch(/last administrator/);
        });
      });

      it("suspends, revokes keys and sessions, hands over open work only, leaves teams, and audits, all at once", async () => {
        let result: Record<string, unknown> = {};
        await asServiceRole(c, async () => {
          result = (
            await c.query("select public.offboard_member($1, $2, $3, $4) as r", [
              orgA,
              membershipId,
              alice,
              erin,
            ])
          ).rows[0].r;
        });
        expect(result).toMatchObject({
          user_id: carol,
          api_keys_revoked: 1,
          tasks_reassigned: 1,
          teams_left: 1,
          sessions_marked_revoked: 1,
          reassigned_to: erin,
        });
        const {
          rows: [m],
        } = await c.query("select status, presence from public.memberships where id = $1", [
          membershipId,
        ]);
        expect(m).toEqual({ status: "suspended", presence: "offline" });
        expect(
          (await c.query("select revoked_at from public.api_keys where id = $1", [keyId])).rows[0]
            .revoked_at,
        ).not.toBeNull();
        expect(
          (
            await c.query(
              "select revoked_at, revoked_reason from public.user_sessions where session_id = 'carol-phone'",
            )
          ).rows[0].revoked_reason,
        ).toBe("offboarded");
        const { rows: tasks } = await c.query(
          "select subject, assignee_id from public.tasks where subject like 'Carol %' order by subject",
        );
        expect(tasks).toEqual([
          { subject: "Carol done", assignee_id: carol }, // finished work stays attributed
          { subject: "Carol open", assignee_id: erin },
        ]);
        expect(
          await count(c, "select 1 from public.team_members where user_id = $1", [carol]),
        ).toBe(0);
        expect(result.conversations_reassigned).toBe(1);
        expect(
          (
            await c.query("select assignee_user_id from public.conversations where id = $1", [
              convId,
            ])
          ).rows[0].assignee_user_id,
        ).toBe(erin);
        expect(
          await count(
            c,
            "select 1 from public.conversations where status = 'closed' and assignee_user_id = $1",
            [carol],
          ),
        ).toBe(1);
        const {
          rows: [audit],
        } = await c.query(
          "select user_id, diff from public.audit_log where action = 'member.offboarded' and entity_id = $1",
          [membershipId],
        );
        expect(audit.user_id).toBe(alice);
        expect(audit.diff.api_keys_revoked).toBe(1);
      });

      it("refuses to off-board someone already suspended, and unassigns when there is no hand-over target", async () => {
        await asServiceRole(c, async () => {
          const agentRole = (
            await c.query<{ id: string }>(
              "select id from public.roles where org_id = $1 and name = 'Agent'",
              [orgA],
            )
          ).rows[0].id;
          const suspended = (
            await c.query<{ id: string }>(
              "insert into public.memberships (org_id, user_id, role_id, status) values ($1, $2, $3, 'suspended') returning id",
              [orgA, frank, agentRole],
            )
          ).rows[0].id;
          expect(
            (
              await fails(c, "select public.offboard_member($1, $2, $3, null)", [
                orgA,
                suspended,
                alice,
              ])
            )?.message,
          ).toMatch(/already suspended/);

          const mid = (
            await c.query<{ id: string }>(
              "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3) returning id",
              [orgA, grace, agentRole],
            )
          ).rows[0].id;
          await c.query(
            "insert into public.tasks (org_id, subject, due_at, assignee_id) values ($1, 'Grace open', now(), $2)",
            [orgA, grace],
          );
          await c.query("select public.offboard_member($1, $2, $3, null)", [orgA, mid, alice]);
          expect(
            (await c.query("select assignee_id from public.tasks where subject = 'Grace open'"))
              .rows[0].assignee_id,
          ).toBeNull();
        });
      });
    });
  },
);
