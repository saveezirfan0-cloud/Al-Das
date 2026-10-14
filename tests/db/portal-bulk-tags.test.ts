/**
 * Portal bulk edit and portal tags (docs/33): portal_record_tags RLS across organisations and permissions, the
 * scope / record trigger, and public.portal_bulk_update touching only the caller's organisation. Fake data only.
 * Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("portal bulk edit and tags", () => {
  let c: Client;
  let alice: string; // Admin ('*') of org A
  let bob: string; // Admin of org B
  let erin: string; // 'portal.*.read' in org A
  let frank: string; // no portal permission in org A
  let gina: string; // reads website entry points only, in org A
  let orgA: string;
  let orgB: string;
  let diagA1: string;
  let diagA2: string;
  let diagB: string;
  let tagA: string;
  let tagB: string;
  let enquiryTagA: string;

  async function addMember(org: string, user: string, name: string, permissions: string[]) {
    const { rows } = await c.query<{ id: string }>(
      "insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb) returning id",
      [org, name, JSON.stringify(permissions)],
    );
    await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
      org,
      user,
      rows[0].id,
    ]);
  }
  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(`${sql} returning id::text`, params)).rows[0].id;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    erin = await createAuthUser(c, "erin@example.test");
    frank = await createAuthUser(c, "frank@example.test");
    gina = await createAuthUser(c, "gina@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      await addMember(orgA, erin, "Portal reader", ["portal.*.read"]);
      await addMember(orgA, frank, "No portal", ["inbox.send"]);
      await addMember(orgA, gina, "Website reader", ["portal.website_entry_points.read"]);
      await c.query("select public.seed_portal_objects($1)", [orgA]);
      await c.query("select public.seed_portal_objects($1)", [orgB]);
      diagA1 = await one(
        "insert into public.ref_diagnoses (org_id, code, short_description, chronic) values ($1, 'Z01', 'Fake one', false)",
        [orgA],
      );
      diagA2 = await one(
        "insert into public.ref_diagnoses (org_id, code, short_description, chronic) values ($1, 'Z02', 'Fake two', true)",
        [orgA],
      );
      diagB = await one(
        "insert into public.ref_diagnoses (org_id, code, short_description, chronic) values ($1, 'Z01', 'Fake B', false)",
        [orgB],
      );
      tagA = await one(
        "insert into public.tags (org_id, name, scope) values ($1, 'Review', 'portal')",
        [orgA],
      );
      tagB = await one(
        "insert into public.tags (org_id, name, scope) values ($1, 'Review', 'portal')",
        [orgB],
      );
      enquiryTagA = await one(
        "insert into public.tags (org_id, name, scope) values ($1, 'Hot', 'enquiry')",
        [orgA],
      );
      await c.query(
        "insert into public.portal_record_tags (org_id, object_key, record_id, tag_id) values ($1, 'ref_diagnoses', $2, $3)",
        [orgA, diagA1, tagA],
      );
      await c.query(
        "insert into public.portal_record_tags (org_id, object_key, record_id, tag_id) values ($1, 'ref_diagnoses', $2, $3)",
        [orgB, diagB, tagB],
      );
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const insertTag = (org: string, record: string, tag: string, objectKey = "ref_diagnoses") =>
    c.query(
      "insert into public.portal_record_tags (org_id, object_key, record_id, tag_id) values ($1, $2, $3, $4)",
      [org, objectKey, record, tag],
    );

  describe("portal_record_tags", () => {
    it("shows each organisation only its own record tags", async () => {
      const sql = "select 1 from public.portal_record_tags";
      expect(await asUser(c, alice, () => count(c, sql))).toBe(1);
      expect(await asUser(c, bob, () => count(c, sql))).toBe(1);
      expect(
        await asUser(c, bob, () =>
          count(c, "select 1 from public.portal_record_tags where org_id = $1", [orgA]),
        ),
      ).toBe(0);
    });

    it("follows the object's read permission inside the organisation", async () => {
      const sql = "select 1 from public.portal_record_tags";
      expect(await asUser(c, erin, () => count(c, sql))).toBe(1);
      expect(await asUser(c, frank, () => count(c, sql))).toBe(0);
      expect(await asUser(c, gina, () => count(c, sql))).toBe(0); // diagnoses are not hers to read
    });

    it("has no browser write path, even for an administrator", async () => {
      await asUser(c, alice, async () => {
        await expect(insertTag(orgA, diagA2, tagA)).rejects.toThrow(/row-level security/);
        const del = await c.query("delete from public.portal_record_tags where org_id = $1", [
          orgA,
        ]);
        expect(del.rowCount).toBe(0);
      });
      await asUser(c, bob, async () => {
        // Refused before row security even looks: org A's tag is invisible to org B (check_parent_org).
        await expect(insertTag(orgA, diagA2, tagA)).rejects.toThrow();
      });
      expect(
        await count(c, "select 1 from public.portal_record_tags where org_id = $1", [orgA]),
      ).toBe(1);
    });

    it("refuses a tag that is not a portal tag", async () => {
      await asServiceRole(c, async () => {
        await expect(insertTag(orgA, diagA2, enquiryTagA)).rejects.toThrow(/not a portal tag/);
      });
    });

    it("refuses another organisation's tag or record, and a record that does not exist", async () => {
      await asServiceRole(c, async () => {
        await expect(insertTag(orgA, diagA2, tagB)).rejects.toThrow();
        await expect(insertTag(orgA, diagB, tagA)).rejects.toThrow(/portal record not found/);
        await expect(insertTag(orgA, "00000000-0000-4000-8000-000000000000", tagA)).rejects.toThrow(
          /portal record not found/,
        );
        await expect(insertTag(orgA, diagA2, tagA, "no_such_object")).rejects.toThrow();
      });
    });

    it("goes with its tag when the tag is deleted", async () => {
      await asServiceRole(c, async () => {
        const temp = await one(
          "insert into public.tags (org_id, name, scope) values ($1, 'Temp', 'portal')",
          [orgA],
        );
        await insertTag(orgA, diagA2, temp);
        await c.query("delete from public.tags where id = $1", [temp]);
        expect(
          await count(c, "select 1 from public.portal_record_tags where tag_id = $1", [temp]),
        ).toBe(0);
      });
    });

    it("still refuses unknown tag scopes", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("insert into public.tags (org_id, name, scope) values ($1, 'X', 'nope')", [orgA]),
        ).rejects.toThrow(/tags_scope_check/);
      });
    });
  });

  describe("portal_bulk_update", () => {
    const bulk = (org: string, ids: string[], column: string, value: unknown) =>
      c.query<{ record_id: string; old_value: unknown; new_value: unknown }>(
        "select * from public.portal_bulk_update($1, 'ref_diagnoses', $2::uuid[], $3, $4::jsonb)",
        [org, ids, column, JSON.stringify(value)],
      );

    it("only touches the caller's organisation and skips rows that already hold the value", async () => {
      const { rows } = await asServiceRole(c, () =>
        bulk(orgA, [diagA1, diagA2, diagB], "chronic", true),
      );
      expect(rows.map((r) => r.record_id)).toEqual([diagA1]); // A2 already chronic, B is another org
      expect(rows[0]).toMatchObject({ old_value: false, new_value: true });
      const { rows: b } = await c.query<{ chronic: boolean }>(
        "select chronic from public.ref_diagnoses where id = $1",
        [diagB],
      );
      expect(b[0].chronic).toBe(false);
    });

    it("clears a value and casts to the column type", async () => {
      await asServiceRole(c, async () => {
        const cleared = await bulk(orgA, [diagA1, diagA2], "short_description", null);
        expect(cleared.rows).toHaveLength(2);
        const set = await bulk(orgA, [diagA1], "short_description", "Fake again");
        expect(set.rows[0]).toMatchObject({ old_value: null, new_value: "Fake again" });
      });
    });

    it("names the person in record_history when the actor header is set", async () => {
      await asServiceRole(c, async () => {
        await c.query("begin");
        try {
          await c.query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify({ role: "service_role" }),
          ]);
          await c.query("select set_config('request.headers', $1, true)", [
            JSON.stringify({ "x-pulse-actor": alice }),
          ]);
          await bulk(orgA, [diagA1], "top30", true);
          await c.query("commit");
        } catch (e) {
          await c.query("rollback");
          throw e;
        }
      });
      const { rows } = await c.query<{ actor_id: string | null }>(
        "select actor_id from public.record_history where table_name = 'ref_diagnoses' and record_id = $1 and op = 'update' order by id desc limit 1",
        [diagA1],
      );
      expect(rows[0]?.actor_id).toBe(alice);
    });

    it("refuses system and unknown columns, too many ids and an unknown object", async () => {
      await asServiceRole(c, async () => {
        for (const col of ["org_id", "id", "created_at", "nope", "code; drop table x"]) {
          await expect(bulk(orgA, [diagA1], col, "x"), col).rejects.toThrow(/unknown column/);
        }
        const many = Array.from(
          { length: 501 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        );
        await expect(bulk(orgA, many, "chronic", true)).rejects.toThrow(/at most 500/);
        await expect(
          c.query(
            "select * from public.portal_bulk_update($1, 'no_such_object', $2::uuid[], 'chronic', 'true')",
            [orgA, [diagA1]],
          ),
        ).rejects.toThrow(/unknown portal object/);
      });
    });

    it("cannot be called by signed-in users", async () => {
      await asUser(c, alice, async () => {
        await expect(bulk(orgA, [diagA1], "chronic", false)).rejects.toThrow(/permission denied/);
      });
    });
  });
});
