/**
 * Phase 10 tables: knowledge base, AI usage/feedback, API keys, webhooks.
 * Cross-org isolation, permission gating, secret-bearing tables hidden from the API roles,
 * and the kb_match / kb_replace_chunks service-role RPCs. Runs only with TEST_DATABASE_URL.
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

/** A 1024-d unit vector with a 1 at position i: cosine similarity is 1 for equal i, 0 otherwise. */
function vec(i: number): string {
  const v = new Array<number>(1024).fill(0);
  v[i] = 1;
  return `[${v.join(",")}]`;
}

describe.skipIf(!TEST_DATABASE_URL)("phase 10 RLS and RPCs", () => {
  let c: Client;
  let alice: string; // admin A ('*')
  let carol: string; // agent A (no kb.manage / reports.view / settings.manage)
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  const id: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const { rows: roles } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, roles[0].id],
      );

      id.groupA = await insert(
        "insert into public.kb_groups (org_id, name) values ($1, 'Services')",
        [orgA],
      );
      id.groupB = await insert("insert into public.kb_groups (org_id, name) values ($1, 'Services')", [
        orgB,
      ]);
      id.srcA = await insert(
        "insert into public.kb_sources (org_id, group_id, kind, name, url, status) values ($1, $2, 'url', 'Hours', 'https://a.example.test/hours', 'ready')",
        [orgA, id.groupA],
      );
      id.srcAPending = await insert(
        "insert into public.kb_sources (org_id, kind, name, url, status) values ($1, 'url', 'Draft', 'https://a.example.test/draft', 'pending')",
        [orgA],
      );
      id.srcB = await insert(
        "insert into public.kb_sources (org_id, group_id, kind, name, url, status) values ($1, $2, 'url', 'Hours', 'https://b.example.test/hours', 'ready')",
        [orgB, id.groupB],
      );
      await c.query(
        "insert into public.kb_chunks (org_id, source_id, ord, content, embedding) values ($1, $2, 0, 'A opens at 9', $3::vector), ($1, $4, 0, 'A pending chunk', $3::vector)",
        [orgA, id.srcA, vec(0), id.srcAPending],
      );
      await c.query(
        "insert into public.kb_chunks (org_id, source_id, ord, content, embedding) values ($1, $2, 0, 'B opens at 8', $3::vector)",
        [orgB, id.srcB, vec(0)],
      );

      await c.query(
        "insert into public.ai_usage (org_id, user_id, feature, model) values ($1, $2, 'summarize', 'm'), ($3, $4, 'ask', 'm')",
        [orgA, alice, orgB, bob],
      );
      await c.query(
        "insert into public.kb_feedback (org_id, user_id, feature, positive) values ($1, $2, 'suggest_reply', true), ($3, $4, 'suggest_reply', false)",
        [orgA, alice, orgB, bob],
      );

      id.keyA = await insert(
        "insert into public.api_keys (org_id, name, key_prefix, key_hash, scopes) values ($1, 'ERP', 'pk_abc', 'hash-a', '{contacts:read}')",
        [orgA],
      );
      await c.query(
        "insert into public.api_keys (org_id, name, key_prefix, key_hash) values ($1, 'ERP', 'pk_def', 'hash-b')",
        [orgB],
      );
      await c.query(
        "insert into public.api_idempotency (org_id, api_key_id, idempotency_key, request_hash) values ($1, $2, 'k1', 'h')",
        [orgA, id.keyA],
      );

      id.subA = await insert(
        "insert into public.webhook_subscriptions (org_id, url, events) values ($1, 'https://a.example.test/hook', '{message.received}')",
        [orgA],
      );
      id.subB = await insert(
        "insert into public.webhook_subscriptions (org_id, url, events) values ($1, 'https://b.example.test/hook', '{message.received}')",
        [orgB],
      );
      await c.query(
        "insert into public.webhook_secrets (subscription_id, secret_enc) values ($1, 'v1:x'), ($2, 'v1:y')",
        [id.subA, id.subB],
      );
      id.evt = "11111111-1111-4111-8111-111111111111";
      await c.query(
        "insert into public.webhook_deliveries (org_id, subscription_id, event_id, event, payload) values ($1, $2, $3, 'message.received', '{}'), ($4, $5, $3, 'message.received', '{}')",
        [orgA, id.subA, id.evt, orgB, id.subB],
      );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  const seen = (user: string, table: string) =>
    asUser(c, user, () => count(c, `select 1 from public.${table}`));

  it("members with the right permission see only their own org's rows", async () => {
    for (const table of [
      "kb_groups",
      "kb_sources",
      "ai_usage",
      "kb_feedback",
      "webhook_subscriptions",
      "webhook_deliveries",
    ]) {
      expect(await seen(alice, table), `${table} (alice)`).toBeGreaterThan(0);
      expect(await seen(bob, table), `${table} (bob)`).toBeGreaterThan(0);
    }
    expect(await seen(alice, "kb_sources")).toBe(2); // ready + pending, never org B's
    expect(await seen(bob, "kb_sources")).toBe(1);
    expect(await seen(alice, "kb_chunks")).toBe(2);
    expect(await seen(bob, "kb_chunks")).toBe(1);
    expect(await seen(alice, "webhook_deliveries")).toBe(1);
  });

  it("an agent without kb.manage / reports.view / settings.manage sees none of it", async () => {
    for (const table of [
      "kb_groups",
      "kb_sources",
      "kb_chunks",
      "ai_usage",
      "kb_feedback",
      "webhook_subscriptions",
      "webhook_deliveries",
    ]) {
      expect(await seen(carol, table), table).toBe(0);
    }
  });

  it("secret-bearing tables are invisible to every API role, even admins", async () => {
    for (const table of ["api_keys", "api_idempotency", "webhook_secrets"]) {
      expect(await seen(alice, table), table).toBe(0);
      expect(await seen(bob, table), table).toBe(0);
    }
  });

  it("API roles cannot write the new tables", async () => {
    await asUser(c, alice, async () => {
      await expect(
        c.query("insert into public.kb_groups (org_id, name) values ($1, 'x')", [orgA]),
      ).rejects.toThrow(/row-level security/);
      await expect(
        c.query("insert into public.ai_usage (org_id, feature, model) values ($1, 'ask', 'm')", [
          orgA,
        ]),
      ).rejects.toThrow(/row-level security|permission denied/);
      await expect(
        c.query(
          "insert into public.api_keys (org_id, name, key_prefix, key_hash) values ($1, 'x', 'p', 'h')",
          [orgA],
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
    });
  });

  it("child rows must carry their parent's org", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.kb_sources (org_id, group_id, kind, name, url) values ($1, $2, 'url', 'x', 'https://x.example.test')",
          [orgA, id.groupB],
        ),
      ).rejects.toThrow(/does not belong to org/);
      await expect(
        c.query(
          "insert into public.kb_chunks (org_id, source_id, ord, content, embedding) values ($1, $2, 5, 'x', $3::vector)",
          [orgA, id.srcB, vec(1)],
        ),
      ).rejects.toThrow(/does not belong to org/);
      await expect(
        c.query(
          "insert into public.webhook_deliveries (org_id, subscription_id, event_id, event, payload) values ($1, $2, gen_random_uuid(), 'x', '{}')",
          [orgA, id.subB],
        ),
      ).rejects.toThrow(/does not belong to org/);
    });
  });

  it("webhook deliveries are unique per (subscription, event) so fan-out is idempotent", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.webhook_deliveries (org_id, subscription_id, event_id, event, payload) values ($1, $2, $3, 'message.received', '{}')",
          [orgA, id.subA, id.evt],
        ),
      ).rejects.toThrow(/duplicate key/);
      const r = await c.query(
        "insert into public.webhook_deliveries (org_id, subscription_id, event_id, event, payload) values ($1, $2, $3, 'message.received', '{}') on conflict (subscription_id, event_id) do nothing",
        [orgA, id.subA, id.evt],
      );
      expect(r.rowCount).toBe(0);
    });
  });

  it("webhook subscriptions only accept https urls", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.webhook_subscriptions (org_id, url, events) values ($1, 'http://plain.example.test', '{x}')",
          [orgA],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe("kb_match", () => {
    it("is scoped to the org and to ready sources", async () => {
      await asServiceRole(c, async () => {
        const { rows } = await c.query<{ content: string; similarity: number }>(
          "select content, similarity from public.kb_match($1, $2::vector, null, 5)",
          [orgA, vec(0)],
        );
        expect(rows.map((r) => r.content)).toEqual(["A opens at 9"]); // not B's chunk, not the pending source
        expect(rows[0].similarity).toBeCloseTo(1, 5);
      });
    });

    it("filters by group and ranks by similarity", async () => {
      await asServiceRole(c, async () => {
        const grouped = await c.query("select 1 from public.kb_match($1, $2::vector, $3, 5)", [
          orgA,
          vec(0),
          [id.groupB], // a group from another org matches nothing
        ]);
        expect(grouped.rowCount).toBe(0);

        const none = await c.query<{ similarity: number }>(
          "select similarity from public.kb_match($1, $2::vector, null, 5)",
          [orgA, vec(7)],
        );
        expect(none.rows[0].similarity).toBeCloseTo(0, 5);
      });
    });

    it("is not callable by API roles", async () => {
      await asUser(c, alice, async () => {
        await expect(
          c.query("select * from public.kb_match($1, $2::vector, null, 5)", [orgA, vec(0)]),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe("kb_replace_chunks", () => {
    it("swaps chunks atomically, marks the source ready and records the hash", async () => {
      await asServiceRole(c, async () => {
        const chunks = JSON.stringify([
          { ord: 0, content: "first", embedding: JSON.parse(vec(1)) },
          { ord: 1, content: "second", embedding: JSON.parse(vec(2)) },
        ]);
        const { rows } = await c.query<{ n: number }>(
          "select public.kb_replace_chunks($1, $2, $3::jsonb, 'hash-1') as n",
          [orgA, id.srcAPending, chunks],
        );
        expect(rows[0].n).toBe(2);
        const src = await c.query(
          "select status, content_hash, chunk_count from public.kb_sources where id = $1",
          [id.srcAPending],
        );
        expect(src.rows[0]).toMatchObject({ status: "ready", content_hash: "hash-1", chunk_count: 2 });

        // Replacing again drops the old chunks.
        await c.query("select public.kb_replace_chunks($1, $2, $3::jsonb, 'hash-2')", [
          orgA,
          id.srcAPending,
          JSON.stringify([{ ord: 0, content: "only", embedding: JSON.parse(vec(3)) }]),
        ]);
        expect(
          await count(c, "select 1 from public.kb_chunks where source_id = $1", [id.srcAPending]),
        ).toBe(1);
      });
    });

    it("refuses a source from another org", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("select public.kb_replace_chunks($1, $2, '[]'::jsonb, 'h')", [orgA, id.srcB]),
        ).rejects.toThrow(/not found/);
      });
    });
  });
});
