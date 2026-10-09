/**
 * Phase 8: flow tables. Members read; only flows.manage writes flows and variables; runs, steps,
 * versions and locks are written by the engine (service role) only; nothing crosses organisations.
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

describe.skipIf(!TEST_DATABASE_URL)("flows (rls)", () => {
  let c: Client;
  let alice: string; // Admin of org A
  let bob: string; // Admin of org B
  let agent: string; // member of org A without flows.manage
  let orgA: string;
  let orgB: string;
  let flowA: string;
  let flowB: string;
  let runA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    agent = await createAuthUser(c, "agent@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const role = await c.query<{ id: string }>(
        "insert into public.roles (org_id, name, permissions) values ($1,'Front desk','[\"inbox.send\"]') returning id",
        [orgA],
      );
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1,$2,$3)", [
        orgA,
        agent,
        role.rows[0].id,
      ]);
      const mk = async (org: string, name: string) =>
        (
          await c.query<{ id: string }>(
            "insert into public.flows (org_id, name, trigger_type) values ($1,$2,'shortcut') returning id",
            [org, name],
          )
        ).rows[0].id;
      flowA = await mk(orgA, "A flow");
      flowB = await mk(orgB, "B flow");
      await c.query(
        'insert into public.flow_versions (org_id, flow_id, version, graph) values ($1,$2,1,\'{"nodes":[],"edges":[]}\')',
        [orgA, flowA],
      );
      runA = (
        await c.query<{ id: string }>(
          "insert into public.flow_runs (org_id, flow_id, flow_version) values ($1,$2,1) returning id",
          [orgA, flowA],
        )
      ).rows[0].id;
      await c.query(
        "insert into public.flow_run_steps (org_id, run_id, seq, node_id, node_type, status) values ($1,$2,1,'n','message','ok')",
        [orgA, runA],
      );
      await c.query(
        "insert into public.flow_variables (org_id, key, value_type) values ($1,'clinic','text')",
        [orgA],
      );
      await c.query(
        "insert into public.flow_locks (key, holder, expires_at) values (gen_random_uuid(), 'x', now() + interval '1 minute')",
      );
    });
  });
  afterAll(async () => {
    await c?.end();
  });

  const tables = ["flows", "flow_versions", "flow_runs", "flow_run_steps", "flow_variables"];

  it("members of the organisation can read all of it", async () => {
    for (const user of [alice, agent]) {
      for (const t of tables) {
        expect(
          await asUser(c, user, () =>
            count(c, `select 1 from public.${t} where org_id = $1`, [orgA]),
          ),
          `${t} as ${user}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("another organisation sees nothing", async () => {
    for (const t of tables) {
      expect(
        await asUser(c, bob, () => count(c, `select 1 from public.${t} where org_id = $1`, [orgA])),
        t,
      ).toBe(0);
    }
    expect(
      await asUser(c, bob, () =>
        count(c, "select 1 from public.v_flow_run_counts where org_id = $1", [orgA]),
      ),
    ).toBe(0);
  });

  it("only flows.manage can write flows and variables", async () => {
    await expect(
      asUser(c, agent, () =>
        c.query(
          "insert into public.flows (org_id, name, trigger_type) values ($1,'x','shortcut')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(c, agent, () =>
        c.query(
          "insert into public.flow_variables (org_id, key, value_type) values ($1,'x','text')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      await asUser(
        c,
        agent,
        async () =>
          (await c.query("update public.flows set name = 'hacked' where id = $1", [flowA]))
            .rowCount,
      ),
    ).toBe(0);
    await asUser(c, alice, () =>
      c.query("insert into public.flows (org_id, name, trigger_type) values ($1,'ok','shortcut')", [
        orgA,
      ]),
    );
    await expect(
      asUser(c, alice, () =>
        c.query(
          "insert into public.flows (org_id, name, trigger_type) values ($1,'cross','shortcut')",
          [orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      await asUser(
        c,
        alice,
        async () =>
          (await c.query("update public.flows set name = 'moved' where id = $1", [flowB])).rowCount,
      ),
    ).toBe(0);
  });

  it("runs, steps and versions are not writable by anyone with a user session", async () => {
    for (const user of [alice, agent]) {
      await expect(
        asUser(c, user, () =>
          c.query("insert into public.flow_runs (org_id, flow_id, flow_version) values ($1,$2,1)", [
            orgA,
            flowA,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asUser(c, user, () =>
          c.query(
            "insert into public.flow_versions (org_id, flow_id, version, graph) values ($1,$2,2,'{}')",
            [orgA, flowA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        await asUser(
          c,
          user,
          async () =>
            (await c.query("update public.flow_runs set status = 'failed' where id = $1", [runA]))
              .rowCount,
        ),
      ).toBe(0);
      expect(
        await asUser(
          c,
          user,
          async () =>
            (await c.query("delete from public.flow_run_steps where run_id = $1", [runA])).rowCount,
        ),
      ).toBe(0);
    }
  });

  it("the lease table and its functions are service-role only", async () => {
    // RLS with no policy: a user session reads nothing and cannot write.
    expect(await asUser(c, alice, () => count(c, "select 1 from public.flow_locks"))).toBe(0);
    await expect(
      asUser(c, alice, () =>
        c.query(
          "insert into public.flow_locks (key, holder, expires_at) values (gen_random_uuid(), 'x', now())",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(c, alice, () => c.query("select public.flow_lock_acquire(gen_random_uuid(), 'x', 5)")),
    ).rejects.toThrow(/permission denied/);
    await c.query("set role anon");
    await expect(
      c.query("select public.flow_lock_acquire(gen_random_uuid(), 'x', 5)"),
    ).rejects.toThrow(/permission denied/);
    await c.query("reset role");
  });

  it("enforces one live run per conversation and one run per trigger key", async () => {
    await asServiceRole(c, async () => {
      const ch = (
        await c.query<{ id: string }>(
          "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1,'M','w','p') returning id",
          [orgA],
        )
      ).rows[0].id;
      const ct = (
        await c.query<{ id: string }>(
          "insert into public.contacts (org_id, first_name) values ($1,'T') returning id",
          [orgA],
        )
      ).rows[0].id;
      const cv = (
        await c.query<{ id: string }>(
          "insert into public.conversations (org_id, channel_id, contact_id) values ($1,$2,$3) returning id",
          [orgA, ch, ct],
        )
      ).rows[0].id;
      const ins = (status: string, key: string | null) =>
        c.query(
          "insert into public.flow_runs (org_id, flow_id, flow_version, conversation_id, status, trigger_key) values ($1,$2,1,$3,$4,$5)",
          [orgA, flowA, cv, status, key],
        );
      await ins("running", "k1");
      await expect(ins("waiting", "k2")).rejects.toThrow(/flow_runs_live_conversation_uidx/);
      await c.query("update public.flow_runs set status = 'completed' where conversation_id = $1", [
        cv,
      ]);
      await expect(ins("completed", "k1")).rejects.toThrow(/flow_runs_trigger_key_uidx/);
      await ins("running", "k3"); // a finished run no longer blocks the conversation
    });
  });

  it("variable names are validated and unique per organisation", async () => {
    await asServiceRole(c, async () => {
      await expect(
        c.query(
          "insert into public.flow_variables (org_id, key, value_type) values ($1,'1bad','text')",
          [orgA],
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        c.query(
          "insert into public.flow_variables (org_id, key, value_type) values ($1,'clinic','text')",
          [orgA],
        ),
      ).rejects.toThrow(/duplicate key/);
      await c.query(
        "insert into public.flow_variables (org_id, key, value_type) values ($1,'clinic','text')",
        [orgB],
      ); // other org: fine
    });
  });

  it("the run counters view reports per flow", async () => {
    const row = await asUser(
      c,
      alice,
      async () =>
        (
          await c.query(
            "select completed, failed, live from public.v_flow_run_counts where flow_id = $1",
            [flowA],
          )
        ).rows[0],
    );
    expect(row).toMatchObject({
      completed: expect.any(Number),
      failed: 0,
      live: expect.any(Number),
    });
  });
});
