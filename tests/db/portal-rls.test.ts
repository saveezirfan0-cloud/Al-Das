/**
 * Phase 9: portal framework RLS, wildcard permissions in SQL, saved-view sharing and the
 * table-agnostic search RPC. Fake data only. Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("portal framework", () => {
  let c: Client;
  let alice: string; // Admin ('*') of org A
  let bob: string; // Admin of org B
  let dave: string; // Manager ('portal.*') in org A
  let erin: string; // Reader ('portal.*.read') in org A
  let frank: string; // no portal permission in org A
  let orgA: string;
  let orgB: string;
  let diagA: string;
  let diagB: string;
  let settingA: string;
  let entryA: string;

  async function addRole(org: string, name: string, permissions: string[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      "insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb) returning id",
      [org, name, JSON.stringify(permissions)],
    );
    return rows[0].id;
  }
  async function addMember(org: string, user: string, role: string) {
    await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
      org,
      user,
      role,
    ]);
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    dave = await createAuthUser(c, "dave@example.test");
    erin = await createAuthUser(c, "erin@example.test");
    frank = await createAuthUser(c, "frank@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      await addMember(orgA, dave, await addRole(orgA, "Portal manager", ["portal.*"]));
      await addMember(orgA, erin, await addRole(orgA, "Portal reader", ["portal.*.read"]));
      await addMember(orgA, frank, await addRole(orgA, "No portal", ["inbox.send"]));
      await c.query("select public.seed_portal_objects($1)", [orgA]);
      await c.query("select public.seed_portal_objects($1)", [orgB]);
      await c.query("select public.seed_clinical_settings($1)", [orgA]);

      const ins = async (org: string, code: string) =>
        (
          await c.query<{ id: string }>(
            "insert into public.ref_diagnoses (org_id, code, short_description, chronic) values ($1, $2, 'Fake', $3) returning id",
            [org, code, code === "I10"],
          )
        ).rows[0].id;
      diagA = await ins(orgA, "I10");
      await ins(orgA, "J45");
      diagB = await ins(orgB, "I10");
      settingA = (
        await c.query<{ id: string }>(
          "select id from public.clinical_settings where org_id = $1 limit 1",
          [orgA],
        )
      ).rows[0].id;
      entryA = (
        await c.query<{ id: string }>(
          "insert into public.website_entry_points (org_id, section, source_key) values ($1, '01. General', 'Home') returning id",
          [orgA],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await c.end();
  });

  describe("has_perm_wild", () => {
    const check = (user: string, org: string, perm: string) =>
      asUser(c, user, async () => {
        const { rows } = await c.query<{ ok: boolean }>("select app.has_perm_wild($1, $2) as ok", [
          org,
          perm,
        ]);
        return rows[0].ok;
      });

    it("honours '*', 'portal.*' and 'portal.*.read'", async () => {
      expect(await check(alice, orgA, "portal.ref_items.write")).toBe(true);
      expect(await check(dave, orgA, "portal.ref_items.write")).toBe(true);
      expect(await check(dave, orgA, "portal.ref_items.read")).toBe(true);
      expect(await check(erin, orgA, "portal.ref_items.read")).toBe(true);
      expect(await check(erin, orgA, "portal.ref_items.write")).toBe(false);
      expect(await check(frank, orgA, "portal.ref_items.read")).toBe(false);
    });

    it("does not let 'portal.*' cover clinical sign-off, and never crosses orgs", async () => {
      expect(await check(dave, orgA, "clinical.settings.manage")).toBe(false);
      expect(await check(alice, orgA, "clinical.settings.manage")).toBe(true);
      expect(await check(alice, orgB, "portal.ref_items.read")).toBe(false);
    });
  });

  describe("tenant isolation", () => {
    it("members only see their own org's reference rows", async () => {
      expect(await asUser(c, alice, () => count(c, "select 1 from public.ref_diagnoses"))).toBe(2);
      expect(await asUser(c, bob, () => count(c, "select 1 from public.ref_diagnoses"))).toBe(1);
      expect(
        await asUser(c, bob, () =>
          count(c, "select 1 from public.ref_diagnoses where id = $1", [diagA]),
        ),
      ).toBe(0);
      expect(
        await asUser(c, alice, () =>
          count(c, "select 1 from public.ref_diagnoses where id = $1", [diagB]),
        ),
      ).toBe(0);
    });

    it("cross-org writes are rejected", async () => {
      await expect(
        asUser(c, alice, () =>
          c.query(
            "insert into public.website_entry_points (org_id, section, source_key) values ($1, 'x', 'y')",
            [orgB],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("portal_objects is visible only to members who can read the object", async () => {
      expect(await asUser(c, alice, () => count(c, "select 1 from public.portal_objects"))).toBe(7);
      expect(await asUser(c, erin, () => count(c, "select 1 from public.portal_objects"))).toBe(7);
      expect(await asUser(c, frank, () => count(c, "select 1 from public.portal_objects"))).toBe(0);
      expect(
        await asUser(c, bob, () =>
          count(c, "select 1 from public.portal_objects where org_id = $1", [orgA]),
        ),
      ).toBe(0);
    });

    it("seed_portal_objects is idempotent and service-role only", async () => {
      await asServiceRole(c, () => c.query("select public.seed_portal_objects($1)", [orgA]));
      expect(
        await asServiceRole(c, () =>
          count(c, "select 1 from public.portal_objects where org_id = $1", [orgA]),
        ),
      ).toBe(7);
      await expect(
        asUser(c, alice, () => c.query("select public.seed_portal_objects($1)", [orgA])),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("write permissions", () => {
    it("Manager (portal.*) writes portal tables; Reader cannot", async () => {
      await asUser(c, dave, () =>
        c.query("update public.website_entry_points set route_to = 'Nursing team' where id = $1", [
          entryA,
        ]),
      );
      const { rows } = await c.query(
        "select route_to from public.website_entry_points where id = $1",
        [entryA],
      );
      expect(rows[0].route_to).toBe("Nursing team");

      const res = await asUser(c, erin, () =>
        c.query("update public.website_entry_points set route_to = 'Hacked' where id = $1", [
          entryA,
        ]),
      );
      expect(res.rowCount).toBe(0);
      await expect(
        asUser(c, erin, () =>
          c.query(
            "insert into public.website_entry_points (org_id, section, source_key) values ($1, 'a', 'b')",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("clinical settings need clinical.settings.manage, not portal.*", async () => {
      const denied = await asUser(c, dave, () =>
        c.query("update public.clinical_settings set owner = 'x' where id = $1", [settingA]),
      );
      expect(denied.rowCount).toBe(0);
      const ok = await asUser(c, alice, () =>
        c.query("update public.clinical_settings set owner = 'Dr Fake' where id = $1", [settingA]),
      );
      expect(ok.rowCount).toBe(1);
    });

    it("reference tables have no write policy for staff (service role only)", async () => {
      const res = await asUser(c, alice, () =>
        c.query("update public.ref_diagnoses set short_description = 'x' where id = $1", [diagA]),
      );
      expect(res.rowCount).toBe(0);
    });
  });

  describe("timeline, comments, attachments, saved views", () => {
    let viewPrivate: string;
    let viewShared: string;

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        await c.query(
          "insert into public.portal_record_events (org_id, object_key, record_id, type, actor_id) values ($1, 'ref_diagnoses', $2, 'updated', $3)",
          [orgA, diagA, alice],
        );
        await c.query(
          "insert into public.portal_comments (org_id, object_key, record_id, author_id, body) values ($1, 'ref_diagnoses', $2, $3, 'hello')",
          [orgA, diagA, alice],
        );
        await c.query(
          "insert into public.portal_comments (org_id, object_key, record_id, author_id, body, deleted_at) values ($1, 'ref_diagnoses', $2, $3, 'gone', now())",
          [orgA, diagA, alice],
        );
        await c.query(
          "insert into public.portal_attachments (org_id, object_key, record_id, path, file_name, uploaded_by) values ($1, 'ref_diagnoses', $2, $3, 'a.pdf', $4)",
          [orgA, diagA, `${orgA}/ref_diagnoses/${diagA}/x.pdf`, alice],
        );
        viewPrivate = (
          await c.query<{ id: string }>(
            "insert into public.saved_views (org_id, object_key, owner_id, name) values ($1, 'ref_diagnoses', $2, 'Mine') returning id",
            [orgA, alice],
          )
        ).rows[0].id;
        viewShared = (
          await c.query<{ id: string }>(
            "insert into public.saved_views (org_id, object_key, owner_id, name, shared_all) values ($1, 'ref_diagnoses', $2, 'Everyone', true) returning id",
            [orgA, alice],
          )
        ).rows[0].id;
      });
    });

    it("readers see events, live comments and attachments; others do not", async () => {
      for (const t of ["portal_record_events", "portal_comments", "portal_attachments"]) {
        expect(await asUser(c, erin, () => count(c, `select 1 from public.${t}`)), t).toBe(1);
        expect(await asUser(c, frank, () => count(c, `select 1 from public.${t}`)), t).toBe(0);
        expect(await asUser(c, bob, () => count(c, `select 1 from public.${t}`)), t).toBe(0);
      }
    });

    it("staff cannot insert timeline / comments / attachments directly (server-only writes)", async () => {
      await expect(
        asUser(c, dave, () =>
          c.query(
            "insert into public.portal_comments (org_id, object_key, record_id, author_id, body) values ($1, 'ref_diagnoses', $2, $3, 'x')",
            [orgA, diagA, dave],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("saved views: owner sees private + shared; reader sees only shared; no-permission sees none", async () => {
      const ids = (u: string) =>
        asUser(c, u, async () =>
          (await c.query<{ id: string }>("select id from public.saved_views")).rows.map(
            (r) => r.id,
          ),
        );
      expect((await ids(alice)).sort()).toEqual([viewPrivate, viewShared].sort());
      expect(await ids(erin)).toEqual([viewShared]);
      expect(await ids(frank)).toEqual([]);
      expect(await ids(bob)).toEqual([]);
    });
  });

  describe("portal_search / count / ids RPCs", () => {
    const search = (org: string, key: string, where = "true", order = "c.code asc") =>
      asServiceRole(c, () =>
        c.query(
          "select row_data, total from public.portal_search($1, $2, $3, '[]'::jsonb, $4, 50, 0)",
          [org, key, where, order],
        ),
      );

    it("returns only the org's rows, with a total, as jsonb", async () => {
      const r = await search(orgA, "ref_diagnoses");
      expect(r.rows).toHaveLength(2);
      expect(Number(r.rows[0].total)).toBe(2);
      expect(r.rows.map((x) => x.row_data.code)).toEqual(["I10", "J45"]);
      expect(r.rows.every((x) => x.row_data.org_id === orgA)).toBe(true);
      const b = await search(orgB, "ref_diagnoses");
      expect(b.rows).toHaveLength(1);
    });

    it("binds filter values through the params array", async () => {
      const r = await asServiceRole(c, () =>
        c.query(
          "select row_data from public.portal_search($1, 'ref_diagnoses', 'c.code = ($1 ->> 0)', '[\"J45\"]'::jsonb, 'c.code asc', 50, 0)",
          [orgA],
        ),
      );
      expect(r.rows.map((x) => x.row_data.code)).toEqual(["J45"]);
    });

    it("rejects unknown and other-org objects, and unsafe ORDER BY", async () => {
      await expect(search(orgA, "memberships")).rejects.toThrow(/unknown portal object/);
      await expect(search(orgA, "ref_diagnoses; drop table orgs")).rejects.toThrow(
        /unknown portal object/,
      );
      await expect(
        search(orgA, "ref_diagnoses", "true", "c.code; drop table orgs"),
      ).rejects.toThrow(/invalid order by/);
      await asServiceRole(c, () =>
        c.query("delete from public.portal_objects where org_id = $1 and key = 'ref_items'", [
          orgB,
        ]),
      );
      await expect(search(orgB, "ref_items")).rejects.toThrow(/unknown portal object/);
      await asServiceRole(c, () =>
        c.query(
          "update public.portal_objects set enabled = false where org_id = $1 and key = 'ref_items'",
          [orgA],
        ),
      );
      await expect(search(orgA, "ref_items")).rejects.toThrow(/unknown portal object/);
    });

    it("count and ids agree with search; staff cannot call the RPCs", async () => {
      const n = await asServiceRole(c, () =>
        c.query("select public.portal_count($1, 'ref_diagnoses', 'true', '[]'::jsonb) as n", [
          orgA,
        ]),
      );
      expect(Number(n.rows[0].n)).toBe(2);
      const ids = await asServiceRole(c, () =>
        c.query("select * from public.portal_ids($1, 'ref_diagnoses', 'true', '[]'::jsonb, 10)", [
          orgA,
        ]),
      );
      expect(ids.rowCount).toBe(2);
      await expect(
        asUser(c, alice, () =>
          c.query(
            "select * from public.portal_search($1, 'ref_diagnoses', 'true', '[]'::jsonb, '', 10, 0)",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("website_entry_points constraints", () => {
    it("unique per section + source, and channel/team must belong to the org", async () => {
      await expect(
        asServiceRole(c, () =>
          c.query(
            "insert into public.website_entry_points (org_id, section, source_key) values ($1, '01. General', 'Home')",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/duplicate key/);
      const team = await asServiceRole(c, () =>
        c.query<{ id: string }>(
          "insert into public.teams (org_id, name) values ($1, 'Team B') returning id",
          [orgB],
        ),
      );
      await expect(
        asServiceRole(c, () =>
          c.query(
            "insert into public.website_entry_points (org_id, section, source_key, route_team_id) values ($1, 's', 'k', $2)",
            [orgA, team.rows[0].id],
          ),
        ),
      ).rejects.toThrow(/does not belong to org/);
    });
  });
});
