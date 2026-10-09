/**
 * Phase 7 SQL: tenant isolation, batched dispatch, message → recipient status sync,
 * reply tracking, retry re-queue and the funnel. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyRecipient } from "@/lib/campaigns/recipients";

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

describe.skipIf(!TEST_DATABASE_URL)("campaigns SQL", () => {
  let c: Client;
  let alice: string; // admin A
  let carol: string; // agent A (no campaigns.view)
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let channelA: string;
  let channelB: string;
  let templateA: string;
  let templateB: string;
  let campaign: string;
  const contacts: string[] = [];
  const recipients: string[] = [];

  async function one<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T> {
    const { rows } = await c.query<T>(sql, params);
    return rows[0];
  }
  async function insert(sql: string, params: unknown[]): Promise<string> {
    return (await one<{ id: string }>(sql + " returning id", params)).id;
  }
  async function recipient(id: string) {
    return one<{
      status: string;
      skip_reason: string | null;
      message_id: string | null;
      replied_at: string | null;
      sent_at: string | null;
      delivered_at: string | null;
      read_at: string | null;
      error_code: number | null;
      attempts: number;
    }>("select * from public.campaign_recipients where id = $1", [id]);
  }
  async function dispatch(items: unknown[]) {
    return asServiceRole(c, async () => {
      const { rows } = await c.query<{ recipient_id: string; message_id: string }>(
        "select * from public.campaign_dispatch($1, $2::jsonb)",
        [campaign, JSON.stringify(items)],
      );
      return rows;
    });
  }
  const spec = {
    type: "template",
    template_id: "00000000-0000-0000-0000-000000000000",
    values: { "body.1": "Pat" },
  };

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
      channelA = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A', 'waba-a', 'pn-a')",
        [orgA],
      );
      channelB = await insert(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'B', 'waba-b', 'pn-b')",
        [orgB],
      );
      templateA = await insert(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category) values ($1, $2, 'waba-a', 'promo', 'en', 'APPROVED', 'MARKETING')",
        [orgA, channelA],
      );
      templateB = await insert(
        "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status) values ($1, $2, 'waba-b', 'promo', 'en', 'APPROVED')",
        [orgB, channelB],
      );
      for (let i = 1; i <= 4; i++)
        contacts.push(
          await insert(
            "insert into public.contacts (org_id, first_name, phone_e164, promotions_opt_in) values ($1, $2, $3, true)",
            [orgA, `Pat${i}`, `+97150000000${i}`],
          ),
        );
      campaign = await insert(
        "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type, status, retry_rounds) values ($1, 'Spring', $2, $3, 'csv', 'sending', 1)",
        [orgA, channelA, templateA],
      );
      await insert(
        "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'B camp', $2, $3, 'csv')",
        [orgB, channelB, templateB],
      );
      for (const contact of contacts)
        recipients.push(
          await insert(
            "insert into public.campaign_recipients (org_id, campaign_id, contact_id) values ($1, $2, $3)",
            [orgA, campaign, contact],
          ),
        );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("campaigns.view gates reads and orgs are isolated", async () => {
    await asUser(c, alice, async () => {
      expect(await count(c, "select 1 from public.campaigns")).toBe(1);
      expect(await count(c, "select 1 from public.campaign_recipients")).toBe(4);
    });
    await asUser(c, bob, async () => {
      expect(await count(c, "select 1 from public.campaigns")).toBe(1);
      expect(await count(c, "select 1 from public.campaign_recipients")).toBe(0);
    });
    await asUser(c, carol, async () => {
      expect(await count(c, "select 1 from public.campaigns")).toBe(0);
      expect(await count(c, "select 1 from public.campaign_recipients")).toBe(0);
    });
  });

  it("members cannot write campaigns or recipients, nor call the RPCs", async () => {
    await asUser(c, alice, async () => {
      await expect(c.query("update public.campaigns set name = 'x'")).resolves.toMatchObject({
        rowCount: 0,
      });
      await expect(
        c.query(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'x', $2, $3, 'csv')",
          [orgA, channelA, templateA],
        ),
      ).rejects.toThrow();
      await expect(c.query("select public.campaign_funnel($1)", [campaign])).rejects.toThrow();
      await expect(
        c.query("select * from public.campaign_dispatch($1, '[]'::jsonb)", [campaign]),
      ).rejects.toThrow();
    });
  });

  it("rejects a channel or template from another org", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'x', $2, $3, 'csv')",
          [orgA, channelB, templateA],
        ),
      ).rejects.toThrow(/does not belong/);
      await expect(
        c.query(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'x', $2, $3, 'csv')",
          [orgA, channelA, templateB],
        ),
      ).rejects.toThrow(/does not belong/);
    });
  });

  it("dispatch skips, creates hidden conversations and queues one message per recipient", async () => {
    const out = await dispatch([
      { recipient_id: recipients[0], body: "Hi Pat1", spec, vars: { "body.1": "Pat1" } },
      { recipient_id: recipients[1], body: "Hi Pat2", spec, vars: { "body.1": "Pat2" } },
      { recipient_id: recipients[2], skip: "stop_marketing" },
    ]);
    expect(out).toHaveLength(2);
    const r0 = await recipient(recipients[0]);
    expect(r0).toMatchObject({ status: "queued", attempts: 1 });
    expect(r0.message_id).toBe(out.find((o) => o.recipient_id === recipients[0])!.message_id);
    expect(await recipient(recipients[2])).toMatchObject({
      status: "skipped",
      skip_reason: "stop_marketing",
    });

    const conv = await one<{
      status: string;
      campaign_only: boolean;
      last_message_direction: string;
    }>(
      "select c.status, c.campaign_only, c.last_message_direction from public.conversations c join public.messages m on m.conversation_id = c.id where m.id = $1",
      [r0.message_id],
    );
    expect(conv).toMatchObject({
      status: "waiting",
      campaign_only: true,
      last_message_direction: "out",
    });
    const msg = await one<{ status: string; kind: string; payload: { send: { type: string } } }>(
      "select status, kind, payload from public.messages where id = $1",
      [r0.message_id],
    );
    expect(msg).toMatchObject({ status: "queued", kind: "template" });
    expect(msg.payload.send.type).toBe("template");
  });

  it("dispatch is idempotent: a replay touches nothing that is no longer pending", async () => {
    const before = await count(c, "select 1 from public.messages");
    const again = await dispatch([
      { recipient_id: recipients[0], body: "Hi again", spec, vars: {} },
      { recipient_id: recipients[2], body: "late", spec, vars: {} },
    ]);
    expect(again).toHaveLength(0);
    expect(await count(c, "select 1 from public.messages")).toBe(before);
    expect((await recipient(recipients[0])).attempts).toBe(1);
  });

  it("reuses the live conversation of a contact", async () => {
    const existing = await insert(
      "insert into public.conversations (org_id, channel_id, contact_id, status) values ($1, $2, $3, 'open')",
      [orgA, channelA, contacts[3]],
    );
    const out = await dispatch([{ recipient_id: recipients[3], body: "Hi Pat4", spec, vars: {} }]);
    const conv = await one<{ conversation_id: string }>(
      "select conversation_id from public.messages where id = $1",
      [out[0].message_id],
    );
    expect(conv.conversation_id).toBe(existing);
    expect(
      await one("select campaign_only, status from public.conversations where id = $1", [existing]),
    ).toMatchObject({
      campaign_only: false,
      status: "open",
    });
  });

  it("message status moves the recipient forward only", async () => {
    const r = await recipient(recipients[0]);
    const mid = r.message_id!;
    await c.query(
      "update public.messages set status = 'sent', wa_message_id = 'wamid.c0' where id = $1",
      [mid],
    );
    expect(await recipient(recipients[0])).toMatchObject({ status: "sent" });
    await c.query("update public.messages set status = 'read' where id = $1", [mid]);
    const read = await recipient(recipients[0]);
    expect(read).toMatchObject({ status: "read" });
    expect(read.delivered_at).not.toBeNull();
    expect(read.sent_at).not.toBeNull();
    // a late 'delivered' must not regress read (the messages trigger also rejects it)
    await c.query("update public.messages set status = 'delivered' where id = $1", [mid]);
    expect((await recipient(recipients[0])).status).toBe("read");
  });

  it("a failed message fails its recipient with the Meta error code", async () => {
    const r = await recipient(recipients[1]);
    await c.query(
      "update public.messages set status = 'failed', error_code = 130429, error_message = 'rate' where id = $1",
      [r.message_id],
    );
    expect(await recipient(recipients[1])).toMatchObject({ status: "failed", error_code: 130429 });
  });

  it("a reply within 7 days marks the most recent campaign recipient as replied", async () => {
    const r = await recipient(recipients[0]);
    const { conversation_id } = await one<{ conversation_id: string }>(
      "select conversation_id from public.messages where id = $1",
      [r.message_id],
    );
    expect((await recipient(recipients[0])).replied_at).toBeNull();
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, wa_message_id) values ($1, $2, 'in', 'reaction', '👍', 'received', 'wamid.r0')",
      [orgA, conversation_id],
    );
    expect((await recipient(recipients[0])).replied_at).toBeNull(); // reactions are not replies
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, wa_message_id) values ($1, $2, 'in', 'text', 'yes please', 'received', 'wamid.r1')",
      [orgA, conversation_id],
    );
    expect((await recipient(recipients[0])).replied_at).not.toBeNull();
  });

  it("requeues only failed recipients with retryable codes, then dispatch sends a new message", async () => {
    await c.query(
      "update public.campaign_recipients set status = 'failed', error_code = 131026 where id = $1",
      [recipients[3]],
    );
    const n = await asServiceRole(c, async () => {
      const { rows } = await c.query<{ n: number }>(
        "select public.campaign_requeue_failed($1, $2::int[]) as n",
        [campaign, [130429, 131000]],
      );
      return rows[0].n;
    });
    expect(n).toBe(1);
    expect((await recipient(recipients[1])).status).toBe("pending");
    expect((await recipient(recipients[3])).status).toBe("failed"); // non-retryable stays failed

    await c.query("update public.campaigns set retry_round = 1 where id = $1", [campaign]);
    const out = await dispatch([{ recipient_id: recipients[1], body: "Hi Pat2", spec, vars: {} }]);
    expect(out).toHaveLength(1);
    expect(await recipient(recipients[1])).toMatchObject({
      status: "queued",
      attempts: 2,
      error_code: null,
    });
    // the first (failed) message no longer drives the recipient
    const oldMsg = await one<{ id: string }>(
      "select id from public.messages where campaign_recipient_id = $1 and status = 'failed'",
      [recipients[1]],
    );
    await c.query("update public.messages set status = 'failed', error_code = 1 where id = $1", [
      oldMsg.id,
    ]);
    expect((await recipient(recipients[1])).status).toBe("queued");
  });

  it("funnel counts are cumulative and exclude skipped from eligible", async () => {
    const f = await asServiceRole(c, async () => {
      const { rows } = await c.query<{ f: Record<string, number> }>(
        "select public.campaign_funnel($1) as f",
        [campaign],
      );
      return rows[0].f;
    });
    expect(f).toMatchObject({
      total: 4,
      eligible: 3,
      skipped: 1,
      sent: 1,
      delivered: 1,
      read: 1,
      replied: 1,
      failed: 1,
      queued: 1,
    });
  });

  it("deleting a message detaches it from its recipient", async () => {
    const r = await recipient(recipients[1]);
    await c.query("delete from public.messages where id = $1", [r.message_id]);
    expect((await recipient(recipients[1])).message_id).toBeNull();
  });

  it("job_enqueue_batch pushes every payload to the queue", async () => {
    const ids = await asServiceRole(c, async () => {
      const { rows } = await c.query<{ ids: string[] }>(
        "select public.job_enqueue_batch('outbound', array['{\"a\":1}'::jsonb, '{\"a\":2}'::jsonb], 0) as ids",
      );
      return rows[0].ids;
    });
    expect(ids).toHaveLength(2);
    await c.query("delete from pgmq.q_outbound");
  });
  describe("audience snapshots", () => {
    let snapCampaign: string;
    const flags = [
      { name: "ok", phone: "+971511000001", bsuid: null, opt: true, stop: false },
      { name: "no-opt", phone: "+971511000002", bsuid: null, opt: false, stop: false },
      { name: "stopped", phone: "+971511000003", bsuid: null, opt: true, stop: true },
      { name: "bsuid", phone: null, bsuid: "BS1", opt: true, stop: false },
      { name: "nothing", phone: null, bsuid: null, opt: true, stop: false },
    ];

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        for (const f of flags)
          await c.query(
            "insert into public.contacts (org_id, first_name, phone_e164, wa_bsuid, promotions_opt_in, stop_marketing, source) values ($1, $2, $3, $4, $5, $6, 'snap')",
            [orgA, f.name, f.phone, f.bsuid, f.opt, f.stop],
          );
        snapCampaign = await insert(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'Snap', $2, $3, 'segment')",
          [orgA, channelA, templateA],
        );
      });
    });

    async function snapshot(marketing: boolean, dry: boolean) {
      return asServiceRole(c, async () => {
        const { rows } = await c.query<{
          r: { total: number; eligible: number; skipped: Record<string, number> };
        }>("select public.campaign_snapshot_segment($1, $2, $3, '[]'::jsonb, $4, 1000, $5) as r", [
          orgA,
          snapCampaign,
          "c.source = 'snap'",
          marketing,
          dry,
        ]);
        return rows[0].r;
      });
    }

    it("a dry run counts without writing, and SQL agrees with classifyRecipient", async () => {
      const dry = await snapshot(true, true);
      expect(dry).toEqual({
        total: 5,
        eligible: 2,
        skipped: { no_opt_in: 1, stop_marketing: 1, no_destination: 1 },
      });
      expect(
        await count(c, "select 1 from public.campaign_recipients where campaign_id = $1", [
          snapCampaign,
        ]),
      ).toBe(0);

      for (const marketing of [true, false]) {
        const expected: Record<string, number> = {};
        let eligible = 0;
        for (const f of flags) {
          const reason = classifyRecipient(
            {
              phone_e164: f.phone,
              wa_bsuid: f.bsuid,
              promotions_opt_in: f.opt,
              stop_marketing: f.stop,
            },
            { marketing },
          );
          if (reason) expected[reason] = (expected[reason] ?? 0) + 1;
          else eligible++;
        }
        const got = await snapshot(marketing, true);
        expect(got.eligible).toBe(eligible);
        expect(got.skipped).toEqual(expected);
      }
    });

    it("writes pending/skipped recipients once (idempotent)", async () => {
      await snapshot(true, false);
      await snapshot(true, false);
      const rows = await c.query<{ status: string; n: string }>(
        "select status, count(*)::text as n from public.campaign_recipients where campaign_id = $1 group by status",
        [snapCampaign],
      );
      expect(Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]))).toEqual({
        pending: 2,
        skipped: 3,
      });
    });

    it("CSV rows match existing contacts, create new ones only with consent, and keep extra columns", async () => {
      const csvCampaign = await asServiceRole(c, async () =>
        insert(
          "insert into public.campaigns (org_id, name, channel_id, template_id, audience_type) values ($1, 'Csv', $2, $3, 'csv')",
          [orgA, channelA, templateA],
        ),
      );
      const rows = [
        { phone_e164: "+971511000001", first_name: "", last_name: "", data: { visit: "Mon" } }, // existing, opted in
        { phone_e164: "+971511000002", first_name: "", last_name: "", data: {} }, // existing, no opt-in
        {
          phone_e164: "+971599999999",
          first_name: "New",
          last_name: "One",
          data: { visit: "Tue" },
        }, // unknown
      ];
      const call = (confirmed: boolean, dry: boolean) =>
        asServiceRole(c, async () => {
          const { rows: out } = await c.query<{
            r: {
              total: number;
              eligible: number;
              created: number;
              skipped: Record<string, number>;
            };
          }>("select public.campaign_add_csv_rows($1, $2, $3::jsonb, true, $4, $5, $6) as r", [
            orgA,
            csvCampaign,
            JSON.stringify(rows),
            confirmed,
            alice,
            dry,
          ]);
          return out[0].r;
        });

      expect(await call(false, true)).toEqual({
        total: 3,
        eligible: 1,
        created: 0,
        skipped: { no_opt_in: 2 },
      });
      expect(await call(true, true)).toEqual({
        total: 3,
        eligible: 2,
        created: 1,
        skipped: { no_opt_in: 1 },
      });
      expect(
        await count(c, "select 1 from public.contacts where phone_e164 = '+971599999999'"),
      ).toBe(0);

      await call(true, false);
      const created = await one<{ promotions_opt_in: boolean; source: string; created_by: string }>(
        "select promotions_opt_in, source, created_by from public.contacts where phone_e164 = '+971599999999'",
      );
      expect(created).toMatchObject({
        promotions_opt_in: true,
        source: "campaign_csv",
        created_by: alice,
      });
      const stored = await c.query<{ status: string; csv_data: { visit?: string } }>(
        "select r.status, r.csv_data from public.campaign_recipients r join public.contacts k on k.id = r.contact_id where r.campaign_id = $1 and k.phone_e164 = '+971511000001'",
        [csvCampaign],
      );
      expect(stored.rows[0]).toMatchObject({ status: "pending", csv_data: { visit: "Mon" } });
      expect(
        await count(c, "select 1 from public.campaign_recipients where campaign_id = $1", [
          csvCampaign,
        ]),
      ).toBe(3);
      await call(true, false); // replay: no duplicates, no second contact
      expect(
        await count(c, "select 1 from public.campaign_recipients where campaign_id = $1", [
          csvCampaign,
        ]),
      ).toBe(3);
      expect(
        await count(c, "select 1 from public.contacts where phone_e164 = '+971599999999'"),
      ).toBe(1);
    });
  });
});
