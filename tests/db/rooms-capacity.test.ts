/**
 * M3 rooms and capacity (docs/23_PHASE_M3A_NOTES.md): rooms, room_rota, fin_ref_doctor_keys.
 *   - RLS: org-scoped, permission-gated (rooms.manage / finance.revenue.view), branch-bound for rooms and their rota,
 *     no browser writes
 *   - the rota never double-books a room (also under two concurrent writers), and the doctor must work at the room's
 *     branch; a room with a rota cannot move branch; an unknown cost is null, never 0
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
  const rota = (room: string, doctor: string, weekday: number, start: number, end: number) =>
    c.query(
      "insert into public.room_rota (org_id, room_id, specialist_id, weekday, start_min, end_min) values ($1, $2, $3, $4, $5, $6) returning id",
      [org, room, doctor, weekday, start, end],
    );

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
      id.beta = await one(
        "insert into public.specialists (org_id, name) values ($1, 'Dr Beta Demo')",
        [org],
      );
      id.foreignDoc = await one(
        "insert into public.specialists (org_id, name) values ($1, 'Dr Foreign Demo')",
        [otherOrg],
      );
      await c.query(
        "insert into public.specialist_locations (org_id, specialist_id, location_id) values ($1, $2, $3), ($1, $4, $3)",
        [org, id.alpha, id.north, id.beta],
      );
      id.r1 = await one(
        "insert into public.rooms (org_id, location_id, name, kind, monthly_cost) values ($1, $2, 'Room 1', 'consultation', 6000)",
        [org, id.north],
      );
      id.r2 = await one(
        "insert into public.rooms (org_id, location_id, name, kind) values ($1, $2, 'Room 2', 'procedure')",
        [org, id.south],
      );
      id.awayRoom = await one(
        "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Away room')",
        [otherOrg, id.away],
      );
      id.rotaRow = (await rota(id.r1, id.alpha, 1, 540, 720)).rows[0].id;
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

  describe("row level security", () => {
    it("rooms and rota are read with rooms.manage only, never across orgs", async () => {
      const rooms = "select count(*)::text as n from public.rooms where org_id = $1";
      const rotaQ = "select count(*)::text as n from public.room_rota where org_id = $1";
      expect(await count(owner, rooms)).toBe(2);
      expect(await count(roomsUser, rooms)).toBe(2);
      expect(await count(roomsUser, rotaQ)).toBe(1);
      expect(await count(financeUser, rooms)).toBe(0);
      expect(await count(agent, rooms)).toBe(0);
      expect(await count(agent, rotaQ)).toBe(0);
      expect(await count(stranger, rooms)).toBe(0);
      expect(await count(stranger, rotaQ)).toBe(0);
    });

    it("the doctor-key links are read with finance.revenue.view, not by others or other orgs", async () => {
      const q = "select count(*)::text as n from public.fin_ref_doctor_keys where org_id = $1";
      expect(await count(financeUser, q)).toBe(1);
      expect(await count(owner, q)).toBe(1);
      expect(await count(roomsUser, q)).toBe(0);
      expect(await count(agent, q)).toBe(0);
      expect(await count(stranger, q)).toBe(0);
    });

    it("a member limited to one branch sees only that branch's rooms and their rota", async () => {
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
        expect(
          await count(roomsUser, "select count(*)::text as n from public.rooms where org_id = $1"),
        ).toBe(1);
        expect(
          await count(
            roomsUser,
            "select count(*)::text as n from public.room_rota where org_id = $1",
          ),
        ).toBe(0);
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
      for (const sql of [
        [
          "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Sneaky')",
          [org, id.north],
        ],
        ["update public.rooms set monthly_cost = 1 where org_id = $1", [org]],
        ["delete from public.room_rota where org_id = $1", [org]],
        [
          "insert into public.fin_ref_doctor_keys (org_id, doctor_key, specialist_id) values ($1, 'x', $2)",
          [org, id.beta],
        ],
      ] as [string, unknown[]][]) {
        const res = await asUser(c, owner, () => c.query(sql[0], sql[1])).catch((e: Error) => e);
        if (res instanceof Error)
          expect(res.message).toMatch(/row-level security|permission denied/);
        else expect(res.rowCount, sql[0]).toBe(0);
      }
      expect(
        await count(owner, "select count(*)::text as n from public.rooms where org_id = $1"),
      ).toBe(2);
    });
  });

  describe("rota rules", () => {
    it("refuses an overlap in the same room and day, and allows touching times and other days", async () => {
      await asServiceRole(c, async () => {
        await expect(rota(id.r1, id.beta, 1, 600, 660)).rejects.toThrow(/room_double_booked/);
        await expect(rota(id.r1, id.alpha, 1, 500, 541)).rejects.toThrow(/room_double_booked/);
        await expect(rota(id.r1, id.beta, 1, 720, 900)).resolves.toBeTruthy(); // 12:00 starts as the first ends
        await expect(rota(id.r1, id.beta, 2, 540, 720)).resolves.toBeTruthy();
        // moving a row into an occupied slot is refused too
        await expect(
          c.query(
            "update public.room_rota set start_min = 700 where room_id = $1 and weekday = 1 and start_min = 720",
            [id.r1],
          ),
        ).rejects.toThrow(/room_double_booked/);
        // editing a row in place (no other row involved) is fine
        await c.query("update public.room_rota set end_min = 700 where id = $1", [id.rotaRow]);
      });
    });

    it("never lets two concurrent writers double-book a room", async () => {
      const a = await connect();
      const b = await connect();
      try {
        await a.query("set role service_role");
        await b.query("set role service_role");
        const sql =
          "insert into public.room_rota (org_id, room_id, specialist_id, weekday, start_min, end_min) values ($1, $2, $3, 3, 540, 600)";
        await a.query("begin");
        await a.query(sql, [org, id.r1, id.alpha]);
        await b.query("begin");
        const second = b.query(sql, [org, id.r1, id.beta]).then(
          () => "inserted",
          (e: Error) => e.message,
        );
        await new Promise((r) => setTimeout(r, 200));
        await a.query("commit");
        expect(await second).toMatch(/room_double_booked/);
        await b.query("rollback");
      } finally {
        await a.end();
        await b.end();
      }
    });

    it("needs the doctor to work at the room's branch, and the room and doctor of the same org", async () => {
      await asServiceRole(c, async () => {
        await expect(rota(id.r2, id.alpha, 1, 540, 600)).rejects.toThrow(
          /specialist_not_at_room_location/,
        );
        await expect(rota(id.r1, id.foreignDoc, 4, 540, 600)).rejects.toThrow(/does not belong/);
        await expect(rota(id.awayRoom, id.alpha, 4, 540, 600)).rejects.toThrow(/does not belong/);
      });
    });

    it("refuses times out of range and an end before the start", async () => {
      await asServiceRole(c, async () => {
        await expect(rota(id.r1, id.alpha, 0, 540, 600)).rejects.toThrow();
        await expect(rota(id.r1, id.alpha, 5, 600, 540)).rejects.toThrow();
        await expect(rota(id.r1, id.alpha, 5, 600, 1441)).rejects.toThrow();
      });
    });
  });

  describe("rooms", () => {
    it("a cost of 0 is refused (unknown is null), and so is a room of another org's branch", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("update public.rooms set monthly_cost = 0 where id = $1", [id.r1]),
        ).rejects.toThrow(/monthly_cost/);
        await c.query("update public.rooms set monthly_cost = null where id = $1", [id.r2]);
        await expect(
          c.query(
            "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Wrong org')",
            [org, id.away],
          ),
        ).rejects.toThrow(/does not belong/);
        await expect(
          c.query(
            "insert into public.rooms (org_id, location_id, name, kind) values ($1, $2, 'Odd', 'office')",
            [org, id.north],
          ),
        ).rejects.toThrow();
      });
    });

    it("a room with a rota cannot move branch; one without can", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("update public.rooms set location_id = $2 where id = $1", [id.r1, id.south]),
        ).rejects.toThrow(/room_has_rota/);
        await c.query("update public.rooms set location_id = $2 where id = $1", [id.r2, id.north]);
        await c.query("update public.rooms set location_id = $2 where id = $1", [id.r2, id.south]);
      });
    });

    it("deleting a room deletes its rota", async () => {
      await asServiceRole(c, async () => {
        const tmp = await one(
          "insert into public.rooms (org_id, location_id, name) values ($1, $2, 'Temporary')",
          [org, id.north],
        );
        await rota(tmp, id.beta, 6, 540, 600);
        await c.query("delete from public.rooms where id = $1", [tmp]);
        const { rows } = await c.query("select 1 from public.room_rota where room_id = $1", [tmp]);
        expect(rows).toHaveLength(0);
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
      path.join(process.cwd(), "supabase/migrations/20261127000500_rooms_capacity.sql"),
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
