/**
 * Recall tables: programme configuration is readable by members and writable with flows.manage;
 * sends and runs are PHI, so reads need the clinical follow-up key; nothing crosses organisations.
 * Fake data only. Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("recall (rls)", () => {
  let c: Client;
  let alice: string; // admin org A
  let bob: string; // admin org B
  let coordinator: string; // org A: portal.clinical_followups.read/write
  let agent: string; // org A: inbox only
  let orgA: string;
  let orgB: string;
  let progA: string;
  let sendA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    coordinator = await createAuthUser(c, "coord@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const role = async (name: string, perms: string[]) =>
        (
          await c.query<{ id: string }>(
            "insert into public.roles (org_id, name, permissions) values ($1,$2,$3::jsonb) returning id",
            [orgA, name, JSON.stringify(perms)],
          )
        ).rows[0].id;
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1,$2,$3)", [
        orgA,
        coordinator,
        await role("Coordinator", [
          "portal.clinical_followups.read",
          "portal.clinical_followups.write",
        ]),
      ]);
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1,$2,$3)", [
        orgA,
        agent,
        await role("Front desk", ["inbox.send"]),
      ]);
      await c.query("select public.seed_recall_programmes($1)", [orgA]);
      await c.query("select public.seed_recall_programmes($1)", [orgB]);
      progA = (
        await c.query<{ id: string }>(
          "select id from public.recall_programmes where org_id=$1 and key='chronic_90d'",
          [orgA],
        )
      ).rows[0].id;
      const contact = (
        await c.query<{ id: string }>(
          "insert into public.contacts (org_id, first_name) values ($1,'T') returning id",
          [orgA],
        )
      ).rows[0].id;
      sendA = (
        await c.query<{ id: string }>(
          "insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key) values ($1,$2,$3,'2026-06-01') returning id",
          [orgA, progA, contact],
        )
      ).rows[0].id;
      await c.query(
        "insert into public.recall_runs (org_id, programme_id, send_mode) values ($1,$2,'test')",
        [orgA, progA],
      );
    });
  });
  afterAll(async () => {
    await c?.end();
  });

  it("members read programmes and their template map, other organisations do not", async () => {
    for (const u of [alice, agent, coordinator]) {
      expect(
        await asUser(c, u, () =>
          count(c, "select 1 from public.recall_programmes where org_id = $1", [orgA]),
        ),
      ).toBeGreaterThan(0);
      expect(
        await asUser(c, u, () =>
          count(c, "select 1 from public.recall_programme_templates where org_id = $1", [orgA]),
        ),
      ).toBeGreaterThan(0);
    }
    expect(
      await asUser(c, bob, () =>
        count(c, "select 1 from public.recall_programmes where org_id = $1", [orgA]),
      ),
    ).toBe(0);
    expect(
      await asUser(c, bob, () =>
        count(c, "select 1 from public.recall_programme_templates where org_id = $1", [orgA]),
      ),
    ).toBe(0);
  });

  it("sends and runs need the clinical follow-up key", async () => {
    expect(await asUser(c, coordinator, () => count(c, "select 1 from public.recall_sends"))).toBe(
      1,
    );
    expect(await asUser(c, coordinator, () => count(c, "select 1 from public.recall_runs"))).toBe(
      1,
    );
    expect(await asUser(c, agent, () => count(c, "select 1 from public.recall_sends"))).toBe(0);
    expect(await asUser(c, agent, () => count(c, "select 1 from public.recall_runs"))).toBe(0);
    expect(await asUser(c, bob, () => count(c, "select 1 from public.recall_sends"))).toBe(0);
  });

  it("only flows.manage edits programmes; only the follow-up write key edits sends", async () => {
    expect(
      await asUser(
        c,
        agent,
        async () =>
          (
            await c.query("update public.recall_programmes set status='active' where id=$1", [
              progA,
            ])
          ).rowCount,
      ),
    ).toBe(0);
    expect(
      await asUser(
        c,
        coordinator,
        async () =>
          (
            await c.query("update public.recall_programmes set status='active' where id=$1", [
              progA,
            ])
          ).rowCount,
      ),
    ).toBe(0);
    expect(
      await asUser(
        c,
        alice,
        async () =>
          (
            await c.query("update public.recall_programmes set status='paused' where id=$1", [
              progA,
            ])
          ).rowCount,
      ),
    ).toBe(1);
    expect(
      await asUser(
        c,
        agent,
        async () =>
          (await c.query("update public.recall_sends set outcome='x' where id=$1", [sendA]))
            .rowCount,
      ),
    ).toBe(0);
    expect(
      await asUser(
        c,
        coordinator,
        async () =>
          (
            await c.query("update public.recall_sends set outcome='wants_booking' where id=$1", [
              sendA,
            ])
          ).rowCount,
      ),
    ).toBe(1);
    expect(
      await asUser(
        c,
        bob,
        async () =>
          (await c.query("update public.recall_sends set outcome='x' where id=$1", [sendA]))
            .rowCount,
      ),
    ).toBe(0);
  });

  it("candidate queries and the seed are not callable by signed-in users", async () => {
    await expect(
      asUser(c, alice, () =>
        c.query(
          "select * from public.recall_birthday_candidates($1,$2,array['10-12'],'2026',false,true,10,0)",
          [orgA, progA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(c, alice, () => c.query("select public.seed_recall_programmes($1)", [orgA])),
    ).rejects.toThrow(/permission denied/);
  });

  it("a booked follow-up needs a booking date, and a cycle is unique per patient", async () => {
    await expect(
      asServiceRole(c, () =>
        c.query("update public.recall_sends set follow_up_status='booked' where id=$1", [sendA]),
      ),
    ).rejects.toThrow(/recall_booked_needs_date/);
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key) select org_id, programme_id, contact_id, cycle_key from public.recall_sends where id=$1",
          [sendA],
        ),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("seeding is idempotent and leaves every template unmapped", async () => {
    await asServiceRole(c, () => c.query("select public.seed_recall_programmes($1)", [orgA]));
    expect(await count(c, "select 1 from public.recall_programmes where org_id=$1", [orgA])).toBe(
      11,
    );
    expect(
      await count(
        c,
        "select 1 from public.recall_programme_templates where org_id=$1 and wa_template_id is not null",
        [orgA],
      ),
    ).toBe(0);
    expect(
      await count(c, "select 1 from public.recall_programmes where org_id=$1 and status='active'", [
        orgA,
      ]),
    ).toBe(1); // only the managed reminder row
  });
});
