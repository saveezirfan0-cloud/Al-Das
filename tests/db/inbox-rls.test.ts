/**
 * Phase 3 tables: cross-org isolation, conversation visibility by assignment,
 * message status ladder, send slots, round-robin. Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("inbox RLS and SQL functions", () => {
  let c: Client;
  let alice: string; // admin A (has '*', so inbox.view_all)
  let carol: string; // agent A (inbox.send only)
  let dave: string; // agent A, member of team "Front desk"
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let channelA: string;
  let channelB: string;
  let contactA: string;
  let teamA: string;
  const conv: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    dave = await createAuthUser(c, "dave@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      const { rows: roles } = await c.query<{ id: string }>(
        "select id from public.roles where org_id = $1 and name = 'Agent'",
        [orgA],
      );
      for (const u of [carol, dave]) {
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
          [orgA, u, roles[0].id],
        );
      }
      teamA = await insert(
        "insert into public.teams (org_id, name, round_robin) values ($1, 'Front desk', true)",
        [orgA],
      );
      await c.query(
        "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)",
        [orgA, teamA, dave],
      );

      channelA = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A main', 'waba-a', 'pn-a')",
        [orgA],
      );
      channelB = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'B main', 'waba-b', 'pn-b')",
        [orgB],
      );
      await c.query(
        "insert into public.channel_secrets (channel_id, access_token_enc) values ($1, 'v1:enc'), ($2, 'v1:enc')",
        [channelA, channelB],
      );

      contactA = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Pat', '+971500000001')",
        [orgA],
      );
      const contactA2 = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Sam', '+971500000002')",
        [orgA],
      );
      const contactA3 = await insert(
        "insert into public.contacts (org_id, first_name, wa_bsuid) values ($1, 'User', 'BSUID_X')",
        [orgA],
      );
      const contactA4 = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Lee', '+971500000004')",
        [orgA],
      );
      const contactB = await insert(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Other', '+971500000003')",
        [orgB],
      );

      conv.unassigned = await insert(
        "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
        [orgA, channelA, contactA],
      );
      conv.carol = await insert(
        "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id) values ($1, $2, $3, $4)",
        [orgA, channelA, contactA2, carol],
      );
      conv.team = await insert(
        "insert into public.conversations (org_id, channel_id, contact_id, assignee_team_id) values ($1, $2, $3, $4)",
        [orgA, channelA, contactA3, teamA],
      );
      conv.alice = await insert(
        "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id) values ($1, $2, $3, $4)",
        [orgA, channelA, contactA4, alice],
      );
      conv.b = await insert(
        "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
        [orgB, channelB, contactB],
      );

      for (const [name, id] of Object.entries(conv)) {
        await c.query(
          "insert into public.messages (org_id, conversation_id, direction, kind, body, wa_message_id, status) values ($1, $2, 'in', 'text', $3, $4, 'received')",
          [name === "b" ? orgB : orgA, id, `hello ${name}`, `wamid.${name}`],
        );
      }
      await c.query(
        "insert into public.tags (org_id, name, scope) values ($1, 'VIP', 'conversation'), ($2, 'VIP', 'conversation')",
        [orgA, orgB],
      );
      await c.query(
        "insert into public.quick_replies (org_id, shortcut, text) values ($1, 'hours', 'We are open 8-8'), ($2, 'hours', 'B hours')",
        [orgA, orgB],
      );
      await c.query(
        "insert into public.conv_categories (org_id, name) values ($1, 'Booking'), ($2, 'Booking')",
        [orgA, orgB],
      );
      await c.query(
        "insert into public.inbox_views (org_id, owner_id, name, shared_all) values ($1, $2, 'Alice private', false), ($1, $2, 'Everyone', true), ($3, $4, 'B view', true)",
        [orgA, alice, orgB, bob],
      );
      await c.query(
        "insert into public.inbox_views (org_id, owner_id, name, shared_team_ids) values ($1, $2, 'Front desk view', array[$3]::uuid[])",
        [orgA, alice, teamA],
      );
      await c.query(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status) values ($1, $2, 'waba-a', 'hello', 'en', 'APPROVED'), ($3, $4, 'waba-b', 'hello', 'en', 'APPROVED')",
        [orgA, channelA, orgB, channelB],
      );
      await c.query("insert into public.webhook_events_in (payload) values ('{}'::jsonb)");
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("every Phase 3 table is tenant-isolated for an admin", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.contacts")).toBe(4);
      expect(await count(c, "select 1 from public.channels")).toBe(1);
      expect(await count(c, "select 1 from public.conversations")).toBe(4);
      expect(await count(c, "select 1 from public.messages")).toBe(4);
      expect(await count(c, "select 1 from public.tags")).toBe(1);
      expect(await count(c, "select 1 from public.quick_replies")).toBe(1);
      expect(await count(c, "select 1 from public.conv_categories")).toBe(1);
      expect(await count(c, "select 1 from public.wa_templates")).toBe(1);
      expect(await count(c, "select 1 from public.inbox_views")).toBe(3);
    });
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.conversations")).toBe(1);
      expect(await count(c, "select 1 from public.messages")).toBe(1);
      expect(await count(c, "select 1 from public.contacts")).toBe(1);
    });
  });

  it("service-role-only tables are invisible to the API roles", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.channel_secrets")).toBe(0);
      expect(await count(c, "select 1 from public.webhook_events_in")).toBe(0);
      expect(await count(c, "select 1 from public.channel_send_slots")).toBe(0);
      await expect(c.query("select public.claim_send_slot($1, 10)", [channelA])).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        c.query("select public.apply_message_status('wamid.unassigned', 'read', now())"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("an agent without inbox.view_all sees own, team and unassigned conversations only", async () => {
    await asUser(c, carol, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.conversations order by created_at",
      );
      expect(rows.map((r) => r.id).sort()).toEqual([conv.unassigned, conv.carol].sort());
      expect(await count(c, "select 1 from public.messages")).toBe(2);
    });
    await asUser(c, dave, async () => {
      const { rows } = await c.query<{ id: string }>("select id from public.conversations");
      expect(rows.map((r) => r.id).sort()).toEqual([conv.unassigned, conv.team].sort());
      // saved views: own, shared with everyone, shared with my team — not Alice's private one
      const { rows: views } = await c.query<{ name: string }>(
        "select name from public.inbox_views order by name",
      );
      expect(views.map((v) => v.name)).toEqual(["Everyone", "Front desk view"]);
    });
    await asUser(c, carol, async () => {
      const { rows: views } = await c.query<{ name: string }>(
        "select name from public.inbox_views order by name",
      );
      expect(views.map((v) => v.name)).toEqual(["Everyone"]);
    });
  });

  it("agents cannot write inbox tables directly", async () => {
    await asUser(c, carol, async () => {
      const r = await c.query("update public.conversations set status = 'closed' where id = $1", [
        conv.carol,
      ]);
      expect(r.rowCount).toBe(0);
      await expect(
        c.query(
          "insert into public.messages (org_id, conversation_id, direction, kind, body) values ($1, $2, 'out', 'text', 'x')",
          [orgA, conv.carol],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        c.query(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [orgA, channelA, contactA],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("mentions are visible to the mentioned user only", async () => {
    await asServiceRole(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        "select id from public.messages where conversation_id = $1",
        [conv.unassigned],
      );
      await c.query(
        "insert into public.mentions (org_id, message_id, conversation_id, user_id) values ($1, $2, $3, $4)",
        [orgA, rows[0].id, conv.unassigned, carol],
      );
    });
    await asUser(c, carol, async () =>
      expect(await count(c, "select 1 from public.mentions")).toBe(1),
    );
    await asUser(c, dave, async () =>
      expect(await count(c, "select 1 from public.mentions")).toBe(0),
    );
    await asUser(c, carol, async () => {
      const r = await c.query("update public.mentions set read_at = now() where user_id = $1", [
        carol,
      ]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("integrity triggers reject cross-org references", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [orgA, channelB, contactA],
        ),
      ).rejects.toThrow(/does not belong/);
      await expect(
        c.query("update public.conversations set assignee_user_id = $1 where id = $2", [
          bob,
          conv.unassigned,
        ]),
      ).rejects.toThrow(/not a member/);
      const { rows: tagB } = await c.query<{ id: string }>(
        "select id from public.tags where org_id = $1",
        [orgB],
      );
      await expect(
        c.query(
          "insert into public.conversation_labels (org_id, conversation_id, tag_id) values ($1, $2, $3)",
          [orgA, conv.unassigned, tagB[0].id],
        ),
      ).rejects.toThrow(/does not belong/);
    });
  });

  it("one live conversation per contact per number", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [orgA, channelA, contactA],
        ),
      ).rejects.toThrow(/conversations_live_idx/);
      await c.query("update public.conversations set status = 'closed' where id = $1", [
        conv.unassigned,
      ]);
      const id = await insert(
        "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
        [orgA, channelA, contactA],
      );
      await c.query("delete from public.conversations where id = $1", [id]);
      await c.query("update public.conversations set status = 'open' where id = $1", [
        conv.unassigned,
      ]);
    });
  });

  it("message status only moves forward; failed after read is ignored", async () => {
    await asServiceRole(c, async () => {
      const id = await insert(
        "insert into public.messages (org_id, conversation_id, direction, kind, body, wa_message_id, status) values ($1, $2, 'out', 'text', 'x', 'wamid.out1', 'queued')",
        [orgA, conv.carol],
      );
      const apply = async (s: string, code: number | null = null) =>
        (
          await c.query<{ r: boolean }>(
            "select public.apply_message_status('wamid.out1', $1, now(), $2, 'err') as r",
            [s, code],
          )
        ).rows[0].r;
      expect(await apply("delivered")).toBe(true);
      expect(await apply("sent")).toBe(false);
      expect(
        (await c.query("select status from public.messages where id = $1", [id])).rows[0].status,
      ).toBe("delivered");
      expect(await apply("read")).toBe(true);
      expect(await apply("failed", 131050)).toBe(false);
      expect(
        (await c.query("select status, error_code from public.messages where id = $1", [id]))
          .rows[0],
      ).toEqual({ status: "read", error_code: null });
      expect(await apply("read")).toBe(false);
      expect(
        (await c.query("select public.apply_message_status('wamid.nope', 'sent', now()) as r"))
          .rows[0].r,
      ).toBe(false);
      // direct updates go through the same guard
      await c.query("update public.messages set status = 'queued' where id = $1", [id]);
      expect(
        (await c.query("select status from public.messages where id = $1", [id])).rows[0].status,
      ).toBe("read");
    });
  });

  it("send slots cap sends per second per channel", async () => {
    await asServiceRole(c, async () => {
      const at = "2026-05-01T10:00:00.250Z";
      const claim = async (t = at) =>
        (
          await c.query<{ r: boolean }>(
            "select public.claim_send_slot($1, 3, $2::timestamptz) as r",
            [channelA, t],
          )
        ).rows[0].r;
      expect([await claim(), await claim(), await claim()]).toEqual([true, true, true]);
      expect(await claim()).toBe(false);
      expect(await claim("2026-05-01T10:00:01.000Z")).toBe(true);
      // another channel has its own budget
      expect(
        (
          await c.query<{ r: boolean }>(
            "select public.claim_send_slot($1, 3, $2::timestamptz) as r",
            [channelB, at],
          )
        ).rows[0].r,
      ).toBe(true);
    });
  });

  it("round-robin picks online members least recently assigned", async () => {
    await asServiceRole(c, async () => {
      const pick = async () =>
        (
          await c.query<{ u: string | null }>(
            "select public.pick_round_robin_assignee($1, $2) as u",
            [orgA, teamA],
          )
        ).rows[0].u;
      expect(await pick()).toBeNull(); // nobody online
      await c.query("update public.memberships set presence = 'online' where user_id in ($1, $2)", [
        dave,
        carol,
      ]);
      await c.query(
        "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)",
        [orgA, teamA, carol],
      );
      const first = await pick();
      const second = await pick();
      expect(new Set([first, second])).toEqual(new Set([dave, carol]));
      expect(await pick()).toBe(first); // wraps around
      await c.query("update public.team_members set rr_weight = 0 where user_id = $1", [carol]);
      expect(await pick()).toBe(dave);
      expect(await pick()).toBe(dave);
    });
  });
});
