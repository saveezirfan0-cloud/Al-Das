/**
 * Phase 20c routing on real Postgres: capacity-aware round-robin and the fallback team (incl. two routings racing for
 * the last place), presence auto-away (sweep, heartbeat, idle-aware picking), the auto-reply claim, the assignment and
 * presence logs, the restricted enquiry view in RLS and in the service-role search, and the G13 report functions.
 * Synthetic data only. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enquiryScopeSql } from "@/lib/enquiries/scope";
import { ParamBag } from "@/lib/filters/to-sql";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 20c routing, presence, enquiry view and reports", () => {
  let c: Client;
  let alice: string; // admin A
  let carol: string; // desk A, team T, limit 1
  let dave: string; // desk A, team T, limit 1
  let erin: string; // desk A, fallback team F
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let teamT: string;
  let teamF: string;
  let channelA: string;
  let n = 0;

  async function one(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id::text as id", params);
    return rows[0].id;
  }

  /** A fresh unowned conversation in org A (one contact per conversation: the live-conversation index allows one each). */
  async function newConversation(): Promise<string> {
    n += 1;
    const contact = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, $2, $3)",
      [
        orgA,
        `Layla Demo-${String(n).padStart(2, "0")}`,
        `+447700900${String(500 + n).padStart(3, "0")}`,
      ],
    );
    return one(
      "insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)",
      [orgA, channelA, contact],
    );
  }

  async function route(conv: string, client: Client = c) {
    const { rows } = await client.query<{ r: Record<string, unknown> }>(
      "select public.route_conversation($1, $2, $3, true) as r",
      [orgA, conv, teamT],
    );
    return rows[0].r;
  }

  async function presence(user: string, p: string, seenMinutesAgo: number | null = 0) {
    await c.query(
      "update public.memberships set presence = $3, last_seen_at = case when $4::int is null then null else now() - make_interval(mins => $4::int) end where org_id = $1 and user_id = $2",
      [orgA, user, p, seenMinutesAgo],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    dave = await createAuthUser(c, "dave@example.test");
    erin = await createAuthUser(c, "erin@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const desk = await one(
        `insert into public.roles (org_id, name, permissions) values ($1, 'Desk', '["inbox.send","enquiries.view","enquiries.manage"]'::jsonb)`,
        [orgA],
      );
      for (const u of [carol, dave, erin])
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
          [orgA, u, desk],
        );
      teamF = await one(
        "insert into public.teams (org_id, name, round_robin) values ($1, 'Overflow', true)",
        [orgA],
      );
      teamT = await one(
        "insert into public.teams (org_id, name, round_robin, fallback_team_id, auto_reply_text) values ($1, 'Front desk', true, $2, 'Thanks, we will reply soon.')",
        [orgA, teamF],
      );
      for (const u of [carol, dave])
        await c.query(
          "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)",
          [orgA, teamT, u],
        );
      await c.query(
        "insert into public.team_members (org_id, team_id, user_id) values ($1, $2, $3)",
        [orgA, teamF, erin],
      );
      await c.query(
        "update public.memberships set max_open_conversations = 1 where org_id = $1 and user_id in ($2, $3)",
        [orgA, carol, dave],
      );
      channelA = await one(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A main', 'waba-20c', 'pn-20c')",
        [orgA],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("teams", () => {
    it("refuses a fallback team from another org or the team itself", async () => {
      await asServiceRole(c, async () => {
        const other = await one("insert into public.teams (org_id, name) values ($1, 'B team')", [
          orgB,
        ]);
        await expect(
          c.query("update public.teams set fallback_team_id = $2 where id = $1", [teamT, other]),
        ).rejects.toThrow(/does not belong/);
        await expect(
          c.query("update public.teams set fallback_team_id = id where id = $1", [teamT]),
        ).rejects.toThrow(/teams_fallback_not_self/);
      });
    });
  });

  describe("capacity-aware round-robin and the fallback team", () => {
    it("fills each member up to their limit, then falls back, then stays put when nobody is online anywhere", async () => {
      await asServiceRole(c, async () => {
        for (const u of [carol, dave, erin]) await presence(u, "online");
        const r1 = await route(await newConversation());
        const r2 = await route(await newConversation());
        expect(new Set([r1.user_id, r2.user_id])).toEqual(new Set([carol, dave]));
        expect(r1).toMatchObject({
          team_id: teamT,
          fallback: false,
          team_online: true,
          auto_reply_text: "Thanks, we will reply soon.",
        });

        // Everyone in T is at their limit of 1: the fallback team takes it.
        const r3 = await route(await newConversation());
        expect(r3).toMatchObject({
          team_id: teamF,
          user_id: erin,
          fallback: true,
          team_online: true,
          auto_reply_text: null,
        });

        // Nobody online in the fallback team either: it stays in T, unowned (T's members are online but full).
        await presence(erin, "offline");
        const c4 = await newConversation();
        const r4 = await route(c4);
        expect(r4).toMatchObject({
          team_id: teamT,
          user_id: null,
          fallback: false,
          team_online: true,
        });
        const { rows } = await c.query(
          "select assignee_team_id, assignee_user_id from public.conversations where id = $1",
          [c4],
        );
        expect(rows[0]).toEqual({ assignee_team_id: teamT, assignee_user_id: null });

        // A closed conversation frees the place.
        await c.query(
          "update public.conversations set status = 'closed', closed_at = now() where assignee_user_id = $1",
          [carol],
        );
        expect((await route(await newConversation())).user_id).toBe(carol);

        // Nobody online in T at all, and the fallback is online: falls back even without round-robin capacity issues.
        await presence(carol, "away");
        await presence(dave, "away");
        await presence(erin, "online");
        const r6 = await route(await newConversation());
        expect(r6).toMatchObject({ team_id: teamF, user_id: erin, fallback: true });

        // Nobody online anywhere: stays in T, and the team counts as unstaffed (the auto-reply case).
        await presence(erin, "offline");
        expect(await route(await newConversation())).toMatchObject({
          team_id: teamT,
          user_id: null,
          team_online: false,
        });
      });
    });

    it("leaves an owned conversation alone", async () => {
      await asServiceRole(c, async () => {
        const conv = await newConversation();
        await c.query("update public.conversations set assignee_user_id = $2 where id = $1", [
          conv,
          alice,
        ]);
        expect(await route(conv)).toMatchObject({ user_id: alice });
        const { rows } = await c.query(
          "select assignee_user_id from public.conversations where id = $1",
          [conv],
        );
        expect(rows[0].assignee_user_id).toBe(alice);
      });
    });

    it("never gives two racing routings the same last place", async () => {
      const c2 = await connect();
      try {
        await asServiceRole(c, async () => {
          // Clean slate: close everything, only carol online in T with a limit of 1, erin online in the fallback team.
          await c.query(
            "update public.conversations set status = 'closed', closed_at = now() where org_id = $1 and status <> 'closed'",
            [orgA],
          );
          await presence(carol, "online");
          await presence(dave, "offline");
          await presence(erin, "online");
        });
        const a = await asServiceRole(c, () => newConversation());
        const b = await asServiceRole(c, () => newConversation());
        await c.query("set role service_role");
        await c2.query("set role service_role");
        await c.query("begin");
        await c2.query("begin");
        const first = await route(a, c);
        const second = await route(b, c2); // carol's capacity lock is held by the first transaction: skipped, not waited on
        await c.query("commit");
        await c2.query("commit");
        await c.query("reset role");
        await c2.query("reset role");
        expect(first).toMatchObject({ user_id: carol, team_id: teamT });
        expect(second).toMatchObject({ user_id: erin, team_id: teamF, fallback: true });
        const { rows } = await c.query<{ n: number }>(
          "select count(*)::int as n from public.conversations where assignee_user_id = $1 and status <> 'closed'",
          [carol],
        );
        expect(rows[0].n).toBe(1);
      } finally {
        await c2.query("rollback").catch(() => {});
        await c2.end();
      }
    });

    it("keeps pick_round_robin_assignee (enquiry rules) free of the conversation limit, and the capped picker honours it", async () => {
      await asServiceRole(c, async () => {
        // carol is at her limit of 1 from the race test, dave is offline.
        const pick = async (fn: string) =>
          (await c.query<{ u: string | null }>(`select public.${fn}($1, $2) as u`, [orgA, teamT]))
            .rows[0].u;
        expect(await pick("pick_round_robin_assignee")).toBe(carol);
        expect(await pick("pick_round_robin_assignee_capped")).toBeNull();
      });
    });
  });

  describe("presence auto-away", () => {
    it("treats a stale online member as away in routing, the sweep marks them away, and their heartbeat brings them back", async () => {
      await asServiceRole(c, async () => {
        await c.query(
          "update public.conversations set status = 'closed', closed_at = now() where org_id = $1 and status <> 'closed'",
          [orgA],
        );
        await presence(carol, "online", 30);
        await presence(dave, "online", 1);
        await presence(erin, "offline");
        // Auto-away off: carol still counts as online.
        expect(
          (await c.query<{ n: number }>("select public.presence_auto_away_sweep() as n")).rows[0].n,
        ).toBe(0);
        await c.query(
          `update public.orgs set settings = jsonb_set(settings, '{inbox}', coalesce(settings->'inbox', '{}') || '{"auto_away_minutes": 10}') where id = $1`,
          [orgA],
        );
        // Auto-away on (10 min): only dave is really online.
        const r = await route(await newConversation());
        expect(r.user_id).toBe(dave);
        expect(
          (await c.query<{ n: number }>("select public.presence_auto_away_sweep() as n")).rows[0].n,
        ).toBe(1);
        const { rows } = await c.query(
          "select presence, presence_auto from public.memberships where org_id = $1 and user_id = $2",
          [orgA, carol],
        );
        expect(rows[0]).toEqual({ presence: "away", presence_auto: true });
      });
      // carol comes back: her heartbeat (as herself) ends the automatic away.
      const back = await asUser(
        c,
        carol,
        async () =>
          (await c.query<{ p: string }>("select public.presence_heartbeat($1) as p", [orgA]))
            .rows[0].p,
      );
      expect(back).toBe("online");
      // A status she picked herself is never overridden by a heartbeat.
      await asUser(c, carol, async () => {
        await c.query("select public.set_presence($1, 'away')", [orgA]);
        expect(
          (await c.query<{ p: string }>("select public.presence_heartbeat($1) as p", [orgA]))
            .rows[0].p,
        ).toBe("away");
      });
      // Bob (another org) cannot touch org A presence.
      await asUser(c, bob, async () => {
        expect(
          (await c.query<{ p: string | null }>("select public.presence_heartbeat($1) as p", [orgA]))
            .rows[0].p,
        ).toBeNull();
      });
      await asServiceRole(c, async () => {
        const { rows } = await c.query<{ presence: string; previous: string; source: string }>(
          "select presence, previous, source from public.member_presence_events where org_id = $1 and user_id = $2 order by id desc limit 3",
          [orgA, carol],
        );
        expect(rows).toEqual([
          { presence: "away", previous: "online", source: "manual" },
          { presence: "online", previous: "away", source: "auto_back" },
          { presence: "away", previous: "online", source: "auto_away" },
        ]);
        await c.query(
          `update public.orgs set settings = settings #- '{inbox,auto_away_minutes}' where id = $1`,
          [orgA],
        );
      });
    });
  });

  describe("logs", () => {
    it("records routing, staff and system assignment changes with their source and actor", async () => {
      await asServiceRole(c, async () => {
        await presence(dave, "online");
        await c.query(
          "update public.conversations set status = 'closed', closed_at = now() where org_id = $1 and status <> 'closed'",
          [orgA],
        );
        const conv = await newConversation();
        await route(conv);
        // A staff member reassigns through a server action: the service-role request carries x-pulse-actor.
        await c.query("select set_config('request.jwt.claims', $1, false)", [
          JSON.stringify({ role: "service_role" }),
        ]);
        await c.query("select set_config('request.headers', $1, false)", [
          JSON.stringify({ "x-pulse-actor": alice }),
        ]);
        await c.query("update public.conversations set assignee_user_id = $2 where id = $1", [
          conv,
          carol,
        ]);
        await c.query("select set_config('request.headers', '', false)");
        await c.query("select set_config('request.jwt.claims', '', false)");
        // A job unassigns it (no actor).
        await c.query("update public.conversations set assignee_user_id = null where id = $1", [
          conv,
        ]);
        const { rows } = await c.query(
          "select kind, from_user_id, to_user_id, to_team_id, actor_id, source from public.conversation_assignment_events where conversation_id = $1 order by id",
          [conv],
        );
        expect(rows).toEqual([
          {
            kind: "assigned",
            from_user_id: null,
            to_user_id: dave,
            to_team_id: teamT,
            actor_id: null,
            source: "routing",
          },
          {
            kind: "reassigned",
            from_user_id: dave,
            to_user_id: carol,
            to_team_id: teamT,
            actor_id: alice,
            source: "user",
          },
          {
            kind: "unassigned",
            from_user_id: carol,
            to_user_id: null,
            to_team_id: teamT,
            actor_id: null,
            source: "system",
          },
        ]);
      });
    });

    it("shows the logs to people with reports.view only, and never to another org", async () => {
      const count = async (user: string, table: string) =>
        asUser(
          c,
          user,
          async () =>
            (await c.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0]
              .n,
        );
      expect(await count(alice, "conversation_assignment_events")).toBeGreaterThan(0);
      expect(await count(carol, "conversation_assignment_events")).toBe(0);
      expect(await count(bob, "conversation_assignment_events")).toBe(0);
      expect(await count(alice, "member_presence_events")).toBeGreaterThan(0);
      // carol sees her own status log, not dave's
      const own = await asUser(c, carol, async () =>
        (
          await c.query<{ u: string }>(
            "select distinct user_id::text as u from public.member_presence_events",
          )
        ).rows.map((r) => r.u),
      );
      expect(own).toEqual([carol]);
      expect(await count(bob, "member_presence_events")).toBe(0);
      // no client writes
      await asUser(c, alice, async () => {
        await expect(
          c.query(
            "insert into public.member_presence_events (org_id, user_id, presence, source) values ($1, $2, 'online', 'manual')",
            [orgA, alice],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it("does not block deleting a team or a profile that appears in the log", async () => {
      await asServiceRole(c, async () => {
        const temp = await one("insert into public.teams (org_id, name) values ($1, 'Temporary')", [
          orgA,
        ]);
        const conv = await newConversation();
        await c.query("update public.conversations set assignee_team_id = $2 where id = $1", [
          conv,
          temp,
        ]);
        await c.query("delete from public.teams where id = $1", [temp]);
        const { rows } = await c.query(
          "select kind, from_team_id, to_team_id from public.conversation_assignment_events where conversation_id = $1 order by id",
          [conv],
        );
        expect(rows).toEqual([
          { kind: "team_changed", from_team_id: null, to_team_id: temp },
          { kind: "team_changed", from_team_id: temp, to_team_id: null },
        ]);
      });
    });
  });

  describe("auto-reply claim", () => {
    it("claims auto_reply_sent_at exactly once per conversation", async () => {
      await asServiceRole(c, async () => {
        const conv = await newConversation();
        const claim = () =>
          c.query(
            "update public.conversations set auto_reply_sent_at = now() where id = $1 and org_id = $2 and auto_reply_sent_at is null returning id",
            [conv, orgA],
          );
        expect((await claim()).rowCount).toBe(1);
        expect((await claim()).rowCount).toBe(0);
      });
    });
  });

  describe("restricted enquiry view", () => {
    const e: Record<string, string> = {};

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        const pipeline = await one(
          "insert into public.pipelines (org_id, name) values ($1, 'Leads 20c')",
          [orgA],
        );
        const stage = await one(
          "insert into public.stages (org_id, pipeline_id, name) values ($1, $2, 'New')",
          [orgA, pipeline],
        );
        const ins = (title: string, assignee: string | null, createdBy: string | null) =>
          one(
            "insert into public.enquiries (org_id, pipeline_id, stage_id, title, assignee_id, created_by) values ($1, $2, $3, $4, $5, $6)",
            [orgA, pipeline, stage, title, assignee, createdBy],
          );
        e.carol = await ins("Assigned to carol", carol, alice);
        e.dave = await ins("Assigned to dave", dave, alice);
        e.carolDraft = await ins("Unassigned, created by carol", null, carol);
        e.system = await ins("Unassigned, from a rule", null, null);
        e.erin = await ins("Assigned to erin", erin, alice);
        await c.query(
          "update public.memberships set enquiry_scope = 'own' where org_id = $1 and user_id = $2",
          [orgA, carol],
        );
        await c.query(
          "update public.memberships set enquiry_scope = 'team' where org_id = $1 and user_id = $2",
          [orgA, dave],
        );
      });
    });

    const titles = async (user: string) =>
      asUser(c, user, async () =>
        (
          await c.query<{ title: string }>(
            "select title from public.enquiries where pipeline_id in (select id from public.pipelines where name = 'Leads 20c') order by title",
          )
        ).rows.map((r) => r.title),
      );

    it("enforces own / team / all in RLS, and another org sees nothing", async () => {
      expect(await titles(carol)).toEqual(["Assigned to carol", "Unassigned, created by carol"]);
      expect(await titles(dave)).toEqual([
        "Assigned to carol",
        "Assigned to dave",
        "Unassigned, created by carol",
        "Unassigned, from a rule",
      ]);
      expect(await titles(erin)).toHaveLength(5); // default 'all': no behaviour change
      expect(await titles(alice)).toHaveLength(5);
      expect(await titles(bob)).toEqual([]);
    });

    it("blocks updates and deletes of enquiries outside the view", async () => {
      await asUser(c, carol, async () => {
        const r = await c.query("update public.enquiries set title = 'hijacked' where id = $1", [
          e.dave,
        ]);
        expect(r.rowCount).toBe(0);
        const ok = await c.query(
          "update public.enquiries set title = 'Assigned to carol' where id = $1",
          [e.carol],
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it("applies the same rule to the service-role search and the id filter", async () => {
      await asServiceRole(c, async () => {
        const bag = new ParamBag();
        const where = `(true) and ${enquiryScopeSql({ userId: carol, scope: "own" }, (v) => bag.text(v), "e")}`;
        const { rows } = await c.query<{ id: string }>(
          "select id::text from public.enquiries_search($1, $2, $3::jsonb)",
          [orgA, where, JSON.stringify(bag.params)],
        );
        expect(new Set(rows.map((r) => r.id))).toEqual(new Set([e.carol, e.carolDraft]));
        const ids = await c.query<{ id: string }>(
          "select public.enquiry_ids_visible_to($1, $2, $3::uuid[])::text as id",
          [orgA, dave, Object.values(e)],
        );
        expect(new Set(ids.rows.map((r) => r.id))).toEqual(
          new Set([e.carol, e.dave, e.carolDraft, e.system]),
        );
        const none = await c.query("select public.enquiry_ids_visible_to($1, $2, $3::uuid[])", [
          orgA,
          bob,
          Object.values(e),
        ]);
        expect(none.rowCount).toBe(0);
      });
    });

    it("hides the tags of enquiries outside the view and refuses tagging them", async () => {
      await asServiceRole(c, async () => {
        const tag = await one(
          "insert into public.tags (org_id, name, scope) values ($1, 'VIP 20c', 'enquiry')",
          [orgA],
        );
        e.tag = tag;
        for (const id of [e.carol, e.dave])
          await c.query(
            "insert into public.enquiry_tags (org_id, enquiry_id, tag_id) values ($1, $2, $3)",
            [orgA, id, tag],
          );
      });
      await asUser(c, carol, async () => {
        const { rows } = await c.query<{ enquiry_id: string }>(
          "select enquiry_id::text from public.enquiry_tags where tag_id = $1",
          [e.tag],
        );
        expect(rows.map((r) => r.enquiry_id)).toEqual([e.carol]);
        const del = await c.query("delete from public.enquiry_tags where enquiry_id = $1", [
          e.dave,
        ]);
        expect(del.rowCount).toBe(0);
        await expect(
          c.query(
            "insert into public.enquiry_tags (org_id, enquiry_id, tag_id) values ($1, $2, $3)",
            [orgA, e.system, e.tag],
          ),
        ).rejects.toThrow(/row-level security|does not belong/); // the parent check cannot see it either
      });
      expect(
        await asUser(
          c,
          alice,
          async () =>
            (await c.query("select 1 from public.enquiry_tags where tag_id = $1", [e.tag]))
              .rowCount,
        ),
      ).toBe(2);
      await asServiceRole(c, () => c.query("delete from public.tags where id = $1", [e.tag]));
      delete e.tag;
    });

    it("a suspended member sees nothing", async () => {
      await asServiceRole(c, () =>
        c.query(
          "update public.memberships set status = 'suspended' where org_id = $1 and user_id = $2",
          [orgA, erin],
        ),
      );
      expect(await titles(erin)).toEqual([]);
      await asServiceRole(c, () =>
        c.query(
          "update public.memberships set status = 'active' where org_id = $1 and user_id = $2",
          [orgA, erin],
        ),
      );
    });

    it("adds branch access (Phase B) on top of the view, in RLS and in the service-role search", async () => {
      const branch: Record<string, string> = {};
      await asServiceRole(c, async () => {
        for (const name of ["North 20c", "South 20c"])
          branch[name] = await one("insert into public.locations (org_id, name) values ($1, $2)", [
            orgA,
            name,
          ]);
        await c.query("update public.enquiries set location_id = $2 where id = $1", [
          e.carol,
          branch["North 20c"],
        ]);
        await c.query("update public.enquiries set location_id = $2 where id = $1", [
          e.carolDraft,
          branch["South 20c"],
        ]);
        await c.query(
          "update public.memberships set branch_scope = 'selected' where org_id = $1 and user_id = $2",
          [orgA, carol],
        );
        await c.query(
          `insert into public.membership_locations (org_id, membership_id, location_id)
           select $1, m.id, $3 from public.memberships m where m.org_id = $1 and m.user_id = $2`,
          [orgA, carol, branch["North 20c"]],
        );
      });
      try {
        expect(await titles(carol)).toEqual(["Assigned to carol"]);
        await asServiceRole(c, async () => {
          const search = async (scope: "own" | "all") => {
            const bag = new ParamBag();
            const where = `(true) and ${enquiryScopeSql({ userId: carol, scope, branchScope: "selected" }, (v) => bag.text(v), "e")}`;
            const { rows } = await c.query<{ id: string }>(
              "select id::text from public.enquiries_search($1, $2, $3::jsonb)",
              [orgA, where, JSON.stringify(bag.params)],
            );
            return new Set(rows.map((r) => r.id));
          };
          // Same rows as RLS: own view and branch together.
          expect(await search("own")).toEqual(new Set([e.carol]));
          // Branch alone: every enquiry without a branch, plus the North one.
          expect(await search("all")).toEqual(new Set([e.carol, e.dave, e.system, e.erin]));
        });
      } finally {
        await asServiceRole(c, async () => {
          await c.query(
            "delete from public.membership_locations where location_id = any($1::uuid[])",
            [Object.values(branch)],
          );
          await c.query(
            "update public.memberships set branch_scope = 'all' where org_id = $1 and user_id = $2",
            [orgA, carol],
          );
          await c.query(
            "update public.enquiries set location_id = null where id = any($1::uuid[])",
            [[e.carol, e.carolDraft]],
          );
        });
      }
      expect(await titles(carol)).toEqual(["Assigned to carol", "Unassigned, created by carol"]);
    });
  });

  describe("G13 report functions", () => {
    let localToday = "";
    const today = () => localToday;

    it("measure assignment to close, owner removed, AI engagement, cohorts and presence", async () => {
      const frank = await createAuthUser(c, "frank@example.test");
      await asServiceRole(c, async () => {
        const role = (
          await c.query<{ id: string }>(
            "select id from public.roles where org_id = $1 and name = 'Desk'",
            [orgA],
          )
        ).rows[0].id;
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
          [orgA, frank, role],
        );
        // Report days are org-local (Asia/Dubai), not UTC.
        localToday = (
          await c.query<{ d: string }>(
            "select (now() at time zone timezone)::date::text as d from public.orgs where id = $1",
            [orgA],
          )
        ).rows[0].d;
        // A conversation assigned 2 h ago, reassigned 1 h ago and closed now, with a flow message and no staff reply.
        const conv = await newConversation();
        await c.query(
          "update public.conversations set assignee_user_id = $2, assignee_team_id = $3 where id = $1",
          [conv, dave, teamT],
        );
        await c.query("update public.conversations set assignee_user_id = $2 where id = $1", [
          conv,
          frank,
        ]);
        await c.query(
          "update public.conversation_assignment_events set at = now() - case when kind = 'assigned' then interval '2 hours' else interval '1 hour' end where conversation_id = $1",
          [conv],
        );
        await c
          .query(
            "insert into public.messages (org_id, conversation_id, direction, kind, body, status, flow_run_id) values ($1, $2, 'out', 'text', 'Automated hello', 'sent', gen_random_uuid())",
            [orgA, conv],
          )
          .catch(async () => {
            // flow_run_id may carry a foreign key: fall back to an automated message without it
            await c.query(
              "insert into public.messages (org_id, conversation_id, direction, kind, body, status) values ($1, $2, 'out', 'text', 'Automated hello', 'sent')",
              [orgA, conv],
            );
          });
        await c.query(
          "update public.conversations set status = 'closed', closed_at = now() where id = $1",
          [conv],
        );

        const close = await c.query(
          "select * from public.report_assignment_close($1, $2, $2, null, $3::uuid[])",
          [orgA, today(), [frank]],
        );
        const total = close.rows.find((r) => r.is_total);
        expect(total).toMatchObject({ closed: 1, with_assignment: 1 });
        const mine = close.rows.find((r) => !r.is_total);
        expect(mine.user_id).toBe(frank);
        expect(Math.abs(Number(mine.first_median_seconds) - 7200)).toBeLessThanOrEqual(10);
        expect(Math.abs(Number(mine.last_median_seconds) - 3600)).toBeLessThanOrEqual(10);

        const removed = await c.query(
          "select * from public.report_owner_removed($1, $2, $2, null, $3::uuid[])",
          [orgA, today(), [dave]],
        );
        const daveRow = removed.rows.find((r) => !r.is_total);
        expect(daveRow).toMatchObject({ user_id: dave });
        expect(daveRow.reassigned).toBeGreaterThanOrEqual(1);

        const ai = await c.query("select * from public.report_ai_engagement($1, $2, $2)", [
          orgA,
          today(),
        ]);
        expect(ai.rows[0].closed).toBeGreaterThanOrEqual(1);
        expect(ai.rows[0].closed_without_human).toBeGreaterThanOrEqual(1);
        expect(ai.rows[0].handled_by_automation).toBeGreaterThanOrEqual(1);

        const cohorts = await c.query("select * from public.report_enquiry_cohorts($1, $2, $2)", [
          orgA,
          today(),
        ]);
        expect(cohorts.rows.reduce((s, r) => s + r.created, 0)).toBe(5);

        const p = await c.query<{
          j: {
            seed: Array<{ user_id: string; presence: string }>;
            events: unknown[];
            truncated: boolean;
          };
        }>(
          "select public.report_presence_events($1, now() - interval '1 day', now() + interval '1 minute') as j",
          [orgA],
        );
        expect(p.rows[0].j.truncated).toBe(false);
        expect(p.rows[0].j.events.length).toBeGreaterThan(0);
        expect(p.rows[0].j.seed.map((s) => s.user_id)).toContain(carol);

        // Org B sees none of org A's numbers through its own org id.
        const b = await c.query("select * from public.report_ai_engagement($1, $2, $2)", [
          orgB,
          today(),
        ]);
        expect(b.rows[0].closed).toBe(0);
      });
    });

    it("cannot be called by signed-in users", async () => {
      await asUser(c, alice, async () => {
        await expect(
          c.query("select * from public.report_owner_removed($1, '2026-01-01', '2026-12-31')", [
            orgA,
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          c.query("select public.report_presence_events($1, now(), now())", [orgA]),
        ).rejects.toThrow(/permission denied/);
        await expect(c.query("select count(*) from public.v_assignment_events")).rejects.toThrow(
          /permission denied/,
        );
      });
    });
  });
});
