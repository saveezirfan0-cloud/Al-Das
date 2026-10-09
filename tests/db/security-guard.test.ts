/**
 * Phase 11 security pass, database side. Introspects the catalog so that a future
 * migration cannot add a table, policy or function that quietly breaks tenant
 * isolation (CLAUDE.md rule 1), and sweeps every org-scoped table with real
 * cross-org reads and writes. Runs only with TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

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

/** Tables with no API policy on purpose: only the service role (server code after can()) touches them. */
const SERVICE_ONLY = new Set([
  // Phase 6: per-org appointment number counter, only touched by a security-definer trigger
  "appointment_counters",
  "channel_secrets",
  "channel_send_slots",
  "dead_letters",
  // Finance module: infrastructure and raw-payload tables, documented as service-only in their migrations
  "fin_capture_lease",
  "fin_capture_settings",
  "fin_raw_diligence_files",
  "fin_raw_unite_batches",
  "integration_accounts",
  "unite_api_calls",
  "job_runs",
  "rate_limit_hits",
  "scheduled_jobs",
  "webhook_events_in",
]);

/** SECURITY DEFINER functions in `public` that signed-in users may call directly (each uses auth.uid() inside). */
const AUTHENTICATED_RPCS = new Set(["mark_all_notifications_read", "set_presence"]);

/**
 * Tables whose BEFORE-INSERT triggers (cross-org consistency checks, system-role protection)
 * raise before RLS is evaluated, so the generic insert probe sees 23514 instead of 42501.
 * Their policies are proven by the dedicated per-table suites, which this file checks by name.
 */
const TRIGGER_GUARDED = new Set(["conversation_labels", "conversations", "invites", "memberships", "team_members"]);

/** Helpers a policy must call to be considered org-scoped. */
const ORG_SCOPE_MARKERS = [
  "org_id",
  "app.is_org_member",
  "app.has_perm",
  "app.user_org_ids",
  "app.can_view_conversation",
  "app.shares_org_with",
];

type Rel = { name: string; rls: boolean; has_org: boolean; policies: number };

