/**
 * Phase 4: wa_templates after the templates migration. Cross-org isolation, writes
 * limited to templates.manage, the new builder columns and the unique key.
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

describe.skipIf(!TEST_DATABASE_URL)("wa_templates RLS and builder columns", () => {
  let c: Client;
  let alice: string; // admin A ('*' includes templates.manage)
  let carol: string; // agent A (no templates.manage)
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let channelA: string;
  let channelB: string;
  let tplA: string;
  let tplB: string;

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-t@example.test");
    carol = await createAuthUser(c, "carol-t@example.test");
    bob = await createAuthUser(c, "bob-t@example.test");
    orgA = await createOrg(c, "Org A", "org-a-t", alice);
    orgB = await createOrg(c, "Org B", "org-b-t", bob);
    await asServiceRole(c, async () => {
      const { rows: roles } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, roles[0].id],
      );
      channelA = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A', 'waba-ta', 'pn-ta')",
        [orgA],
      );
      channelB = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'B', 'waba-tb', 'pn-tb')",
        [orgB],
      );
      tplA = await insert(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status) values ($1, $2, 'waba-ta', 'hello_a', 'en', 'DRAFT')",
        [orgA, channelA],
      );
      tplB = await insert(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status) values ($1, $2, 'waba-tb', 'hello_b', 'en', 'APPROVED')",
        [orgB, channelB],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("has the builder columns with safe defaults", async () => {
    const { rows } = await c.query(
      "select media_paths, submit_error, submitted_at, created_by, gallery_key from public.wa_templates where id = $1",
      [tplA],
    );
    expect(rows[0]).toEqual({
      media_paths: {},
      submit_error: null,
      submitted_at: null,
      created_by: null,
      gallery_key: null,
    });
  });

  it("members see only their own org's templates", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.wa_templates")).toBe(1);
      expect(await count(c, "select 1 from public.wa_templates where id = $1", [tplB])).toBe(0);
    });
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.wa_templates where id = $1", [tplA])).toBe(0);
      expect(await count(c, "select 1 from public.wa_templates where id = $1", [tplB])).toBe(1);
    });
  });

  it("agents can read templates (the inbox picker) but cannot write them", async () => {
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.wa_templates")).toBe(1);
      await expect(
        c.query(
          "insert into public.wa_templates (org_id, waba_id, name, language) values ($1, 'waba-ta', 'sneaky', 'en')",
          [orgA],
        ),
      ).rejects.toThrow(/row-level security/);
      const upd = await c.query("update public.wa_templates set name = 'renamed' where id = $1", [
        tplA,
      ]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query("delete from public.wa_templates where id = $1", [tplA]);
      expect(del.rowCount).toBe(0);
    });
    expect(
      await count(c, "select 1 from public.wa_templates where id = $1 and name = 'hello_a'", [
        tplA,
      ]),
    ).toBe(1);
  });

  it("template managers write in their org only", async () => {
    await asUser(c, alice, async () => {
      await c.query(
        "insert into public.wa_templates (org_id, waba_id, name, language, status, media_paths, gallery_key) values ($1, 'waba-ta', 'from_gallery', 'ar', 'DRAFT', '{\"header\": \"x/templates/1.png\"}', 'appointment_confirmation')",
        [orgA],
      );
      const upd = await c.query(
        "update public.wa_templates set archived_at = now() where id = $1",
        [tplA],
      );
      expect(upd.rowCount).toBe(1);
      await expect(
        c.query(
          "insert into public.wa_templates (org_id, waba_id, name, language) values ($1, 'waba-tb', 'cross_org', 'en')",
          [orgB],
        ),
      ).rejects.toThrow(/row-level security/);
      const cross = await c.query("update public.wa_templates set name = 'hacked' where id = $1", [
        tplB,
      ]);
      expect(cross.rowCount).toBe(0);
      const crossDel = await c.query("delete from public.wa_templates where id = $1", [tplB]);
      expect(crossDel.rowCount).toBe(0);
    });
    expect(
      await count(c, "select 1 from public.wa_templates where id = $1 and name = 'hello_b'", [
        tplB,
      ]),
    ).toBe(1);
  });

  it("one template per WABA, name and language", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.wa_templates (org_id, waba_id, name, language) values ($1, 'waba-ta', 'hello_a', 'en')",
          [orgA],
        ),
      ).rejects.toThrow(/duplicate key|unique/);
      // Same name in another language is a separate template.
      await c.query(
        "insert into public.wa_templates (org_id, waba_id, name, language) values ($1, 'waba-ta', 'hello_a', 'ar')",
        [orgA],
      );
    });
  });
});
