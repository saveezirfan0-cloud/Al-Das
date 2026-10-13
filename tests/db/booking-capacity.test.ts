/**
 * Phase 20c (G6) booking capacity in SQL (20261026000100_booking_capacity.sql): book_appointment,
 * move_appointment and accept_slot_offer re-check buffers, weekly blocks and places under the per-specialist
 * advisory lock; defaults behave exactly as before; Unite rows written the way the sync writes them are never
 * refused, only flagged by appointment_capacity_conflicts; the SQL rule matches the pure TypeScript one.
 * Synthetic data only; Asia/Dubai (UTC+4, no DST).
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expandRecurringBlocks, slotFits, type BusyInterval } from "@/lib/appointments/slots";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

/** Dubai wall clock → ISO instant. */
const local = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+04:00`).toISOString();
const MON = "2026-06-15";
const TUE = "2026-06-16";
const WED = "2026-06-17";
const THU = "2026-06-18";
const FRI = "2026-06-19";

describe.skipIf(!TEST_DATABASE_URL)("booking capacity (SQL)", () => {
  let c: Client;
  let c2: Client;
  let alice: string;
  let carol: string;
  let orgA: string;
  let orgB: string;
  let bob: string;
  const id: Record<string, string> = {};

  type BookOpts = {
    spec?: string;
    service?: string;
    location?: string;
    enforce?: boolean;
    client?: Client;
    contact?: string;
  };
  const book = (date: string, from: string, to: string, o: BookOpts = {}) => {
    // "24:00" = the next local midnight
    const ends =
      to === "24:00"
        ? new Date(new Date(local(date, "00:00")).getTime() + 86_400_000).toISOString()
        : local(date, to);
    return (o.client ?? c).query<{ id: string }>(
      "select (public.book_appointment($1, $2, $3, $4, $5, null, $6, $7, 'awaiting', null, false, 'portal', null, $8)).id as id",
      [
        orgA,
        o.contact ?? id.contact,
        o.location ?? id.loc1,
        o.spec ?? id.spec1,
        o.service ?? id.consult,
        local(date, from),
        ends,
        o.enforce ?? true,
      ],
    );
  };
  const svc = async <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  beforeAll(async () => {
    c = await connect();
    c2 = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      const one = async (sql: string, p: unknown[]) =>
        (await c.query(sql + " returning id", p)).rows[0].id as string;
      const agent = (
        await c.query("select id from public.roles where org_id = $1 and name = 'Agent'", [orgA])
      ).rows[0].id;
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [orgA, carol, agent],
      );
      id.loc1 = await one("insert into public.locations (org_id, name) values ($1, 'Main')", [
        orgA,
      ]);
      id.loc2 = await one("insert into public.locations (org_id, name) values ($1, 'Branch')", [
        orgA,
      ]);
      id.spec1 = await one("insert into public.specialists (org_id, name) values ($1, 'Dr One')", [
        orgA,
      ]);
      id.spec2 = await one(
        "insert into public.specialists (org_id, name, max_per_slot) values ($1, 'Dr Group', 3)",
        [orgA],
      );
      id.consult = await one("insert into public.services (org_id, name) values ($1, 'Consult')", [
        orgA,
      ]);
      id.buffered = await one(
        "insert into public.services (org_id, name, buffer_after_min) values ($1, 'Procedure', 15)",
        [orgA],
      );
      id.prepped = await one(
        "insert into public.services (org_id, name, buffer_before_min) values ($1, 'Scan', 10)",
        [orgA],
      );
      id.group = await one(
        "insert into public.services (org_id, name, capacity) values ($1, 'Group class', 3)",
        [orgA],
      );
      id.contact = await one(
        "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-61', '+447700900601')",
        [orgA],
      );
      for (const n of [2, 3, 4])
        id[`contact${n}`] = await one(
          "insert into public.contacts (org_id, first_name, phone_e164) values ($1, $2, $3)",
          [orgA, `Layla Demo-6${n}`, `+44770090060${n}`],
        );
      // Monday lunch at Main only; Monday 15:00–15:30 admin time everywhere.
      await c.query(
        "insert into public.specialist_recurring_blocks (org_id, specialist_id, location_id, weekday, start_min, end_min, reason) values ($1, $2, $3, 1, 780, 840, 'Lunch')",
        [orgA, id.spec1, id.loc1],
      );
      await c.query(
        "insert into public.specialist_recurring_blocks (org_id, specialist_id, location_id, weekday, start_min, end_min) values ($1, $2, null, 1, 900, 930)",
        [orgA, id.spec1],
      );
    });
  });

  afterAll(async () => {
    await c.end();
    await c2.end();
  });

  it("keeps today's behaviour with every default: any overlap is slot_taken, back-to-back is fine", async () => {
    await svc(async () => {
      await book(MON, "09:00", "09:30");
      await expect(book(MON, "09:15", "09:45")).rejects.toThrow(/slot_taken/);
      await expect(book(MON, "08:45", "09:15")).rejects.toThrow(/slot_taken/);
      await book(MON, "09:30", "10:00");
      await book(MON, "08:30", "09:00");
      // the old 6-argument check still exists and agrees
      await c.query("reset role");
      await expect(
        c.query("select app.assert_slot_free($1, $2, $3, $4, $5, null)", [
          orgA,
          id.spec1,
          id.loc1,
          local(MON, "09:10"),
          local(MON, "09:20"),
        ]),
      ).rejects.toThrow(/slot_taken/);
      await c.query("set role service_role");
    });
  });

  it("lets exactly one of two simultaneous bookings take the last place", async () => {
    await svc(async () => {
      await book(TUE, "11:00", "11:30", { spec: id.spec2, service: id.group });
      await book(TUE, "11:00", "11:30", {
        spec: id.spec2,
        service: id.group,
        contact: id.contact2,
      });
      await c2.query("set role service_role");
      const results = await Promise.allSettled([
        book(TUE, "11:00", "11:30", { spec: id.spec2, service: id.group, contact: id.contact3 }),
        book(TUE, "11:00", "11:30", {
          spec: id.spec2,
          service: id.group,
          contact: id.contact4,
          client: c2,
        }),
      ]);
      await c2.query("reset role");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failed).toHaveLength(1);
      expect(String(failed[0].reason.message)).toBe("slot_taken");
      const n = (
        await c.query(
          "select count(*)::int as n from public.appointments where specialist_id = $1 and starts_at = $2",
          [id.spec2, local(TUE, "11:00")],
        )
      ).rows[0].n;
      expect(n).toBe(3);
      await expect(
        book(TUE, "11:00", "11:30", { spec: id.spec2, service: id.group }),
      ).rejects.toThrow(/slot_taken/);
      // a one-patient service never joins a group slot, and the group never joins a consultation
      await expect(
        book(TUE, "11:15", "11:45", { spec: id.spec2, service: id.consult }),
      ).rejects.toThrow(/slot_taken/);
      await book(TUE, "13:00", "13:30", { spec: id.spec2, service: id.consult });
      await expect(
        book(TUE, "13:00", "13:30", { spec: id.spec2, service: id.group }),
      ).rejects.toThrow(/slot_taken/);
    });
  });

  it("limits a group service by the specialist's bookings per slot", async () => {
    await svc(async () => {
      await book(TUE, "15:00", "15:30", { service: id.group }); // Dr One: max_per_slot 1
      await expect(book(TUE, "15:00", "15:30", { service: id.group })).rejects.toThrow(
        /slot_taken/,
      );
    });
  });

  it("enforces buffers at the exact edges, before and after, also across midnight", async () => {
    await svc(async () => {
      await book(WED, "10:00", "10:30", { service: id.buffered }); // busy until 10:45
      await expect(book(WED, "10:30", "11:00")).rejects.toThrow(/slot_taken/);
      await expect(book(WED, "10:44", "11:14")).rejects.toThrow(/slot_taken/);
      await book(WED, "10:45", "11:15");
      await expect(book(WED, "09:20", "09:50", { service: id.buffered })).rejects.toThrow(
        /slot_taken/,
      ); // cleans until 10:05
      await book(WED, "09:15", "09:45", { service: id.buffered }); // its cleaning ends exactly at 10:00
      // A scan prepares 10 minutes before: 11:20 would prepare from 11:10 (inside the 10:45 consult); 11:25 from 11:15, fine.
      await expect(book(WED, "11:20", "11:50", { service: id.prepped })).rejects.toThrow(
        /slot_taken/,
      );
      await book(WED, "11:25", "11:55", { service: id.prepped });
      // Across midnight: a 23:30 procedure cleans until 00:15 the next day.
      await book(WED, "23:30", "24:00", { service: id.buffered });
      await expect(book(THU, "00:00", "00:30")).rejects.toThrow(/slot_taken/);
      await expect(book(THU, "00:14", "00:44")).rejects.toThrow(/slot_taken/);
      await book(THU, "00:15", "00:45");
    });
  });

  it("refuses weekly blocks in the location's clock, per location, with buffers, unless overridden", async () => {
    await svc(async () => {
      await expect(book(MON, "13:15", "13:45")).rejects.toThrow(/slot_taken/); // lunch at Main
      await book(MON, "13:15", "13:45", { location: id.loc2 }); // lunch is Main only
      await expect(book(MON, "15:10", "15:20", { location: id.loc2 })).rejects.toThrow(
        /slot_taken/,
      ); // every location
      await expect(book(MON, "12:30", "12:55", { service: id.buffered })).rejects.toThrow(
        /slot_taken/,
      ); // cleans into lunch
      await book(MON, "12:00", "12:30", { service: id.buffered }); // cleans until 12:45
      await book(TUE, "13:15", "13:45"); // Tuesday has no lunch block
      await book(MON, "14:00", "14:30"); // right after lunch
      await book(MON, "13:30", "13:40", { enforce: false }); // staff override still books
    });
  });

  it("move_appointment re-checks with the appointment's own service", async () => {
    await svc(async () => {
      const moving = (await book(FRI, "15:00", "15:30", { service: id.buffered })).rows[0].id;
      await book(FRI, "16:00", "16:30");
      const move = (from: string, to: string) =>
        c.query("select (public.move_appointment($1, $2, $3, $4, $5, $6, 'awaiting', true)).id", [
          orgA,
          moving,
          id.loc1,
          id.spec1,
          local(FRI, from),
          local(FRI, to),
        ]);
      await expect(move("15:31", "16:01")).rejects.toThrow(/slot_taken/); // overlaps the 16:00
      await expect(move("15:30", "16:00")).rejects.toThrow(/slot_taken/); // cleaning runs into 16:00
      await move("15:15", "15:45"); // overlaps only itself; cleaning ends exactly 16:00
    });
  });

  it("accept_slot_offer books while places remain and tells the others only when the last one goes", async () => {
    await svc(async () => {
      const slot = [local(THU, "10:00"), local(THU, "10:30")];
      await book(THU, "10:00", "10:30", { spec: id.spec2, service: id.group });
      const offers: string[] = [];
      for (const who of [id.contact2, id.contact3, id.contact4]) {
        const entry = (
          await c.query(
            "insert into public.waitlist_entries (org_id, contact_id, specialist_id, service_id) values ($1, $2, $3, $4) returning id",
            [orgA, who, id.spec2, id.group],
          )
        ).rows[0].id;
        offers.push(
          (
            await c.query(
              "insert into public.slot_offers (org_id, waitlist_entry_id, specialist_id, location_id, service_id, starts_at, ends_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
              [orgA, entry, id.spec2, id.loc1, id.group, slot[0], slot[1], "2026-06-17T00:00:00Z"],
            )
          ).rows[0].id,
        );
      }
      const accept = async (offer: string) =>
        (
          await c.query("select public.accept_slot_offer($1, $2, $3) as r", [
            orgA,
            offer,
            "2026-06-10T00:00:00Z",
          ])
        ).rows[0].r.result as string;
      const status = async (offer: string) =>
        (await c.query("select status from public.slot_offers where id = $1", [offer])).rows[0]
          .status as string;
      expect(await accept(offers[0])).toBe("booked");
      expect(await status(offers[1])).toBe("pending"); // one place left: nobody is told it has gone
      expect(await accept(offers[1])).toBe("booked");
      expect(await status(offers[2])).toBe("taken"); // now full
      expect(await accept(offers[2])).toBe("taken");

      // Default capacity: an occupied one-place slot is taken.
      await book(THU, "14:00", "14:30");
      const entry = (
        await c.query(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id, service_id) values ($1, $2, $3, $4) returning id",
          [orgA, id.contact2, id.spec1, id.consult],
        )
      ).rows[0].id;
      const offer = (
        await c.query(
          "insert into public.slot_offers (org_id, waitlist_entry_id, specialist_id, location_id, service_id, starts_at, ends_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
          [
            orgA,
            entry,
            id.spec1,
            id.loc1,
            id.consult,
            local(THU, "14:00"),
            local(THU, "14:30"),
            "2026-06-17T00:00:00Z",
          ],
        )
      ).rows[0].id;
      expect(await accept(offer)).toBe("taken");
    });
  });

  it("accepts Unite rows written the way the sync writes them, and only flags the ones that conflict", async () => {
    await svc(async () => {
      const unite = async (
        ext: string,
        date: string,
        from: string,
        to: string,
        status = "confirmed",
      ) =>
        (
          await c.query(
            "insert into public.appointments (org_id, specialist_id, location_id, starts_at, ends_at, status, source, external_id) values ($1, $2, $3, $4, $5, $6, 'unite', $7) returning id",
            [orgA, id.spec1, id.loc1, local(date, from), local(date, to), status, ext],
          )
        ).rows[0].id as string;
      const inLunch = await unite("U-1", MON, "13:00", "13:30"); // weekly block
      const overPortal = await unite("U-2", MON, "09:00", "09:30"); // on top of a portal booking
      const fine = await unite("U-3", FRI, "10:00", "10:30");
      const gone = await unite("U-4", MON, "13:00", "13:30", "cancelled");
      // the sync's later update (moved in Unite) is never refused either
      await c.query("update public.appointments set starts_at = $2, ends_at = $3 where id = $1", [
        inLunch,
        local(MON, "13:10"),
        local(MON, "13:40"),
      ]);

      const portal = (
        await c.query(
          "select id from public.appointments where specialist_id = $1 and starts_at = $2 and source = 'portal'",
          [id.spec1, local(MON, "09:00")],
        )
      ).rows[0].id;
      const { rows } = await c.query<{ appointment_id: string; reason: string }>(
        "select * from public.appointment_capacity_conflicts($1, $2::uuid[])",
        [orgA, [inLunch, overPortal, fine, gone, portal]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.appointment_id, r.reason]));
      expect(byId[inLunch]).toBe("blocked");
      expect(byId[overPortal]).toBe("full");
      expect(byId[portal]).toBe("full"); // the portal booking now shares its slot too
      expect(byId[fine]).toBeUndefined();
      expect(byId[gone]).toBeUndefined();
      // another org's ids flag nothing
      expect(
        (
          await c.query("select * from public.appointment_capacity_conflicts($1, $2::uuid[])", [
            orgB,
            [inLunch],
          ])
        ).rows,
      ).toEqual([]);
    });
    await asUser(c, alice, async () => {
      await expect(
        c.query("select * from public.appointment_capacity_conflicts($1, $2::uuid[])", [orgA, []]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("matches the pure TypeScript rule (slotFits) slot by slot", async () => {
    const day = MON;
    const svcRow = async (sid: string) =>
      (
        await c.query(
          "select buffer_before_min, buffer_after_min, capacity from public.services where id = $1",
          [sid],
        )
      ).rows[0];
    const spec = (
      await c.query("select max_per_slot from public.specialists where id = $1", [id.spec1])
    ).rows[0];
    const appts = (
      await c.query(
        `select a.starts_at, a.ends_at, coalesce(s.buffer_before_min, 0) bb, coalesce(s.buffer_after_min, 0) ba, coalesce(s.capacity, 1) cap
         from public.appointments a left join public.services s on s.id = a.service_id
        where a.specialist_id = $1 and a.status in ('awaiting', 'confirmed', 'completed')`,
        [id.spec1],
      )
    ).rows;
    const weekly = (
      await c.query(
        "select weekday, start_min, end_min from public.specialist_recurring_blocks where specialist_id = $1 and (location_id is null or location_id = $2)",
        [id.spec1, id.loc1],
      )
    ).rows;
    const busy: BusyInterval[] = [
      ...appts.map((a) => ({
        start: a.starts_at,
        end: a.ends_at,
        bufferBeforeMin: a.bb,
        bufferAfterMin: a.ba,
        capacity: Math.min(a.cap, spec.max_per_slot),
      })),
      ...expandRecurringBlocks(weekly, "2026-06-14", "2026-06-16", "Asia/Dubai"),
    ];
    let compared = 0;
    let fits = 0;
    for (const sid of [id.consult, id.buffered, id.prepped, id.group]) {
      const s = await svcRow(sid);
      for (let m = 8 * 60; m <= 17 * 60; m += 5) {
        const start = new Date(new Date(local(day, "00:00")).getTime() + m * 60_000);
        const end = new Date(start.getTime() + 25 * 60_000);
        const sql = (
          await c.query("select app.slot_conflict($1, $2, $3, $4, $5, $6, null) as r", [
            orgA,
            id.spec1,
            id.loc1,
            sid,
            start.toISOString(),
            end.toISOString(),
          ])
        ).rows[0].r;
        const ts = slotFits(
          {
            start,
            end,
            bufferBeforeMin: s.buffer_before_min,
            bufferAfterMin: s.buffer_after_min,
            capacity: Math.min(s.capacity, spec.max_per_slot),
          },
          busy,
        );
        expect({ sid, m, fits: sql === null }).toEqual({ sid, m, fits: ts });
        compared++;
        if (ts) fits++;
      }
    }
    expect(compared).toBeGreaterThan(400);
    expect(fits).toBeGreaterThan(20); // not vacuous either way
    expect(fits).toBeLessThan(compared);
  });

  it("recurring blocks: members read, only settings.manage writes, other orgs see nothing", async () => {
    await asUser(c, carol, async () => {
      expect(
        (
          await c.query(
            "select count(*)::int n from public.specialist_recurring_blocks where org_id = $1",
            [orgA],
          )
        ).rows[0].n,
      ).toBe(2);
      await expect(
        c.query(
          "insert into public.specialist_recurring_blocks (org_id, specialist_id, weekday, start_min, end_min) values ($1, $2, 2, 600, 660)",
          [orgA, id.spec1],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(c, alice, async () => {
      await c.query(
        "insert into public.specialist_recurring_blocks (org_id, specialist_id, weekday, start_min, end_min) values ($1, $2, 7, 600, 660)",
        [orgA, id.spec1],
      );
      await expect(
        c.query(
          "insert into public.specialist_recurring_blocks (org_id, specialist_id, weekday, start_min, end_min) values ($1, $2, 7, 660, 600)",
          [orgA, id.spec1],
        ),
      ).rejects.toThrow(/check constraint/);
    });
    await asUser(c, bob, async () => {
      expect(
        (await c.query("select count(*)::int n from public.specialist_recurring_blocks")).rows[0].n,
      ).toBe(0);
    });
  });
});
