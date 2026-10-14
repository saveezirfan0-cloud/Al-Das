/**
 * Phase 20g (G9) campaign A/B tests against real Postgres: RLS on campaign_ab_variants, the deterministic assignment
 * (trigger on campaign_recipients, also through the real snapshot function), a variant that never flips (re-snapshot,
 * retry requeue, direct update), the variant guards, the A vs B funnel (with quick-reply clicks) and media usage for a
 * variant B mapping. Synthetic data only (+44 7700 900xxx, "Demo" names).
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  seedSf20gRows,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Phase 20g campaign A/B (db)", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let carol: string;
  let orgA: string;
  let orgB: string;
  let seeded: Record<string, string>;
  let seededB: Record<string, string>;
  let templateB: string;
  let n = 0;

  async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const { rows } = await c.query<T>(sql, params);
    return rows;
  }
  const id = async (sql: string, params: unknown[] = []) =>
    (await q<{ id: string }>(sql + " returning id::text as id", params))[0]!.id;
  const phone = () => `+447700900${String(100 + ++n).padStart(3, "0")}`;
  const contact = () =>
    id(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', $2, $3)",
      [orgA, `Demo-${n}`, phone()],
    );
  const campaign = (name: string) =>
    id(
      "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, $2, $3, $4, 'csv')",
      [orgA, name, seeded.channel, seeded.template],
    );
  const addVariant = (campaignId: string, split: number, tpl = templateB) =>
    id(
      "insert into public.campaign_ab_variants (org_id, campaign_id, template_id, split_pct) values ($1, $2, $3, $4)",
      [orgA, campaignId, tpl, split],
    );
  const addRecipient = (campaignId: string, contactId: string, variant: string | null = null) =>
    q(
      "insert into public.campaign_recipients (org_id, campaign_id, contact_id, variant) values ($1, $2, $3, $4) on conflict (campaign_id, contact_id) do nothing",
      [orgA, campaignId, contactId, variant],
    );
  const variants = (campaignId: string) =>
    q<{ contact_id: string; variant: string | null; bucket: number }>(
      "select contact_id::text, variant, app.campaign_ab_bucket(campaign_id, contact_id) as bucket from public.campaign_recipients where campaign_id = $1 order by contact_id",
      [campaignId],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-20g@example.test");
    bob = await createAuthUser(c, "bob-20g@example.test");
    carol = await createAuthUser(c, "carol-20g@example.test");
    orgA = await createOrg(c, "Org 20g A", "org-20g-a", alice);
    orgB = await createOrg(c, "Org 20g B", "org-20g-b", bob);
    const agent = (
      await q<{ id: string }>("select id from public.roles where org_id = $1 and name = 'Agent'", [
        orgA,
      ])
    )[0]!.id;
    await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
      orgA,
      carol,
      agent,
    ]);
    seeded = await seedSf20gRows(c, orgA, "a");
    seededB = await seedSf20gRows(c, orgB, "b");
    templateB = await id(
      "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category) values ($1, $2, 'waba-20g-a', 'sweep_20g_b', 'en', 'APPROVED', 'UTILITY')",
      [orgA, seeded.channel],
    );
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("RLS", () => {
    it("lets campaigns.view read its own org's variants, nobody else", async () => {
      const seen = (who: string) =>
        asUser(
          c,
          who,
          async () =>
            (
              await q<{ n: number }>(
                "select count(*)::int as n from public.campaign_ab_variants where org_id = $1",
                [orgA],
              )
            )[0]!.n,
        );
      expect(await seen(alice)).toBeGreaterThan(0);
      expect(await seen(bob)).toBe(0);
      expect(await seen(carol)).toBe(0); // Agent role: no campaigns.view
    });

    it("has no write policy: even an admin cannot add or change a variant directly", async () => {
      const cid = await campaign("RLS write");
      await asUser(c, alice, async () => {
        await expect(
          c.query(
            "insert into public.campaign_ab_variants (org_id, campaign_id, template_id, split_pct) values ($1, $2, $3, 50)",
            [orgA, cid, templateB],
          ),
        ).rejects.toThrow(/row-level security/);
        const upd = await c.query("update public.campaign_ab_variants set split_pct = 10");
        expect(upd.rowCount).toBe(0);
      });
    });

    it("refuses a variant B template from another org", async () => {
      const cid = await campaign("Cross org");
      await expect(addVariant(cid, 50, seededB.template)).rejects.toThrow();
    });
  });

  describe("deterministic assignment", () => {
    let cid: string;
    let people: string[];

    beforeAll(async () => {
      cid = await campaign("Split 30");
      await addVariant(cid, 30);
      people = [];
      for (let i = 0; i < 300; i++) people.push(await contact());
      // a caller-supplied variant is ignored: the trigger always decides
      for (const p of people) await addRecipient(cid, p, "b");
    });

    it("puts each person in B exactly when the hash bucket is below the split, about 30% overall", async () => {
      const rows = await variants(cid);
      expect(rows).toHaveLength(300);
      for (const r of rows) expect(r.variant).toBe(r.bucket < 30 ? "b" : "a");
      const b = rows.filter((r) => r.variant === "b").length;
      expect(b).toBeGreaterThan(60);
      expect(b).toBeLessThan(120);
    });

    it("never flips: a second snapshot, a retry requeue and a direct update keep the variant", async () => {
      const before = await variants(cid);
      for (const p of people.slice(0, 50)) await addRecipient(cid, p, "a"); // on conflict do nothing
      await q(
        "update public.campaign_recipients set status = 'failed', error_code = 131049 where campaign_id = $1",
        [cid],
      );
      await asServiceRole(c, () =>
        c.query("select public.campaign_requeue_failed($1, array[131049])", [cid]),
      );
      expect(await variants(cid)).toEqual(before);
      const flip = before[0]!.variant === "a" ? "b" : "a";
      await expect(
        q("update public.campaign_recipients set variant = $2 where campaign_id = $1", [cid, flip]),
      ).rejects.toThrow(/never changes/);
      expect(await variants(cid)).toEqual(before);
    });

    it("is the same for the same person in the same campaign, and independent across campaigns", async () => {
      const other = await campaign("Split 30 again");
      await addVariant(other, 30);
      for (const p of people) await addRecipient(other, p);
      const a = (await variants(cid)).map((r) => r.variant);
      const b = (await variants(other)).map((r) => r.variant);
      expect(a).not.toEqual(b); // another campaign id reshuffles
      const bucket = await q<{ x: number; y: number }>(
        "select app.campaign_ab_bucket($1, $2) as x, app.campaign_ab_bucket($1, $2) as y",
        [cid, people[0]],
      );
      expect(bucket[0]!.x).toBe(bucket[0]!.y);
    });

    it("assigns through the real segment snapshot function too", async () => {
      const snap = await campaign("Snapshot");
      await addVariant(snap, 50);
      await asServiceRole(c, () =>
        c.query(
          "select public.campaign_snapshot_segment($1, $2, 'true', '[]'::jsonb, false, 1000, false)",
          [orgA, snap],
        ),
      );
      const rows = await variants(snap);
      expect(rows.length).toBeGreaterThanOrEqual(300);
      for (const r of rows) expect(r.variant).toBe(r.bucket < 50 ? "b" : "a");
    });

    it("leaves ordinary campaigns without a variant", async () => {
      const plain = await campaign("No test");
      await addRecipient(plain, people[0]!);
      expect((await variants(plain))[0]!.variant).toBeNull();
    });
  });

  describe("variant guards", () => {
    it("refuses a split outside 1 to 99, a second variant, a change, and a variant added after the audience", async () => {
      const cid = await campaign("Guards");
      await expect(addVariant(cid, 0)).rejects.toThrow(/split_pct/);
      await expect(addVariant(cid, 100)).rejects.toThrow(/split_pct/);
      await addVariant(cid, 20);
      await expect(addVariant(cid, 30)).rejects.toThrow(/duplicate key|unique/);
      await expect(
        q("update public.campaign_ab_variants set split_pct = 40 where campaign_id = $1", [cid]),
      ).rejects.toThrow(/cannot be changed/);

      const late = await campaign("Late variant");
      await addRecipient(late, await contact());
      await expect(addVariant(late, 50)).rejects.toThrow(/before the audience/);
    });

    it("keeps the template from being deleted and goes away with its campaign", async () => {
      const cid = await campaign("Cascade");
      await addVariant(cid, 50);
      await expect(q("delete from public.wa_templates where id = $1", [templateB])).rejects.toThrow(
        /foreign key/,
      );
      await q("delete from public.campaigns where id = $1", [cid]);
      expect(
        await q("select 1 from public.campaign_ab_variants where campaign_id = $1", [cid]),
      ).toHaveLength(0);
    });
  });

  describe("A vs B funnel", () => {
    it("counts each version separately, with replies and quick-reply clicks", async () => {
      const cid = await campaign("Funnel");
      await addVariant(cid, 50);
      // find two people per side
      const picks: Record<string, string[]> = { a: [], b: [] };
      while (picks.a.length < 3 || picks.b.length < 3) {
        const p = await contact();
        const [{ bucket }] = await q<{ bucket: number }>(
          "select app.campaign_ab_bucket($1, $2) as bucket",
          [cid, p],
        );
        const side = bucket < 50 ? "b" : "a";
        if (picks[side]!.length < 3) {
          picks[side]!.push(p);
          await addRecipient(cid, p);
        }
      }
      const set = (contactId: string, sql: string, params: unknown[] = []) =>
        q(
          `update public.campaign_recipients set ${sql} where campaign_id = $1 and contact_id = $2`,
          [cid, contactId, ...params],
        );
      // A: read + replied, delivered, skipped.  B: read + clicked, read, failed.
      await set(picks.a[0]!, "status = 'read', replied_at = now(), wa_message_id = 'wamid.20g.a0'");
      await set(picks.a[1]!, "status = 'delivered', wa_message_id = 'wamid.20g.a1'");
      await set(picks.a[2]!, "status = 'skipped', skip_reason = 'no_opt_in'");
      await set(picks.b[0]!, "status = 'read', wa_message_id = 'wamid.20g.b0'");
      await set(picks.b[1]!, "status = 'read', wa_message_id = 'wamid.20g.b1'");
      await set(picks.b[2]!, "status = 'failed', error_code = 131026");
      const conv = await id(
        "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
        [orgA, seeded.channel, picks.b[0]],
      );
      await q(
        "insert into public.messages (org_id, conversation_id, direction, kind, status, at, reply_to_wa_message_id) values ($1, $2, 'in', 'button', 'received', now(), 'wamid.20g.b0')",
        [orgA, conv],
      );
      // a text reply quoting the message is not a click
      await q(
        "insert into public.messages (org_id, conversation_id, direction, kind, status, at, reply_to_wa_message_id) values ($1, $2, 'in', 'text', 'received', now(), 'wamid.20g.b1')",
        [orgA, conv],
      );

      const [{ f }] = await asServiceRole(c, () =>
        q<{ f: Record<string, Record<string, number>> }>(
          "select public.campaign_ab_funnel($1) as f",
          [cid],
        ),
      );
      expect(f.a).toMatchObject({
        total: 3,
        eligible: 2,
        sent: 2,
        delivered: 2,
        read: 1,
        replied: 1,
        clicked: 0,
        failed: 0,
        skipped: 1,
      });
      expect(f.b).toMatchObject({
        total: 3,
        eligible: 3,
        sent: 2,
        delivered: 2,
        read: 2,
        replied: 0,
        clicked: 1,
        failed: 1,
        skipped: 0,
      });
      // ordinary campaign: nothing to compare
      const plain = await campaign("Plain funnel");
      const [{ g }] = await asServiceRole(c, () =>
        q<{ g: unknown }>("select public.campaign_ab_funnel($1) as g", [plain]),
      );
      expect(g).toEqual({});
    });

    it("is not callable from the browser", async () => {
      await asUser(c, alice, async () => {
        await expect(
          c.query("select public.campaign_ab_funnel(gen_random_uuid())"),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe("media usage", () => {
    it("blocks deleting a library file used only by a live campaign's version B", async () => {
      const asset = (await q<{ id: string }>("select gen_random_uuid()::text as id"))[0]!.id;
      await asServiceRole(c, async () => {
        await c.query(
          "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status) values ($2::uuid, $1::uuid, 'Promo image', 'image', 'image/jpeg', 1000, $1::uuid::text || '/' || $2::uuid::text || '/original.jpg', 'ready')",
          [orgA, asset],
        );
        const cid = await id(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status) values ($1, 'Media B', $2, $3, 'csv', 'scheduled')",
          [orgA, seeded.channel, seeded.template],
        );
        await c.query(
          "insert into public.campaign_ab_variants (org_id, campaign_id, template_id, variable_map, split_pct) values ($1, $2, $3, $4, 50)",
          [orgA, cid, templateB, JSON.stringify({ "header.media": `media:${asset}` })],
        );
        const usage = await q<{ kind: string; ref_name: string; blocking: boolean }>(
          "select kind, ref_name, blocking from public.media_asset_usage($1, $2)",
          [orgA, asset],
        );
        expect(usage).toEqual([{ kind: "campaign", ref_name: "Media B", blocking: true }]);
        await expect(
          c.query("delete from public.media_assets where id = $1", [asset]),
        ).rejects.toThrow(/used by a live/);
        await c.query("update public.campaigns set status = 'completed' where id = $1", [cid]);
        await c.query("delete from public.media_assets where id = $1", [asset]);
      });
    });
  });
});
