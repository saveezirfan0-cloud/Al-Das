/**
 * Tenant isolation and permission checks for the Phase 2 CRM tables, plus the
 * merge and duplicate RPCs. Fake data only. Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("CRM row level security", () => {
  let c: Client;
  let alice: string; // admin of org A
  let bob: string; // admin of org B
  let carol: string; // agent in org A (contacts.view only)
  let orgA: string;
  let orgB: string;
  let contactA: string;
  let contactA2: string;
  let contactB: string;
  let tagA: string;
  let tagB: string;
  let segA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    carol = await createAuthUser(c, "carol@example.test");
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

      const ins = async (org: string, first: string, phone: string | null, email: string | null) =>
        (
          await c.query<{ id: string }>(
            "insert into public.contacts (org_id, first_name, last_name, phone_e164, email, dob) values ($1, $2, 'Test', $3, $4, '1990-01-01') returning id",
            [org, first, phone, email],
          )
        ).rows[0].id;
      contactA = await ins(orgA, "Ana", "+971500000001", "ana@example.test");
      contactA2 = await ins(orgA, "Ana", "+971500000002", "ANA@example.test");
      contactB = await ins(orgB, "Bea", "+971500000003", null);

      tagA = (
        await c.query<{ id: string }>(
          "insert into public.tags (org_id, name) values ($1, 'vip') returning id",
          [orgA],
        )
      ).rows[0].id;
      tagB = (
        await c.query<{ id: string }>(
          "insert into public.tags (org_id, name) values ($1, 'vip') returning id",
          [orgB],
        )
      ).rows[0].id;
      segA = (
        await c.query<{ id: string }>(
          "insert into public.segments (org_id, name, kind) values ($1, 'S', 'static') returning id",
          [orgA],
        )
      ).rows[0].id;
      await c.query(
        "insert into public.contact_tags (org_id, contact_id, tag_id) values ($1, $2, $3)",
        [orgA, contactA, tagA],
      );
      await c.query(
        "insert into public.segment_members (org_id, segment_id, contact_id) values ($1, $2, $3)",
        [orgA, segA, contactA2],
      );
      await c.query(
        "insert into public.contact_phones (org_id, contact_id, phone_e164) values ($1, $2, '+971500000009')",
        [orgA, contactA2],
      );
      await c.query(
        "insert into public.custom_fields (org_id, key, label, type) values ($1, 'plan', 'Plan', 'text'), ($2, 'plan', 'Plan', 'text')",
        [orgA, orgB],
      );
      await c.query(
        "insert into public.timeline_events (org_id, contact_id, type, actor_type) values ($1, $2, 'contact.created', 'system'), ($3, $4, 'contact.created', 'system')",
        [orgA, contactA, orgB, contactB],
      );
      await c.query(
        "insert into public.external_refs (org_id, source, entity, external_id, local_table, local_id) values ($1, 'sanoflow', 'contact', 'x1', 'contacts', $2)",
        [orgA, contactA],
      );
      await c.query(
        "insert into public.sync_reviews (org_id, source, entity, external_id, reason) values ($1, 'airtable', 't', 'rec1', 'multiple_phone_matches')",
        [orgA],
      );
      await c.query(
        "insert into public.mentions (org_id, user_id, contact_id) values ($1, $2, $3), ($1, $4, $3)",
        [orgA, alice, contactA, carol],
      );
      await c.query(
        "insert into public.user_grid_prefs (org_id, user_id, grid_key, prefs) values ($1, $2, 'contacts', '{}'), ($1, $3, 'contacts', '{}')",
        [orgA, alice, carol],
      );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("members only see their own org's CRM rows", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.contacts")).toBe(2);
      expect(await count(c, "select 1 from public.contacts where org_id = $1", [orgB])).toBe(0);
      expect(await count(c, "select 1 from public.contact_phones")).toBe(1);
      expect(await count(c, "select 1 from public.tags")).toBe(1);
      expect(await count(c, "select 1 from public.contact_tags")).toBe(1);
      expect(await count(c, "select 1 from public.custom_fields")).toBe(1);
      expect(await count(c, "select 1 from public.segments")).toBe(1);
      expect(await count(c, "select 1 from public.segment_members")).toBe(1);
      expect(await count(c, "select 1 from public.timeline_events")).toBe(1);
      expect(await count(c, "select 1 from public.external_refs")).toBe(1);
      expect(await count(c, "select 1 from public.sync_reviews")).toBe(1);
      expect(await count(c, "select 1 from public.mentions")).toBe(1); // only her own
      expect(await count(c, "select 1 from public.user_grid_prefs")).toBe(1); // only her own
    });
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.contacts")).toBe(1);
      expect(await count(c, "select 1 from public.tags")).toBe(1);
      expect(await count(c, "select 1 from public.contact_tags")).toBe(0);
      expect(await count(c, "select 1 from public.timeline_events")).toBe(1);
      expect(await count(c, "select 1 from public.external_refs")).toBe(0);
      expect(await count(c, "select 1 from public.mentions")).toBe(0);
    });
  });

  it("an agent with contacts.view only cannot write contacts, and cannot see import bookkeeping", async () => {
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.contacts")).toBe(2);
      expect(await count(c, "select 1 from public.external_refs")).toBe(0);
      expect(await count(c, "select 1 from public.sync_reviews")).toBe(0);
      await expect(
        c.query("insert into public.contacts (org_id, first_name) values ($1, 'X')", [orgA]),
      ).rejects.toThrow(/row-level security/);
      await expect(
        c.query("insert into public.tags (org_id, name) values ($1, 'x')", [orgA]),
      ).rejects.toThrow(/row-level security/);
      const upd = await c.query("update public.contacts set first_name = 'Hacked' where id = $1", [
        contactA,
      ]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query("delete from public.contacts where id = $1", [contactA]);
      expect(del.rowCount).toBe(0);
    });
  });

  it("cross-org writes are rejected even for admins", async () => {
    await asUser(c, alice, async () => {
      await expect(
        c.query("insert into public.contacts (org_id, first_name) values ($1, 'X')", [orgB]),
      ).rejects.toThrow(/row-level security/);
      await expect(
        c.query(
          "insert into public.custom_fields (org_id, key, label, type) values ($1, 'k', 'K', 'text')",
          [orgB],
        ),
      ).rejects.toThrow(/row-level security/);
      // A tag from org B cannot be attached to an org A contact (same-org trigger).
      await expect(
        c.query(
          "insert into public.contact_tags (org_id, contact_id, tag_id) values ($1, $2, $3)",
          [orgA, contactA, tagB],
        ),
      ).rejects.toThrow(/does not belong to org/);
      const upd = await c.query("update public.contacts set first_name = 'Hacked' where id = $1", [
        contactB,
      ]);
      expect(upd.rowCount).toBe(0);
    });
  });

  it("timeline notes must be authored as the caller", async () => {
    await asUser(c, alice, async () => {
      await c.query(
        "insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload) values ($1, $2, 'note', 'user', $3, '{\"text\":\"hello\"}')",
        [orgA, contactA, alice],
      );
      await expect(
        c.query(
          "insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id) values ($1, $2, 'note', 'user', $3)",
          [orgA, contactA, carol],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        c.query(
          "insert into public.timeline_events (org_id, contact_id, type, actor_type) values ($1, $2, 'contact.merged', 'system')",
          [orgA, contactA],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("unique identifiers are enforced per org and freed by soft delete", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Dup', '+971500000001')",
          [orgA],
        ),
      ).rejects.toThrow(/contacts_org_phone_uidx/);
      // Same phone in another org is fine.
      const { rows } = await c.query<{ id: string }>(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Dup', '+971500000001') returning id",
        [orgB],
      );
      await c.query("delete from public.contacts where id = $1", [rows[0].id]);
      await expect(
        c.query(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Bad', '0501234567')",
          [orgA],
        ),
      ).rejects.toThrow(/check/);
      await expect(
        c.query(
          "insert into public.contacts (org_id, first_name, external_id) values ($1, 'P', 'PIN1'), ($1, 'Q', 'PIN1')",
          [orgA],
        ),
      ).rejects.toThrow(/contacts_org_external_uidx/);
    });
  });

  it("finds duplicate candidates by email, name+dob and alternate phone", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ a_id: string; b_id: string; reason: string }>(
        "select * from public.contact_duplicate_candidates($1, 50)",
        [orgA],
      );
      const reasons = rows.map((r) => r.reason).sort();
      expect(reasons).toEqual(["email", "name_dob"]);
      // alternate phone +971500000009 matches nobody; add a contact with it as primary
      const { rows: ins } = await c.query<{ id: string }>(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Alt', '+971500000009') returning id",
        [orgA],
      );
      const { rows: again } = await c.query<{ reason: string }>(
        "select * from public.contact_duplicate_candidates($1, 50)",
        [orgA],
      );
      expect(again.map((r) => r.reason).sort()).toEqual(["email", "name_dob", "phone"]);
      await c.query("delete from public.contacts where id = $1", [ins[0].id]);
    });
  });

  it("merge_contacts moves children, keeps opt-outs and frees identifiers", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        'update public.contacts set stop_marketing = true, custom = \'{"plan":"axa","x":1}\' where id = $1',
        [contactA2],
      );
      await c.query('update public.contacts set custom = \'{"plan":"mednet"}\' where id = $1', [
        contactA,
      ]);
      await c.query(
        'select public.merge_contacts($1, $2, $3, \'{"last_name":"Merged"}\'::jsonb, $4)',
        [orgA, contactA, contactA2, alice],
      );

      const { rows: p } = await c.query("select * from public.contacts where id = $1", [contactA]);
      expect(p[0].last_name).toBe("Merged");
      expect(p[0].phone_e164).toBe("+971500000001");
      expect(p[0].stop_marketing).toBe(true);
      expect(p[0].custom).toEqual({ plan: "mednet", x: 1 });
      expect(p[0].deleted_at).toBeNull();

      const { rows: s } = await c.query("select * from public.contacts where id = $1", [contactA2]);
      expect(s[0].deleted_at).not.toBeNull();
      expect(s[0].merged_into_id).toBe(contactA);
      expect(s[0].phone_e164).toBeNull();

      const { rows: phones } = await c.query<{ phone_e164: string }>(
        "select phone_e164 from public.contact_phones where contact_id = $1 order by 1",
        [contactA],
      );
      expect(phones.map((r) => r.phone_e164)).toEqual(["+971500000002", "+971500000009"]);
      expect(
        await count(c, "select 1 from public.contact_phones where contact_id = $1", [contactA2]),
      ).toBe(0);
      expect(
        await count(
          c,
          "select 1 from public.segment_members where contact_id = $1 and segment_id = $2",
          [contactA, segA],
        ),
      ).toBe(1);
      expect(
        await count(
          c,
          "select 1 from public.timeline_events where contact_id = $1 and type = 'contact.merged'",
          [contactA],
        ),
      ).toBe(1);
      // The freed phone can be reused.
      await c.query(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Reuse', '+971500000002')",
        [orgA],
      );
      await expect(
        c.query("select public.merge_contacts($1, $2, $2)", [orgA, contactA]),
      ).rejects.toThrow(/itself/);
      await expect(
        c.query("select public.merge_contacts($1, $2, $3)", [orgA, contactA, contactB]),
      ).rejects.toThrow(/not found/);
    });
  });
});
