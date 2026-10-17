/**
 * W7: the Tally bridge with SEVERAL Tally companies, one per accounting entity (migration 20261210000400).
 * The company rule agrees with lib/accounting/tally/companies.ts on the shared scenarios; every pushed voucher and every
 * export belongs to one entity and is handed to the connector with that entity's company; an entity without a company
 * is never sent anywhere; the ledger start, the AlterID cursors, the trial-balance check and the mirror journals are
 * per entity; an entity's company cannot be changed once data was exchanged; a second organisation sees none of it.
 * Synthetic data only (fake companies "Demo Clinic LLC", "Demo Pharmacy FZ-LLC"). Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remoteIdBase, withPulseVoucherTypes } from "@/lib/accounting/tally/bridge";
import { parseTallyXml } from "@/lib/accounting/tally/parse";
import {
  mergeParsed,
  planTallyImport,
  type PlanContext,
  type TallyPlan,
} from "@/lib/accounting/tally/plan";
import { stagedRows } from "@/lib/accounting/tally/stage";
import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";
import { buildBridgeVoucherXml } from "@/lib/finance/tally-xml";

import scenarios from "../unit/accounting/tally/fixtures/company-scenarios.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const FIX = join(__dirname, "../unit/accounting/tally/fixtures");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CONTENT = {
  narration: "Pulse: Payment voucher PV-DEMO-1",
  entries: [
    { ledger: "Supplier Demo B", side: "debit", cents: 250_000 },
    { ledger: "Bank - Demo Main", side: "credit", cents: 250_000 },
  ],
};
const ID = (n: number) => `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

describe.skipIf(!TEST_DATABASE_URL)("Tally bridge, several companies (W7)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let entA: string; // org A's default entity: "Demo Clinic LLC" (the integration's company)
  let entA2: string; // org A's second entity: "Demo Pharmacy FZ-LLC"
  let entA3: string; // org A's third entity: no Tally company
  let entB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const rows = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows as T[];
  const n = async (sql: string, p: unknown[] = []) => Number((await one<{ n: string }>(sql, p)).n);
  const rpc = async <T = Record<string, unknown>>(fn: string, args: unknown[]) =>
    (
      await one<{ r: T }>(
        `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`,
        args.map((a) => (a !== null && typeof a === "object" ? JSON.stringify(a) : a)),
      )
    ).r;
  // app.* functions are not the service role's: ask as the test's own (owner) connection
  const company = async (org: string, entity: string) =>
    (await q("select app.acc_tally_company($1, $2) as r", [org, entity])).rows[0].r as
      string | null;

  const item = (org: string, id: string, extra: Record<string, unknown> = {}) => ({
    kind: "voucher",
    id,
    remote_base: remoteIdBase(org, "voucher", id),
    action: "push",
    date: "2026-07-15",
    voucher_type: "payment",
    amount: 2500,
    journal_sha256: "a".repeat(64),
    content: CONTENT,
    ...extra,
  });
  const pushRow = async (org: string, id: string) =>
    (
      await rows<Record<string, unknown>>(
        "select * from public.acc_tally_push where org_id = $1 and source_kind = 'voucher' and source_id = $2 order by version, role",
        [org, id],
      )
    )[0];
  const claim = (org: string, device: string, today = "2026-08-01") =>
    rpc<{ jobs: Array<Record<string, unknown>> }>("acc_tally_bridge_claim", [
      org,
      device,
      10,
      today,
    ]);

  async function pairDevice(org: string, user: string, token: string) {
    const code = `code-${org}`;
    await rpc("acc_tally_bridge_pair_create", [org, user, "Accounts PC", sha(code)]);
    return (
      await rpc<{ device_id: string }>("acc_tally_bridge_pair_exchange", [
        sha(code),
        sha(token),
        "1.0.0",
      ])
    ).device_id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const u of ["alice", "bob", "chiefA", "chiefB"])
      users[u] = await createAuthUser(c, `${u}-companies@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const [org, chief] of [
        [orgA, "chiefA"],
        [orgB, "chiefB"],
      ] as const) {
        for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
            [org, r.name, r.description, JSON.stringify(r.permissions)],
          );
        await q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = 'Chief Accountant'",
          [org, users[chief]],
        );
        await q(
          `insert into public.integration_accounts (org_id, kind, config_enc, config, status, enabled)
           values ($1, 'tally_bridge', 'v1:test:test:test', '{"company":"Demo Clinic LLC"}'::jsonb, 'active', true)`,
          [org],
        );
      }
      entA = (
        await q("select id from public.acc_entities where org_id = $1 and is_default", [orgA])
      ).rows[0].id;
      entB = (
        await q("select id from public.acc_entities where org_id = $1 and is_default", [orgB])
      ).rows[0].id;
      entA2 = (
        await q(
          "insert into public.acc_entities (org_id, name, tally_company) values ($1, 'Demo Pharmacy LLC', 'Demo Pharmacy FZ-LLC') returning id",
          [orgA],
        )
      ).rows[0].id;
      entA3 = (
        await q(
          "insert into public.acc_entities (org_id, name) values ($1, 'Demo Holding LLC') returning id",
          [orgA],
        )
      ).rows[0].id;
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("which company an entity has", () => {
    it("agrees with lib/accounting/tally/companies.ts on every shared scenario", async () => {
      // a scratch organisation, so the scenarios change nothing the other tests rely on
      const scratch = await createOrg(c, "Org S", "org-s", users.alice);
      for (const s of scenarios.resolve) {
        await svc(async () => {
          await q(
            "delete from public.integration_accounts where org_id = $1 and kind = 'tally_bridge'",
            [scratch],
          );
          if (s.fallback)
            await q(
              `insert into public.integration_accounts (org_id, kind, config_enc, config, status, enabled)
               values ($1, 'tally_bridge', 'v1:test:test:test', $2::jsonb, 'active', true)`,
              [scratch, JSON.stringify({ company: s.fallback })],
            );
        });
        const ids = new Map<string, string>();
        await svc(async () => {
          await q("delete from public.acc_entities where org_id = $1 and not is_default", [
            scratch,
          ]);
          const def = s.entities.find((e) => e.is_default)!;
          ids.set(
            def.key,
            (
              await q(
                "update public.acc_entities set tally_company = $2 where org_id = $1 and is_default returning id",
                [scratch, def.tally_company],
              )
            ).rows[0].id,
          );
          for (const e of s.entities.filter((x) => !x.is_default))
            ids.set(
              e.key,
              (
                await q(
                  "insert into public.acc_entities (org_id, name, tally_company, active) values ($1, $2, $3, $4) returning id",
                  [scratch, `Entity ${e.key}`, e.tally_company, e.active],
                )
              ).rows[0].id,
            );
        });
        for (const [key, want] of Object.entries(s.expect))
          expect(await company(scratch, ids.get(key)!), `${s.name} (${key})`).toBe(want);
      }
    });

    it("is unique per organisation (any case), may repeat in another organisation, and is never blank", async () => {
      expect(
        (await fails(
          svc(() =>
            q(
              "update public.acc_entities set tally_company = 'DEMO PHARMACY fz-llc' where id = $1",
              [entA3],
            ),
          ),
        )) as {
          code?: string;
        } | null,
      ).toMatchObject({ code: "23505" });
      await svc(() =>
        q("update public.acc_entities set tally_company = 'Demo Pharmacy FZ-LLC' where id = $1", [
          entB,
        ]),
      );
      expect(await company(orgB, entB)).toBe("Demo Pharmacy FZ-LLC");
      await svc(() =>
        q("update public.acc_entities set tally_company = null where id = $1", [entB]),
      );
      expect(
        (await fails(
          svc(() =>
            q("update public.acc_entities set tally_company = '   ' where id = $1", [entA3]),
          ),
        )) as {
          code?: string;
        } | null,
      ).toMatchObject({ code: "23514" });
    });

    it("an entity with a company is resolved for its own organisation only", async () => {
      expect(await company(orgA, entA)).toBe("Demo Clinic LLC");
      expect(await company(orgA, entA2)).toBe("Demo Pharmacy FZ-LLC");
      expect(await company(orgA, entA3)).toBeNull();
      // another organisation's entity id is not an entity of this one
      expect(await company(orgB, entA2)).toBeNull();
    });
  });

  describe("pushing", () => {
    let device: string;
    const v1 = ID(1); // default entity (an item without an entity belongs to it)
    const v2 = ID(2); // second entity
    const v3 = ID(3); // third entity: no company

    beforeAll(async () => {
      device = await pairDevice(orgA, users.chiefA, "ptb_" + "w".repeat(43));
      await rpc("acc_tally_bridge_save_settings", [
        orgA,
        users.chiefA,
        { push_enabled: true, pull_enabled: false, push_from: "2026-07-01", revenue_mode: "daily" },
      ]);
    });

    it("keeps each voucher and its job with the item's entity and hands the connector that entity's company", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, v1), item(orgA, v2, { entity_id: entA2 })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ queued: 2 });
      expect(await pushRow(orgA, v1)).toMatchObject({ entity_id: entA, status: "ready" });
      expect(await pushRow(orgA, v2)).toMatchObject({ entity_id: entA2, status: "ready" });
      // REMOTEIDs are the voucher's own, never shared between the two companies
      expect((await pushRow(orgA, v1)).remote_id).not.toBe((await pushRow(orgA, v2)).remote_id);
      const res = await claim(orgA, device);
      const byRemote = new Map(
        res.jobs.map((j) => [(j.push as { remote_id: string }).remote_id, j]),
      );
      expect(byRemote.get(String((await pushRow(orgA, v1)).remote_id))).toMatchObject({
        entity_id: entA,
        company: "Demo Clinic LLC",
      });
      expect(byRemote.get(String((await pushRow(orgA, v2)).remote_id))).toMatchObject({
        entity_id: entA2,
        company: "Demo Pharmacy FZ-LLC",
      });
    });

    it("an entity without a Tally company is never sent anywhere: its item waits, and goes once it has one", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, v3, { entity_id: entA3 })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ held: 1 });
      expect(await pushRow(orgA, v3)).toMatchObject({
        entity_id: entA3,
        status: "held",
        reason: "no_tally_company",
      });
      expect(
        await n("select count(*) as n from public.acc_tally_jobs where push_id = $1", [
          (await pushRow(orgA, v3)).id,
        ]),
      ).toBe(0);
      await svc(() =>
        q("update public.acc_entities set tally_company = 'Demo Holding Co' where id = $1", [
          entA3,
        ]),
      );
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, v3, { entity_id: entA3 })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ queued: 1 });
      const res = await claim(orgA, device);
      expect(res.jobs).toHaveLength(1);
      expect(res.jobs[0]).toMatchObject({ entity_id: entA3, company: "Demo Holding Co" });
    });

    it("an item naming another organisation's entity, or no entity of this organisation, is refused", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, ID(4), { entity_id: entB }), item(orgA, ID(5), { entity_id: "not-a-uuid" })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ invalid: 2 });
      expect(
        await n("select count(*) as n from public.acc_tally_push where source_id in ($1, $2)", [
          ID(4),
          ID(5),
        ]),
      ).toBe(0);
      // a row cannot be pointed at another organisation's entity either
      expect(
        await fails(
          svc(() =>
            q(
              "update public.acc_tally_push set entity_id = $2 where org_id = $1 and source_id = $3",
              [orgA, entB, v1],
            ),
          ),
        ),
      ).not.toBeNull();
    });

    it("the ledger start stops one entity on its own day and leaves the others pushing", async () => {
      await svc(() =>
        q("update public.acc_entities set ledger_start_date = '2026-09-01' where id = $1", [entA2]),
      );
      // dated on or after that entity's start: Pulse posts it itself
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, ID(6), { entity_id: entA2, date: "2026-09-02" })],
          "2026-08-15",
          null,
        ]),
      ).toEqual({ out_of_range: 1 });
      // the default entity's new item still goes (its own start is not set)
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [
            item(orgA, ID(7), { date: "2026-08-20" }),
            item(orgA, ID(8), { entity_id: entA2, date: "2026-08-20" }),
          ],
          "2026-09-01",
          null,
        ]),
      ).toEqual({ queued: 1, entity_stopped: 1 });
      expect(await pushRow(orgA, ID(8))).toBeUndefined();
      // the claim holds the second entity's waiting import and cancels its job; the others are handed out
      await rpc("acc_tally_bridge_push_apply", [
        orgA,
        [item(orgA, ID(9), { entity_id: entA2, date: "2026-08-25" })],
        "2026-08-26",
        null,
      ]);
      const res = await claim(orgA, device, "2026-09-01");
      expect(res.jobs.map((j) => j.entity_id)).toEqual([entA]);
      expect(await pushRow(orgA, ID(9))).toMatchObject({
        status: "held",
        reason: "ledger_started",
      });
      expect(
        await n(
          "select count(*) as n from public.acc_tally_jobs where push_id = $1 and status = 'cancelled' and error_code = 'ledger_started'",
          [(await pushRow(orgA, ID(9))).id],
        ),
      ).toBe(1);
      // a person's retry of the stopped entity's voucher is refused for that entity
      await svc(() =>
        q(
          "update public.acc_tally_push set status = 'failed', reason = 'tally_error' where source_id = $1",
          [v2],
        ),
      );
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_retry", [
              orgA,
              users.chiefA,
              (await pushRow(orgA, v2)).id,
              "2026-09-01",
            ]),
          ),
        ),
      ).toBe("ledger_started");
      // ...but the organisation as a whole is still pushing
      expect(await rpc("acc_tally_bridge_push_apply", [orgA, [], "2026-09-01", null])).toEqual({});
      await svc(() =>
        q("update public.acc_entities set ledger_start_date = null where id = $1", [entA2]),
      );
    });

    it("the whole organisation stops only when no entity has anything left to send", async () => {
      await svc(() =>
        q(
          "update public.acc_entities set ledger_start_date = '2026-09-01'" + " where org_id = $1",
          [orgA],
        ),
      );
      expect(await rpc("acc_tally_bridge_push_apply", [orgA, [], "2026-09-01", null])).toEqual({
        stopped: "ledger_started",
      });
      await svc(() =>
        q("update public.acc_entities set ledger_start_date = null where org_id = $1", [orgA]),
      );
      // the integration's company is the default entity's only: with none anywhere nothing is bridged
      await svc(() =>
        q("update public.integration_accounts set config = '{}'::jsonb where org_id = $1", [orgB]),
      );
      await rpc("acc_tally_bridge_save_settings", [
        orgB,
        users.chiefB,
        { push_enabled: true, push_from: "2026-07-01" },
      ]);
      expect(await rpc("acc_tally_bridge_push_apply", [orgB, [], "2026-08-01", null])).toEqual({
        stopped: "no_tally_company",
      });
      await svc(() =>
        q(
          'update public.integration_accounts set config = \'{"company":"Demo Clinic LLC"}\'::jsonb where org_id = $1',
          [orgB],
        ),
      );
    });
  });

  describe("pulling", () => {
    let device: string;

    beforeAll(async () => {
      device = await pairDevice(orgB, users.chiefB, "ptb_" + "x".repeat(43));
    });

    it("queues masters, vouchers and the trial-balance check once per bridged entity, each from its own cursor", async () => {
      // org B: a second bridged entity; a third without a company
      const entB2 = (
        await one<{ id: string }>(
          "insert into public.acc_entities (org_id, name, tally_company) values ($1, 'Demo Pharmacy LLC', 'Demo Pharmacy FZ-LLC') returning id",
          [orgB],
        )
      ).id;
      await one(
        "insert into public.acc_entities (org_id, name) values ($1, 'Demo Holding LLC') returning id",
        [orgB],
      );
      await rpc("acc_tally_bridge_save_settings", [
        orgB,
        users.chiefB,
        { push_enabled: false, pull_enabled: true, push_from: null, revenue_mode: "daily" },
      ]);
      expect(await rpc("acc_tally_bridge_tick", [orgB, "2026-08-01"])).toEqual({
        masters: 2,
        vouchers: 2,
        trial_balance: 2,
        pull: true,
      });
      const jobs = await rows<{ kind: string; entity_id: string; params: Record<string, unknown> }>(
        "select kind, entity_id, params from public.acc_tally_jobs where org_id = $1 order by seq",
        [orgB],
      );
      expect(jobs.filter((j) => j.entity_id === entB)).toHaveLength(3);
      expect(jobs.filter((j) => j.entity_id === entB2)).toHaveLength(3);
      // a second tick adds nothing: one open export per entity and kind
      expect(await rpc("acc_tally_bridge_tick", [orgB, "2026-08-01"])).toEqual({ pull: true });
      expect(
        await fails(
          svc(() =>
            q(
              "insert into public.acc_tally_jobs (org_id, entity_id, kind, params) values ($1, $2, 'export_masters_since', '{}')",
              [orgB, entB2],
            ),
          ),
        ),
      ).toMatchObject({ code: "23505" });

      // the connector gets each job with its own company
      const res = await rpc<{
        jobs: Array<{ id: string; kind: string; entity_id: string; company: string }>;
      }>("acc_tally_bridge_claim", [orgB, device, 10, "2026-08-01"]);
      expect(res.jobs.length).toBeGreaterThan(0);
      for (const j of res.jobs)
        expect(j.company).toBe(j.entity_id === entB ? "Demo Clinic LLC" : "Demo Pharmacy FZ-LLC");

      // finishing a pull moves only that entity's cursor
      const jobOf = (e: string, kind: string) =>
        jobs.length &&
        rows<{ id: string }>(
          "select id from public.acc_tally_jobs where org_id = $1 and entity_id = $2 and kind = $3",
          [orgB, e, kind],
        ).then((r) => r[0].id);
      await rpc("acc_tally_bridge_pull_finish", [
        orgB,
        await jobOf(entB2, "export_vouchers_since"),
        null,
        "vouchers",
        50,
        [],
        [],
      ]);
      await rpc("acc_tally_bridge_pull_finish", [
        orgB,
        await jobOf(entB, "export_vouchers_since"),
        null,
        "vouchers",
        10,
        [],
        [],
      ]);
      expect(
        await rows(
          "select entity_id, alter_id from public.acc_tally_cursors where org_id = $1 and cursor = 'vouchers' order by alter_id",
          [orgB],
        ),
      ).toEqual([
        { entity_id: entB, alter_id: "10" },
        { entity_id: entB2, alter_id: "50" },
      ]);
      // the next pull of each starts from its own cursor
      await svc(() =>
        q("update public.acc_tally_jobs set status = 'done' where org_id = $1", [orgB]),
      );
      await rpc("acc_tally_bridge_tick", [orgB, "2026-08-02"]);
      const next = await rows<{ entity_id: string; params: { since_alter_id: number } }>(
        "select entity_id, params from public.acc_tally_jobs where org_id = $1 and kind = 'export_vouchers_since' and status = 'queued'",
        [orgB],
      );
      expect(new Map(next.map((j) => [j.entity_id, j.params.since_alter_id]))).toEqual(
        new Map([
          [entB, 10],
          [entB2, 50],
        ]),
      );
      // an entity that loses its company (nothing was exchanged yet) asks Tally for nothing any more
      const lab = await one<{ id: string }>(
        "insert into public.acc_entities (org_id, name, tally_company) values ($1, 'Demo Lab LLC', 'Demo Lab Co') returning id",
        [orgB],
      );
      expect(await rpc("acc_tally_bridge_tick", [orgB, "2026-08-02"])).toMatchObject({
        masters: 1,
        vouchers: 1,
        trial_balance: 1,
      });
      await svc(() =>
        q("update public.acc_entities set tally_company = null where id = $1", [lab.id]),
      );
      await rpc("acc_tally_bridge_tick", [orgB, "2026-08-02"]);
      expect(
        await n(
          "select count(*) as n from public.acc_tally_jobs where entity_id = $1 and status = 'queued'",
          [lab.id],
        ),
      ).toBe(0);
      expect(
        await n(
          "select count(*) as n from public.acc_tally_jobs where entity_id = $1 and error_code = 'no_tally_company'",
          [lab.id],
        ),
      ).toBe(3);
    });
  });

  describe("an imported voucher lands in its own entity", () => {
    const REMOTE_ITEM = ID(2);
    let remote: string;

    async function context(org: string): Promise<PlanContext> {
      const accounts = (await rows(
        "select id, code, name, is_group, is_system, tally_guid, tally_group, control from public.acc_accounts where org_id = $1",
        [org],
      )) as unknown as PlanContext["accounts"];
      const costCentres = (await rows(
        "select id, code, name from public.acc_cost_centres where org_id = $1",
        [org],
      )) as unknown as PlanContext["costCentres"];
      const tallyJournals = (await rows(
        "select tally_guid as guid, source_version as version from public.acc_journals where org_id = $1 and source_kind = 'tally_import' and status = 'posted'",
        [org],
      )) as unknown as PlanContext["tallyJournals"];
      return { accounts, costCentres, tallyJournals };
    }
    async function stageBridge(org: string, entity: string, p: TallyPlan): Promise<string> {
      const imp = await one<{ id: string }>(
        `insert into public.acc_tally_imports (org_id, entity_id, file_sha256, source)
         values ($1, $2, $3, 'bridge') returning id`,
        [org, entity, [sha(String(Math.random()))]],
      );
      const r = stagedRows(org, imp.id, p);
      if (r.length)
        await svc(() =>
          q(
            `insert into public.acc_tally_staged (org_id, import_id, seq, kind, guid, alter_id, payload)
             select org_id, import_id, seq, kind, guid, alter_id, payload from jsonb_populate_recordset(null::public.acc_tally_staged, $1::jsonb)`,
            [JSON.stringify(r)],
          ),
        );
      return imp.id;
    }

    beforeAll(async () => {
      // org A's chart from the 22I fixtures, applied by the bridge for the default entity (the chart is shared)
      const masters = parseTallyXml(readFileSync(join(FIX, "masters.xml")));
      const mplan = planTallyImport(mergeParsed([masters]), await context(orgA), {
        openingDate: null,
      });
      const imp = await stageBridge(orgA, entA, mplan);
      await rpc("acc_tally_apply_masters", [orgA, imp, null]);
      await rpc("acc_tally_bridge_pull_finish", [orgA, null, imp, "masters", 40, [], []]);
      remote = String((await pushRow(orgA, REMOTE_ITEM)).remote_id);
    });

    it("a pull for the second entity posts into the second entity, links the voucher it pushed and moves its cursor only", async () => {
      const xml = buildBridgeVoucherXml({
        company: "Demo Pharmacy FZ-LLC",
        costCategory: "Primary Cost Category",
        remoteId: remote,
        number: "PB-DEMO",
        date: "2026-07-15",
        tallyType: "Pulse Payment",
        narration: CONTENT.narration,
        entries: CONTENT.entries as Array<{
          ledger: string;
          side: "debit" | "credit";
          cents: number;
        }>,
      }).replace("<DATE>", "<ALTERID>500</ALTERID><MASTERID>9</MASTERID><DATE>");
      const plan = planTallyImport(
        withPulseVoucherTypes(mergeParsed([parseTallyXml(new TextEncoder().encode(xml))])),
        await context(orgA),
        { openingDate: null },
      );
      expect(plan.vouchers).toHaveLength(1);
      const imp = await stageBridge(orgA, entA2, plan);
      await rpc("acc_tally_apply_masters", [orgA, imp, null]);
      expect(await rpc("acc_tally_post_vouchers", [orgA, imp, null, 10])).toMatchObject({
        done: 1,
        remaining: 0,
      });
      // a job of the second entity, so the cursor is its own
      const job = await one<{ id: string }>(
        "insert into public.acc_tally_jobs (org_id, entity_id, kind, params) values ($1, $2, 'export_vouchers_since', '{}') returning id",
        [orgA, entA2],
      );
      expect(
        await rpc("acc_tally_bridge_pull_finish", [orgA, job.id, imp, "vouchers", 500, [], []]),
      ).toMatchObject({ linked: 1 });
      expect(
        await one(
          "select entity_id, source_kind from public.acc_journals where org_id = $1 and tally_guid = $2 and status = 'posted'",
          [orgA, remote],
        ),
      ).toEqual({ entity_id: entA2, source_kind: "tally_import" });
      expect(await pushRow(orgA, REMOTE_ITEM)).toMatchObject({ entity_id: entA2 });
      expect(
        await one(
          "select mirror_journal_id is not null as linked from public.acc_tally_push where source_id = $1",
          [REMOTE_ITEM],
        ),
      ).toEqual({ linked: true });
      expect(
        await rows(
          "select entity_id, cursor, alter_id from public.acc_tally_cursors where org_id = $1 and cursor = 'vouchers'",
          [orgA],
        ),
      ).toEqual([{ entity_id: entA2, cursor: "vouchers", alter_id: "500" }]);
      // the same company's trial balance is the second entity's books, not the default entity's
      const tbJob = await one<{ id: string }>(
        "insert into public.acc_tally_jobs (org_id, entity_id, kind, params) values ($1, $2, 'export_trial_balance', '{\"as_at\":\"2026-07-31\"}') returning id",
        [orgA, entA2],
      );
      const tb = await rpc<Record<string, unknown>>("acc_tally_bridge_record_tb", [
        orgA,
        tbJob.id,
        "2026-07-31",
        "d".repeat(64),
        [
          { name: "Bank - Demo Main", debit: 0, credit: 2500 },
          { name: "Supplier Demo B", debit: 2500, credit: 0 },
        ],
      ]);
      expect(tb).toMatchObject({ reconciled: true, differences: 0 });
      expect(
        await one("select entity_id, source from public.acc_tally_reconciliations where id = $1", [
          tb.id,
        ]),
      ).toEqual({ entity_id: entA2, source: "bridge" });
      // the default entity has no such voucher: the same figures reconcile it to nothing
      const tbDefault = await one<{ id: string }>(
        "insert into public.acc_tally_jobs (org_id, entity_id, kind, params) values ($1, $2, 'export_trial_balance', '{\"as_at\":\"2026-07-31\"}') returning id",
        [orgA, entA],
      );
      const drift = await rpc<Record<string, unknown>>("acc_tally_bridge_record_tb", [
        orgA,
        tbDefault.id,
        "2026-07-31",
        "e".repeat(64),
        [{ name: "Bank - Demo Main", debit: 0, credit: 2500 }],
      ]);
      expect(drift).toMatchObject({ reconciled: false });
    });

    it("a file import's reconciliation compares the import's own entity", async () => {
      const imp = await one<{ id: string }>(
        `insert into public.acc_tally_imports (org_id, entity_id, file_sha256, source, status, committed_at)
         values ($1, $2, $3, 'file', 'committed', now()) returning id`,
        [orgA, entA2, [sha("committed file")]],
      );
      const r = await rpc<Record<string, unknown>>("acc_tally_reconcile", [
        orgA,
        null,
        imp.id,
        users.chiefA,
        "2026-07-31",
        "c".repeat(64),
        [
          { name: "Bank - Demo Main", debit: 0, credit: 2500 },
          { name: "Supplier Demo B", debit: 2500, credit: 0 },
        ],
      ]);
      expect(r).toMatchObject({ reconciled: true });
      expect(
        await one("select entity_id from public.acc_tally_reconciliations where id = $1", [r.id]),
      ).toEqual({ entity_id: entA2 });
    });
  });

  describe("changing an entity's Tally company", () => {
    it("is refused once the bridge exchanged data for the entity, allowed before, and idempotent for the same name", async () => {
      // the second entity of org A has a cursor and a mirrored journal by now
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_entities set tally_company = 'Demo Other Co' where id = $1", [
                entA2,
              ]),
            ),
          ),
        ),
      ).toBe("tally_company_in_use");
      await svc(() =>
        q("update public.acc_entities set tally_company = 'demo pharmacy fz-llc' where id = $1", [
          entA2,
        ]),
      );
      // the default entity: naming its integration company is the same company; another is not
      await svc(() =>
        q("update public.acc_entities set tally_company = 'Demo Clinic LLC' where id = $1", [entA]),
      );
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_entities set tally_company = 'Demo Other Co' where id = $1", [
                entA,
              ]),
            ),
          ),
        ),
      ).toBe("tally_company_in_use");
      await svc(() =>
        q("update public.acc_entities set tally_company = null where id = $1", [entA]),
      );
      // an entity nothing was exchanged with can still change its company
      const fresh = (
        await one<{ id: string }>(
          "insert into public.acc_entities (org_id, name, tally_company) values ($1, 'Demo Fresh LLC', 'Demo Fresh Co') returning id",
          [orgA],
        )
      ).id;
      await svc(() =>
        q("update public.acc_entities set tally_company = 'Demo Fresh Co 2' where id = $1", [
          fresh,
        ]),
      );
      expect(await company(orgA, fresh)).toBe("Demo Fresh Co 2");
    });
  });

  describe("who sees what", () => {
    it("another organisation sees none of an organisation's entities, companies, vouchers, jobs or cursors", async () => {
      const seen = async (u: string, table: string, org: string) =>
        asUser(c, users[u], async () =>
          Number(
            (await q(`select count(*) as n from public.${table} where org_id = $1`, [org])).rows[0]
              .n,
          ),
        );
      for (const t of ["acc_entities", "acc_tally_push", "acc_tally_jobs", "acc_tally_cursors"]) {
        expect(await seen("chiefA", t, orgA), `${t} for its own organisation`).toBeGreaterThan(0);
        expect(await seen("chiefB", t, orgA), `${t} across organisations`).toBe(0);
        expect(await seen("chiefA", t, orgB), `${t} across organisations`).toBe(0);
      }
      const tc = await asUser(c, users.chiefB, async () =>
        (
          await q("select tally_company from public.acc_entities where tally_company is not null")
        ).rows.map((r) => r.tally_company),
      );
      expect(tc).not.toContain("Demo Holding Co");
      // no write policy: a signed-in person changes nothing directly
      const changed = await asUser(c, users.chiefA, async () => {
        try {
          return (
            (
              await q("update public.acc_entities set tally_company = 'X' where org_id = $1", [
                orgA,
              ])
            ).rowCount ?? 0
          );
        } catch {
          return 0;
        }
      });
      expect(changed).toBe(0);
    });
  });
});
