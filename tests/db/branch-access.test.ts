/**
 * Phase B branch access (docs/34_CLINIC_OS_PLAN.md): app.location_visible_to() in RLS.
 *   - 'all' (the default) sees every branch, as before
 *   - 'selected' sees only the branches in membership_locations, plus rows with no branch
 *   - membership_locations refuses a branch of another org, and members cannot write it themselves
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

describe.skipIf(!TEST_DATABASE_URL)("branch access", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let desk: string;
  let deskMembership: string;
  const loc: Record<string, string> = {};

  const one = async (sql: string, p: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id", p)).rows[0].id;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner@example.test");
    desk = await createAuthUser(c, "desk@example.test");
    const stranger = await createAuthUser(c, "other@example.test");
    org = await createOrg(c, "Org B", "org-b", owner);
    otherOrg = await createOrg(c, "Org C", "org-c", stranger);
    await asServiceRole(c, async () => {
      const admin = (
        await c.query<{ id: string }>(
          "select id from public.roles where org_id = $1 and name = 'Admin'",
          [org],
        )
      ).rows[0].id;
      deskMembership = await one(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, desk, admin],
      );
      for (const name of ["North", "South", "East"])
        loc[name] = await one("insert into public.locations (org_id, name) values ($1, $2)", [
          org,
          name,
        ]);
      loc.foreign = await one("insert into public.locations (org_id, name) values ($1, 'Away')", [
        otherOrg,
      ]);
      let n = 1;
      for (const where of [loc.North, loc.South, loc.East, null])
        await c.query(
          `insert into public.appointments (org_id, number, location_id, starts_at, ends_at, source)
           values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 30 minutes', 'unite')`,
          [org, n++, where],
        );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const visible = (user: string) =>
    asUser(c, user, async () =>
      (
        await c.query<{ number: string }>(
          "select number from public.appointments where org_id = $1 order by number",
          [org],
        )
      ).rows.map((r) => Number(r.number)),
    );

  it("everyone sees every branch by default", async () => {
    expect(await visible(desk)).toEqual([1, 2, 3, 4]);
  });

  it("a member limited to some branches sees only those, plus rows with no branch", async () => {
    await asServiceRole(c, async () => {
      await c.query("update public.memberships set branch_scope = 'selected' where id = $1", [
        deskMembership,
      ]);
      for (const l of [loc.North, loc.East])
        await c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, deskMembership, l],
        );
    });
    expect(await visible(desk)).toEqual([1, 3, 4]);
    expect(await visible(owner)).toEqual([1, 2, 3, 4]);

    // An update aimed at the hidden branch touches nothing.
    const updated = await asUser(c, desk, async () =>
      c.query("update public.appointments set notes = 'x' where org_id = $1 and location_id = $2", [
        org,
        loc.South,
      ]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("with no branches chosen a limited member sees only rows without a branch", async () => {
    await asServiceRole(c, () =>
      c.query("delete from public.membership_locations where membership_id = $1", [deskMembership]),
    );
    expect(await visible(desk)).toEqual([4]);
  });

  it("refuses another org's branch and member self-assignment", async () => {
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, deskMembership, loc.foreign],
        ),
      ),
    ).rejects.toThrow(/does not belong/);
    await expect(
      asUser(c, desk, () =>
        c.query(
          "insert into public.membership_locations (org_id, membership_id, location_id) values ($1, $2, $3)",
          [org, deskMembership, loc.South],
        ),
      ),
    ).rejects.toThrow();
  });
});
