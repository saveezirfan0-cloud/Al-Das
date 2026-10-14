/**
 * Inbox paging through PostgREST: the cursor filters, the label filter applied before paging, and earlier-message
 * pages. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT. Synthetic data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseInboxQuery } from "@/lib/inbox/folders";
import { listConversationsPage, listMessagesPage } from "@/lib/inbox/queries";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "inbox paging through PostgREST",
  () => {
    let c: Client;
    let org: string;
    let user: string;
    let tag: string;
    const convs: string[] = [];
    let client: Parameters<typeof listConversationsPage>[0];

    const q = async (sql: string, p: unknown[]) =>
      (await c.query(sql + " returning id", p)).rows[0].id as string;

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "admin@example.test");
      org = await createOrg(c, "Org P", "org-p", user);
      client = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as unknown as typeof client;
      await c.query("set role service_role");
      const channel = await q(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'WABA1', '109900000000041')",
        [org],
      );
      tag = await q(
        "insert into public.tags (org_id, name, scope) values ($1, 'follow-up', 'conversation')",
        [org],
      );
      // Five conversations, newest first, with microsecond timestamps; two share a timestamp (tie broken by id).
      const stamps = [
        "2026-10-10 10:00:00.123456+00",
        "2026-10-10 09:00:00.654321+00",
        "2026-10-10 09:00:00.654321+00",
        "2026-10-10 08:00:00.000001+00",
        "2026-10-10 07:00:00+00",
      ];
      for (const [i, at] of stamps.entries()) {
        const contact = await q(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', $2, $3)",
          [org, `Demo-${i}`, `+44770090040${i}`],
        );
        const conv = await q(
          "insert into public.conversations (org_id, channel_id, contact_id, last_message_at) values ($1, $2, $3, $4)",
          [org, channel, contact, at],
        );
        convs.push(conv);
      }
      // Label only the oldest two: with the filter in JavaScript after a cap, these were the ones missed.
      for (const conv of convs.slice(3))
        await c.query(
          "insert into public.conversation_labels (org_id, conversation_id, tag_id) values ($1, $2, $3)",
          [org, conv, tag],
        );
      // Seven messages in the first conversation, one second apart.
      for (let i = 0; i < 7; i++)
        await c.query(
          "insert into public.messages (org_id, conversation_id, direction, kind, body, at) values ($1, $2, 'in', 'text', $3, $4)",
          [org, convs[0], `m${i}`, `2026-10-10 06:00:0${i}.5+00`],
        );
      await c.query("reset role");
    });

    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    const ctx = () => ({ userId: user, orgId: org, teamIds: [] });

    it("pages every conversation exactly once, newest and oldest first", async () => {
      for (const sort of ["newest", "oldest"] as const) {
        const query = parseInboxQuery({ sort });
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 5; i++) {
          const page = await listConversationsPage(client, query, ctx(), { limit: 2, cursor });
          seen.push(...page.rows.map((r) => r.id));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(new Set(seen).size).toBe(5);
        expect(seen).toHaveLength(5);
        const expected = sort === "newest" ? [convs[0], convs[4]] : [convs[4], convs[0]];
        expect([seen[0], seen[4]]).toEqual(expected);
      }
    });

    it("filters by label in the database, before paging", async () => {
      const page = await listConversationsPage(client, parseInboxQuery({ label: tag }), ctx(), {
        limit: 1,
      });
      expect(page.rows.map((r) => r.id)).toEqual([convs[3]]);
      const next = await listConversationsPage(client, parseInboxQuery({ label: tag }), ctx(), {
        limit: 1,
        cursor: page.nextCursor,
      });
      expect(next.rows.map((r) => r.id)).toEqual([convs[4]]);
    });

    it("loads earlier messages before the oldest one on screen", async () => {
      const latest = await listMessagesPage(client, convs[0], { limit: 3 });
      expect(latest.messages.map((m) => m.body)).toEqual(["m4", "m5", "m6"]);
      const earlier = await listMessagesPage(client, convs[0], {
        limit: 3,
        before: latest.nextCursor,
      });
      expect(earlier.messages.map((m) => m.body)).toEqual(["m1", "m2", "m3"]);
    });
  },
);
