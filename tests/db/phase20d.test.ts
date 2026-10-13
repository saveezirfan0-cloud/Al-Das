/**
 * Phase 20d against real Postgres: RLS on the new tables, recurring-campaign runs (claimed once, audience re-read per
 * run, no double send within a run), the monthly budget hard stop (including concurrent claims), the template
 * performance numbers, the one-retry-per-message index and media usage for carousel cards and recurring campaigns.
 * Synthetic data only (+44 7700 900xxx, "Demo" names).
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
  seedPhase20dRows,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Phase 20d (db)", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let carol: string;
  let orgA: string;
  let orgB: string;
  let seeded: Record<string, string>;
  let n = 0;

  async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const { rows } = await c.query<T>(sql, params);
    return rows;
  }
  const id = async (sql: string, params: unknown[] = []) =>
    (await q<{ id: string }>(sql + " returning id::text as id", params))[0]!.id;
  const phone = () => `+447700900${String(500 + ++n).padStart(3, "0")}`;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-20d@example.test");
    bob = await createAuthUser(c, "bob-20d@example.test");
    carol = await createAuthUser(c, "carol-20d@example.test");
    orgA = await createOrg(c, "Org 20d A", "org-20d-a", alice);
    orgB = await createOrg(c, "Org 20d B", "org-20d-b", bob);
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
    seeded = await seedPhase20dRows(c, orgA, "a");
    await seedPhase20dRows(c, orgB, "b");
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("RLS", () => {
    it("lets campaigns.view read its own org's recurring campaigns and budget, nobody else", async () => {
      for (const t of ["campaign_recurrences", "campaign_budget_months"]) {
        const seen = (who: string) =>
          asUser(c, who, async () =>
            Number(
              (
                await q<{ n: string }>(
                  `select count(*)::text as n from public.${t} where org_id = $1`,
                  [orgA],
                )
              )[0]!.n,
            ),
          );
        expect(await seen(alice), t).toBeGreaterThan(0);
        expect(await seen(bob), t).toBe(0);
        expect(await seen(carol), t).toBe(0); // Agent role: no campaigns.view
      }
    });

    it("has no write policy: even an admin cannot write directly", async () => {
      await asUser(c, alice, async () => {
        await expect(
          c.query(
            "insert into public.campaign_budget_months (org_id, month, used) values ($1, '2030-01-01', 0)",
            [orgA],
          ),
        ).rejects.toThrow();
        const r = await c.query(
          "update public.campaign_recurrences set status = 'paused' where org_id = $1",
          [orgA],
        );
        expect(r.rowCount).toBe(0);
      });
    });

    it("keeps the claim, budget and report functions away from browser roles", async () => {
      await asUser(c, alice, async () => {
        await expect(c.query("select public.campaign_budget_claim($1, 1)", [orgA])).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          c.query(
            "select * from public.report_template_performance($1, current_date, current_date)",
            [orgA],
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          c.query("select public.campaign_recurrence_claim($1, now(), now() + interval '1 day')", [
            seeded.recurrence,
          ]),
        ).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe("recurring campaigns", () => {
    let rec: string;
    const T1 = "2026-11-02T06:00:00Z";
    const T2 = "2026-11-09T06:00:00Z";
    const T3 = "2026-11-16T06:00:00Z";
    const claim = (runAt: string, next: string, skip: string | null = null) =>
      asServiceRole(
        c,
        async () =>
          (
            await q<{ id: string | null }>(
              "select public.campaign_recurrence_claim($1, $2::timestamptz, $3::timestamptz, $4) as id",
              [rec, runAt, next, skip],
            )
          )[0]!.id,
      );
    const snapshot = (campaign: string) =>
      asServiceRole(
        c,
        async () =>
          (
            await q<{ r: { total: number; eligible: number; skipped: Record<string, number> } }>(
              "select public.campaign_snapshot_segment($1, $2, 'c.last_name = ($1->>0)', '[\"Drift20d\"]'::jsonb, true, 1000, false) as r",
              [orgA, campaign],
            )
          )[0]!.r,
      );
    const recipients = (campaign: string) =>
      q<{ status: string; n: string }>(
        "select status, count(*)::text as n from public.campaign_recipients where campaign_id = $1 group by status order by status",
        [campaign],
      );

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        await c.query("update public.wa_templates set category = 'MARKETING' where id = $1", [
          seeded.template,
        ]);
        for (const first of ["Layla Demo-01", "Omar Demo-02"])
          await c.query(
            "insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in) values ($1, $2, 'Drift20d', $3, true)",
            [orgA, first, phone()],
          );
        rec = await id(
          `insert into public.campaign_recurrences (org_id, name, channel_id, template_id, segment_id, cron, timezone, next_run_at, variable_map, retry_rounds, created_by)
           values ($1, 'Monthly offers', $2, $3, $4, '0 10 * * 1', 'Asia/Dubai', $5, '{"body.1":"contact.first_name"}', 2, $6)`,
          [orgA, seeded.channel, seeded.template, seeded.segment, T1, alice],
        );
      });
    });

    it("creates exactly one ordinary campaign per run, however often the run is claimed", async () => {
      const c1 = await claim(T1, T2);
      expect(c1).toBeTruthy();
      expect(await claim(T1, T2)).toBeNull(); // replayed job / tick safety net
      const rows = await q<{
        status: string;
        audience_type: string;
        retry_rounds: number;
        run_key: string;
        variable_map: unknown;
        segment_id: string;
      }>(
        "select status, audience_type, retry_rounds, run_key, variable_map, segment_id::text from public.campaigns where recurrence_id = $1",
        [rec],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "preparing",
        audience_type: "segment",
        retry_rounds: 2,
        run_key: "2026-11-02T06:00Z",
        variable_map: { "body.1": "contact.first_name" },
        segment_id: seeded.segment,
      });
      const [r] = await q<{
        next_run_at: Date;
        runs: number;
        last_run_outcome: string;
        last_campaign_id: string;
      }>(
        "select next_run_at, runs, last_run_outcome, last_campaign_id::text from public.campaign_recurrences where id = $1",
        [rec],
      );
      expect(r!.next_run_at.toISOString()).toBe(new Date(T2).toISOString());
      expect(r).toMatchObject({ runs: 1, last_run_outcome: "created", last_campaign_id: c1 });
    });

    it("re-reads the audience on every run and never adds a person twice within a run", async () => {
      const c1 = (
        await q<{ id: string }>(
          "select id::text from public.campaigns where recurrence_id = $1 and run_key = '2026-11-02T06:00Z'",
          [rec],
        )
      )[0]!.id;
      expect((await snapshot(c1)).eligible).toBe(2);
      await snapshot(c1); // a retried snapshot of the same run
      expect(await recipients(c1)).toEqual([{ status: "pending", n: "2" }]);

      // Between runs the segment changes: one more patient, and one opts out of marketing.
      await asServiceRole(c, async () => {
        await c.query(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in) values ($1, 'Sara Demo-03', 'Drift20d', $2, true)",
          [orgA, phone()],
        );
        await c.query(
          "update public.contacts set stop_marketing = true where org_id = $1 and first_name = 'Omar Demo-02'",
          [orgA],
        );
      });
      const c2 = await claim(T2, T3);
      expect(c2).toBeTruthy();
      expect(c2).not.toBe(c1);
      const counts = await snapshot(c2!);
      expect(counts).toMatchObject({ total: 3, eligible: 2, skipped: { stop_marketing: 1 } });
      expect(await recipients(c2!)).toEqual([
        { status: "pending", n: "2" },
        { status: "skipped", n: "1" },
      ]);
      // The first run's audience is untouched by the second.
      expect(await recipients(c1)).toEqual([{ status: "pending", n: "2" }]);
    });

    it("ignores a stale run time and a paused series", async () => {
      expect(await claim(T1, T2)).toBeNull();
      await asServiceRole(c, () =>
        c.query("update public.campaign_recurrences set status = 'paused' where id = $1", [rec]),
      );
      expect(await claim(T3, "2026-11-23T06:00:00Z")).toBeNull();
      const [r] = await q<{ next_run_at: Date }>(
        "select next_run_at from public.campaign_recurrences where id = $1",
        [rec],
      );
      expect(r!.next_run_at.toISOString()).toBe(new Date(T3).toISOString());
    });

    it("records a skipped run, moves on to the next one and creates nothing", async () => {
      await asServiceRole(c, () =>
        c.query("update public.campaign_recurrences set status = 'active' where id = $1", [rec]),
      );
      const before = (
        await q<{ n: string }>(
          "select count(*)::text as n from public.campaigns where recurrence_id = $1",
          [rec],
        )
      )[0]!.n;
      expect(await claim(T3, "2026-11-23T06:00:00Z", "budget_reached")).toBeNull();
      const [r] = await q<{ next_run_at: Date; last_run_outcome: string }>(
        "select next_run_at, last_run_outcome from public.campaign_recurrences where id = $1",
        [rec],
      );
      expect(r!.last_run_outcome).toBe("skipped:budget_reached");
      expect(r!.next_run_at.toISOString()).toBe("2026-11-23T06:00:00.000Z");
      expect(
        (
          await q<{ n: string }>(
            "select count(*)::text as n from public.campaigns where recurrence_id = $1",
            [rec],
          )
        )[0]!.n,
      ).toBe(before);
    });

    it("refuses a next run that is not after this run", async () => {
      await expect(claim("2026-11-23T06:00:00Z", "2026-11-23T06:00:00Z")).rejects.toThrow(
        /next run must be after/,
      );
    });

    it("keeps the run's campaigns when the series is deleted", async () => {
      await asServiceRole(c, () =>
        c.query("delete from public.campaign_recurrences where id = $1", [rec]),
      );
      const rows = await q<{ n: string }>(
        "select count(*)::text as n from public.campaigns where run_key like '2026-11-%'",
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });
  });

  describe("monthly budget hard stop", () => {
    const setLimit = (org: string, limit: unknown) =>
      asServiceRole(c, () =>
        c.query(
          "update public.orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{campaign_budget}', $2::jsonb) where id = $1",
          [org, JSON.stringify({ monthly_limit: limit })],
        ),
      );
    const claimN = (org: string, k: number, client: Client = c) =>
      client
        .query<{ g: number }>("select public.campaign_budget_claim($1, $2) as g", [org, k])
        .then((r) => Number(r.rows[0]!.g));
    const status = (org: string) =>
      q<{ used: number; monthly_limit: number | null }>(
        "select used, monthly_limit from public.campaign_budget_status($1)",
        [org],
      ).then((r) => r[0]!);

    beforeAll(async () => {
      await asServiceRole(c, () => c.query("delete from public.campaign_budget_months"));
    });

    it("grants up to the limit, then nothing, and gives back unused room", async () => {
      await setLimit(orgA, 5);
      await asServiceRole(c, async () => {
        expect(await claimN(orgA, 3)).toBe(3);
        expect(await claimN(orgA, 3)).toBe(2);
        expect(await claimN(orgA, 1)).toBe(0);
        expect(await status(orgA)).toEqual({ used: 5, monthly_limit: 5 });
        await c.query("select public.campaign_budget_refund($1, 2)", [orgA]);
        expect(await claimN(orgA, 4)).toBe(2);
        await c.query("select public.campaign_budget_refund($1, 99)", [orgA]);
        expect((await status(orgA)).used).toBe(0);
      });
    });

    it("counts without stopping when no limit is set, and fails closed on a corrupt limit or unknown org", async () => {
      await setLimit(orgB, null);
      await asServiceRole(c, async () => {
        expect(await claimN(orgB, 1000)).toBe(1000);
        expect(await status(orgB)).toEqual({ used: 1000, monthly_limit: null });
      });
      await setLimit(orgB, "lots");
      await asServiceRole(c, async () => {
        expect(await claimN(orgB, 1)).toBe(0);
        expect(await claimN("99999999-9999-4999-8999-999999999999", 1)).toBe(0);
      });
    });

    it("never lets concurrent fanouts pass the limit together", async () => {
      await setLimit(orgA, 10);
      await asServiceRole(c, () =>
        c.query("delete from public.campaign_budget_months where org_id = $1", [orgA]),
      );
      const clients = await Promise.all([1, 2, 3, 4].map(() => connect()));
      try {
        for (const k of clients) await k.query("set role service_role");
        // Four connections racing, five one-message claims each (20 asked, 10 allowed).
        const granted = await Promise.all(
          clients.map(async (k) => {
            let got = 0;
            for (let i = 0; i < 5; i++) got += await claimN(orgA, 1, k);
            return got;
          }),
        );
        expect(granted.reduce((a, b) => a + b, 0)).toBe(10);
      } finally {
        await Promise.all(clients.map((k) => k.end()));
      }
      await asServiceRole(c, async () => expect((await status(orgA)).used).toBe(10));
    });
  });

  describe("template performance", () => {
    let t1: string;
    let t2: string;
    let ch2: string;
    let conv1: string;
    let conv2: string;
    const out = (
      conv: string,
      tpl: string,
      status: string,
      at: string,
      extra: Record<string, unknown> = {},
    ) =>
      id(
        `insert into public.messages (org_id, conversation_id, direction, kind, payload, status, at, wa_message_id, error_code, retry_of_message_id)
         values ($1, $2, 'out', 'template', jsonb_build_object('send', jsonb_build_object('type', 'template', 'template_id', $3::text, 'values', '{}'::jsonb)), $4, $5, $6, $7, $8)`,
        [orgA, conv, tpl, status, at, extra.wa ?? null, extra.code ?? null, extra.retryOf ?? null],
      );
    const inbound = (conv: string, kind: string, at: string, replyTo: string | null = null) =>
      c.query(
        "insert into public.messages (org_id, conversation_id, direction, kind, status, at, reply_to_wa_message_id) values ($1, $2, 'in', $3, 'received', $4, $5)",
        [orgA, conv, kind, at, replyTo],
      );
    const report = (args: {
      channels?: string[] | null;
      template?: string | null;
      from?: string;
      to?: string;
      org?: string;
    }) =>
      asServiceRole(c, () =>
        q<Record<string, unknown>>(
          "select * from public.report_template_performance($1, $2::date, $3::date, $4::uuid[], $5::uuid)",
          [
            args.org ?? orgA,
            args.from ?? "2026-10-01",
            args.to ?? "2026-10-31",
            args.channels ?? null,
            args.template ?? null,
          ],
        ),
      );

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        t1 = await id(
          "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category) values ($1, $2, 'waba-20d-a', 'reminder_20d', 'en', 'APPROVED', 'UTILITY')",
          [orgA, seeded.channel],
        );
        t2 = await id(
          "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category) values ($1, $2, 'waba-20d-a', 'promo_20d', 'ar', 'APPROVED', 'MARKETING')",
          [orgA, seeded.channel],
        );
        ch2 = await id(
          "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Second', 'waba-20d-a', 'pn-20d-a2')",
          [orgA],
        );
        const k1 = await id(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-07', $2)",
          [orgA, phone()],
        );
        const k2 = await id(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Omar Demo-08', $2)",
          [orgA, phone()],
        );
        conv1 = await id(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [orgA, seeded.channel, k1],
        );
        conv2 = await id(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
          [orgA, ch2, k2],
        );

        // Org timezone is the create_org default; days below are well inside October either way.
        await out(conv1, t1, "read", "2026-10-10T08:00:00Z", { wa: "wamid.20d.1" });
        await inbound(conv1, "text", "2026-10-10T08:30:00Z"); // replied within 24 h
        await inbound(conv1, "button", "2026-10-10T08:31:00Z", "wamid.20d.1"); // quick-reply tap
        await out(conv2, t1, "delivered", "2026-10-11T08:00:00Z", { wa: "wamid.20d.2" });
        await inbound(conv2, "text", "2026-10-12T09:00:01Z"); // 25 h later: not a reply
        const failed = await out(conv1, t1, "failed", "2026-10-15T08:00:00Z", { code: 131000 });
        await out(conv1, t1, "sent", "2026-10-15T08:10:00Z", {
          wa: "wamid.20d.4",
          retryOf: failed,
        });
        await out(conv1, t1, "queued", "2026-10-20T08:00:00Z");
        await out(conv1, t2, "sent", "2026-10-21T08:00:00Z", { wa: "wamid.20d.6" });
        await out(conv1, t1, "read", "2026-08-01T08:00:00Z", { wa: "wamid.20d.7" }); // outside the range
      });
    });

    it("counts sent, delivered, read, replied, clicked, failed, pending and retries per template", async () => {
      const rows = await report({});
      const r1 = rows.find((r) => r.template_id === t1)!;
      expect(r1).toMatchObject({
        name: "reminder_20d",
        messages: 5,
        sent: 3,
        delivered: 2,
        read_count: 1,
        replied: 1,
        clicked: 1,
        failed: 1,
        pending: 1,
        retries: 1,
        from_campaigns: 0,
      });
      const r2 = rows.find((r) => r.template_id === t2)!;
      expect(r2).toMatchObject({ messages: 1, sent: 1, read_count: 0, replied: 0 });
      expect(rows[0]!.template_id).toBe(t1); // busiest first
    });

    it("filters by number, template and date range, and never crosses orgs", async () => {
      expect(await report({ channels: [ch2] })).toEqual([
        expect.objectContaining({ template_id: t1, messages: 1, delivered: 1, replied: 0 }),
      ]);
      expect((await report({ template: t2 })).map((r) => r.template_id)).toEqual([t2]);
      expect((await report({ from: "2026-08-01", to: "2026-08-01" }))[0]).toMatchObject({
        template_id: t1,
        messages: 1,
        read_count: 1,
      });
      expect(await report({ org: orgB })).toEqual([]);
    });

    it("allows one retry per failed message", async () => {
      const failed = (
        await q<{ id: string }>(
          "select id::text from public.messages where error_code = 131000 and org_id = $1",
          [orgA],
        )
      )[0]!.id;
      await asServiceRole(c, async () => {
        await expect(
          out(conv1, t1, "queued", "2026-10-15T09:10:00Z", { retryOf: failed }),
        ).rejects.toThrow(/messages_retry_of_uidx/);
      });
    });
  });

  describe("media usage (carousel cards, recurring campaigns)", () => {
    it("blocks deleting a library file used by a card header or an active recurring campaign", async () => {
      const assetA = (await q<{ id: string }>("select gen_random_uuid()::text as id"))[0]!.id;
      const assetB = (await q<{ id: string }>("select gen_random_uuid()::text as id"))[0]!.id;
      await asServiceRole(c, async () => {
        for (const a of [assetA, assetB])
          await c.query(
            "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status) values ($2::uuid, $1::uuid, 'Card image', 'image', 'image/jpeg', 1000, $1::uuid::text || '/' || $2::uuid::text || '/original.jpg', 'ready')",
            [orgA, a],
          );
        await c.query("update public.wa_templates set variable_map = $2 where id = $1", [
          seeded.template,
          JSON.stringify({ "card.1.header.media": `media:${assetA}` }),
        ]);
        const rec = await id(
          `insert into public.campaign_recurrences (org_id, name, channel_id, template_id, segment_id, cron, timezone, next_run_at, variable_map)
           values ($1, 'Card promo', $2, $3, $4, '0 10 * * 1', 'Asia/Dubai', now() + interval '1 day', $5)`,
          [
            orgA,
            seeded.channel,
            seeded.template,
            seeded.segment,
            JSON.stringify({ "card.0.header.media": `media:${assetB}` }),
          ],
        );
        const usageA = await q<{ kind: string; blocking: boolean }>(
          "select kind, blocking from public.media_asset_usage($1, $2)",
          [orgA, assetA],
        );
        expect(usageA).toEqual([{ kind: "template", blocking: true }]);
        const usageB = await q<{ kind: string; ref_name: string; blocking: boolean }>(
          "select kind, ref_name, blocking from public.media_asset_usage($1, $2)",
          [orgA, assetB],
        );
        expect(usageB).toEqual([
          { kind: "campaign", ref_name: "Recurring: Card promo", blocking: true },
        ]);
        await expect(
          c.query("delete from public.media_assets where id = $1", [assetB]),
        ).rejects.toThrow(/used by a live/);
        await c.query("update public.campaign_recurrences set status = 'paused' where id = $1", [
          rec,
        ]);
        await c.query("delete from public.media_assets where id = $1", [assetB]);
      });
    });
  });
});
