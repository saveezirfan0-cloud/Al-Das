/**
 * docs/44: the Tally bridge's direct HTTPS connection, database side. Pulse's own device is created on first use only
 * while the integration is on; it replaces an active connector (whose unanswered jobs are asked again) and is reused
 * after that; its token is never accepted at the connector door; a connector pairing replaces it; an administrator's
 * revoke keeps it off until the integration changes; it claims jobs like any device; service role only. Synthetic data
 * only ("Demo Clinic"). Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("Tally direct connection (docs/44)", () => {
  let c: Client;
  let org: string;
  let off: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const direct = async (o: string, state = "ok") =>
    (
      await one<{ r: string | null }>("select public.acc_tally_bridge_direct_device($1, $2) as r", [
        o,
        state,
      ])
    ).r;
  const device = (id: string) =>
    one<{ status: string; transport: string; tally_state: string | null }>(
      "select status, transport, tally_state from public.acc_tally_devices where id = $1",
      [id],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const u of ["alice", "bob", "chief"])
      users[u] = await createAuthUser(c, `${u}-direct@example.test`);
    org = await createOrg(c, "Org A", "org-a", users.alice);
    off = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const o of [org, off]) {
        for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
            [o, r.name, r.description, JSON.stringify(r.permissions)],
          );
        await q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = 'Chief Accountant'",
          [o, users.chief],
        );
        await q(
          `insert into public.integration_accounts (org_id, kind, config_enc, config, status, enabled)
           values ($1, 'tally_bridge', 'v1:test:test:test', '{"company":"Demo Clinic LLC","provider":"https"}'::jsonb, 'active', $2)`,
          [o, o === org],
        );
        await q(
          "insert into public.acc_tally_bridge_settings (org_id, pull_enabled) values ($1, true) on conflict (org_id) do update set pull_enabled = true",
          [o],
        );
      }
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("is created only while the integration is on, replaces the connector and requeues its unanswered jobs", async () => {
    expect(await direct(off)).toBeNull();

    // a paired connector with a job it never answered
    await one("select public.acc_tally_bridge_pair_create($1, $2, 'Accounts PC', $3)", [
      org,
      users.chief,
      sha("ABCD-EFGH-JKMN-PQRS"),
    ]);
    const paired = (
      await one<{ r: { device_id: string } }>(
        "select public.acc_tally_bridge_pair_exchange($1, $2, '1.0.0') as r",
        [sha("ABCD-EFGH-JKMN-PQRS"), sha("ptb_" + "a".repeat(43))],
      )
    ).r;
    const job = await one<{ id: string }>(
      `insert into public.acc_tally_jobs (org_id, kind, status, params, device_id, sent_at, attempts)
       values ($1, 'export_masters_since', 'sent', '{"since_alter_id":0}', $2, now(), 1) returning id`,
      [org, paired.device_id],
    );

    const id = await direct(org, "ok");
    expect(id).toBeTruthy();
    expect(await device(id!)).toEqual({ status: "active", transport: "direct", tally_state: "ok" });
    expect((await device(paired.device_id)).status).toBe("revoked");
    expect(
      await one("select status, device_id from public.acc_tally_jobs where id = $1", [job.id]),
    ).toEqual({ status: "queued", device_id: null });

    // reused, with Tally's state recorded; one active device per organisation
    expect(await direct(org, "unreachable")).toBe(id);
    expect((await device(id!)).tally_state).toBe("unreachable");
    expect(
      Number(
        (
          await one<{ n: string }>(
            "select count(*) as n from public.acc_tally_devices where org_id = $1 and status = 'active'",
            [org],
          )
        ).n,
      ),
    ).toBe(1);

    // it claims jobs as a device does
    await direct(org, "ok");
    const claimed = (
      await one<{ r: { jobs: Array<{ id: string }> } }>(
        "select public.acc_tally_bridge_claim($1, $2, 5, '2026-08-01'::date) as r",
        [org, id],
      )
    ).r;
    expect(claimed.jobs.map((j) => j.id)).toContain(job.id);
  });

  it("its token is never accepted at the connector door", async () => {
    const tokenSha = (
      await one<{ token_sha256: string }>(
        "select token_sha256 from public.acc_tally_devices where org_id = $1 and transport = 'direct' and status = 'active'",
        [org],
      )
    ).token_sha256;
    expect(
      (
        await one<{ r: unknown }>("select public.acc_tally_bridge_device($1, null, null) as r", [
          tokenSha,
        ])
      ).r,
    ).toBeNull();
  });

  it("an administrator's revoke keeps it off until the integration changes", async () => {
    const id = (await direct(org))!;
    await one("select public.acc_tally_bridge_revoke($1, $2, $3)", [org, users.chief, id]);
    expect(await direct(org)).toBeNull();
    // saving the settings again (or switching off and on) brings it back
    await svc(() =>
      q(
        "update public.integration_accounts set updated_at = now() + interval '1 second' where org_id = $1 and kind = 'tally_bridge'",
        [org],
      ),
    );
    const again = await direct(org);
    expect(again).toBeTruthy();
    expect(again).not.toBe(id);
  });

  it("a connector pairing replaces it", async () => {
    const id = (await direct(org))!;
    await one("select public.acc_tally_bridge_pair_create($1, $2, 'Accounts PC', $3)", [
      org,
      users.chief,
      sha("BCDE-FGHJ-KMNP-QRST"),
    ]);
    await one("select public.acc_tally_bridge_pair_exchange($1, $2, '1.0.0')", [
      sha("BCDE-FGHJ-KMNP-QRST"),
      sha("ptb_" + "b".repeat(43)),
    ]);
    expect((await device(id)).status).toBe("revoked");
    expect(await direct(org)).toBeNull();
  });

  it("is service role only", async () => {
    const err = await asUser(c, users.chief, () =>
      q("select public.acc_tally_bridge_direct_device($1, 'ok')", [org]),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
  });
});
