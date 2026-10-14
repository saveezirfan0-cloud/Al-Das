/**
 * Phase C (organisation, docs/34_CLINIC_OS_PLAN.md) on Postgres:
 *   - RLS: hr.view reads staff and duties; the rota is readable with hr.view or appointments.view; nobody writes from a
 *     browser (writes are server actions through the service role); another org sees nothing; archived staff are
 *     hidden; the branch rule (app.location_visible_to) applies to staff (home branch), duties and shifts;
 *   - the rota refuses two overlapping shifts for one person (touching shifts are fine), and shifts for archived staff;
 *   - a linked Pulse user must be a member; a changed visa or licence date re-arms its reminder;
 *   - record history covers staff_members and rota_shifts, readable with hr.view only.
 * Synthetic data only.
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

type Err = { code?: string; hint?: string; message?: string };

describe.skipIf(!TEST_DATABASE_URL)("organisation: staff, duties and rota", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let hr: string;
  let desk: string;
  let plain: string;
  let stranger: string;
  let hrMembership: string;
  const loc: Record<string, string> = {};
  const staff: Record<string, string> = {};

  const one = async (sql: string, p: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", p)).rows[0].id;

  async function fails(sql: string, params: unknown[]): Promise<Err | null> {
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

  const shift = (who: string, where: string, start: string, end: string) =>
    asServiceRole(c, () =>
      one(
        "insert into public.rota_shifts (org_id, location_id, staff_member_id, starts_at, ends_at, role_label) values ($1, $2, $3, $4, $5, 'front_desk')",
        [org, where, who, start, end],
      ),
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-c@example.test");
    hr = await createAuthUser(c, "hr-c@example.test");
    desk = await createAuthUser(c, "desk-c@example.test");
    plain = await createAuthUser(c, "plain-c@example.test");
    stranger = await createAuthUser(c, "stranger-c@example.test");
    org = await createOrg(c, "Org Phase C", "org-phase-c", owner);
    otherOrg = await createOrg(c, "Org Other C", "org-other-c", stranger);
    await asServiceRole(c, async () => {
      const role = async (name: string, perms: string[]) =>
        one(
          "insert into public.roles (org_id, name, description, permissions) values ($1, $2, 'synthetic', $3::jsonb)",
          [org, name, JSON.stringify(perms)],
        );
      const hrRole = await role("HR test", ["hr.view", "hr.manage"]);
      const deskRole = await role("Desk test", ["appointments.view"]);
      const plainRole = await role("Plain test", ["contacts.view"]);
      hrMembership = await one(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, hr, hrRole],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, desk, deskRole],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, plain, plainRole],
      );
      for (const name of ["North", "South"])
        loc[name] = await one("insert into public.locations (org_id, name) values ($1, $2)", [
          org,
          name,
        ]);
      loc.away = await one("insert into public.locations (org_id, name) values ($1, 'Away')", [
        otherOrg,
      ]);
      staff.north = await one(
        "insert into public.staff_members (org_id, full_name, home_location_id, visa_expires_on) values ($1, 'Layla Demo-01', $2, '2026-11-01')",
        [org, loc.North],
      );
      staff.south = await one(
        "insert into public.staff_members (org_id, full_name, home_location_id) values ($1, 'Omar Demo-02', $2)",
        [org, loc.South],
      );
      staff.floating = await one(
        "insert into public.staff_members (org_id, full_name) values ($1, 'Sara Demo-03')",
        [org],
      );
      staff.archived = await one(
        "insert into public.staff_members (org_id, full_name, home_location_id, deleted_at) values ($1, 'Old Demo-04', $2, now())",
        [org, loc.North],
      );
      staff.foreign = await one(
        "insert into public.staff_members (org_id, full_name) values ($1, 'Away Demo-05')",
        [otherOrg],
      );
      await c.query(
        "insert into public.staff_duties (org_id, staff_member_id, title, location_id) values ($1, $2, 'North desk', $3), ($1, $4, 'South desk', $5)",
        [org, staff.north, loc.North, staff.south, loc.South],
      );
    });
    await shift(staff.north, loc.North, "2026-10-14T05:00:00Z", "2026-10-14T09:00:00Z");
    await shift(staff.south, loc.South, "2026-10-14T05:00:00Z", "2026-10-14T13:00:00Z");
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const names = (user: string) =>
    asUser(c, user, async () =>
      (
        await c.query<{ full_name: string }>(
          "select full_name from public.staff_members order by full_name",
        )
      ).rows.map((r) => r.full_name),
    );
  const countAs = (user: string, table: string) =>
    asUser(c, user, async () =>
      Number(
        (await c.query<{ n: string }>(`select count(*)::text as n from public.${table}`)).rows[0].n,
      ),
    );

  describe("row level security", () => {
    it("lets hr.view read staff and duties, hiding archived records", async () => {
      expect(await names(hr)).toEqual(["Layla Demo-01", "Omar Demo-02", "Sara Demo-03"]);
      expect(await countAs(hr, "staff_duties")).toBe(2);
      expect(await countAs(hr, "rota_shifts")).toBe(2);
    });

    it("gives appointments.view the rota only, and other members nothing", async () => {
      expect(await names(desk)).toEqual([]);
      expect(await countAs(desk, "staff_duties")).toBe(0);
      expect(await countAs(desk, "rota_shifts")).toBe(2);
      for (const t of ["staff_members", "staff_duties", "rota_shifts"])
        expect(await countAs(plain, t), t).toBe(0);
    });

    it("shows another org nothing", async () => {
      for (const t of ["staff_members", "staff_duties", "rota_shifts"])
        expect(
          await asUser(c, stranger, async () =>
            Number(
              (
                await c.query<{ n: string }>(
                  `select count(*)::text as n from public.${t} where org_id = $1`,
                  [org],
                )
              ).rows[0].n,
            ),
          ),
          t,
        ).toBe(0);
      expect(await names(stranger)).toEqual(["Away Demo-05"]);
    });

    it("refuses every browser write, even with hr.manage", async () => {
      await asUser(c, hr, async () => {
        const ins = await fails(
          "insert into public.staff_members (org_id, full_name) values ($1, 'Sneaky Demo-09')",
          [org],
        );
        expect(ins?.code).toBe("42501");
        const upd = await c.query(
          "update public.staff_members set job_title = 'x' where org_id = $1",
          [org],
        );
        expect(upd.rowCount).toBe(0);
        const del = await c.query("delete from public.rota_shifts where org_id = $1", [org]);
        expect(del.rowCount).toBe(0);
        const duty = await fails(
          "insert into public.staff_duties (org_id, staff_member_id, title) values ($1, $2, 'x')",
          [org, staff.north],
        );
        expect(duty?.code).toBe("42501");
      });
    });

    it("applies the branch rule to staff (home branch), their duties and shifts", async () => {
      await asServiceRole(c, async () => {
        await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [
          hrMembership,
        ]);
        await c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, hrMembership, loc.North],
        );
      });
      // North plus the record without a home branch; South is hidden, with its duty and shift
      expect(await names(hr)).toEqual(["Layla Demo-01", "Sara Demo-03"]);
      expect(
        await asUser(c, hr, async () =>
          (await c.query<{ title: string }>("select title from public.staff_duties")).rows.map(
            (r) => r.title,
          ),
        ),
      ).toEqual(["North desk"]);
      expect(
        await asUser(c, hr, async () =>
          (
            await c.query<{ location_id: string }>(
              "select location_id::text from public.rota_shifts",
            )
          ).rows.map((r) => r.location_id),
        ),
      ).toEqual([loc.North]);
      await asServiceRole(c, async () => {
        await c.query("delete from public.membership_locations where membership_id = $1", [
          hrMembership,
        ]);
        await c.query("update public.memberships set branch_scope = 'all' where id = $1", [
          hrMembership,
        ]);
      });
      expect(await names(hr)).toHaveLength(3);
    });
  });

  describe("rota overlap", () => {
    it("refuses an overlapping shift for the same person, even in another branch", async () => {
      const err = await asServiceRole(c, () =>
        fails(
          "insert into public.rota_shifts (org_id, location_id, staff_member_id, starts_at, ends_at) values ($1, $2, $3, '2026-10-14T08:00:00Z', '2026-10-14T10:00:00Z')",
          [org, loc.South, staff.north],
        ),
      );
      expect(err?.code).toBe("23P01");
      expect(err?.hint).toBe("rota_overlap");
    });

    it("allows touching shifts, another person at the same time, and editing a shift in place", async () => {
      const after = await shift(
        staff.north,
        loc.North,
        "2026-10-14T09:00:00Z",
        "2026-10-14T13:00:00Z",
      );
      await shift(staff.floating, loc.North, "2026-10-14T05:00:00Z", "2026-10-14T09:00:00Z");
      await asServiceRole(c, () =>
        c.query("update public.rota_shifts set room = 'Room 2' where id = $1", [after]),
      );
      // moving it onto the morning shift is refused
      const moved = await asServiceRole(c, () =>
        fails("update public.rota_shifts set starts_at = '2026-10-14T08:30:00Z' where id = $1", [
          after,
        ]),
      );
      expect(moved?.code).toBe("23P01");
    });

    it("refuses shifts for archived staff, empty or over-long shifts, and another org's branch", async () => {
      const archived = await asServiceRole(c, () =>
        fails(
          "insert into public.rota_shifts (org_id, location_id, staff_member_id, starts_at, ends_at) values ($1, $2, $3, '2026-10-20T05:00:00Z', '2026-10-20T09:00:00Z')",
          [org, loc.North, staff.archived],
        ),
      );
      expect(archived?.hint).toBe("staff_archived");
      for (const [s, e] of [
        ["2026-10-20T05:00:00Z", "2026-10-20T05:00:00Z"],
        ["2026-10-20T05:00:00Z", "2026-10-21T06:00:00Z"],
      ]) {
        const bad = await asServiceRole(c, () =>
          fails(
            "insert into public.rota_shifts (org_id, location_id, staff_member_id, starts_at, ends_at) values ($1, $2, $3, $4, $5)",
            [org, loc.North, staff.south, s, e],
          ),
        );
        expect(bad?.code, `${s}-${e}`).toBe("23514");
      }
      const away = await asServiceRole(c, () =>
        fails(
          "insert into public.rota_shifts (org_id, location_id, staff_member_id, starts_at, ends_at) values ($1, $2, $3, '2026-10-20T05:00:00Z', '2026-10-20T09:00:00Z')",
          [org, loc.away, staff.south],
        ),
      );
      expect(away?.message).toMatch(/does not belong/);
    });
  });

  describe("staff record rules", () => {
    it("links only a member of the org as the Pulse user, and one record per user", async () => {
      const outsider = await asServiceRole(c, () =>
        fails("update public.staff_members set profile_id = $2 where id = $1", [
          staff.south,
          stranger,
        ]),
      );
      expect(outsider?.hint).toBe("profile_not_member");
      await asServiceRole(c, () =>
        c.query("update public.staff_members set profile_id = $2 where id = $1", [
          staff.south,
          desk,
        ]),
      );
      const twice = await asServiceRole(c, () =>
        fails("update public.staff_members set profile_id = $2 where id = $1", [
          staff.floating,
          desk,
        ]),
      );
      expect(twice?.code).toBe("23505");
    });

    it("refuses a manager or department of another org and an end before the start", async () => {
      const mgr = await asServiceRole(c, () =>
        fails("update public.staff_members set manager_staff_id = $2 where id = $1", [
          staff.south,
          staff.foreign,
        ]),
      );
      expect(mgr?.message).toMatch(/does not belong/);
      const self = await asServiceRole(c, () =>
        fails("update public.staff_members set manager_staff_id = id where id = $1", [staff.south]),
      );
      expect(self?.code).toBe("23514");
      const dates = await asServiceRole(c, () =>
        fails(
          "update public.staff_members set start_date = '2026-10-14', end_date = '2026-10-01' where id = $1",
          [staff.south],
        ),
      );
      expect(dates?.code).toBe("23514");
    });

    it("re-arms a visa or licence reminder when the date changes", async () => {
      await asServiceRole(c, async () => {
        await c.query(
          "update public.staff_members set visa_expiry_notified_at = now(), licence_expiry_notified_at = now() where id = $1",
          [staff.north],
        );
        await c.query("update public.staff_members set job_title = 'Lead' where id = $1", [
          staff.north,
        ]);
        let row = (
          await c.query<{ v: string | null; l: string | null }>(
            "select visa_expiry_notified_at::text as v, licence_expiry_notified_at::text as l from public.staff_members where id = $1",
            [staff.north],
          )
        ).rows[0];
        expect(row.v).not.toBeNull();
        await c.query(
          "update public.staff_members set visa_expires_on = '2027-11-01' where id = $1",
          [staff.north],
        );
        row = (
          await c.query<{ v: string | null; l: string | null }>(
            "select visa_expiry_notified_at::text as v, licence_expiry_notified_at::text as l from public.staff_members where id = $1",
            [staff.north],
          )
        ).rows[0];
        expect(row.v).toBeNull();
        expect(row.l).not.toBeNull();

        const doc = await one(
          "insert into public.specialists (org_id, name, licence_expires_on, licence_expiry_notified_at) values ($1, 'Dr Demo-06', '2026-11-01', now())",
          [org],
        );
        await c.query(
          "update public.specialists set licence_expires_on = '2027-11-01' where id = $1",
          [doc],
        );
        const s = (
          await c.query<{ n: string | null; a: string }>(
            "select licence_expiry_notified_at::text as n, licence_authority as a from public.specialists where id = $1",
            [doc],
          )
        ).rows[0];
        expect(s.n).toBeNull();
        expect(s.a).toBe("DHA");
      });
    });
  });

  describe("record history", () => {
    it("records staff and shift changes, readable with hr.view only", async () => {
      await asServiceRole(c, () =>
        c.query("update public.staff_members set job_title = 'Supervisor' where id = $1", [
          staff.south,
        ]),
      );
      const read = (user: string) =>
        asUser(c, user, async () =>
          Number(
            (
              await c.query<{ n: string }>(
                "select count(*)::text as n from public.record_history where table_name = 'staff_members' and record_id = $1",
                [staff.south],
              )
            ).rows[0].n,
          ),
        );
      expect(await read(hr)).toBeGreaterThan(0);
      expect(await read(desk)).toBe(0);
      const shifts = await asUser(c, hr, async () =>
        Number(
          (
            await c.query<{ n: string }>(
              "select count(*)::text as n from public.record_history where table_name = 'rota_shifts'",
            )
          ).rows[0].n,
        ),
      );
      expect(shifts).toBeGreaterThan(0);
      // the reminder claim columns are not history
      const keys = await asServiceRole(c, async () =>
        (
          await c.query<{ k: string }>(
            "select distinct jsonb_object_keys(changes) as k from public.record_history where table_name = 'staff_members'",
          )
        ).rows.map((r) => r.k),
      );
      expect(keys).not.toContain("visa_expiry_notified_at");
      expect(keys).not.toContain("licence_expiry_notified_at");
    });
  });
});
