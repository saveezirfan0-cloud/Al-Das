/**
 * reserve_send_slot(): bulk sends book a future second once instead of polling.
 * Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("send slot reservation", () => {
  let c: Client;
  let alice: string;
  let chanA: string;
  let chanB: string;

  const reserve = async (channel: string, cap: number) =>
    Number(
      (await c.query<{ r: number }>("select public.reserve_send_slot($1, $2) as r", [channel, cap]))
        .rows[0].r,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const org = await createOrg(c, "Org A", "org-a", alice);
    await asServiceRole(c, async () => {
      const ins = async (pn: string) =>
        (
          await c.query<{ id: string }>(
            "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, $2, 'waba', $3) returning id",
            [org, `Chan ${pn}`, pn],
          )
        ).rows[0].id;
      chanA = await ins("pn-a");
      chanB = await ins("pn-b");
    });
    await c.query("set role service_role");
  });
  afterAll(async () => {
    await c.query("reset role");
    await resetDb(c);
    await c.end();
  });

  it("books consecutive seconds, `cap` messages per second, starting at least one second out", async () => {
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(await reserve(chanA, 3));
    expect(delays[0]).toBeGreaterThanOrEqual(1);
    const base = delays[0];
    // 3 per second: [b,b,b,b+1,b+1,b+1,b+2] (allow a one-second tick over the test run)
    const offsets = delays.map((d) => d - base);
    expect(offsets.slice(0, 3).every((o) => o <= 1)).toBe(true);
    expect(offsets[6]).toBeGreaterThanOrEqual(2);
    expect(offsets[6]).toBeLessThanOrEqual(3);
    const { rows } = await c.query<{ used: number }>(
      "select booked as used from public.channel_send_slots where channel_id = $1 and slot > now() order by slot",
      [chanA],
    );
    expect(rows.every((r) => r.used <= 3)).toBe(true);
    expect(rows.reduce((a, r) => a + r.used, 0)).toBe(7);
  });

  it("is O(1) per call for a long backlog: 2,000 reservations at cap 16 span ~125 s and never exceed the cap", async () => {
    let last = 0;
    for (let i = 0; i < 2000; i++) last = await reserve(chanB, 16);
    expect(last).toBeGreaterThanOrEqual(122);
    expect(last).toBeLessThanOrEqual(128);
    const { rows } = await c.query<{ max: number; total: string }>(
      "select max(booked) as max, sum(booked)::text as total from public.channel_send_slots where channel_id = $1",
      [chanB],
    );
    expect(rows[0].max).toBeLessThanOrEqual(16);
    expect(Number(rows[0].total)).toBe(2000);
  });

  it("bookings are a scheduling hint only: they never consume the send-time budget, and claims never move a booking", async () => {
    await c.query("truncate public.channel_send_slots, public.channel_send_cursor");
    const d = await reserve(chanA, 2);
    const target = new Date(Date.now() + d * 1000).toISOString();
    // the booked second still has its full send budget...
    const claims: boolean[] = [];
    for (let i = 0; i < 4; i++)
      claims.push(
        (
          await c.query<{ r: boolean }>(
            "select public.claim_send_slot($1, 2, $2::timestamptz) as r",
            [chanA, target],
          )
        ).rows[0].r,
      );
    expect(claims).toEqual([true, true, false, false]); // the hard cap is enforced at send time
    // ...and the next booking is unaffected by those claims
    const d2 = await reserve(chanA, 2);
    expect(d2).toBeGreaterThanOrEqual(d);
    const { rows } = await c.query<{ used: number; booked: number }>(
      "select used, booked from public.channel_send_slots where channel_id = $1",
      [chanA],
    );
    expect(rows.every((r) => r.used <= 2 && r.booked <= 2)).toBe(true);
  });

  it("keeps channels independent", async () => {
    await c.query("truncate public.channel_send_slots, public.channel_send_cursor");
    for (let i = 0; i < 50; i++) await reserve(chanA, 5);
    expect(await reserve(chanB, 5)).toBeLessThanOrEqual(2);
  });

  it("is parallel-safe: 200 concurrent reservations at cap 10 never overbook a second", async () => {
    await c.query("truncate public.channel_send_slots, public.channel_send_cursor");
    const clients = await Promise.all(Array.from({ length: 10 }, () => connect()));
    try {
      await Promise.all(clients.map((x) => x.query("set role service_role")));
      await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          clients[i % clients.length].query("select public.reserve_send_slot($1, 10)", [chanA]),
        ),
      );
    } finally {
      await Promise.all(clients.map((x) => x.end()));
    }
    const { rows } = await c.query<{ max: number; total: string }>(
      "select max(booked) as max, sum(booked)::text as total from public.channel_send_slots where channel_id = $1",
      [chanA],
    );
    expect(rows[0].max).toBeLessThanOrEqual(10);
    expect(Number(rows[0].total)).toBe(200);
  });

  it("job_next_due reports seconds until the earliest delayed message, ignoring visible and in-flight ones", async () => {
    const clear = async () => {
      await c.query("reset role");
      await c.query("delete from pgmq.q_outbound");
      await c.query("set role service_role");
    };
    await clear();
    const due = async () =>
      (await c.query<{ d: number | null }>("select public.job_next_due('outbound') as d")).rows[0]
        .d;
    expect(await due()).toBeNull();
    await c.query("select public.job_enqueue('outbound', '{\"a\":1}'::jsonb, 0)"); // visible now
    expect(await due()).toBeNull();
    await c.query("select public.job_enqueue('outbound', '{\"a\":2}'::jsonb, 30)");
    await c.query("select public.job_enqueue('outbound', '{\"a\":3}'::jsonb, 7)");
    const d = await due();
    expect(d).toBeGreaterThanOrEqual(6);
    expect(d).toBeLessThanOrEqual(7);
    // a message that was read (in flight, vt in the future, read_ct > 0) is not "delayed"
    await clear();
    await c.query("select public.job_enqueue('outbound', '{\"a\":4}'::jsonb, 0)");
    await c.query("select * from public.job_read('outbound', 60, 1)");
    expect(await due()).toBeNull();
    await expect(c.query("select public.job_next_due('outbound; drop table x')")).rejects.toThrow(
      /invalid queue name/,
    );
    await clear();
  });

  it("is not callable by signed-in users", async () => {
    await c.query("reset role");
    await asUser(c, alice, async () => {
      await expect(c.query("select public.reserve_send_slot($1, 5)", [chanA])).rejects.toThrow(
        /permission denied/,
      );
      await expect(c.query("select public.job_next_due('outbound')")).rejects.toThrow(
        /permission denied/,
      );
    });
    await c.query("set role service_role");
  });
});
