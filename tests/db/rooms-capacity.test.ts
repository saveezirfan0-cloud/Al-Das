/**
 * M3 rooms and capacity (docs/23_PHASE_M3A_NOTES.md): rooms and fin_ref_doctor_keys.
 *   - RLS: org-scoped, permission-gated (rooms.manage / finance.revenue.view), branch-bound for rooms, no browser writes
 *   - rooms: name unique per branch, an unknown cost is null (0 refused), a branch of another org refused
 *   - doctor-key links: a doctor of another org refused
 *   - the Manager grant in the migration is idempotent
 * Synthetic data only.
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

describe.skipIf(!TEST_DATABASE_URL)("rooms and capacity", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let roomsUser: string;
  let roomsMembership: string;
  let financeUser: string;
  let agent: string;
  let stranger: string;
  const id: Record<string, string> = {};

  const one = async (sql: string, p: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", p)).rows[0].id;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner@example.test");
    roomsUser = await createAuthUser(c, "rooms@example.test");
    financeUser = await createAuthUser(c, "finance@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    stranger = await createAuthUser(c, "stranger@example.test");
    org = await createOrg(c, "Org R", "org-r", owner);
    otherOrg = await createOrg(c, "Org S", "org-s", stranger);
    await asServiceRole(c, async () => {
      const role = (name: string, perms: string[]) =>
        one("insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb)", [
          org,
          name,
          JSON.stringify(perms),
        ]);
      const agentRole = (
        await c.query<{ id: string }>(
          "select id from public.roles where org_id = $1 and name = 'Agent'",
          [org],
        )
      ).rows[0].id;
      roomsMembership = await one(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, roomsUser, await role("Rooms only", ["rooms.manage"])],
      );
      await one("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
        org,
        financeUser,
        await role("Finance read", ["finance.revenue.view"]),
      ]);
      await one("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
        org,
        agent,
        agentRole,
      ]);

      id.north = await one("insert into public.locations (org_id, name) values ($1, 'North')", [
        org,
      ]);
      id.south = await one("insert into public.locations (org_id, name) values ($1, 'South')", [
        org,
      ]);
      id.away = await one("insert into public.locations (org_id, name) values ($1, 'Away')", [
        otherOrg,
      ]);
      id.alpha = await one(
        "insert into public.specialists (org_id, name) values ($1, 'Dr Alpha Demo')",
        [org],
      );
      id.foreignDoc = await one(
        "insert into public.specialists (org_id, name) values ($1, 'Dr Foreign Demo')",
        [otherOrg],
      );
      id.r1 = await one(
        "insert into public.rooms (org_id, location_id, name, kind, monthly_cost) values ($1, $2, 'Room 1', 'consultation', 6000)",
        [org, id.north],
      );
      id.r2 = await one(
        "insert into public.rooms (org_id, location_id, name, kind) values ($1, $2, 'Room 2', 'procedure')",
        [org, id.south],
      );
      await one(
        "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Away room')",
        [otherOrg, id.away],
      );
      await c.query(
        "insert into public.fin_ref_doctor_keys (org_id, doctor_key, specialist_id) values ($1, 'alpha demo', $2)",
        [org, id.alpha],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const count = (user: string, sql: string, p: unknown[] = [org]) =>
    asUser(c, user, async () => Number((await c.query<{ n: string }>(sql, p)).rows[0].n));
  const ROOMS = "select count(*)::text as n from public.rooms where org_id = $1";
  const KEYS = "select count(*)::text as n from public.fin_ref_doctor_keys where org_id = $1";

  describe("row level security", () => {
    it("rooms are read with rooms.manage only, never across orgs", async () => {
      expect(await count(owner, ROOMS)).toBe(2);
      expect(await count(roomsUser, ROOMS)).toBe(2);
      expect(await count(financeUser, ROOMS)).toBe(0);
      expect(await count(agent, ROOMS)).toBe(0);
      expect(await count(stranger, ROOMS)).toBe(0);
      expect(await count(stranger, ROOMS, [otherOrg])).toBe(1);
    });

    it("the doctor-key links are read with finance.revenue.view, not by others or other orgs", async () => {
      expect(await count(financeUser, KEYS)).toBe(1);
      expect(await count(owner, KEYS)).toBe(1);
      expect(await count(roomsUser, KEYS)).toBe(0);
      expect(await count(agent, KEYS)).toBe(0);
      expect(await count(stranger, KEYS)).toBe(0);
    });

    it("a member limited to one branch sees only that branch's rooms", async () => {
      await asServiceRole(c, async () => {
        await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [
          roomsMembership,
        ]);
        await c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, roomsMembership, id.south],
        );
      });
      try {
        expect(await count(roomsUser, ROOMS)).toBe(1);
      } finally {
        await asServiceRole(c, async () => {
          await c.query("delete from public.membership_locations where membership_id = $1", [
            roomsMembership,
          ]);
          await c.query("update public.memberships set branch_scope = 'all' where id = $1", [
            roomsMembership,
          ]);
        });
      }
    });

    it("signed-in users cannot write: every write is a server action", async () => {
      for (const [sql, params] of [
        [
          "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Sneaky')",
          [org, id.north],
        ],
        ["update public.rooms set monthly_cost = 1 where org_id = $1", [org]],
        ["delete from public.rooms where org_id = $1", [org]],
        [
          "insert into public.fin_ref_doctor_keys (org_id, doctor_key, specialist_id) values ($1, 'x', $2)",
          [org, id.alpha],
        ],
        ["delete from public.fin_ref_doctor_keys where org_id = $1", [org]],
      ] as [string, unknown[]][]) {
        const res = await asUser(c, owner, () => c.query(sql, params)).catch((e: Error) => e);
        if (res instanceof Error)
          expect(res.message).toMatch(/row-level security|permission denied/);
        else expect(res.rowCount, sql).toBe(0);
      }
      expect(await count(owner, ROOMS)).toBe(2);
      expect(await count(owner, KEYS)).toBe(1);
      const cost = await asServiceRole(c, () =>
        c.query<{ monthly_cost: string }>("select monthly_cost from public.rooms where id = $1", [
          id.r1,
        ]),
      );
      expect(Number(cost.rows[0].monthly_cost)).toBe(6000);
    });
  });

  describe("rooms", () => {
    it("a cost of 0 is refused (unknown is null); kind is a closed list; names are unique per branch", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("update public.rooms set monthly_cost = 0 where id = $1", [id.r1]),
        ).rejects.toThrow(/monthly_cost/);
        await c.query("update public.rooms set monthly_cost = null where id = $1", [id.r2]);
        await expect(
          c.query(
            "insert into public.rooms (org_id, location_id, name, kind) values ($1, $2, 'Odd', 'office')",
            [org, id.north],
          ),
        ).rejects.toThrow();
        await expect(
          c.query(
            "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Room 1')",
            [org, id.north],
          ),
        ).rejects.toThrow(/duplicate key/);
        // the same name at another branch is fine
        await c.query(
          "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Room 1')",
          [org, id.south],
        );
        await c.query(
          "delete from public.rooms where org_id = $1 and location_id = $2 and name = 'Room 1'",
          [org, id.south],
        );
      });
    });

    it("refuses a room at another org's branch", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query(
            "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Wrong org')",
            [org, id.away],
          ),
        ).rejects.toThrow(/does not belong/);
      });
    });
  });

  describe("doctor-key links", () => {
    it("refuse a doctor of another org", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query(
            "insert into public.fin_ref_doctor_keys (org_id, doctor_key, specialist_id) values ($1, 'foreign', $2)",
            [org, id.foreignDoc],
          ),
        ).rejects.toThrow(/does not belong/);
      });
    });
  });

  it("the migration's Manager grant is idempotent", async () => {
    const file = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261208000500_rooms_capacity.sql"),
      "utf8",
    );
    const grant = /update public\.roles r[\s\S]*?;/.exec(file)![0];
    await asServiceRole(c, async () => {
      const manager = await one(
        "insert into public.roles (org_id, name, permissions, is_system) values ($1, 'Manager', '[\"appointments.view\"]'::jsonb, true)",
        [org],
      );
      await c.query(grant);
      await c.query(grant);
      const { rows } = await c.query<{ permissions: string[] }>(
        "select permissions from public.roles where id = $1",
        [manager],
      );
      expect(rows[0].permissions).toEqual(["appointments.view", "rooms.manage"]);
    });
  });
});
