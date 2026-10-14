/**
 * Sanoflow parity G11: public.unlink_conversation_contact (move a WhatsApp chat to a new contact).
 * Plain Postgres; runs only with TEST_DATABASE_URL. Synthetic names and reserved +44 7700 900xxx numbers only.
 *
 * Covers: the WhatsApp identity moves with the chat; live WhatsApp chats follow the number, closed ones and other
 * channels stay; no message is lost or moved between conversations; the household link, opt-outs and timeline;
 * every refusal leaves everything unchanged; other organisations and browser roles cannot use it.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const PHONE = "+447700900311";

describe.skipIf(!TEST_DATABASE_URL)("unlink_conversation_contact", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;
  let waA: string;
  let waB: string;
  let web: string;
  let oldContact: string;
  let live: string; // the chat being moved (WhatsApp A, open)
  let liveB: string; // another live chat on WhatsApp B: follows the number
  let closedA: string; // an older closed chat on WhatsApp A: stays as history
  let webConv: string; // website chat: not WhatsApp, stays
  let foreign: string; // org B conversation

  async function id(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id::text", params);
    return rows[0].id;
  }

  async function unlink(args: {
    org?: string;
    conversation?: string;
    first?: string;
    last?: string;
    keep?: boolean;
    rel?: string;
  }) {
    return c.query<{
      r: { contact_id: string; old_contact_id: string; conversation_ids: string[] };
    }>("select public.unlink_conversation_contact($1, $2, $3, $4, $5, $6, $7) as r", [
      args.org ?? orgA,
      args.conversation ?? live,
      args.first ?? "Layla",
      args.last ?? "Demo-07",
      args.keep ?? true,
      args.rel ?? "spouse",
      alice,
    ]);
  }

  async function tryUnlink(args: Parameters<typeof unlink>[0]) {
    // The role is set inside the transaction (set local) so a refusal can be rolled back cleanly.
    await c.query("begin");
    try {
      await c.query("set local role service_role");
      const r = await unlink(args);
      await c.query("commit");
      return { ok: true as const, r: r.rows[0].r };
    } catch (e) {
      await c.query("rollback");
      return {
        ok: false as const,
        message: (e as Error).message,
        code: (e as { code?: string }).code,
      };
    }
  }

  async function snapshot() {
    const { rows } = await c.query(
      `select (select json_agg(json_build_object('id', id, 'contact_id', contact_id) order by id) from public.conversations) as convs,
              (select json_agg(json_build_object('id', id, 'conversation_id', conversation_id) order by id) from public.messages) as msgs,
              (select json_agg(json_build_object('id', id, 'phone', phone_e164, 'bsuid', wa_bsuid) order by id) from public.contacts) as contacts,
              (select count(*) from public.household_links) as links`,
    );
    return rows[0];
  }

  beforeAll(async () => {
    c = await connect();
  });

  beforeEach(async () => {
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    waA = await id(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'WABA1', '109900000000011')",
      [orgA],
    );
    waB = await id(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Branch', 'WABA1', '109900000000012')",
      [orgA],
    );
    web = await id(
      "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, 'web', 'Website', '', $2)",
      [orgA, `web:${orgA}`],
    );
    oldContact = await id(
      `insert into public.contacts (org_id, first_name, last_name, phone_e164, wa_bsuid, wa_profile_name, language,
                                    stop_marketing, promotions_opt_in, external_id)
       values ($1, 'Omar', 'Demo-08', $2, 'AE.demo-bsuid-1', 'Demo profile', 'ar', true, true, 'PIN-DEMO-1')`,
      [orgA, PHONE],
    );
    await c.query(
      "insert into public.contact_phones (org_id, contact_id, phone_e164, label) values ($1, $2, $3, 'old'), ($1, $2, '+447700900312', 'work')",
      [orgA, oldContact, PHONE],
    );
    const conv = (channel: string, status: string, at: string) =>
      id(
        "insert into public.conversations (org_id, channel_id, contact_id, status, last_inbound_at, last_message_at) values ($1, $2, $3, $4, $5, $5)",
        [orgA, channel, oldContact, status, at],
      );
    live = await conv(waA, "open", new Date().toISOString());
    liveB = await conv(waB, "waiting", new Date().toISOString());
    closedA = await conv(waA, "closed", "2026-01-01T00:00:00Z");
    webConv = await conv(web, "open", new Date().toISOString());
    for (const cv of [live, live, liveB, closedA, webConv])
      await c.query(
        "insert into public.messages (org_id, conversation_id, direction, kind, body, status, payload, at) values ($1, $2, 'in', 'text', 'synthetic', 'received', $3::jsonb, now() - interval '1 hour')",
        [orgA, cv, JSON.stringify({ from: PHONE.slice(1), id: "wamid.demo" })],
      );
    const chB = await id(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'B', 'WABA2', '109900000000021')",
      [orgB],
    );
    const contactB = await id(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Sara', '+447700900313')",
      [orgB],
    );
    foreign = await id(
      "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
      [orgB, chB, contactB],
    );
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("moves the number and the live WhatsApp chats to a new contact; closed and other-channel chats stay", async () => {
    const messagesBefore = await snapshot();
    const res = await tryUnlink({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { contact_id: newId, old_contact_id, conversation_ids } = res.r;
    expect(old_contact_id).toBe(oldContact);
    expect([...conversation_ids].sort()).toEqual([live, liveB].sort());

    const { rows: nc } = await c.query(
      "select first_name, last_name, phone_e164, wa_bsuid, wa_profile_name, language, stop_marketing, promotions_opt_in, source, external_id, created_by::text from public.contacts where id = $1",
      [newId],
    );
    expect(nc[0]).toEqual({
      first_name: "Layla",
      last_name: "Demo-07",
      phone_e164: PHONE,
      wa_bsuid: "AE.demo-bsuid-1",
      wa_profile_name: "Demo profile",
      language: "ar",
      stop_marketing: true, // opt-outs travel with the number
      promotions_opt_in: false, // consent is never invented
      source: "inbox",
      external_id: null, // the Unite PIN stays with the patient record
      created_by: alice,
    });
    const { rows: oc } = await c.query(
      "select phone_e164, wa_bsuid, wa_profile_name, external_id, deleted_at from public.contacts where id = $1",
      [oldContact],
    );
    expect(oc[0]).toEqual({
      phone_e164: null,
      wa_bsuid: null,
      wa_profile_name: null,
      external_id: "PIN-DEMO-1",
      deleted_at: null,
    });
    // The alternate-phone row with the moved number is gone; other alternates stay.
    expect(
      await count(c, "select 1 from public.contact_phones where contact_id = $1", [oldContact]),
    ).toBe(1);

    const owner = async (conv: string) =>
      (await c.query("select contact_id::text from public.conversations where id = $1", [conv]))
        .rows[0].contact_id;
    expect(await owner(live)).toBe(newId);
    expect(await owner(liveB)).toBe(newId);
    expect(await owner(closedA)).toBe(oldContact);
    expect(await owner(webConv)).toBe(oldContact);

    // No message lost and none moved between conversations.
    const after = await snapshot();
    expect(after.msgs).toEqual(messagesBefore.msgs);

    const { rows: links } = await c.query(
      "select guardian_contact_id::text as g, dependant_contact_id::text as d, relationship, reminders_to_guardian from public.household_links",
    );
    expect(links).toEqual([
      { g: newId, d: oldContact, relationship: "spouse", reminders_to_guardian: true },
    ]);
    expect(
      await count(
        c,
        "select 1 from public.timeline_events where type in ('conversation.moved_out', 'conversation.moved_in') and payload::text not like '%Layla%'",
      ),
    ).toBe(2);
  });

  it("without the family link only the contact and chats change", async () => {
    const res = await tryUnlink({ keep: false, rel: "nonsense-ignored" });
    expect(res.ok).toBe(true);
    expect(await count(c, "select 1 from public.household_links")).toBe(0);
  });

  it("a later inbound match by phone or BSUID finds the new contact (unique identifiers moved, not copied)", async () => {
    const res = await tryUnlink({});
    if (!res.ok) throw new Error(res.message);
    expect(
      await count(c, "select 1 from public.contacts where org_id = $1 and phone_e164 = $2", [
        orgA,
        PHONE,
      ]),
    ).toBe(1);
    expect(
      await count(
        c,
        "select 1 from public.contacts where org_id = $1 and wa_bsuid = 'AE.demo-bsuid-1' and id = $2",
        [orgA, res.r.contact_id],
      ),
    ).toBe(1);
  });

  it("refuses and changes nothing: family links, non-WhatsApp chat, no name, bad relationship, other organisation", async () => {
    const dep = await id(
      "insert into public.contacts (org_id, first_name) values ($1, 'Kid Demo-10')",
      [orgA],
    );
    await c.query(
      "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
      [orgA, oldContact, dep],
    );
    const before = await snapshot();
    const cases: Array<[Parameters<typeof unlink>[0], RegExp]> = [
      [{}, /family links/],
      [{ conversation: webConv }, /only WhatsApp/],
      [{ first: " ", last: "" }, /needs a name/],
      [{ rel: "cousin" }, /unknown relationship/],
      [{ conversation: foreign }, /conversation not found/],
      [{ org: orgB, conversation: live }, /conversation not found/],
    ];
    for (const [args, re] of cases) {
      const r = await tryUnlink(args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(re);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a chat whose latest inbound sender is an alternate number, or a chat nobody wrote in", async () => {
    // The person now writes from the contact's alternate number (+447700900312, in contact_phones).
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, payload) values ($1, $2, 'in', 'text', 'synthetic', 'received', $3::jsonb)",
      [orgA, live, JSON.stringify({ from: "447700900312", id: "wamid.alt" })],
    );
    const before = await snapshot();
    const r = await tryUnlink({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/different number/);
    expect(await snapshot()).toEqual(before);

    await c.query("delete from public.messages where conversation_id = $1", [live]);
    const r2 = await tryUnlink({});
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toMatch(/nobody has written/);
  });

  it("accepts a username user whose BSUID is the contact's", async () => {
    await c.query(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, status, payload) values ($1, $2, 'in', 'text', 'synthetic', 'received', $3::jsonb)",
      [orgA, live, JSON.stringify({ from: "AE.demo-bsuid-1", id: "wamid.bsuid" })],
    );
    expect((await tryUnlink({})).ok).toBe(true);
  });

  it("refuses a contact with no WhatsApp identity", async () => {
    await c.query("update public.contacts set phone_e164 = null, wa_bsuid = null where id = $1", [
      oldContact,
    ]);
    const r = await tryUnlink({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no WhatsApp number/);
  });

  it("browsers cannot call it (service role only)", async () => {
    for (const role of ["authenticated", "anon"]) {
      await c.query("begin");
      let code: string | undefined;
      try {
        await c.query(`set local role ${role}`);
        await c.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: alice, role }),
        ]);
        await unlink({});
      } catch (e) {
        code = (e as { code?: string }).code;
      } finally {
        await c.query("rollback");
      }
      expect(code).toBe("42501");
    }
    // And as a signed-in admin of the organisation through the normal helper, still refused.
    await expect(asUser(c, alice, () => unlink({}))).rejects.toMatchObject({ code: "42501" });
    expect(await count(c, "select 1 from public.household_links")).toBe(0);
  });
});
