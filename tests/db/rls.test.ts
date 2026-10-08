/**
 * Proves tenant isolation: a user can never read or write another org's rows,
 * and non-admins can't perform settings writes. Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("row level security", () => {
  let c: Client;
  let alice: string; // admin of org A
  let bob: string; // admin of org B
  let carol: string; // agent in org A
  let nobody: string; // signed up, no membership
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    nobody = await createAuthUser(c, "nobody@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, rows[0].id],
      );
      await c.query(
        "insert into public.teams (org_id, name) values ($1, 'Front desk'), ($2, 'Back office')",
        [orgA, orgB],
      );
      await c.query(
        "insert into public.notifications (org_id, user_id, type, title) values ($1, $2, 'system', 'A hello'), ($3, $4, 'system', 'B hello'), ($1, $5, 'system', 'Carol hello')",
        [orgA, alice, orgB, bob, carol],
      );
      await c.query(
        "insert into public.invites (org_id, email, role_id, token_hash, expires_at) select $1, 'x@example.test', id, 'hashA', now() + interval '1 day' from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.invites (org_id, email, role_id, token_hash, expires_at) select $1, 'y@example.test', id, 'hashB', now() + interval '1 day' from public.roles where org_id = $1 and name = 'Agent'",
        [orgB],
      );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("profiles were created by the auth trigger", async () => {
    expect(await count(c, "select 1 from public.profiles")).toBe(4);
  });

  it("a member only sees their own org's rows in every tenant table", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.orgs")).toBe(1);
      expect((await c.query("select name from public.orgs")).rows[0].name).toBe("Org A");
      expect(await count(c, "select 1 from public.roles")).toBe(2);
      expect(await count(c, "select 1 from public.roles where org_id = $1", [orgB])).toBe(0);
      expect(await count(c, "select 1 from public.memberships")).toBe(2);
      expect(await count(c, "select 1 from public.teams")).toBe(1);
      expect((await c.query("select name from public.teams")).rows[0].name).toBe("Front desk");
      expect(await count(c, "select 1 from public.team_members")).toBe(0);
      expect(await count(c, "select 1 from public.invites")).toBe(1);
      expect(await count(c, "select 1 from public.audit_log")).toBe(1);
      expect(await count(c, "select 1 from public.audit_log where org_id = $1", [orgB])).toBe(0);
      // Notifications: only your own, not a colleague's.
      const titles = (
        await c.query("select title from public.notifications order by title")
      ).rows.map((r) => r.title);
      expect(titles).toEqual(["A hello"]);
      // Profiles: self + colleagues, not members of other orgs.
      const emails = (await c.query("select email from public.profiles order by email")).rows.map(
        (r) => r.email,
      );
      expect(emails).toEqual(["alice@example.test", "carol@example.test"]);
    });

    await asUser(c, bob, async () => {
      expect((await c.query("select name from public.orgs")).rows.map((r) => r.name)).toEqual([
        "Org B",
      ]);
      expect((await c.query("select name from public.teams")).rows.map((r) => r.name)).toEqual([
        "Back office",
      ]);
      expect((await c.query("select email from public.profiles")).rows.map((r) => r.email)).toEqual(
        ["bob@example.test"],
      );
    });
  });

  it("a user without a membership sees nothing but their own profile", async () => {
    await asUser(c, nobody, async () => {
      expect(await count(c, "select 1 from public.orgs")).toBe(0);
      expect(await count(c, "select 1 from public.roles")).toBe(0);
      expect(await count(c, "select 1 from public.memberships")).toBe(0);
      expect(await count(c, "select 1 from public.teams")).toBe(0);
      expect(await count(c, "select 1 from public.notifications")).toBe(0);
      expect((await c.query("select email from public.profiles")).rows.map((r) => r.email)).toEqual(
        ["nobody@example.test"],
      );
    });
  });

  it("cross-org writes are rejected", async () => {
    await asUser(c, alice, async () => {
      await expect(
        c.query("insert into public.teams (org_id, name) values ($1, 'sneaky')", [orgB]),
      ).rejects.toThrow(/row-level security/);
      await expect(
        c.query(
          "insert into public.roles (org_id, name, permissions) values ($1, 'sneaky', '[]')",
          [orgB],
        ),
      ).rejects.toThrow(/row-level security/);
      // Updates/deletes against invisible rows silently affect 0 rows.
      expect(
        (await c.query("update public.teams set name = 'x' where org_id = $1", [orgB])).rowCount,
      ).toBe(0);
      expect((await c.query("delete from public.roles where org_id = $1", [orgB])).rowCount).toBe(
        0,
      );
      expect(
        (await c.query("update public.orgs set name = 'x' where id = $1", [orgB])).rowCount,
      ).toBe(0);
      expect(
        (await c.query("update public.notifications set read_at = now() where org_id = $1", [orgB]))
          .rowCount,
      ).toBe(0);
    });
  });

  it("admins can write settings tables in their org; agents cannot", async () => {
    await asUser(c, alice, async () => {
      await c.query("insert into public.teams (org_id, name) values ($1, 'Marketing')", [orgA]);
      expect(
        (await c.query("update public.orgs set name = 'Org A+' where id = $1", [orgA])).rowCount,
      ).toBe(1);
    });
    await asUser(c, carol, async () => {
      await expect(
        c.query("insert into public.teams (org_id, name) values ($1, 'Nope')", [orgA]),
      ).rejects.toThrow(/row-level security/);
      expect(
        (await c.query("update public.orgs set name = 'hack' where id = $1", [orgA])).rowCount,
      ).toBe(0);
      expect(await count(c, "select 1 from public.invites")).toBe(0); // settings.manage only
      expect(await count(c, "select 1 from public.audit_log")).toBe(0);
      expect(await count(c, "select 1 from public.teams")).toBe(2); // read is fine
    });
  });

  it("membership role/status can't be changed by the member, only presence via RPC", async () => {
    await asUser(c, carol, async () => {
      const { rows: adminRole } = await c.query("select id from public.roles where name = 'Admin'");
      expect(
        (
          await c.query("update public.memberships set role_id = $1 where user_id = $2", [
            adminRole[0].id,
            carol,
          ])
        ).rowCount,
      ).toBe(0);
      await c.query("select public.set_presence($1, 'away')", [orgA]);
      expect(
        (await c.query("select presence from public.memberships where user_id = $1", [carol]))
          .rows[0].presence,
      ).toBe("away");
      await expect(c.query("select public.set_presence($1, 'invisible')", [orgA])).rejects.toThrow(
        /invalid presence/,
      );
    });
    // Still 'Agent' when checked by the service role.
    await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "select r.name from public.memberships m join public.roles r on r.id = m.role_id where m.user_id = $1",
        [carol],
      );
      expect(rows[0].name).toBe("Agent");
    });
  });

  it("infrastructure tables are invisible to API roles", async () => {
    await asServiceRole(c, async () => {
      await c.query("insert into public.scheduled_jobs (kind) values ('queue:outbound')");
      await c.query("insert into public.job_runs (queue) values ('outbound')");
    });
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.scheduled_jobs")).toBe(0);
      expect(await count(c, "select 1 from public.job_runs")).toBe(0);
      expect(await count(c, "select 1 from public.dead_letters")).toBe(0);
      await expect(c.query("select * from public.claim_scheduled_jobs(1, 'x')")).rejects.toThrow(
        /permission denied/,
      );
      await expect(c.query("select public.job_enqueue('outbound', '{}'::jsonb)")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("integrity guards: roles and teams must belong to the membership's org", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgB],
      );
      await expect(
        c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
          orgA,
          nobody,
          rows[0].id,
        ]),
      ).rejects.toThrow(/does not belong/);
      const { rows: teamB } = await c.query("select id from public.teams where org_id = $1", [
        orgB,
      ]);
      await expect(
        c.query("insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)", [
          orgA,
          teamB[0].id,
          alice,
        ]),
      ).rejects.toThrow(/does not belong/);
      await expect(
        c.query("delete from public.roles where org_id = $1 and name = 'Admin'", [orgA]),
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        c.query("update public.roles set name = 'Boss' where org_id = $1 and name = 'Admin'", [
          orgA,
        ]),
      ).rejects.toThrow(/cannot be renamed/);
    });
  });

  it("create_org is service-role only", async () => {
    await asUser(c, nobody, async () => {
      await expect(
        c.query("select public.create_org('X', 'x', $1::jsonb, $2)", [
          JSON.stringify([{ name: "Admin", permissions: ["*"] }]),
          nobody,
        ]),
      ).rejects.toThrow(/permission denied/);
    });
    await asServiceRole(c, async () => {
      await c.query("select public.create_org('Mine', 'mine', $1::jsonb, $2)", [
        JSON.stringify([{ name: "Admin", permissions: ["*"] }]),
        nobody,
      ]);
    });
    await asUser(c, nobody, async () => {
      expect((await c.query("select name from public.orgs")).rows.map((r) => r.name)).toEqual([
        "Mine",
      ]);
    });
  });
});
