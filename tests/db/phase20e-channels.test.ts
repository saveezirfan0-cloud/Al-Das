/**
 * Phase 20e: website chat, Instagram / Messenger and the Google Calendar mirror, database side. Cross-org isolation of the new
 * tables, the inbound functions (visitor -> contact -> conversation -> message; platform id -> contact), idempotency, erasure and
 * merges, the channel type constraints, and the read-only busy-block mirror. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { createHash, randomBytes } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  seedPhase20eRows,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => sha(randomBytes(32).toString("base64url"));

describe.skipIf(!TEST_DATABASE_URL)("phase 20e: channels and calendar mirror", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;
  let webA: string;
  let igA: string;
  let fbA: string;
  let webB: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "error",
    );
  const channel = async (org: string, type: string, ref: string) =>
    (
      await svc(() =>
        q(
          "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, $2, $2, '', $3) returning id::text",
          [org, type, `${type}:${ref}`],
        ),
      )
    ).rows[0].id as string;
  const web = (
    org: string,
    ch: string,
    hash: string,
    create: boolean,
    clientId: string,
    body = "Hello, I would like an appointment",
    name = "",
  ) =>
    svc(async () => {
      const { rows } = await q("select public.web_chat_receive($1, $2, $3, $4, $5, $6, $7) as r", [
        org,
        ch,
        hash,
        create,
        name,
        clientId,
        body,
      ]);
      return rows[0].r as Record<string, unknown>;
    });
  const social = (
    org: string,
    ch: string,
    platform: string,
    sender: string,
    mid: string,
    body = "Hi",
    kind = "text",
  ) =>
    svc(async () => {
      const { rows } = await q(
        "select public.channel_receive_social($1, $2, $3, $4, $5, $6, $7) as r",
        [org, ch, platform, sender, mid, kind, body],
      );
      return rows[0].r as Record<string, unknown>;
    });

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    webA = await channel(orgA, "web", orgA);
    igA = await channel(orgA, "instagram", "17841400000000001");
    fbA = await channel(orgA, "messenger", "100000000000001");
    webB = await channel(orgB, "web", orgB);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("channel rows", () => {
    it("accepts the new types only with the namespaced reference and no WhatsApp account", async () => {
      expect(
        await code(
          svc(() =>
            q(
              "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, 'web', 'x', 'WABA1', 'web:abc')",
              [orgA],
            ),
          ),
        ),
      ).toBe("23514");
      expect(
        await code(
          svc(() =>
            q(
              "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, 'instagram', 'x', '', '1234567')",
              [orgA],
            ),
          ),
        ),
      ).toBe("23514");
      expect(
        await code(
          svc(() =>
            q(
              "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, 'telegram', 'x', '', 'telegram:1')",
              [orgA],
            ),
          ),
        ),
      ).toBe("23514");
      // WhatsApp rows are unchanged
      expect(
        await code(
          svc(() =>
            q(
              "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'WA', 'WABA9', '109900000000001')",
              [orgA],
            ),
          ),
        ),
      ).toBeNull();
    });
  });

  describe("website chat", () => {
    it("turns a first message into a contact without a phone, a conversation and a message", async () => {
      const h = token();
      const r = await web(orgA, webA, h, true, "client-000001", "Hello", "Layla Demo-21");
      expect(r).toMatchObject({ duplicate: false, opened: true, created_contact: true });
      const { rows: contact } = await svc(() =>
        q(
          "select first_name, last_name, phone_e164, wa_bsuid, source from public.contacts where id = $1",
          [r.contact_id],
        ),
      );
      expect(contact[0]).toEqual({
        first_name: "Layla Demo-21",
        last_name: "",
        phone_e164: null,
        wa_bsuid: null,
        source: "web_chat",
      });
      const { rows: conv } = await svc(() =>
        q(
          "select channel_id, status, unread_count, last_message_direction, last_inbound_at is not null as inbound from public.conversations where id = $1",
          [r.conversation_id],
        ),
      );
      expect(conv[0]).toEqual({
        channel_id: webA,
        status: "open",
        unread_count: 1,
        last_message_direction: "in",
        inbound: true,
      });
      const { rows: msg } = await svc(() =>
        q("select direction, kind, body, status from public.messages where id = $1", [
          r.message_id,
        ]),
      );
      expect(msg[0]).toEqual({ direction: "in", kind: "text", body: "Hello", status: "received" });
      const { rows: sess } = await svc(() =>
        q(
          "select contact_id, conversation_id from public.web_chat_sessions where token_hash = $1",
          [h],
        ),
      );
      expect(sess[0]).toEqual({ contact_id: r.contact_id, conversation_id: r.conversation_id });
    });

    it("keeps the same visitor in the same conversation and ignores a repeated message id", async () => {
      const h = token();
      const first = await web(orgA, webA, h, true, "client-000002");
      const second = await web(orgA, webA, h, false, "client-000003", "Second");
      expect(second).toMatchObject({
        duplicate: false,
        opened: false,
        conversation_id: first.conversation_id,
        contact_id: first.contact_id,
        created_contact: false,
      });
      const again = await web(orgA, webA, h, false, "client-000003", "Second");
      expect(again).toMatchObject({ duplicate: true, message_id: second.message_id });
      const { rows } = await svc(() =>
        q(
          "select count(*)::int as n, max(unread_count) as u from public.messages m join public.conversations c on c.id = m.conversation_id where m.conversation_id = $1",
          [first.conversation_id],
        ),
      );
      expect(rows[0]).toEqual({ n: 2, u: 2 });
    });

    it("never lets a token work in another workspace or channel, and never invents a session without p_create", async () => {
      const h = token();
      await web(orgA, webA, h, true, "client-000004");
      expect(await web(orgB, webB, h, false, "client-000005")).toEqual({ error: "session" });
      expect(await web(orgA, webA, token(), false, "client-000006")).toEqual({ error: "session" });
      expect(await web(orgA, igA, token(), true, "client-000007")).toEqual({ error: "channel" });
      expect(await code(web(orgA, webA, "not-a-hash", true, "client-000008"))).toBe("23514");
      expect(await code(web(orgA, webA, token(), true, "bad id"))).toBe("23514");
    });

    it("opens a new conversation after the previous one was closed", async () => {
      const h = token();
      const first = await web(orgA, webA, h, true, "client-000010");
      await svc(() =>
        q("update public.conversations set status = 'closed', closed_at = now() where id = $1", [
          first.conversation_id,
        ]),
      );
      const next = await web(orgA, webA, h, false, "client-000011");
      expect(next.opened).toBe(true);
      expect(next.conversation_id).not.toBe(first.conversation_id);
      const { rows } = await svc(() =>
        q("select conversation_id from public.web_chat_sessions where token_hash = $1", [h]),
      );
      expect(rows[0].conversation_id).toBe(next.conversation_id);
    });
  });

  describe("Instagram and Messenger", () => {
    it("matches the sender by the platform-scoped id on this channel only, never by phone", async () => {
      const a = await social(orgA, igA, "instagram", "900000000000001", "mid.a1", "Hi there");
      expect(a).toMatchObject({ created_contact: true, opened: true, duplicate: false });
      const b = await social(orgA, igA, "instagram", "900000000000001", "mid.a2", "Again");
      expect(b).toMatchObject({
        created_contact: false,
        contact_id: a.contact_id,
        conversation_id: a.conversation_id,
      });
      // the same number on Messenger is a different, page-scoped person
      const m = await social(orgA, fbA, "messenger", "900000000000001", "mid.m1");
      expect(m.contact_id).not.toBe(a.contact_id);
      const { rows } = await svc(() =>
        q("select first_name, last_name, phone_e164, source from public.contacts where id = $1", [
          a.contact_id,
        ]),
      );
      expect(rows[0]).toEqual({
        first_name: "Instagram",
        last_name: "user",
        phone_e164: null,
        source: "instagram",
      });
      const { rows: ids } = await svc(() =>
        q(
          "select platform, external_id, channel_id from public.contact_channel_identities where contact_id = $1",
          [a.contact_id],
        ),
      );
      expect(ids).toEqual([
        { platform: "instagram", external_id: "900000000000001", channel_id: igA },
      ]);
      const { rows: msg } = await svc(() =>
        q("select wa_message_id, body from public.messages where id = $1", [a.message_id]),
      );
      expect(msg[0]).toEqual({ wa_message_id: "ig:mid.a1", body: "Hi there" });
    });

    it("stores an attachment as unsupported without its link, and is idempotent per message id", async () => {
      const r = await social(
        orgA,
        fbA,
        "messenger",
        "900000000000002",
        "mid.att",
        "",
        "unsupported",
      );
      const { rows } = await svc(() =>
        q("select kind, body, payload from public.messages where id = $1", [r.message_id]),
      );
      expect(rows[0]).toEqual({ kind: "unsupported", body: "", payload: {} });
      expect(
        await social(orgA, fbA, "messenger", "900000000000002", "mid.att", "", "unsupported"),
      ).toMatchObject({
        duplicate: true,
      });
    });

    it("refuses a wrong platform, a malformed id and a channel of another workspace", async () => {
      expect(await social(orgA, igA, "messenger", "900000000000003", "mid.x")).toEqual({
        error: "channel",
      });
      expect(await social(orgB, igA, "instagram", "900000000000003", "mid.y")).toEqual({
        error: "channel",
      });
      expect(await code(social(orgA, igA, "instagram", "+971500000000", "mid.z"))).toBe("23514");
      expect(await code(social(orgA, igA, "whatsapp", "900000000000003", "mid.z"))).toBe("23514");
    });

    it("gives a sender whose contact was deleted (not merged) a fresh contact", async () => {
      const a = await social(orgA, igA, "instagram", "900000000000004", "mid.d1");
      await svc(() =>
        q("update public.contacts set deleted_at = now() where id = $1", [a.contact_id]),
      );
      const b = await social(orgA, igA, "instagram", "900000000000004", "mid.d2");
      expect(b.created_contact).toBe(true);
      expect(b.contact_id).not.toBe(a.contact_id);
    });
  });

  describe("erasure and merges", () => {
    it("erasing a contact removes their platform ids and widget sessions", async () => {
      const h = token();
      const w = await web(orgA, webA, h, true, "client-000020");
      const s = await social(orgA, igA, "instagram", "900000000000010", "mid.e1");
      // the same person wrote on Instagram and on the website: staff merged the two
      await svc(() =>
        q("select public.merge_contacts($1, $2, $3, '{}'::jsonb, $4)", [
          orgA,
          s.contact_id,
          w.contact_id,
          alice,
        ]),
      );
      const { rows: moved } = await svc(() =>
        q("select contact_id from public.web_chat_sessions where token_hash = $1", [h]),
      );
      expect(moved[0].contact_id).toBe(s.contact_id);
      await svc(() => q("select public.erase_contact($1, $2, $3)", [orgA, s.contact_id, alice]));
      const left = await svc(() =>
        q(
          "select (select count(*) from public.contact_channel_identities where contact_id = $1)::int as ids, (select count(*) from public.web_chat_sessions where contact_id = $1)::int as sessions",
          [s.contact_id],
        ),
      );
      expect(left.rows[0]).toEqual({ ids: 0, sessions: 0 });
      // the old browser token no longer finds anything
      expect(await web(orgA, webA, h, false, "client-000021")).toEqual({ error: "session" });
    });
  });

  describe("row security", () => {
    beforeAll(async () => {
      await seedPhase20eRows(c, orgA, alice);
    });

    it("hides org A's platform ids and event links from org B, and the token tables from everyone", async () => {
      await asUser(c, bob, async () => {
        for (const t of ["contact_channel_identities", "gcal_event_links"]) {
          const { rows } = await q(`select count(*)::int as n from public.${t} where org_id = $1`, [
            orgA,
          ]);
          expect(rows[0].n, t).toBe(0);
        }
      });
      await asUser(c, alice, async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.contact_channel_identities where org_id = $1",
          [orgA],
        );
        expect(rows[0].n).toBeGreaterThan(0);
        for (const t of ["web_chat_sessions", "gcal_connections", "gcal_oauth_states"]) {
          const n = await q(`select count(*)::int as n from public.${t}`).then(
            (r) => r.rows[0].n as number,
            () => 0,
          );
          expect(n, t).toBe(0);
        }
      });
    });

    it("lets no browser write the new tables or call the functions", async () => {
      await asUser(c, alice, async () => {
        expect(
          await code(
            q(
              "insert into public.contact_channel_identities (org_id, channel_id, contact_id, platform, external_id) select $1, $2, id, 'instagram', '42' from public.contacts where org_id = $1 limit 1",
              [orgA, igA],
            ),
          ),
        ).toBe("42501");
        expect(
          await code(
            q("select public.web_chat_receive($1, $2, $3, true, '', 'client-000099', 'x')", [
              orgA,
              webA,
              token(),
            ]),
          ),
        ).toBe("42501");
        expect(
          await code(q("select public.gcal_clear_busy_blocks($1, gen_random_uuid())", [orgA])),
        ).toBe("42501");
      });
    });
  });

  describe("Google busy blocks (read-only mirror)", () => {
    let spec: string;
    const from = () => new Date(Date.now() - 86_400_000).toISOString();
    const to = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const apply = (blocks: unknown[], f = from(), t = to()) =>
      svc(async () => {
        const { rows } = await q(
          "select public.gcal_apply_busy_blocks($1, $2, $3, $4, $5::jsonb) as r",
          [orgA, spec, f, t, JSON.stringify(blocks)],
        );
        return rows[0].r as Record<string, number>;
      });
    const blocks = () =>
      svc(
        async () =>
          (
            await q(
              "select external_key, starts_at, ends_at, reason, location_id from public.time_blocks where specialist_id = $1 and source = 'google' order by starts_at",
              [spec],
            )
          ).rows,
      );

    beforeAll(async () => {
      spec = (
        await svc(() =>
          q(
            "insert into public.specialists (org_id, name) values ($1, 'Dr Mirror') returning id::text",
            [orgA],
          ),
        )
      ).rows[0].id;
      await svc(() =>
        q(
          "insert into public.time_blocks (org_id, specialist_id, starts_at, ends_at, reason) values ($1, $2, $3, $4, 'Lunch')",
          [orgA, spec, at(5), at(6)],
        ),
      );
    });

    it("is idempotent: the same busy times give the same rows; changes update, missing ones go", async () => {
      const b1 = { key: sha("gcal:e1"), starts_at: at(24), ends_at: at(25) };
      const b2 = { key: sha("gcal:e2"), starts_at: at(48), ends_at: at(49) };
      expect(await apply([b1, b2])).toEqual({ inserted: 2, updated: 0, deleted: 0 });
      const first = await blocks();
      expect(await apply([b1, b2])).toEqual({ inserted: 0, updated: 0, deleted: 0 });
      expect(await blocks()).toEqual(first);
      expect(
        first.every((r) => r.reason === "Busy (Google Calendar)" && r.location_id === null),
      ).toBe(true);
      expect(await apply([{ ...b1, ends_at: at(26) }])).toEqual({
        inserted: 0,
        updated: 1,
        deleted: 1,
      });
      expect((await blocks()).map((r) => r.external_key)).toEqual([b1.key]);
      // the manual block is never touched
      const { rows } = await svc(() =>
        q(
          "select count(*)::int as n from public.time_blocks where specialist_id = $1 and source = 'manual'",
          [spec],
        ),
      );
      expect(rows[0].n).toBe(1);
    });

    it("only replaces blocks inside the window it read", async () => {
      const far = { key: sha("gcal:far"), starts_at: at(24 * 40), ends_at: at(24 * 40 + 1) };
      await apply([far], from(), new Date(Date.now() + 60 * 86_400_000).toISOString());
      await apply([], from(), to()); // a shorter window: the far block is outside it and stays
      expect((await blocks()).map((r) => r.external_key)).toEqual([far.key]);
    });

    it("refuses any other writer of a Google block, but lets the specialist be deleted", async () => {
      await apply([{ key: sha("gcal:g1"), starts_at: at(30), ends_at: at(31) }]);
      expect(
        await code(
          svc(() =>
            q(
              "insert into public.time_blocks (org_id, specialist_id, starts_at, ends_at, source, external_key) values ($1, $2, $3, $4, 'google', $5)",
              [orgA, spec, at(70), at(71), sha("x")],
            ),
          ),
        ),
      ).toBe("23514");
      expect(
        await code(
          svc(() =>
            q("delete from public.time_blocks where specialist_id = $1 and source = 'google'", [
              spec,
            ]),
          ),
        ),
      ).toBe("23514");
      expect(
        await code(
          svc(() =>
            q(
              "update public.time_blocks set reason = 'x' where specialist_id = $1 and source = 'google'",
              [spec],
            ),
          ),
        ),
      ).toBe("23514");
      // the booking check sees the block
      const { rows } = await svc(() =>
        q(
          "select exists (select 1 from public.time_blocks where specialist_id = $1 and starts_at < $3 and ends_at > $2) as busy",
          [spec, at(30), at(31)],
        ),
      );
      expect(rows[0].busy).toBe(true);
      expect(
        await svc(
          async () =>
            (await q("select public.gcal_clear_busy_blocks($1, $2) as n", [orgA, spec])).rows[0].n,
        ),
      ).toBeGreaterThan(0);
      expect(await blocks()).toEqual([]);
      await apply([{ key: sha("gcal:g2"), starts_at: at(30), ends_at: at(31) }]);
      expect(
        await code(svc(() => q("delete from public.specialists where id = $1", [spec]))),
      ).toBeNull();
    });

    it("refuses a specialist of another workspace", async () => {
      const other = (
        await svc(() =>
          q(
            "insert into public.specialists (org_id, name) values ($1, 'Dr B') returning id::text",
            [orgB],
          ),
        )
      ).rows[0].id;
      expect(
        await code(
          svc(() =>
            q(
              "select public.gcal_apply_busy_blocks($1, $2, now(), now() + interval '1 day', '[]'::jsonb)",
              [orgA, other],
            ),
          ),
        ),
      ).toBe("P0002");
    });
  });
});
