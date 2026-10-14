/**
 * Phase B, second slice (docs/34_CLINIC_OS_PLAN.md): branches as a dimension, on real Postgres.
 *   - conversations take their channel's branch when created (trigger), unless one is given
 *   - every new location_id / default_team_id is checked against the row's org
 *   - tasks follow app.location_visible_to() in RLS (select, update, insert); rows without a branch stay visible, and a
 *     new task takes its appointment's (else its enquiry's) branch
 *   - route_conversation prefers the channel's default team over the team passed in (the org default)
 *   - conversations and contacts RLS do not depend on the branch (patients cross branches)
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

describe.skipIf(!TEST_DATABASE_URL)("branch dimension", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let desk: string;
  let deskMembership: string;
  let teamDefault: string;
  let teamNorth: string;
  let foreignTeam: string;
  let chNorth: string;
  let chPlain: string;
  const loc: Record<string, string> = {};
  let n = 0;

  const one = async (sql: string, p: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", p)).rows[0].id;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  async function contact(): Promise<string> {
    n += 1;
    return one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, $2, $3)", [
      org,
      `Layla Demo-${String(n).padStart(2, "0")}`,
      `+447700900${String(700 + n).padStart(3, "0")}`,
    ]);
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-bd@example.test");
    desk = await createAuthUser(c, "desk-bd@example.test");
    const stranger = await createAuthUser(c, "other-bd@example.test");
    org = await createOrg(c, "Org BD", "org-bd", owner);
    otherOrg = await createOrg(c, "Org BD2", "org-bd2", stranger);
    await svc(async () => {
      const deskRole = await one(
        `insert into public.roles (org_id, name, permissions)
         values ($1, 'Desk BD', '["tasks.view","tasks.manage","inbox.send","contacts.view"]'::jsonb)`,
        [org],
      );
      deskMembership = await one(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, desk, deskRole],
      );
      for (const name of ["North", "South"])
        loc[name] = await one("insert into public.locations (org_id, name) values ($1, $2)", [
          org,
          name,
        ]);
      loc.foreign = await one("insert into public.locations (org_id, name) values ($1, 'Away')", [
        otherOrg,
      ]);
      teamDefault = await one("insert into public.teams (org_id, name) values ($1, 'Everyone')", [
        org,
      ]);
      teamNorth = await one(
        "insert into public.teams (org_id, name, location_id) values ($1, 'North desk', $2)",
        [org, loc.North],
      );
      foreignTeam = await one("insert into public.teams (org_id, name) values ($1, 'Away desk')", [
        otherOrg,
      ]);
      chNorth = await one(
        `insert into public.channels (org_id, name, waba_id, phone_number_id, location_id, default_team_id)
         values ($1, 'North number', 'waba-bd', 'pn-bd-north', $2, $3)`,
        [org, loc.North, teamNorth],
      );
      chPlain = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main number', 'waba-bd', 'pn-bd-main')",
        [org],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("conversations", () => {
    it("take their channel's branch when created, unless one is given", async () => {
      await svc(async () => {
        const a = await one(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [org, chNorth, await contact()],
        );
        const b = await one(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [org, chPlain, await contact()],
        );
        const given = await one(
          "insert into public.conversations (org_id, channel_id, contact_id, location_id) values ($1, $2, $3, $4)",
          [org, chNorth, await contact(), loc.South],
        );
        const { rows } = await c.query<{ id: string; location_id: string | null }>(
          "select id::text, location_id::text from public.conversations where id = any($1::uuid[])",
          [[a, b, given]],
        );
        const by = Object.fromEntries(rows.map((r) => [r.id, r.location_id]));
        expect(by[a]).toBe(loc.North);
        expect(by[b]).toBeNull();
        expect(by[given]).toBe(loc.South);
        // A later change of the number's branch does not move existing conversations.
        await c.query("update public.channels set location_id = $2 where id = $1", [
          chPlain,
          loc.South,
        ]);
        const again = await c.query<{ location_id: string | null }>(
          "select location_id::text from public.conversations where id = $1",
          [b],
        );
        expect(again.rows[0].location_id).toBeNull();
        await c.query("update public.channels set location_id = null where id = $1", [chPlain]);
      });
    });

    it("stay visible to a member limited to another branch (patients cross branches)", async () => {
      await svc(async () => {
        await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [
          deskMembership,
        ]);
        await c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, deskMembership, loc.South],
        );
      });
      const seen = await asUser(
        c,
        desk,
        async () =>
          (
            await c.query<{ n: string }>(
              "select count(*)::text as n from public.conversations where org_id = $1 and location_id = $2",
              [org, loc.North],
            )
          ).rows[0].n,
      );
      expect(Number(seen)).toBeGreaterThan(0);
      await svc(async () => {
        await c.query("delete from public.membership_locations where membership_id = $1", [
          deskMembership,
        ]);
        await c.query("update public.memberships set branch_scope = 'all' where id = $1", [
          deskMembership,
        ]);
      });
    });
  });

  describe("org checks", () => {
    it("refuse another org's branch or team on every new column", async () => {
      const contactId = await svc(() => contact());
      for (const [sql, params] of [
        ["update public.channels set location_id = $2 where id = $1", [chPlain, loc.foreign]],
        ["update public.channels set default_team_id = $2 where id = $1", [chPlain, foreignTeam]],
        ["update public.teams set location_id = $2 where id = $1", [teamDefault, loc.foreign]],
        ["update public.contacts set location_id = $2 where id = $1", [contactId, loc.foreign]],
      ] as const)
        await expect(svc(() => c.query(sql, [...params]))).rejects.toThrow(/does not belong/);
      await expect(
        svc(() =>
          c.query(
            "insert into public.tasks (org_id, type, subject, due_at, location_id) values ($1, 'other', 'x', now(), $2)",
            [org, loc.foreign],
          ),
        ),
      ).rejects.toThrow(/does not belong/);
      await expect(
        svc(() =>
          c.query(
            "insert into public.conversations (org_id, channel_id, contact_id, location_id) values ($1, $2, $3, $4)",
            [org, chPlain, contactId, loc.foreign],
          ),
        ),
      ).rejects.toThrow(/does not belong/);
    });

    it("a deleted branch or team leaves the rows without one", async () => {
      await svc(async () => {
        const temp = await one(
          "insert into public.locations (org_id, name) values ($1, 'Pop-up')",
          [org],
        );
        const tempTeam = await one(
          "insert into public.teams (org_id, name) values ($1, 'Pop-up desk')",
          [org],
        );
        await c.query(
          "update public.channels set location_id = $2, default_team_id = $3 where id = $1",
          [chPlain, temp, tempTeam],
        );
        await c.query("delete from public.locations where id = $1", [temp]);
        await c.query("delete from public.teams where id = $1", [tempTeam]);
        const { rows } = await c.query<{
          location_id: string | null;
          default_team_id: string | null;
        }>("select location_id, default_team_id from public.channels where id = $1", [chPlain]);
        expect(rows[0]).toEqual({ location_id: null, default_team_id: null });
      });
    });
  });

  describe("tasks", () => {
    let tNorth: string;
    let tSouth: string;
    let tNone: string;

    beforeAll(async () => {
      await svc(async () => {
        const task = (subject: string, location: string | null) =>
          one(
            "insert into public.tasks (org_id, type, subject, due_at, location_id) values ($1, 'other', $2, now() + interval '1 day', $3)",
            [org, subject, location],
          );
        tNorth = await task("North task", loc.North);
        tSouth = await task("South task", loc.South);
        tNone = await task("Anywhere task", null);
      });
    });

    const visible = () =>
      asUser(c, desk, async () =>
        (
          await c.query<{ subject: string }>(
            "select subject from public.tasks where org_id = $1 and id = any($2::uuid[]) order by subject",
            [org, [tNorth, tSouth, tNone]],
          )
        ).rows.map((r) => r.subject),
      );

    it("everyone sees every branch's tasks by default", async () => {
      expect(await visible()).toEqual(["Anywhere task", "North task", "South task"]);
    });

    it("a member limited to a branch sees only its tasks and those without a branch", async () => {
      await svc(async () => {
        await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [
          deskMembership,
        ]);
        await c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, deskMembership, loc.North],
        );
      });
      expect(await visible()).toEqual(["Anywhere task", "North task"]);
      expect(
        await asUser(
          c,
          owner,
          async () =>
            (
              await c.query("select id from public.tasks where id = any($1::uuid[])", [
                [tNorth, tSouth, tNone],
              ])
            ).rowCount,
        ),
      ).toBe(3);
    });

    it("cannot change, move into or create in a hidden branch", async () => {
      const hidden = await asUser(c, desk, () =>
        c.query("update public.tasks set subject = 'changed' where id = $1", [tSouth]),
      );
      expect(hidden.rowCount).toBe(0);
      await expect(
        asUser(c, desk, () =>
          c.query("update public.tasks set location_id = $2 where id = $1", [tNorth, loc.South]),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asUser(c, desk, () =>
          c.query(
            "insert into public.tasks (org_id, type, subject, due_at, location_id) values ($1, 'other', 'Sneaky', now(), $2)",
            [org, loc.South],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const own = await asUser(c, desk, () =>
        c.query("update public.tasks set subject = 'North task' where id = $1", [tNorth]),
      );
      expect(own.rowCount).toBe(1);
    });

    it("a new task takes its appointment's branch, else its enquiry's", async () => {
      await svc(async () => {
        const appt = await one(
          `insert into public.appointments (org_id, number, location_id, starts_at, ends_at, source)
           values ($1, 9001, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'unite')`,
          [org, loc.South],
        );
        const pipeline = await one(
          "insert into public.pipelines (org_id, name, is_default) values ($1, 'Main BD', true)",
          [org],
        );
        const stage = await one(
          "insert into public.stages (org_id, pipeline_id, name, sort) values ($1, $2, 'New', 0)",
          [org, pipeline],
        );
        const enquiry = await one(
          "insert into public.enquiries (org_id, pipeline_id, stage_id, title, location_id) values ($1, $2, $3, 'Synthetic enquiry', $4)",
          [org, pipeline, stage, loc.North],
        );
        const fromAppt = await one(
          "insert into public.tasks (org_id, type, subject, due_at, appointment_id, enquiry_id) values ($1, 'call', 'Call', now(), $2, $3)",
          [org, appt, enquiry],
        );
        const fromEnquiry = await one(
          "insert into public.tasks (org_id, type, subject, due_at, enquiry_id) values ($1, 'follow_up', 'Follow up', now(), $2)",
          [org, enquiry],
        );
        const chosen = await one(
          "insert into public.tasks (org_id, type, subject, due_at, enquiry_id, location_id) values ($1, 'other', 'Chosen', now(), $2, $3)",
          [org, enquiry, loc.South],
        );
        const { rows } = await c.query<{ id: string; location_id: string | null }>(
          "select id::text, location_id::text from public.tasks where id = any($1::uuid[])",
          [[fromAppt, fromEnquiry, chosen]],
        );
        const by = Object.fromEntries(rows.map((r) => [r.id, r.location_id]));
        expect(by[fromAppt]).toBe(loc.South);
        expect(by[fromEnquiry]).toBe(loc.North);
        expect(by[chosen]).toBe(loc.South);
      });
    });
  });

  describe("routing", () => {
    const route = async (conv: string, team: string) =>
      (
        await svc(() =>
          c.query<{ r: { team_id: string | null; user_id: string | null } }>(
            "select public.route_conversation($1, $2, $3, false) as r",
            [org, conv, team],
          ),
        )
      ).rows[0].r;

    it("a number's own team comes before the org default team", async () => {
      const conv = await svc(async () =>
        one(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [org, chNorth, await contact()],
        ),
      );
      const r = await route(conv, teamDefault);
      expect(r.team_id).toBe(teamNorth);
      const { rows } = await svc(() =>
        c.query<{ assignee_team_id: string }>(
          "select assignee_team_id::text from public.conversations where id = $1",
          [conv],
        ),
      );
      expect(rows[0].assignee_team_id).toBe(teamNorth);
    });

    it("without a team on the number the org default is used, as before", async () => {
      const conv = await svc(async () =>
        one(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [org, chPlain, await contact()],
        ),
      );
      const r = await route(conv, teamDefault);
      expect(r.team_id).toBe(teamDefault);
    });

    it("an owned conversation is left alone", async () => {
      const conv = await svc(async () =>
        one(
          "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id) values ($1, $2, $3, $4)",
          [org, chNorth, await contact(), owner],
        ),
      );
      const r = await route(conv, teamDefault);
      expect(r.user_id).toBe(owner);
      expect(r.team_id).toBeNull();
    });
  });
});
