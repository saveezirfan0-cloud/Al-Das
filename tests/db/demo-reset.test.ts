/**
 * `pnpm demo:reset` for real: the seeder through PostgREST against the test database, the database function that
 * empties a demo workspace, and the script itself (spawned as a child process, with the guard in front).
 * Runs only when TEST_POSTGREST_URL and TEST_SERVICE_JWT are set (see supabase/test/README.md).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { isDemoPhone } from "@/lib/demo/data";
import { seedDemoWorkspace } from "@/lib/demo/seed";
import type { Database, Json } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const ROOT = path.resolve(__dirname, "../..");

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("demo reset", () => {
  let c: Client;
  let admin: SupabaseClient<Database>;
  let owner: string;
  let orgId: string;

  const tablesWithRowsForOrg = async (org: string, except: string[]) => {
    const { rows: tables } = await c.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    const left: Record<string, number> = {};
    for (const t of tables) {
      if (except.includes(t.relname)) continue;
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from public.${t.relname} where org_id = $1`,
        [org],
      );
      if (Number(rows[0].n) > 0) left[t.relname] = Number(rows[0].n);
    }
    return left;
  };

  const countOf = async (table: string, org: string, where = "") =>
    Number(
      (
        await c.query(
          `select count(*)::text as n from public.${table} where org_id = $1 ${where}`,
          [org],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "demo-owner@example.test");
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    });
    const { data, error } = await admin.rpc("create_org", {
      p_name: "Demo Test Clinic",
      p_slug: "demo-test",
      p_roles: SYSTEM_ROLES.map((r) => ({
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      })) as unknown as Json,
      p_owner_id: owner,
    });
    expect(error).toBeNull();
    orgId = data as string;
    await admin
      .from("orgs")
      .update({ is_training: true, settings: { demo_seed: true } })
      .eq("id", orgId);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("seeds a believable, entirely synthetic workspace", async () => {
    const summary = await seedDemoWorkspace(admin, {
      orgId,
      slug: "demo-test",
      staff: { adminId: owner },
    });
    expect(summary).toMatchObject({
      conversations: 30,
      pipelines: 3,
      specialists: 5,
      household_links: 6,
      recall_sends: 8,
      finance_invoices: 9,
    });

    // conversations in different states
    const { rows: states } = await c.query<{ k: string; n: string }>(
      `select status || case when assignee_user_id is null then ':unassigned' else ':assigned' end || case when last_inbound_at < now() - interval '24 hours' then ':outside_window' else '' end as k, count(*)::text as n
       from public.conversations where org_id = $1 group by 1`,
      [orgId],
    );
    expect(states.length).toBeGreaterThanOrEqual(5);
    expect(await countOf("messages", orgId, "and status = 'failed'")).toBeGreaterThanOrEqual(3);
    expect(await countOf("messages", orgId, "and direction = 'note'")).toBeGreaterThan(0);

    // appointments today and tomorrow in every interesting state
    const { rows: board } = await c.query<{ day: string; k: string }>(
      `select (starts_at at time zone 'Asia/Dubai')::date - (now() at time zone 'Asia/Dubai')::date as day,
              coalesce(checkin_status, status) as k
       from public.appointments where org_id = $1`,
      [orgId],
    );
    const todayKinds = new Set(board.filter((b) => Number(b.day) === 0).map((b) => b.k));
    for (const k of [
      "arrived",
      "with_doctor",
      "done",
      "checked_out",
      "no_show",
      "cancelled",
      "confirmed",
    ])
      expect(todayKinds, `today: ${k}`).toContain(k);
    expect(board.filter((b) => Number(b.day) === 1).length).toBeGreaterThanOrEqual(10);
    expect(await countOf("appointments", orgId, "and is_walk_in")).toBe(2);
    expect(await countOf("appointments", orgId, "and source = 'unite'")).toBe(2);
    expect(await countOf("appointment_reminders", orgId, "and status = 'failed'")).toBeGreaterThan(
      0,
    );

    // enquiries, campaign with results, recall in test mode, finance, waiting list
    expect(await countOf("enquiries", orgId)).toBeGreaterThanOrEqual(18);
    const { rows: camp } = await c.query(
      "select status, stats from public.campaigns where org_id = $1",
      [orgId],
    );
    expect(camp[0].status).toBe("completed");
    expect(camp[0].stats).toMatchObject({ total: 38, read: 16, failed: 5, skipped: 4 });
    expect(await countOf("recall_sends", orgId, "and send_mode = 'test'")).toBe(8);
    const { rows: prog } = await c.query(
      "select status, send_mode_override from public.recall_programmes where org_id = $1",
      [orgId],
    );
    expect(prog[0]).toEqual({ status: "active", send_mode_override: "test" });
    expect(await countOf("fin_invoices", orgId)).toBe(9);
    expect(await countOf("waitlist_entries", orgId)).toBe(3);

    // the training lock and the offers wiring are on
    const { rows: org } = await c.query(
      "select is_training, settings from public.orgs where id = $1",
      [orgId],
    );
    expect(org[0].is_training).toBe(true);
    expect(org[0].settings.front_desk.offers_enabled).toBe(true);
    expect(org[0].settings.appointments.templates.reminder).toBeTruthy();
  });

  it("uses no real phone number and no real-looking name anywhere", async () => {
    const { rows: phones } = await c.query<{ p: string }>(
      "select phone_e164 as p from public.contacts where org_id = $1 and phone_e164 is not null",
      [orgId],
    );
    expect(phones.length).toBeGreaterThanOrEqual(60);
    for (const { p } of phones) expect(isDemoPhone(p), p).toBe(true);
    const { rows: names } = await c.query<{ last_name: string }>(
      "select distinct last_name from public.contacts where org_id = $1",
      [orgId],
    );
    for (const { last_name } of names) expect(last_name).toMatch(/^Demo-\d\d$/);
    const { rows: special } = await c.query<{ phone_e164: string | null }>(
      "select display_phone as phone_e164 from public.channels where org_id = $1",
      [orgId],
    );
    expect(special[0].phone_e164).toBe("+44 7700 900000");
    // finance rows carry the PIN only
    const { rows: fin } = await c.query(
      "select to_jsonb(i)::text as t from public.fin_invoices i where org_id = $1 limit 1",
      [orgId],
    );
    expect(fin[0].t).not.toMatch(/Emirates|patient_name/i);
  });

  it("empties exactly the demo workspace and leaves who works there alone", async () => {
    const { data, error } = await admin.rpc("demo_wipe_org", { p_org_id: orgId });
    expect(error).toBeNull();
    expect(data).toMatchObject({ left_behind: [], errors: {} });
    expect((data as { deleted: number }).deleted).toBeGreaterThan(200);
    const KEEP = [
      "orgs",
      "roles",
      "memberships",
      "teams",
      "team_members",
      "invites",
      "audit_log",
      "record_access_log",
      "auth_events",
      "record_history",
      "security_alerts",
      "access_reviews",
      "privacy_requests",
      "user_sessions",
      "notification_preferences",
      "push_subscriptions",
      "notification_digest_log",
    ];
    expect(await tablesWithRowsForOrg(orgId, KEEP)).toEqual({});
    expect(await countOf("roles", orgId)).toBe(SYSTEM_ROLES.length);
    expect(await countOf("memberships", orgId)).toBe(1);
    // and it can be seeded again, to the same shape
    const again = await seedDemoWorkspace(admin, {
      orgId,
      slug: "demo-test",
      staff: { adminId: owner },
    });
    expect(again).toMatchObject({ conversations: 30, contacts: 66, appointments: 47 });
  });

  it("refuses to wipe a workspace that is not a demo workspace (both locks are needed)", async () => {
    const real = await createOrg(c, "Real Clinic", "real-clinic", owner);
    await c.query("set role service_role");
    await c.query(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Keep', '+971500000444')",
      [real],
    );
    await c.query("reset role");
    for (const [label, training, settings] of [
      ["neither lock", false, {}],
      ["training only", true, {}],
      ["seed flag only", false, { demo_seed: true }],
    ] as const) {
      await c.query("update public.orgs set is_training = $2, settings = $3::jsonb where id = $1", [
        real,
        training,
        JSON.stringify(settings),
      ]);
      const { error } = await admin.rpc("demo_wipe_org", { p_org_id: real });
      expect(error?.message, label).toMatch(/not a demo workspace/);
    }
    expect(await countOf("contacts", real)).toBe(1);
    // nobody but the service role may even try
    for (const role of ["anon", "authenticated"]) {
      await c.query(`set role ${role}`);
      const err = await c.query("select public.demo_wipe_org($1)", [real]).then(
        () => null,
        (e: { code?: string }) => e,
      );
      await c.query("reset role");
      expect(err?.code, role).toBe("42501");
    }
  });

  describe("the script", () => {
    const run = (args: string[], env: Record<string, string | undefined>) =>
      spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), ["scripts/demo-reset.ts", ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...env,
        } as unknown as NodeJS.ProcessEnv,
        timeout: 120_000,
      });
    const target = {
      NEXT_PUBLIC_SUPABASE_URL: POSTGREST_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT,
    };

    it("refuses without DEMO_RESET_OK=1 and changes nothing", async () => {
      const before = await countOf("contacts", orgId);
      const r = run([`--owner-id=${owner}`, "--slug=demo-test"], target);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/DEMO_RESET_OK=1/);
      expect(await countOf("contacts", orgId)).toBe(before);
    });

    it("refuses a hosted URL that is not a demo project, before any request is made", () => {
      const r = run([`--owner-id=${owner}`], {
        ...target,
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not recognisably a demo project/);
    });

    it("refuses to touch an existing workspace that is not a demo one", async () => {
      const { rows } = await c.query("select slug from public.orgs where slug = 'real-clinic'");
      expect(rows).toHaveLength(1);
      const r = run([`--owner-id=${owner}`, "--slug=real-clinic"], {
        ...target,
        DEMO_RESET_OK: "1",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not a demo workspace/);
      expect(
        await countOf(
          "contacts",
          (await c.query("select id from public.orgs where slug = 'real-clinic'")).rows[0].id,
        ),
      ).toBe(1);
    });

    it("wipes and re-seeds the demo workspace when allowed, and a second run gives the same result", async () => {
      const first = run([`--owner-id=${owner}`, "--slug=demo-test"], {
        ...target,
        DEMO_RESET_OK: "1",
      });
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/Emptied the demo workspace/);
      expect(first.stdout).toMatch(/conversations 30/);
      const n1 = await countOf("contacts", orgId);
      const second = run([`--owner-id=${owner}`, "--slug=demo-test"], {
        ...target,
        DEMO_RESET_OK: "1",
      });
      expect(second.status).toBe(0);
      expect(await countOf("contacts", orgId)).toBe(n1);
      expect(await countOf("conversations", orgId)).toBe(30);
    });

    it("creates the workspace on first run, marked as a training workspace", async () => {
      const r = run([`--owner-id=${owner}`, "--slug=demo-fresh"], {
        ...target,
        DEMO_RESET_OK: "1",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Created the demo workspace/);
      const { rows } = await c.query(
        "select is_training, settings->>'demo_seed' as seed, timezone from public.orgs where slug = 'demo-fresh'",
      );
      expect(rows[0]).toEqual({ is_training: true, seed: "true", timezone: "Asia/Dubai" });
    });
  });
});