describe.skipIf(!TEST_DATABASE_URL)("security guard (catalog)", () => {
  let c: Client;
  let rels: Rel[];

  beforeAll(async () => {
    c = await connect();
    const { rows } = await c.query<Rel>(`
      select c.relname as name, c.relrowsecurity as rls,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`);
    rels = rows;
  });
  afterAll(async () => {
    await c.end();
  });

  it("sees the schema (guards against an empty catalog making every test vacuous)", () => {
    expect(rels.length).toBeGreaterThanOrEqual(35);
  });

  it("has row level security enabled on every public table", () => {
    expect(rels.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
  });

  it("gives every org-scoped table at least one policy unless it is explicitly service-only", () => {
    const missing = rels.filter((r) => r.has_org && r.policies === 0 && !SERVICE_ONLY.has(r.name));
    expect(missing.map((r) => r.name)).toEqual([]);
  });

  it("keeps the service-only allowlist honest: listed tables have no API policy and exist", () => {
    const byName = new Map(rels.map((r) => [r.name, r]));
    for (const t of SERVICE_ONLY) {
      expect(byName.has(t), `${t} is in SERVICE_ONLY but does not exist`).toBe(true);
      expect(byName.get(t)!.policies, `${t} has policies; remove it from SERVICE_ONLY`).toBe(0);
    }
  });

  it("scopes every policy on an org table to the org (no using(true), no unscoped policy)", async () => {
    const { rows } = await c.query<{
      tablename: string;
      policyname: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>(`select tablename, policyname, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public'`);
    const orgTables = new Set(rels.filter((r) => r.has_org).map((r) => r.name));
    const bad: string[] = [];
    for (const p of rows) {
      if (/anon|public/.test(p.roles) && !/authenticated/.test(p.roles)) bad.push(`${p.tablename}.${p.policyname}: applies to anon/public`);
      const exprs = [p.qual, p.with_check].filter((e): e is string => !!e);
      if (exprs.some((e) => e.trim() === "true")) bad.push(`${p.tablename}.${p.policyname}: always true`);
      if (orgTables.has(p.tablename) && exprs.length > 0) {
        const joined = exprs.join(" ");
        if (!ORG_SCOPE_MARKERS.some((m) => joined.includes(m))) bad.push(`${p.tablename}.${p.policyname}: not org-scoped`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("pins search_path on every SECURITY DEFINER function in public and app", async () => {
    const { rows } = await c.query<{ name: string }>(`
      select n.nspname || '.' || p.proname as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app') and p.prokind = 'f' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("exposes no SECURITY DEFINER RPC in public to anon, and only the allowlisted ones to signed-in users", async () => {
    const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean }>(`
      select p.proname as name,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef`);
    expect(rows.filter((r) => r.anon).map((r) => r.name)).toEqual([]);
    expect(rows.filter((r) => r.auth && !AUTHENTICATED_RPCS.has(r.name)).map((r) => r.name)).toEqual([]);
    expect(rows.some((r) => AUTHENTICATED_RPCS.has(r.name) && r.auth)).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("cross-org sweep over every org-scoped table", () => {
  let c: Client;
  let alice: string; // admin of org A
  let bob: string; // admin of org B
  let nobody: string; // signed up, no membership
  let orgA: string;
  let orgB: string;
  let orgTables: string[];
  let allTables: string[];

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    nobody = await createAuthUser(c, "nobody@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    const { rows } = await c.query<{ name: string; has_org: boolean; policies: number }>(`
      select c.relname as name,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`);
    allTables = rows.map((r) => r.name);
    orgTables = rows.filter((r) => r.has_org && r.policies > 0).map((r) => r.name);

    // Give org A some rows in tables that are service-only or otherwise easy to seed.
    await asServiceRole(c, async () => {
      await c.query("insert into public.rate_limit_hits (key, window_start, hits) values ('sweep', now(), 1)");
      await c.query("insert into public.webhook_events_in (source, payload) values ('meta', '{}'::jsonb)");
      await c.query("insert into public.job_runs (queue, handler, started_at) values ('sweep', 'sweep', now())").catch(() => {});
      await c.query("insert into public.teams (org_id, name) values ($1, 'Front desk')", [orgA]);
      await c.query("insert into public.notifications (org_id, user_id, type, title) values ($1, $2, 'system', 'hello')", [orgA, alice]);
      await c.query("insert into public.audit_log (org_id, user_id, action, entity) values ($1, $2, 'sweep.test', 'org')", [orgA, alice]);
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("covers a meaningful number of tables", () => {
    expect(orgTables.length).toBeGreaterThanOrEqual(25);
  });

  it("hides org A rows from org B's admin in every org-scoped table", async () => {
    const leaks: string[] = [];
    await asUser(c, bob, async () => {
      for (const t of orgTables) {
        const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from public.${t} where org_id = $1`, [orgA]);
        if (Number(rows[0].n) !== 0) leaks.push(t);
      }
    });
    expect(leaks).toEqual([]);
  });

  it("shows a signed-in user without a membership nothing at all, and anon nothing either", async () => {
    const seen: string[] = [];
    await asUser(c, nobody, async () => {
      for (const t of orgTables) {
        const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from public.${t}`);
        if (Number(rows[0].n) !== 0) seen.push(`authenticated:${t}`);
      }
    });
    await c.query("set role anon");
    try {
      for (const t of allTables) {
        const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from public.${t}`).catch(() => ({ rows: [{ n: "0" }] }));
        if (Number(rows[0].n) !== 0) seen.push(`anon:${t}`);
      }
    } finally {
      await c.query("reset role");
    }
    expect(seen).toEqual([]);
  });

  it("denies signed-in users every read of the service-only tables", async () => {
    const seen: string[] = [];
    await asUser(c, alice, async () => {
      for (const t of ["rate_limit_hits", "webhook_events_in", "dead_letters", "job_runs", "channel_secrets", "channel_send_slots", "scheduled_jobs"]) {
        const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from public.${t}`).catch(() => ({ rows: [{ n: "0" }] }));
        if (Number(rows[0].n) !== 0) seen.push(t);
      }
    });
    expect(seen).toEqual([]);
  });

  it("rejects an insert into org A by org B's admin on every org-scoped table (RLS fires before NOT NULL)", async () => {
    const notBlocked: string[] = [];
    await asUser(c, bob, async () => {
      for (const t of orgTables) {
        await c.query("begin");
        try {
          await c.query(`insert into public.${t} (org_id) values ($1)`, [orgA]);
          notBlocked.push(`${t}: insert succeeded`);
        } catch (err) {
          const code = (err as { code?: string }).code;
          const ok = code === "42501" || (code === "23514" && TRIGGER_GUARDED.has(t));
          if (!ok) notBlocked.push(`${t}: ${code}`);
        }
        await c.query("rollback");
      }
    });
    expect(notBlocked).toEqual([]);
  });

  it("has a dedicated cross-org suite for every trigger-guarded table", () => {
    const suites = ["rls.test.ts", "crm-rls.test.ts", "inbox-rls.test.ts"]
      .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"))
      .join("\n");
    for (const t of TRIGGER_GUARDED) expect(suites, `${t} is not covered by a per-table RLS suite`).toMatch(new RegExp(`\\b${t}\\b`));
  });

  it("the insert probe can tell RLS from other failures (control: org A's admin reaches the constraint check)", async () => {
    await asUser(c, alice, async () => {
      await c.query("begin");
      const err = await c.query("insert into public.teams (org_id) values ($1)", [orgA]).then(
        () => null,
        (e: { code?: string }) => e,
      );
      await c.query("rollback");
      expect(err?.code).toBe("23502"); // not-null on name, i.e. RLS let it through
    });
  });

  it("lets org B's admin neither update nor delete org A rows", async () => {
    await asUser(c, bob, async () => {
      for (const t of orgTables) {
        await c.query("begin");
        const u = await c.query(`update public.${t} set org_id = org_id where org_id = $1`, [orgA]).catch(() => ({ rowCount: 0 }));
        const d = await c.query(`delete from public.${t} where org_id = $1`, [orgA]).catch(() => ({ rowCount: 0 }));
        await c.query("rollback");
        expect(u.rowCount ?? 0, `${t} update`).toBe(0);
        expect(d.rowCount ?? 0, `${t} delete`).toBe(0);
      }
    });
  });

  it("does not let org B's admin move org B data into org A by changing org_id", async () => {
    await asServiceRole(c, async () => {
      await c.query("insert into public.teams (org_id, name) values ($1, 'B team')", [orgB]);
    });
    await asUser(c, bob, async () => {
      await c.query("begin");
      const err = await c.query("update public.teams set org_id = $1 where org_id = $2", [orgA, orgB]).then(
        () => null,
        (e: { code?: string }) => e,
      );
      await c.query("rollback");
      expect(err?.code).toBe("42501");
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("audit_log is append-only", () => {
  let c: Client;
  let alice: string;
  let orgA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    await asServiceRole(c, async () => {
      await c.query("insert into public.audit_log (org_id, user_id, action, entity) values ($1, $2, 'x.created', 'x')", [orgA, alice]);
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("blocks UPDATE and DELETE even for the service role", async () => {
    await asServiceRole(c, async () => {
      for (const sql of [
        "update public.audit_log set action = 'tampered'",
        "update public.audit_log set diff = '{}'::jsonb",
        "delete from public.audit_log",
      ]) {
        await c.query("begin");
        const err = await c.query(sql).then(
          () => null,
          (e: { message?: string }) => e,
        );
        await c.query("rollback");
        expect(err?.message, sql).toMatch(/append-only/);
      }
    });
  });

  it("still allows inserts, the user_id null-out when a user is removed, and the org cascade", async () => {
    await asServiceRole(c, async () => {
      await c.query("insert into public.audit_log (org_id, user_id, action, entity) values ($1, $2, 'y.created', 'y')", [orgA, alice]);
    });
    await c.query("delete from auth.users where id = $1", [alice]);
    const { rows } = await c.query<{ n: string; nulls: string }>(
      "select count(*)::text as n, count(*) filter (where user_id is null)::text as nulls from public.audit_log where org_id = $1",
      [orgA],
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
    expect(rows[0].nulls).toBe(rows[0].n);
    // Orgs are never deleted in normal operation (system roles are protected); lift that guard
    // inside a transaction to prove the cascade is the one path that may remove audit rows.
    await c.query("begin");
    try {
      await c.query("alter table public.roles disable trigger user");
      await c.query("delete from public.orgs where id = $1", [orgA]);
      const after = await c.query("select 1 from public.audit_log where org_id = $1", [orgA]);
      expect(after.rowCount).toBe(0);
    } finally {
      await c.query("rollback");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("rate_limit_hit()", () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await c.query("truncate public.rate_limit_hits");
  });
  afterAll(async () => {
    await c.query("truncate public.rate_limit_hits");
    await c.end();
  });

  const hit = async (key: string, limit: number, window = 60) => {
    const { rows } = await c.query<{ allowed: boolean; hits: number; retry_after: number }>(
      "select * from public.rate_limit_hit($1, $2, $3)",
      [key, limit, window],
    );
    return rows[0];
  };

  it("allows up to the limit then blocks with a retry_after inside the window", async () => {
    expect((await hit("k1", 3)).allowed).toBe(true);
    expect((await hit("k1", 3)).allowed).toBe(true);
    const third = await hit("k1", 3);
    expect(third).toMatchObject({ allowed: true, hits: 3, retry_after: 0 });
    const fourth = await hit("k1", 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retry_after).toBeGreaterThanOrEqual(1);
    expect(fourth.retry_after).toBeLessThanOrEqual(60);
  });

  it("keeps keys independent", async () => {
    await hit("a", 1);
    expect((await hit("a", 1)).allowed).toBe(false);
    expect((await hit("b", 1)).allowed).toBe(true);
  });

  it("is atomic under parallel callers: exactly `limit` are allowed", async () => {
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect()));
    try {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          clients[i % clients.length].query<{ allowed: boolean }>("select allowed from public.rate_limit_hit('parallel', 10, 60)"),
        ),
      );
      expect(results.filter((r) => r.rows[0].allowed)).toHaveLength(10);
    } finally {
      await Promise.all(clients.map((x) => x.end()));
    }
  });

  it("rejects empty and oversized keys", async () => {
    await expect(hit("", 1)).rejects.toThrow(/invalid rate limit key/);
    await expect(hit("x".repeat(201), 1)).rejects.toThrow(/invalid rate limit key/);
  });

  it("is callable by the service role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await c.query(`set role ${role}`);
      await c.query("begin");
      const err = await c.query("select * from public.rate_limit_hit('nope', 1, 60)").then(
        () => null,
        (e: { code?: string }) => e,
      );
      await c.query("rollback");
      await c.query("reset role");
      expect(err?.code, role).toBe("42501");
    }
    await asServiceRole(c, async () => {
      expect((await hit("svc", 1)).allowed).toBe(true);
    });
  });
});
