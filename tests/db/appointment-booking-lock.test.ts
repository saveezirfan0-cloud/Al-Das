/**
 * book_appointment / move_appointment (20261012000100): the slot is re-checked under a per-specialist
 * advisory lock, so concurrent bookings cannot double-book. Two real connections race for one slot.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, asUser, connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("appointment booking lock", () => {
  let c: Client;
  let c2: Client;
  let alice: string;
  let orgA: string;
  let orgB: string;
  let location: string;
  let specialist: string;
  let service: string;
  let contact: string;

  const start = (h: number, m = 0) => `2026-06-15T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const book = (client: Client, org: string, startsAt: string, endsAt: string, enforce = true, spec = specialist) =>
    client.query(
      "select (public.book_appointment($1, $2, $3, $4, $5, null, $6, $7, 'awaiting', null, false, 'portal', null, $8)).id as id",
      [org, contact, location, spec, service, startsAt, endsAt, enforce],
    );

  beforeAll(async () => {
    c = await connect();
    c2 = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const one = async (sql: string, p: unknown[]) => (await c.query(sql, p)).rows[0].id as string;
      location = await one("insert into public.locations (org_id, name) values ($1, 'Main') returning id", [orgA]);
      specialist = await one("insert into public.specialists (org_id, name) values ($1, 'Dr Test') returning id", [orgA]);
      service = await one("insert into public.services (org_id, name) values ($1, 'Consult') returning id", [orgA]);
      contact = await one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Test', '+971500000201') returning id", [orgA]);
    });
  });

  afterAll(async () => {
    await c.end();
    await c2.end();
  });

  it("lets exactly one of two simultaneous bookings for the same slot succeed", async () => {
    await asServiceRole(c, async () => {
      // second connection acts as service role too (session-level role, no transaction)
      await c2.query("set role service_role");
      const results = await Promise.allSettled([
        book(c, orgA, start(9), start(9, 30)),
        book(c2, orgA, start(9), start(9, 30)),
      ]);
      await c2.query("reset role");
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(String(failed[0].reason.message)).toBe("slot_taken");
      const n = (await c.query("select count(*)::int as n from public.appointments where specialist_id = $1 and starts_at = $2", [specialist, start(9)])).rows[0].n;
      expect(n).toBe(1);
    });
  });

  it("rejects overlaps (partial too) and time blocks, but allows back-to-back, cancelled slots and the staff override", async () => {
    await asServiceRole(c, async () => {
      await expect(book(c, orgA, start(9, 15), start(9, 45))).rejects.toThrow(/slot_taken/); // overlaps the 9:00 booking
      await book(c, orgA, start(9, 30), start(10)); // adjacent is fine
      await c.query("insert into public.time_blocks (org_id, specialist_id, starts_at, ends_at) values ($1, $2, $3, $4)", [orgA, specialist, start(12), start(13)]);
      await expect(book(c, orgA, start(12, 30), start(13))).rejects.toThrow(/slot_taken/);
      await book(c, orgA, start(12, 30), start(13), false); // override
      await c.query("update public.appointments set status = 'cancelled' where specialist_id = $1 and starts_at = $2", [specialist, start(9)]);
      await book(c, orgA, start(9), start(9, 30)); // cancelled one no longer blocks
    });
  });

  it("move_appointment re-checks under the lock and ignores the appointment's own old time", async () => {
    await asServiceRole(c, async () => {
      const id = (await book(c, orgA, start(15), start(15, 30))).rows[0].id;
      const move = (to: string, end: string) =>
        c.query("select (public.move_appointment($1, $2, $3, $4, $5, $6, 'awaiting', true)).id as id", [orgA, id, location, specialist, to, end]);
      await expect(move(start(9, 30), start(10))).rejects.toThrow(/slot_taken/); // occupied by another booking
      await move(start(15, 10), start(15, 40)); // overlaps only itself
      expect((await c.query("select starts_at from public.appointments where id = $1", [id])).rows[0].starts_at.toISOString()).toBe("2026-06-15T15:10:00.000Z");
    });
  });

  it("is per specialist and org-pinned, and unavailable to signed-in users", async () => {
    await asServiceRole(c, async () => {
      const other = (await c.query("insert into public.specialists (org_id, name) values ($1, 'Dr Two') returning id", [orgA])).rows[0].id;
      await book(c, orgA, start(9, 30), start(10), true, other); // same time as Dr Test's booking, different person
      // another org's id can never move this org's appointment
      const id = (await c.query("select id from public.appointments where specialist_id = $1 limit 1", [specialist])).rows[0].id;
      await expect(
        c.query("select public.move_appointment($1, $2, $3, $4, $5, $6, 'awaiting', false)", [orgB, id, location, specialist, start(16), start(16, 30)]),
      ).rejects.toThrow(/appointment_not_found/);
    });
    await asUser(c, alice, async () => {
      await expect(book(c, orgA, start(17), start(17, 30))).rejects.toThrow(/permission denied/);
    });
  });
});
