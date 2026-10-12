/**
 * Phase 14 database behaviour: permission gating and cross-org isolation of the front desk tables, the
 * slot-offer race (two patients answer YES at once, on real connections), and households in merge and duplicate
 * detection. Runs only with TEST_DATABASE_URL. Synthetic names and reserved test numbers only.
 */
import fs from "node:fs";
import path from "node:path";

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

describe.skipIf(!TEST_DATABASE_URL)("front desk database", () => {
  let c: Client;
  let alice: string; // admin A
  let bob: string; // admin B
  let desk: string; // org A receptionist: frontdesk.use + appointments.manage + contacts.manage
  let agent: string; // org A agent: no frontdesk.use
  let orgA: string;
  let orgB: string;
  const ids: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }
  async function tryQuery(sql: string, params: unknown[] = []) {
    await c.query("begin");
    try {
      const r = await c.query(sql, params);
      await c.query("commit");
      return { ok: true as const, rowCount: r.rowCount ?? 0, rows: r.rows };
    } catch (e) {
      await c.query("rollback");
      return {
        ok: false as const,
        code: (e as { code?: string }).code,
        message: (e as Error).message,
      };
    }
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    desk = await createAuthUser(c, "desk@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    await asServiceRole(c, async () => {
      for (const [user, name, perms] of [
        [
          desk,
          "Desk",
          [
            "frontdesk.use",
            "appointments.view",
            "appointments.manage",
            "contacts.view",
            "contacts.manage",
          ],
        ],
        [agent, "Plain agent", ["appointments.view", "contacts.view"]],
      ] as const) {
        const roleId = await insert(
          "insert into public.roles (org_id, name, permissions) values ($1, $2, $3::jsonb)",
          [orgA, name, JSON.stringify(perms)],
        );
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id, status) values ($1, $2, $3, 'active')",
          [orgA, user, roleId],
        );
      }
      for (const [tag, org] of [
        ["a", orgA],
        ["b", orgB],
      ] as const) {
        ids[`loc_${tag}`] = await insert(
          "insert into public.locations (org_id, name) values ($1, $2)",
          [org, `Clinic ${tag}`],
        );
        ids[`spec_${tag}`] = await insert(
          "insert into public.specialists (org_id, name) values ($1, $2)",
          [org, `Dr ${tag}`],
        );
        ids[`svc_${tag}`] = await insert(
          "insert into public.services (org_id, name, duration_min) values ($1, 'Consultation', 30)",
          [org],
        );
        ids[`mum_${tag}`] = await insert(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Mum', 'Sample', $2)",
          [org, tag === "a" ? "+971500000151" : "+971500000152"],
        );
        ids[`kid_${tag}`] = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob) values ($1, 'Kid', 'Sample', '2019-06-11')",
          [org],
        );
      }
      await c.query(
        "insert into public.specialist_services (org_id, specialist_id, service_id) values ($1, $2, $3)",
        [orgA, ids.spec_a, ids.svc_a],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  // ---------------------------------------------------------------------------------------------------
  describe("permission gating", () => {
    it("lets the desk write handover notes, hides them from people without the permission, and lets only an administrator delete", async () => {
      let noteId = "";
      await asUser(c, desk, async () => {
        const ok = await tryQuery(
          "insert into public.handover_notes (org_id, body, created_by) values ($1, 'Doctor B running late', $2) returning id",
          [orgA, desk],
        );
        expect(ok.ok).toBe(true);
        noteId = (ok as { rows: Array<{ id: string }> }).rows[0].id;
        // cannot sign a note as somebody else
        const forged = await tryQuery(
          "insert into public.handover_notes (org_id, body, created_by) values ($1, 'x', $2)",
          [orgA, alice],
        );
        expect(forged.ok === false && forged.code).toBe("42501");
        const read = await tryQuery("select id from public.handover_notes where org_id = $1", [
          orgA,
        ]);
        expect(read.ok && read.rowCount).toBe(1);
        const del = await tryQuery("delete from public.handover_notes where id = $1", [noteId]);
        expect(del.ok && del.rowCount).toBe(0); // staff resolve notes; they do not delete them
      });
      await asUser(c, agent, async () => {
        const read = await tryQuery("select id from public.handover_notes where org_id = $1", [
          orgA,
        ]);
        expect(read.ok && read.rowCount).toBe(0);
        const w = await tryQuery(
          "insert into public.handover_notes (org_id, body, created_by) values ($1, 'x', $2)",
          [orgA, agent],
        );
        expect(w.ok === false && w.code).toBe("42501");
      });
      await asUser(c, alice, async () => {
        const del = await tryQuery("delete from public.handover_notes where id = $1", [noteId]);
        expect(del.ok && del.rowCount).toBe(1);
      });
    });

    it("lets a member send feedback only as themselves; an administrator reads everyone's, a member only their own", async () => {
      await asUser(c, agent, async () => {
        const mine = await tryQuery(
          "insert into public.help_feedback (org_id, user_id, page, kind, message) values ($1, $2, '/inbox', 'problem', 'The thing broke')",
          [orgA, agent],
        );
        expect(mine.ok).toBe(true);
        const other = await tryQuery(
          "insert into public.help_feedback (org_id, user_id, page, kind, message) values ($1, $2, '/inbox', 'problem', 'as someone else')",
          [orgA, alice],
        );
        expect(other.ok === false && other.code).toBe("42501");
        const own = await tryQuery("select id from public.help_feedback where org_id = $1", [orgA]);
        expect(own.ok && own.rowCount).toBe(1);
        const move = await tryQuery(
          "update public.help_feedback set status = 'done' where user_id = $1",
          [agent],
        );
        expect(move.ok && move.rowCount).toBe(0); // only an administrator triages
      });
      await asUser(c, desk, async () => {
        await tryQuery(
          "insert into public.help_feedback (org_id, user_id, page, kind, message) values ($1, $2, '/front-desk', 'idea', 'Nice')",
          [orgA, desk],
        );
      });
      await asUser(c, alice, async () => {
        const all = await tryQuery("select id from public.help_feedback where org_id = $1", [orgA]);
        expect(all.ok && all.rowCount).toBeGreaterThanOrEqual(2);
        const triage = await tryQuery(
          "update public.help_feedback set status = 'seen' where org_id = $1",
          [orgA],
        );
        expect(triage.ok && triage.rowCount).toBeGreaterThanOrEqual(2);
      });
    });

    it("lets contacts.manage link households and refuses everyone else; links never cross orgs", async () => {
      await asUser(c, agent, async () => {
        const r = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, ids.mum_a, ids.kid_a],
        );
        expect(r.ok === false && r.code).toBe("42501");
      });
      await asUser(c, desk, async () => {
        const cross = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, ids.mum_a, ids.kid_b],
        );
        expect(cross.ok === false && cross.code).toBe("23514"); // dependant belongs to org B
        const ok = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id, created_by) values ($1, $2, $3, $4) returning id",
          [orgA, ids.mum_a, ids.kid_a, desk],
        );
        expect(ok.ok).toBe(true);
        ids.link_a = (ok as { rows: Array<{ id: string }> }).rows[0].id;
        const read = await tryQuery("select id from public.household_links where org_id = $1", [
          orgA,
        ]);
        expect(read.ok && read.rowCount).toBe(1);
      });
      await asUser(c, bob, async () => {
        const read = await tryQuery("select id from public.household_links");
        expect(read.ok && read.rowCount).toBe(0);
      });
    });

    it("keeps a household one hop deep, with one guardian per dependant and nobody their own guardian", async () => {
      await asServiceRole(c, async () => {
        const grand = await insert(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Grand', 'Sample')",
          [orgA],
        );
        const dad = await insert(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Dad', 'Sample', '+971500000153')",
          [orgA],
        );
        // mum -> kid exists (created above). The dependant cannot become a guardian ...
        const down = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, ids.kid_a, grand],
        );
        expect(down.ok === false && down.message).toMatch(/already a dependant/);
        // ... the guardian cannot become a dependant ...
        const up = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, grand, ids.mum_a],
        );
        expect(up.ok === false && up.message).toMatch(/already a guardian/);
        // ... a dependant has one guardian ...
        const second = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, dad, ids.kid_a],
        );
        expect(second.ok === false && second.code).toBe("23505");
        // ... and nobody is their own guardian.
        const self = await tryQuery(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $2)",
          [orgA, dad],
        );
        expect(self.ok === false && self.code).toBe("23514");
      });
    });

    it("lets the desk keep a waiting list, needs a doctor or a service, and asks each patient once per pair", async () => {
      await asUser(c, agent, async () => {
        const r = await tryQuery(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id) values ($1, $2, $3)",
          [orgA, ids.mum_a, ids.spec_a],
        );
        expect(r.ok === false && r.code).toBe("42501");
        expect((await tryQuery("select id from public.waitlist_entries")).ok).toBe(true);
      });
      await asUser(c, desk, async () => {
        const none = await tryQuery(
          "insert into public.waitlist_entries (org_id, contact_id) values ($1, $2)",
          [orgA, ids.mum_a],
        );
        expect(none.ok === false && none.code).toBe("23514");
        const ok = await tryQuery(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id, created_by) values ($1, $2, $3, $4) returning id",
          [orgA, ids.mum_a, ids.spec_a, desk],
        );
        expect(ok.ok).toBe(true);
        const dup = await tryQuery(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id) values ($1, $2, $3)",
          [orgA, ids.mum_a, ids.spec_a],
        );
        expect(dup.ok === false && dup.code).toBe("23505");
        const crossOrg = await tryQuery(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id) values ($1, $2, $3)",
          [orgA, ids.mum_b, ids.spec_a],
        );
        expect(crossOrg.ok === false && crossOrg.code).toBe("23514");
        // removing the entry frees the pair for a new one
        await tryQuery(
          "update public.waitlist_entries set status = 'removed' where contact_id = $1",
          [ids.mum_a],
        );
        const again = await tryQuery(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id) values ($1, $2, $3)",
          [orgA, ids.mum_a, ids.spec_a],
        );
        expect(again.ok).toBe(true);
      });
      await asServiceRole(c, async () => {
        await c.query("delete from public.waitlist_entries where org_id = $1", [orgA]);
      });
    });

    it("lets staff read slot offers but never write them", async () => {
      await asServiceRole(c, async () => {
        ids.entry = await insert(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id) values ($1, $2, $3)",
          [orgA, ids.mum_a, ids.spec_a],
        );
        ids.offer = await insert(
          "insert into public.slot_offers (org_id, waitlist_entry_id, specialist_id, location_id, service_id, starts_at, ends_at, expires_at) values ($1, $2, $3, $4, $5, now() + interval '3 days', now() + interval '3 days 30 minutes', now() + interval '1 day')",
          [orgA, ids.entry, ids.spec_a, ids.loc_a, ids.svc_a],
        );
      });
      await asUser(c, desk, async () => {
        expect((await tryQuery("select id from public.slot_offers")).ok && true).toBe(true);
        const read = await tryQuery("select id from public.slot_offers where org_id = $1", [orgA]);
        expect(read.ok && read.rowCount).toBe(1);
        const upd = await tryQuery(
          "update public.slot_offers set status = 'accepted' where id = $1",
          [ids.offer],
        );
        expect(upd.ok && upd.rowCount).toBe(0);
        const ins = await tryQuery(
          "insert into public.slot_offers (org_id, waitlist_entry_id, specialist_id, location_id, service_id, starts_at, ends_at, expires_at) values ($1, $2, $3, $4, $5, now(), now() + interval '1 hour', now())",
          [orgA, ids.entry, ids.spec_a, ids.loc_a, ids.svc_a],
        );
        expect(ins.ok === false && ins.code).toBe("42501");
      });
      await asUser(c, agent, async () => {
        const read = await tryQuery("select id from public.slot_offers");
        expect(read.ok && read.rowCount).toBe(0);
      });
      await asUser(c, bob, async () => {
        const read = await tryQuery("select id from public.slot_offers");
        expect(read.ok && read.rowCount).toBe(0);
      });
      await asServiceRole(c, async () => {
        await c.query("delete from public.waitlist_entries where org_id = $1", [orgA]);
      });
    });

    it("lets only a workspace administrator switch training mode, and starts every org live", async () => {
      await asServiceRole(c, async () => {
        const { rows } = await c.query("select is_training from public.orgs where id in ($1, $2)", [
          orgA,
          orgB,
        ]);
        expect(rows.every((r) => r.is_training === false)).toBe(true);
      });
      await asUser(c, desk, async () => {
        const r = await tryQuery("update public.orgs set is_training = true where id = $1", [orgA]);
        expect(r.ok && r.rowCount).toBe(0);
      });
      await asUser(c, alice, async () => {
        const r = await tryQuery("update public.orgs set is_training = true where id = $1", [orgA]);
        expect(r.ok && r.rowCount).toBe(1);
        const other = await tryQuery("update public.orgs set is_training = true where id = $1", [
          orgB,
        ]);
        expect(other.ok && other.rowCount).toBe(0);
        await tryQuery("update public.orgs set is_training = false where id = $1", [orgA]);
      });
    });

    it("keeps check-in coherent: a state needs its arrival time", async () => {
      await asServiceRole(c, async () => {
        const base = [orgA, ids.mum_a, ids.loc_a, ids.spec_a, ids.svc_a];
        const bad = await tryQuery(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, starts_at, ends_at, checkin_status) values ($1, $2, $3, $4, $5, now(), now() + interval '30 minutes', 'arrived')",
          base,
        );
        expect(bad.ok === false && bad.code).toBe("23514");
        const worse = await tryQuery(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, starts_at, ends_at, checkin_status, arrived_at) values ($1, $2, $3, $4, $5, now(), now() + interval '30 minutes', 'seen', now())",
          base,
        );
        expect(worse.ok === false && worse.code).toBe("23514");
        const good = await tryQuery(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, starts_at, ends_at, checkin_status, arrived_at, is_walk_in) values ($1, $2, $3, $4, $5, now(), now() + interval '30 minutes', 'arrived', now(), true) returning id",
          base,
        );
        expect(good.ok).toBe(true);
        await c.query("delete from public.appointments where org_id = $1", [orgA]);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("first YES wins (accept_slot_offer)", () => {
    const racers: Client[] = [];
    const slotStart = "2099-01-05T06:00:00Z";
    const slotEnd = "2099-01-05T06:30:00Z";

    beforeAll(async () => {
      for (let i = 0; i < 5; i++) {
        const k = await connect();
        await k.query("set role service_role");
        racers.push(k);
      }
    });
    afterAll(async () => {
      await Promise.all(racers.map((k) => k.end()));
    });

    async function newOffer(
      org: string,
      contactName: string,
      start = slotStart,
      end = slotEnd,
      expires = "2099-01-05T05:00:00Z",
    ) {
      return asServiceRole(c, async () => {
        const contact = await insert(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, $2, 'Racer')",
          [org, contactName],
        );
        const entry = await insert(
          "insert into public.waitlist_entries (org_id, contact_id, specialist_id, service_id) values ($1, $2, $3, $4)",
          [org, contact, ids.spec_a, ids.svc_a],
        );
        const offer = await insert(
          "insert into public.slot_offers (org_id, waitlist_entry_id, specialist_id, location_id, service_id, starts_at, ends_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [org, entry, ids.spec_a, ids.loc_a, ids.svc_a, start, end, expires],
        );
        return { contact, entry, offer };
      });
    }
    const accept = async (k: Client, org: string, offer: string, now = "2099-01-05T04:00:00Z") =>
      (
        await k.query<{ r: { result: string; appointment_id?: string } }>(
          "select public.accept_slot_offer($1, $2, $3) as r",
          [org, offer, now],
        )
      ).rows[0].r;

    it("books the slot for exactly one of two patients who answer YES at the same instant", async () => {
      const [one, two] = [await newOffer(orgA, "Racer1"), await newOffer(orgA, "Racer2")];
      const results = await Promise.all([
        accept(racers[0], orgA, one.offer),
        accept(racers[1], orgA, two.offer),
      ]);
      expect(results.map((r) => r.result).sort()).toEqual(["booked", "taken"]);

      await asServiceRole(c, async () => {
        const { rows: appts } = await c.query(
          "select id, contact_id, status, source from public.appointments where specialist_id = $1 and starts_at = $2",
          [ids.spec_a, slotStart],
        );
        expect(appts).toHaveLength(1);
        expect(appts[0].status).toBe("confirmed");
        const winner = results.findIndex((r) => r.result === "booked") === 0 ? one : two;
        const loser = winner === one ? two : one;
        expect(appts[0].contact_id).toBe(winner.contact);
        const { rows: offers } = await c.query(
          "select id, status, appointment_id from public.slot_offers where id = any($1)",
          [[one.offer, two.offer]],
        );
        const byId = new Map(offers.map((o) => [o.id, o]));
        expect(byId.get(winner.offer)!.status).toBe("accepted");
        expect(byId.get(winner.offer)!.appointment_id).toBe(appts[0].id);
        expect(byId.get(loser.offer)!.status).toBe("taken");
        const { rows: entries } = await c.query(
          "select id, status from public.waitlist_entries where id = any($1)",
          [[one.entry, two.entry]],
        );
        expect(new Map(entries.map((e) => [e.id, e.status])).get(winner.entry)).toBe("booked");
        expect(new Map(entries.map((e) => [e.id, e.status])).get(loser.entry)).toBe("waiting"); // stays on the list
      });
    });

    it("holds with five patients answering at once, repeated: never two bookings for one slot", async () => {
      for (let round = 0; round < 4; round++) {
        const start = `2099-02-0${round + 1}T06:00:00Z`;
        const end = `2099-02-0${round + 1}T06:30:00Z`;
        const offers = [];
        for (let i = 0; i < 5; i++)
          offers.push(
            await newOffer(orgA, `Five${round}${i}`, start, end, `2099-02-0${round + 1}T05:00:00Z`),
          );
        const results = await Promise.all(offers.map((o, i) => accept(racers[i], orgA, o.offer)));
        expect(results.filter((r) => r.result === "booked")).toHaveLength(1);
        expect(results.filter((r) => r.result === "taken")).toHaveLength(4);
        await asServiceRole(c, async () => {
          const { rows } = await c.query(
            "select count(*)::int as n from public.appointments where specialist_id = $1 and starts_at = $2 and status <> 'cancelled'",
            [ids.spec_a, start],
          );
          expect(rows[0].n).toBe(1);
        });
      }
    });

    it("answers a second YES from the same offer with 'not pending' and never books twice", async () => {
      const o = await newOffer(
        orgA,
        "Twice",
        "2099-03-01T06:00:00Z",
        "2099-03-01T06:30:00Z",
        "2099-03-01T05:00:00Z",
      );
      const first = await accept(racers[0], orgA, o.offer, "2099-03-01T04:00:00Z");
      const second = await accept(racers[1], orgA, o.offer, "2099-03-01T04:00:00Z");
      expect(first.result).toBe("booked");
      expect(second.result).toBe("not_pending");
    });

    it("refuses an expired offer and marks it so", async () => {
      const o = await newOffer(
        orgA,
        "Late",
        "2099-04-01T06:00:00Z",
        "2099-04-01T06:30:00Z",
        "2099-04-01T04:10:00Z",
      );
      const r = await accept(racers[0], orgA, o.offer, "2099-04-01T04:30:00Z");
      expect(r.result).toBe("expired");
      await asServiceRole(c, async () => {
        const { rows } = await c.query("select status from public.slot_offers where id = $1", [
          o.offer,
        ]);
        expect(rows[0].status).toBe("expired");
      });
    });

    it("says 'taken' when a staff booking got the slot first, and books nothing", async () => {
      const start = "2099-05-01T06:00:00Z";
      const o = await newOffer(
        orgA,
        "Beaten",
        start,
        "2099-05-01T06:30:00Z",
        "2099-05-01T05:00:00Z",
      );
      await asServiceRole(c, async () => {
        await c.query(
          "select public.book_appointment($1, $2, $3, $4, $5, null, $6, $7, 'awaiting', null, false, 'portal', null, true)",
          [orgA, ids.kid_a, ids.loc_a, ids.spec_a, ids.svc_a, start, "2099-05-01T06:30:00Z"],
        );
      });
      const r = await accept(racers[0], orgA, o.offer, "2099-05-01T04:00:00Z");
      expect(r.result).toBe("taken");
      await asServiceRole(c, async () => {
        const { rows } = await c.query(
          "select count(*)::int as n from public.appointments where specialist_id = $1 and starts_at = $2",
          [ids.spec_a, start],
        );
        expect(rows[0].n).toBe(1);
      });
    });

    it("races a staff booking against a YES: one wins, never both", async () => {
      const start = "2099-06-01T06:00:00Z";
      const end = "2099-06-01T06:30:00Z";
      const o = await newOffer(orgA, "Versus", start, end, "2099-06-01T05:00:00Z");
      const [yes, staff] = await Promise.allSettled([
        accept(racers[0], orgA, o.offer, "2099-06-01T04:00:00Z"),
        racers[1].query(
          "select public.book_appointment($1, $2, $3, $4, $5, null, $6, $7, 'awaiting', null, false, 'portal', null, true)",
          [orgA, ids.kid_a, ids.loc_a, ids.spec_a, ids.svc_a, start, end],
        ),
      ]);
      expect(yes.status).toBe("fulfilled");
      const answer = (yes as PromiseFulfilledResult<{ result: string }>).value.result;
      if (answer === "booked") {
        expect(staff.status).toBe("rejected");
        expect(String((staff as PromiseRejectedResult).reason.message)).toBe("slot_taken");
      } else {
        expect(answer).toBe("taken");
        expect(staff.status).toBe("fulfilled");
      }
      await asServiceRole(c, async () => {
        const { rows } = await c.query(
          "select count(*)::int as n from public.appointments where specialist_id = $1 and starts_at = $2",
          [ids.spec_a, start],
        );
        expect(rows[0].n).toBe(1);
      });
    });

    it("does not touch another org's offer, and signed-in users cannot call it at all", async () => {
      const o = await newOffer(
        orgA,
        "Guarded",
        "2099-07-01T06:00:00Z",
        "2099-07-01T06:30:00Z",
        "2099-07-01T05:00:00Z",
      );
      const wrongOrg = await accept(racers[0], orgB, o.offer, "2099-07-01T04:00:00Z");
      expect(wrongOrg.result).toBe("not_found");
      for (const role of ["authenticated", "anon"]) {
        await c.query(`set role ${role}`);
        const err = await c
          .query("select public.accept_slot_offer($1, $2, now())", [orgA, o.offer])
          .then(
            () => null,
            (e: { code?: string }) => e,
          );
        await c.query("reset role");
        expect(err?.code, role).toBe("42501");
      }
    });

    it("withdraws an offer whose waiting-list entry was removed", async () => {
      const o = await newOffer(
        orgA,
        "Removed",
        "2099-08-01T06:00:00Z",
        "2099-08-01T06:30:00Z",
        "2099-08-01T05:00:00Z",
      );
      await asServiceRole(c, async () => {
        await c.query("update public.waitlist_entries set status = 'removed' where id = $1", [
          o.entry,
        ]);
      });
      const r = await accept(racers[0], orgA, o.offer, "2099-08-01T04:00:00Z");
      expect(r.result).toBe("not_pending");
      await asServiceRole(c, async () => {
        const { rows } = await c.query(
          "select count(*)::int as n from public.appointments where specialist_id = $1 and starts_at = $2",
          [ids.spec_a, "2099-08-01T06:00:00Z"],
        );
        expect(rows[0].n).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("households in duplicate detection and merge", () => {
    let m1: string; // mother
    let m2: string; // her duplicate record
    let k1: string; // child
    let k2: string; // another child
    let k3: string; // the child's duplicate record

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        await c.query("delete from public.household_links where org_id = $1", [orgA]);
        m1 = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob, email) values ($1, 'Hana', 'Household', '1988-03-02', 'hana.household@example.test')",
          [orgA],
        );
        m2 = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob, email) values ($1, 'Hana', 'Household', '1988-03-02', 'hana.household@example.test')",
          [orgA],
        );
        k1 = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob) values ($1, 'Rami', 'Household', '2019-06-11')",
          [orgA],
        );
        k2 = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob) values ($1, 'Dana', 'Household', '2021-01-05')",
          [orgA],
        );
        k3 = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob) values ($1, 'Rami', 'Household', '2019-06-11')",
          [orgA],
        );
        await c.query(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3), ($1, $2, $4)",
          [orgA, m1, k1, k2],
        );
      });
    });

    const candidates = async () =>
      asServiceRole(
        c,
        async () =>
          (
            await c.query<{ a_id: string; b_id: string; reason: string }>(
              "select * from public.contact_duplicate_candidates($1, 500)",
              [orgA],
            )
          ).rows,
      );
    const pair = (x: string, y: string) => [x, y].sort().join("|");

    it("still finds real duplicates (a second record for the same mother, a second record for the same child)", async () => {
      const found = (await candidates()).map((r) => pair(r.a_id, r.b_id));
      expect(found).toContain(pair(m1, m2));
      expect(found).toContain(pair(k1, k3));
    });

    it("does not offer a guardian and her dependant, or two siblings, as duplicates of each other", async () => {
      // Give them the signals that would normally flag a pair: the child carries the mother's number as an alternate phone.
      await asServiceRole(c, async () => {
        await c.query("update public.contacts set phone_e164 = '+971500000161' where id = $1", [
          m1,
        ]);
        await c.query(
          "insert into public.contact_phones (org_id, contact_id, phone_e164, label) values ($1, $2, '+971500000161', 'household')",
          [orgA, k1],
        );
        await c.query(
          "insert into public.contact_phones (org_id, contact_id, phone_e164, label) values ($1, $2, '+971500000161', 'household')",
          [orgA, k2],
        );
      });
      const found = (await candidates()).map((r) => pair(r.a_id, r.b_id));
      expect(found).not.toContain(pair(m1, k1));
      expect(found).not.toContain(pair(m1, k2));
      expect(found).not.toContain(pair(k1, k2));
      // the unlinked duplicate record of the child is not in the family, so it is still shown against the child's phone-holder
      expect(found).toContain(pair(k1, k3));
    });

    it("refuses to merge a guardian into her own dependant (or the reverse)", async () => {
      await asServiceRole(c, async () => {
        const a = await tryQuery("select public.merge_contacts($1, $2, $3)", [orgA, m1, k1]);
        expect(a.ok === false && a.message).toMatch(/different people/);
        const b = await tryQuery("select public.merge_contacts($1, $2, $3)", [orgA, k1, m1]);
        expect(b.ok === false && b.message).toMatch(/different people/);
      });
    });

    it("moves a merged guardian's dependants onto the surviving record", async () => {
      await asServiceRole(c, async () => {
        const dependantOfDuplicate = await insert(
          "insert into public.contacts (org_id, first_name, last_name, dob) values ($1, 'Sami', 'Household', '2023-02-02')",
          [orgA],
        );
        await c.query(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, m2, dependantOfDuplicate],
        );
        const merged = await tryQuery("select public.merge_contacts($1, $2, $3)", [orgA, m1, m2]);
        expect(merged.ok).toBe(true);
        const { rows } = await c.query(
          "select dependant_contact_id from public.household_links where org_id = $1 and guardian_contact_id = $2",
          [orgA, m1],
        );
        expect(rows.map((r) => r.dependant_contact_id).sort()).toEqual(
          [k1, k2, dependantOfDuplicate].sort(),
        );
        const gone = await c.query(
          "select count(*)::int as n from public.household_links where guardian_contact_id = $1",
          [m2],
        );
        expect(gone.rows[0].n).toBe(0);
      });
    });

    it("keeps the surviving child's own guardian when both child records had one", async () => {
      await asServiceRole(c, async () => {
        const other = await insert(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Uncle', 'Household')",
          [orgA],
        );
        await c.query(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, other, k3],
        );
        const merged = await tryQuery("select public.merge_contacts($1, $2, $3)", [orgA, k1, k3]);
        expect(merged.ok).toBe(true);
        const { rows } = await c.query(
          "select guardian_contact_id from public.household_links where dependant_contact_id = $1",
          [k1],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].guardian_contact_id).toBe(m1);
        const left = await c.query(
          "select count(*)::int as n from public.household_links where dependant_contact_id = $1",
          [k3],
        );
        expect(left.rows[0].n).toBe(0);
      });
    });

    it("refuses a merge that would make a chain (a guardian's records merged into someone who is a dependant)", async () => {
      await asServiceRole(c, async () => {
        const parent = await insert(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Parent', 'Household')",
          [orgA],
        );
        const dupParent = await insert(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Parent', 'Household')",
          [orgA],
        );
        const kid = await insert(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Kiddo', 'Household')",
          [orgA],
        );
        await c.query(
          "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
          [orgA, parent, kid],
        );
        // m1's own dependants (k1, k2, ...) exist; try merging m1 (guardian) into `kid` (a dependant)
        const bad = await tryQuery("select public.merge_contacts($1, $2, $3)", [orgA, kid, m1]);
        expect(bad.ok === false && bad.message).toMatch(/unlink first/);
        const fine = await tryQuery("select public.merge_contacts($1, $2, $3)", [
          orgA,
          parent,
          dupParent,
        ]);
        expect(fine.ok).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("permission data migration", () => {
    it("adds frontdesk.use to the Receptionist and Manager system roles once, and to nobody else", async () => {
      const sql = fs.readFileSync(
        path.resolve(__dirname, "../../supabase/migrations/20261014000100_front_desk_core.sql"),
        "utf8",
      );
      const update = sql.slice(sql.lastIndexOf("update public.roles r"));
      await asServiceRole(c, async () => {
        const mk = async (org: string, name: string, perms: string[], system = true) =>
          insert(
            "insert into public.roles (org_id, name, permissions, is_system) values ($1, $2, $3::jsonb, $4)",
            [org, name, JSON.stringify(perms), system],
          );
        const reception = await mk(orgB, "Receptionist", ["appointments.manage"]);
        const manager = await mk(orgB, "Manager", ["reports.view"]);
        const agentRole = await mk(orgB, "Agent 2", ["inbox.send"]);
        const custom = await mk(orgA, "Receptionist", ["appointments.manage"], false);
        ids.roles = JSON.stringify([reception, manager, agentRole, custom]);
        ids.reception = reception;
        ids.manager = manager;
        ids.agentRole = agentRole;
        ids.custom = custom;
      });
      // The migration runs as the database owner, not as the service role.
      await c.query(update);
      await c.query(update); // idempotent
      await asServiceRole(c, async () => {
        const { reception, manager, agentRole, custom } = ids;
        const { rows } = await c.query(
          "select id, permissions from public.roles where id = any($1)",
          [[reception, manager, agentRole, custom]],
        );
        const perms = new Map(rows.map((r) => [r.id, r.permissions as string[]]));
        expect(perms.get(reception)).toEqual(["appointments.manage", "frontdesk.use"]);
        expect(perms.get(manager)).toEqual(["reports.view", "frontdesk.use"]);
        expect(perms.get(agentRole)).toEqual(["inbox.send"]);
        expect(perms.get(custom)).toEqual(["appointments.manage"]); // a custom role of the same name is left alone
      });
    });
  });
});
