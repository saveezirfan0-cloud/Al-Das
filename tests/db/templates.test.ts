/** Phase 4 template columns, the local DRAFT status and who may write wa_templates. */
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

describe.skipIf(!TEST_DATABASE_URL)("templates (db)", () => {
  let c: Client;
  let alice: string; // admin, org A
  let carol: string; // agent, org A
  let bob: string; // admin, org B
  let orgA: string;
  let chanA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const role = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, role.rows[0].id],
      );
      const ch = await c.query<{ id: string }>(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Reception', 'W1', 'pn-1') returning id",
        [orgA],
      );
      chanA = ch.rows[0].id;
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const insert = (name = "t1") =>
    c.query(
      "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, source) values ($1, $2, 'W1', $3, 'en', 'DRAFT', 'local')",
      [orgA, chanA, name],
    );

  it("an admin can create a local DRAFT with the new columns defaulted", async () => {
    await asUser(c, alice, async () => {
      await insert();
      const { rows } = await c.query(
        "select status, source, needs_review, meta_template_id, header_sample_path, last_error from public.wa_templates where name = 't1'",
      );
      expect(rows[0]).toEqual({
        status: "DRAFT",
        source: "local",
        needs_review: false,
        meta_template_id: null,
        header_sample_path: null,
        last_error: null,
      });
    });
  });

  it("members read templates but an agent cannot write them", async () => {
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.wa_templates")).toBe(1);
      await expect(insert("t2")).rejects.toThrow(/row-level security/);
      const upd = await c.query("update public.wa_templates set name = 'hacked'");
      expect(upd.rowCount).toBe(0);
      const del = await c.query("delete from public.wa_templates");
      expect(del.rowCount).toBe(0);
    });
  });

  it("another org sees nothing", async () => {
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.wa_templates")).toBe(0);
    });
  });

  it("rejects an unknown source and duplicate (waba, name, language)", async () => {
    await asServiceRole(c, async () => {
      const raw = (name: string, source: string) =>
        c.query(
          "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, source) values ($1, $2, 'W1', $3, 'en', 'DRAFT', $4)",
          [orgA, chanA, name, source],
        );
      await c.query("begin");
      await expect(raw("t3", "weird")).rejects.toThrow(/source_check|check constraint/);
      await c.query("rollback");
      await c.query("begin");
      await expect(raw("t1", "local")).rejects.toThrow(/duplicate key|unique/);
      await c.query("rollback");
    });
  });

  it("stores the review gate and Arabic gallery flags", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, source, gallery_key, needs_review) values ($1, $2, 'W1', 'g1', 'ar', 'DRAFT', 'gallery', 'appointment_reminder:ar', true)",
        [orgA, chanA],
      );
      const { rows } = await c.query(
        "select needs_review, gallery_key from public.wa_templates where name = 'g1'",
      );
      expect(rows[0]).toEqual({ needs_review: true, gallery_key: "appointment_reminder:ar" });
    });
  });
});
