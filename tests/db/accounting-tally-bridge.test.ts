/**
 * Phase 22J: the Tally bridge, database side. Pairing (hashes only, single use, expiry, one connector per org,
 * revocation); pushing (idempotent, changed in place before Tally has it, reversal and next version after, withdrawal,
 * push-from and held items); the job lifecycle (claim, answers, an unanswered import looked up before it is sent again,
 * "unknown" after five tries, a person's retry); pushing stops at the ledger start; a pushed voucher pulled back through
 * the 22I path is posted once and linked to its source; the trial-balance check; reading a 22F item's journal without
 * posting it; who sees what. Synthetic data only (fake company "Demo Clinic"). Needs TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("Tally bridge (Phase 22J)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let orgC: string;
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
  const n = async (sql: string, p: unknown[] = []) => Number((await one<{ n: string }>(sql, p)).n);
  const rpc = async <T = Record<string, unknown>>(fn: string, args: unknown[]) =>
    (
      await one<{ r: T }>(
        `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`,
        args.map((a) => (a !== null && typeof a === "object" ? JSON.stringify(a) : a)),
      )
    ).r;

  async function pair(org: string, code: string, token: string) {
    await rpc("acc_tally_bridge_pair_create", [org, users.chief, "Accounts PC", sha(code)]);
    return rpc<{ device_id: string; org_id: string }>("acc_tally_bridge_pair_exchange", [
      sha(code),
      sha(token),
      "1.0.0",
    ]);
  }
  const push = (org: string, id: string) =>
    svc(() =>
      q(
        "select * from public.acc_tally_push where org_id = $1 and source_kind = 'voucher' and source_id = $2 order by version, role",
        [org, id],
      ),
    ).then((r) => r.rows);
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
  const claim = (org: string, device: string, today = "2026-08-01") =>
    rpc<{ jobs: Array<Record<string, unknown>>; cost_category: string }>("acc_tally_bridge_claim", [
      org,
      device,
      5,
      today,
    ]);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const u of ["alice", "bob", "carol", "chief", "acct"])
      users[u] = await createAuthUser(c, `${u}-bridge@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    orgC = await createOrg(c, "Org C", "org-c", users.carol);
    await svc(async () => {
      for (const org of [orgA, orgB, orgC]) {
        for (const r of [...FINANCE_ROLES, ...ACCOUNTING_ROLES])
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
            [org, r.name, r.description, JSON.stringify(r.permissions)],
          );
        for (const [u, role] of [
          ["chief", "Chief Accountant"],
          ["acct", "Accountant"],
        ])
          await q(
            "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
            [org, users[u], role],
          );
        await q(
          `insert into public.integration_accounts (org_id, kind, config_enc, config, status, enabled)
           values ($1, 'tally_bridge', 'v1:test:test:test', '{"company":"Demo Clinic LLC"}'::jsonb, 'active', true)`,
          [org],
        );
      }
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("pairing", () => {
    it("stores hashes only; a code works once and only before it expires; the token finds its org", async () => {
      expect(
        hint(await fails(rpc("acc_tally_bridge_pair_create", [orgA, users.acct, "PC", sha("X")]))),
      ).toBe("not_permitted");
      const code = "ABCD-EFGH-JKMN-PQRS";
      const token = "ptb_" + "a".repeat(43);
      const paired = await pair(orgA, code, token);
      expect(paired.org_id).toBe(orgA);
      const d = await one<Record<string, unknown>>(
        "select * from public.acc_tally_devices where id = $1",
        [paired.device_id],
      );
      expect(d).toMatchObject({ status: "active", pairing_sha256: null, token_sha256: sha(token) });
      expect(JSON.stringify(d)).not.toContain(token);
      expect(JSON.stringify(d)).not.toContain(code);
      // single use
      expect(
        hint(
          await fails(rpc("acc_tally_bridge_pair_exchange", [sha(code), sha("ptb_other"), "1"])),
        ),
      ).toBe("invalid_code");
      // the token authenticates; a wrong one does not
      expect(await rpc("acc_tally_bridge_device", [sha(token), "1.0.1", "ok"])).toMatchObject({
        device_id: paired.device_id,
        org_id: orgA,
      });
      expect(await rpc("acc_tally_bridge_device", [sha("ptb_wrong"), null, null])).toBeNull();
      // an expired code
      await rpc("acc_tally_bridge_pair_create", [orgA, users.chief, "PC 2", sha("EXPIRED-CODE")]);
      await svc(() =>
        q(
          "update public.acc_tally_devices set pairing_expires_at = now() - interval '1 minute' where pairing_sha256 = $1",
          [sha("EXPIRED-CODE")],
        ),
      );
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_pair_exchange", [sha("EXPIRED-CODE"), sha("ptb_x"), "1"]),
          ),
        ),
      ).toBe("invalid_code");
    });

    it("a new pairing revokes the previous connector; revoking needs the permission and the org", async () => {
      const first = await rpc<{ device_id: string }>("acc_tally_bridge_device", [
        sha("ptb_" + "a".repeat(43)),
        null,
        null,
      ]);
      const second = await pair(orgA, "BCDE-FGHJ-KMNP-QRST", "ptb_" + "b".repeat(43));
      expect(
        await rpc("acc_tally_bridge_device", [sha("ptb_" + "a".repeat(43)), null, null]),
      ).toBeNull();
      expect(
        (
          await one<{ status: string }>(
            "select status from public.acc_tally_devices where id = $1",
            [first.device_id],
          )
        ).status,
      ).toBe("revoked");
      expect(
        hint(await fails(rpc("acc_tally_bridge_revoke", [orgA, users.acct, second.device_id]))),
      ).toBe("not_permitted");
      expect(
        hint(await fails(rpc("acc_tally_bridge_revoke", [orgB, users.chief, second.device_id]))),
      ).toBe("not_found");
      // org C's connector for the later tests; org A keeps "b"
      await pair(orgC, "CDEF-GHJK-MNPQ-RSTV", "ptb_" + "c".repeat(43));
    });
  });

  describe("pushing", () => {
    let device: string;
    const id = "11111111-1111-4111-8111-111111111111";

    beforeAll(async () => {
      device = (
        await rpc<{ device_id: string }>("acc_tally_bridge_device", [
          sha("ptb_" + "b".repeat(43)),
          null,
          "ok",
        ])
      ).device_id;
    });

    it("needs the switch, the permission and a first date", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, id)], "2026-08-01", null]),
      ).toEqual({
        stopped: "push_off",
      });
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_save_settings", [orgA, users.acct, { push_enabled: true }]),
          ),
        ),
      ).toBe("not_permitted");
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_save_settings", [orgA, users.chief, { push_enabled: true }]),
          ),
        ),
      ).toBe("push_from_needed");
      const s = await rpc<Record<string, unknown>>("acc_tally_bridge_save_settings", [
        orgA,
        users.chief,
        { push_enabled: true, pull_enabled: true, push_from: "2026-07-01", revenue_mode: "daily" },
      ]);
      expect(s).toMatchObject({
        push_enabled: true,
        push_from: "2026-07-01",
        revenue_mode: "daily",
      });
      expect(s.push_sources).toContain("voucher");
    });

    it("queues a new item once (REMOTEID from the TS base plus the version), whatever the number of runs", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, id)], "2026-08-01", null]),
      ).toEqual({
        queued: 1,
      });
      expect(
        await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, id)], "2026-08-01", null]),
      ).toEqual({
        unchanged: 1,
      });
      const rows = await push(orgA, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: 1,
        status: "ready",
        remote_id: `${remoteIdBase(orgA, "voucher", id)}-1`,
      });
      expect(
        await n(
          "select count(*) as n from public.acc_tally_jobs where push_id = $1 and status = 'queued'",
          [rows[0].id],
        ),
      ).toBe(1);
      // outside what the bridge sends
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, "22222222-2222-4222-8222-222222222222", { date: "2026-06-30" })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ out_of_range: 1 });
    });

    it("changes an item in place while Tally does not have it yet", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, id, { journal_sha256: "b".repeat(64), amount: 2600 })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ queued: 1 });
      const rows = await push(orgA, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: 1,
        journal_sha256: "b".repeat(64),
        status: "ready",
      });
      expect(
        await n(
          "select count(*) as n from public.acc_tally_jobs where push_id = $1 and status = 'cancelled'",
          [rows[0].id],
        ),
      ).toBe(1);
    });

    it("hands the job out once, waits while it is on its way, and is done when Tally created it", async () => {
      const res = await claim(orgA, device);
      const job = res.jobs.find((j) => j.kind === "import_voucher")!;
      expect(job).toMatchObject({ check_first: false, lookup_only: false });
      expect((job.push as Record<string, unknown>).content).toEqual(CONTENT);
      expect((await claim(orgA, device)).jobs.filter((j) => j.kind === "import_voucher")).toEqual(
        [],
      );
      expect((await push(orgA, id))[0].status).toBe("sent");
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, id, { journal_sha256: "c".repeat(64) })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ waiting: 1 });
      // an answer from a connector the job was not sent to is refused
      const other = await rpc<{ device_id: string }>("acc_tally_bridge_device", [
        sha("ptb_" + "c".repeat(43)),
        null,
        null,
      ]);
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_import_result", [
              orgA,
              other.device_id,
              job.id,
              "created",
              42,
              null,
              null,
            ]),
          ),
        ),
      ).toBe("not_expected");
      await rpc("acc_tally_bridge_import_result", [
        orgA,
        device,
        job.id,
        "created",
        42,
        null,
        null,
      ]);
      expect((await push(orgA, id))[0]).toMatchObject({ status: "done", tally_master_id: "42" });
      expect(
        await n(
          "select count(*) as n from public.acc_tally_sync_log where org_id = $1 and outcome = 'created'",
          [orgA],
        ),
      ).toBe(1);
      // the same answer again is ignored
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_import_result", [
              orgA,
              device,
              job.id,
              "created",
              42,
              null,
              null,
            ]),
          ),
        ),
      ).toBe("not_expected");
    });

    it("a change once Tally has it: a reversal voucher (other side, opposite type) and the next version", async () => {
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [item(orgA, id, { journal_sha256: "c".repeat(64) })],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ new_version: 1 });
      const rows = await push(orgA, id);
      const base = remoteIdBase(orgA, "voucher", id);
      const v1 = rows.find((r) => r.version === 1 && r.role === "voucher")!;
      const rev = rows.find((r) => r.role === "reversal")!;
      const v2 = rows.find((r) => r.version === 2)!;
      expect(v1).toMatchObject({ status: "done", reversed: true });
      expect(rev).toMatchObject({
        remote_id: `${base}-1-r`,
        voucher_type: "receipt",
        status: "ready",
        reverses_id: v1.id,
      });
      expect(rev.content.entries).toEqual([
        { ledger: "Supplier Demo B", side: "credit", cents: 250_000 },
        { ledger: "Bank - Demo Main", side: "debit", cents: 250_000 },
      ]);
      expect(v2).toMatchObject({ remote_id: `${base}-2`, status: "ready" });
      // withdrawn before it reached Tally: cancelled; the reversal stands
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [{ kind: "voucher", id, remote_base: base, action: "withdraw" }],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ cancelled: 1 });
      expect((await push(orgA, id)).find((r) => r.version === 2)!.status).toBe("cancelled");
    });

    it("holds an item whose ledger is not mapped, and sends it once it is", async () => {
      const hid = "33333333-3333-4333-8333-333333333333";
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgA,
          [
            {
              ...item(orgA, hid),
              action: "hold",
              content: undefined,
              reason: "ledger_unmapped",
              detail: "No Tally ledger for: 1300 Card clearing",
            },
          ],
          "2026-08-01",
          null,
        ]),
      ).toEqual({ held: 1 });
      expect((await push(orgA, hid))[0]).toMatchObject({
        status: "held",
        reason: "ledger_unmapped",
        content: null,
      });
      expect(
        await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, hid)], "2026-08-01", null]),
      ).toEqual({
        queued: 1,
      });
      expect((await push(orgA, hid))[0]).toMatchObject({ status: "ready", reason: null });
    });

    it("sends only the chosen sources, and Unite revenue only in the chosen form", async () => {
      const settings = (sources: string[]) =>
        rpc("acc_tally_bridge_save_settings", [
          orgA,
          users.chief,
          { push_enabled: true, pull_enabled: true, push_from: "2026-07-01", revenue_mode: "daily", push_sources: sources },
        ]);
      await settings(["supplier_invoice", "unite_invoice"]);
      const other = "99999999-9999-4999-8999-999999999999";
      expect(await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, other)], "2026-08-01", null])).toEqual({
        not_selected: 1,
      });
      const perInvoice = {
        ...item(orgA, "INV001"),
        kind: "unite_invoice",
        remote_base: remoteIdBase(orgA, "unite_invoice", "INV001"),
        voucher_type: "sales",
      };
      expect(await rpc("acc_tally_bridge_push_apply", [orgA, [perInvoice], "2026-08-01", null])).toEqual({
        not_selected: 1,
      });
      expect(
        hint(
          await fails(
            rpc("acc_tally_bridge_save_settings", [
              orgA,
              users.chief,
              { push_enabled: true, push_from: "2026-07-01", push_sources: ["delete_everything"] },
            ]),
          ),
        ),
      ).toBe("invalid");
      await settings(["bank_transfer", "supplier_invoice", "voucher", "unite_invoice"]);
    });
  });

  describe("job lifecycle", () => {
    let device: string;
    const id = "44444444-4444-4444-8444-444444444444";
    let pushId: string;
    const importJob = async () =>
      (await claim(orgA, device)).jobs.find(
        (j) => (j.push as { id?: string } | null)?.id === pushId,
      );

    beforeAll(async () => {
      device = (
        await rpc<{ device_id: string }>("acc_tally_bridge_device", [
          sha("ptb_" + "b".repeat(43)),
          null,
          "ok",
        ])
      ).device_id;
      await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, id)], "2026-08-01", null]);
      pushId = (await push(orgA, id))[0].id;
    });

    it("an unreadable answer: asked again only after a look-up, and a look-up that finds it settles it", async () => {
      const j = (await importJob())!;
      await rpc("acc_tally_bridge_import_result", [
        orgA,
        device,
        j.id,
        "ambiguous",
        null,
        "timeout",
        null,
      ]);
      expect((await push(orgA, id))[0].status).toBe("sent");
      const again = (await importJob())!;
      expect(again).toMatchObject({ id: j.id, check_first: true });
      await rpc("acc_tally_bridge_import_result", [orgA, device, j.id, "exists", 77, null, null]);
      expect((await push(orgA, id))[0]).toMatchObject({ status: "done", tally_master_id: "77" });
    });

    it("no answer for ten minutes: the import is looked up first next time; after five tries it is unknown", async () => {
      const id2 = "55555555-5555-4555-8555-555555555555";
      await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, id2)], "2026-08-01", null]);
      pushId = (await push(orgA, id2))[0].id;
      // Tally not running: the attempt does not count
      let j = (await importJob())!;
      await rpc("acc_tally_bridge_import_result", [
        orgA,
        device,
        j.id,
        "retry",
        null,
        "tally_unreachable",
        null,
      ]);
      expect(
        await one("select status, attempts, check_first from public.acc_tally_jobs where id = $1", [
          j.id,
        ]),
      ).toEqual({ status: "queued", attempts: 0, check_first: false });
      for (let i = 1; i <= 5; i++) {
        j = (await importJob())!;
        expect(j.check_first).toBe(i > 1);
        await svc(() =>
          q(
            "update public.acc_tally_jobs set sent_at = now() - interval '11 minutes' where id = $1",
            [j.id],
          ),
        );
      }
      await claim(orgA, device); // the fifth unanswered send is given up
      expect((await push(orgA, id2))[0]).toMatchObject({ status: "unknown", reason: "no_answer" });
      expect(
        hint(await fails(rpc("acc_tally_bridge_retry", [orgA, users.acct, pushId, "2026-08-01"]))),
      ).toBe("not_permitted");
      expect(
        await rpc("acc_tally_bridge_retry", [orgA, users.chief, pushId, "2026-08-01"]),
      ).toMatchObject({
        status: "ready",
        check_first: true,
      });
      j = (await importJob())!;
      expect(j.check_first).toBe(true);
      // Tally refuses it: failed with its (redacted) text, then sent again by a person
      await rpc("acc_tally_bridge_import_result", [
        orgA,
        device,
        j.id,
        "failed",
        null,
        "tally_error",
        "Voucher type 'Pulse Payment' does not exist",
      ]);
      expect((await push(orgA, id2))[0]).toMatchObject({
        status: "failed",
        reason: "tally_error",
        detail: "Voucher type 'Pulse Payment' does not exist",
      });
      await rpc("acc_tally_bridge_retry", [orgA, users.chief, pushId, "2026-08-01"]);
      expect((await importJob())!.check_first).toBe(false);
    });
  });

  describe("the ledger start", () => {
    it("stops pushing: nothing new is applied, queued imports are cancelled and held; pulls continue", async () => {
      const device = (
        await rpc<{ device_id: string }>("acc_tally_bridge_device", [
          sha("ptb_" + "c".repeat(43)),
          null,
          "ok",
        ])
      ).device_id;
      await rpc("acc_tally_bridge_save_settings", [
        orgC,
        users.chief,
        { push_enabled: true, pull_enabled: true, push_from: "2026-07-01", revenue_mode: "daily" },
      ]);
      const id = "66666666-6666-4666-8666-666666666666";
      await rpc("acc_tally_bridge_push_apply", [orgC, [item(orgC, id)], "2026-08-01", null]);
      await rpc("acc_tally_bridge_tick", [orgC, "2026-08-01"]);
      await one(
        "select public.acc_set_ledger_start($1, (select id from public.acc_entities where org_id = $1 and is_default), $2, '2026-09-01') as r",
        [orgC, users.chief],
      );
      // dated on or after the start: Pulse posts it itself, never sent
      expect(
        await rpc("acc_tally_bridge_push_apply", [
          orgC,
          [item(orgC, "77777777-7777-4777-8777-777777777777", { date: "2026-09-02" })],
          "2026-08-15",
          null,
        ]),
      ).toEqual({ out_of_range: 1 });
      // from the start on, nothing at all
      expect(
        await rpc("acc_tally_bridge_push_apply", [orgC, [item(orgC, id)], "2026-09-01", null]),
      ).toEqual({
        stopped: "ledger_started",
      });
      const res = await claim(orgC, device, "2026-09-01");
      expect(res.jobs.map((j) => j.kind).sort()).toEqual([
        "export_masters_since",
        "export_trial_balance",
        "export_vouchers_since",
      ]);
      expect((await push(orgC, id))[0]).toMatchObject({ status: "held", reason: "ledger_started" });
      expect(
        await n(
          "select count(*) as n from public.acc_tally_jobs where org_id = $1 and kind = 'import_voucher' and status = 'cancelled'",
          [orgC],
        ),
      ).toBe(1);
    });
  });

  describe("pulling", () => {
    let plan: TallyPlan;
    const pushedId = "88888888-8888-4888-8888-888888888888";
    let remote: string;

    async function context(org: string): Promise<PlanContext> {
      const accounts = (
        await svc(() =>
          q(
            "select id, code, name, is_group, is_system, tally_guid, tally_group, control from public.acc_accounts where org_id = $1",
            [org],
          ),
        )
      ).rows;
      const costCentres = (
        await svc(() =>
          q("select id, code, name from public.acc_cost_centres where org_id = $1", [org]),
        )
      ).rows;
      const tallyJournals = (
        await svc(() =>
          q(
            "select tally_guid as guid, source_version as version from public.acc_journals where org_id = $1 and source_kind = 'tally_import' and status = 'posted'",
            [org],
          ),
        )
      ).rows;
      return { accounts, costCentres, tallyJournals } as PlanContext;
    }
    async function stageBridge(org: string, p: TallyPlan, source = "bridge"): Promise<string> {
      const imp = await one<{ id: string }>(
        `insert into public.acc_tally_imports (org_id, entity_id, file_sha256, source)
         values ($1, (select id from public.acc_entities where org_id = $1 and is_default), $2, $3) returning id`,
        [org, [sha(String(Math.random()))], source],
      );
      const rows = stagedRows(org, imp.id, p);
      if (rows.length)
        await svc(() =>
          q(
            `insert into public.acc_tally_staged (org_id, import_id, seq, kind, guid, alter_id, payload)
             select org_id, import_id, seq, kind, guid, alter_id, payload from jsonb_populate_recordset(null::public.acc_tally_staged, $1::jsonb)`,
            [JSON.stringify(rows)],
          ),
        );
      return imp.id;
    }
    const pulledXml = () => {
      // what Tally would export for the voucher the bridge pushed: Pulse's own import, plus Tally's ALTERID
      const xml = buildBridgeVoucherXml({
        company: "Demo Clinic LLC",
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
      });
      return xml.replace("<DATE>", "<ALTERID>500</ALTERID><MASTERID>9</MASTERID><DATE>");
    };

    beforeAll(async () => {
      // the chart from the 22I fixtures, applied by the bridge (no person)
      const masters = parseTallyXml(readFileSync(join(FIX, "masters.xml")));
      const mplan = planTallyImport(mergeParsed([masters]), await context(orgA), {
        openingDate: null,
      });
      const imp = await stageBridge(orgA, mplan);
      await rpc("acc_tally_apply_masters", [orgA, imp, null]);
      await rpc("acc_tally_bridge_pull_finish", [
        orgA,
        null,
        imp,
        "masters",
        40,
        [],
        [{ guid: "demo-guid-led-bank", name: "Bank - Demo Main" }],
      ]);
      // the voucher the bridge pushed
      await rpc("acc_tally_bridge_push_apply", [orgA, [item(orgA, pushedId)], "2026-08-01", null]);
      remote = (await push(orgA, pushedId))[0].remote_id;
    });

    it("a file import still needs a person; a bridge import does not", async () => {
      const imp = await stageBridge(
        orgA,
        { masters: [], vouchers: [] } as unknown as TallyPlan,
        "file",
      );
      expect(hint(await fails(rpc("acc_tally_apply_masters", [orgA, imp, null])))).toBe(
        "not_permitted",
      );
      expect(
        await one<{ tally_name: string }>(
          "select tally_name from public.acc_accounts where org_id = $1 and tally_guid = 'demo-guid-led-bank'",
          [orgA],
        ),
      ).toEqual({ tally_name: "Bank - Demo Main" });
      expect(
        await one(
          "select alter_id from public.acc_tally_cursors where org_id = $1 and cursor = 'masters'",
          [orgA],
        ),
      ).toEqual({ alter_id: "40" });
    });

    it("posts the pushed voucher once as Tally's, links it back to its source, and never twice", async () => {
      plan = planTallyImport(
        withPulseVoucherTypes(mergeParsed([parseTallyXml(new TextEncoder().encode(pulledXml()))])),
        await context(orgA),
        {
          openingDate: null,
        },
      );
      expect(plan.vouchers).toHaveLength(1);
      expect(plan.vouchers[0].payload.remote_id).toBe(remote);
      const imp = await stageBridge(orgA, plan);
      await rpc("acc_tally_apply_masters", [orgA, imp, null]);
      expect(await rpc("acc_tally_post_vouchers", [orgA, imp, null, 10])).toMatchObject({
        done: 1,
        remaining: 0,
      });
      const fin = await rpc<Record<string, unknown>>("acc_tally_bridge_pull_finish", [
        orgA,
        null,
        imp,
        "vouchers",
        500,
        [],
        [],
      ]);
      expect(fin).toMatchObject({ linked: 1 });
      const j = await one<{ id: string; source_kind: string; total: string; voucher_type: string }>(
        "select id, source_kind, total, voucher_type from public.acc_journals where org_id = $1 and tally_guid = $2 and status = 'posted'",
        [orgA, remote],
      );
      expect(j).toMatchObject({ source_kind: "tally_import", voucher_type: "payment" });
      expect(Number(j.total)).toBe(2500);
      expect((await push(orgA, pushedId))[0]).toMatchObject({ mirror_journal_id: j.id });
      expect(
        await n("select count(*) as n from public.acc_tally_imports where id = $1", [imp]),
      ).toBe(0);
      // the same voucher pulled again: unchanged, nothing staged, still one journal
      const again = planTallyImport(
        withPulseVoucherTypes(mergeParsed([parseTallyXml(new TextEncoder().encode(pulledXml()))])),
        await context(orgA),
        { openingDate: null },
      );
      expect(again.vouchers).toHaveLength(0);
      expect(again.report.counts.unchanged).toBe(1);
      await rpc("acc_tally_bridge_pull_finish", [
        orgA,
        null,
        null,
        "vouchers",
        400,
        [{ guid: "x", date: "2026-07-01", number: "1", code: "after_ledger_start" }],
        [],
      ]);
      expect(
        await n(
          "select count(*) as n from public.acc_journals where org_id = $1 and tally_guid = $2",
          [orgA, remote],
        ),
      ).toBe(1);
      // the cursor never moves back
      expect(
        await one(
          "select alter_id from public.acc_tally_cursors where org_id = $1 and cursor = 'vouchers'",
          [orgA],
        ),
      ).toEqual({ alter_id: "500" });
      // refusals are logged once a day per voucher and code
      await rpc("acc_tally_bridge_pull_finish", [
        orgA,
        null,
        null,
        "vouchers",
        500,
        [{ guid: "x", date: "2026-07-01", number: "1", code: "after_ledger_start" }],
        [],
      ]);
      expect(
        await n(
          "select count(*) as n from public.acc_tally_sync_log where org_id = $1 and outcome = 'refused' and tally_guid = 'x'",
          [orgA],
        ),
      ).toBe(1);
    });

    it("the trial-balance check compares Tally's closing balances with the mirror, without a person", async () => {
      const r = await rpc<Record<string, unknown>>("acc_tally_bridge_record_tb", [
        orgA,
        null,
        "2026-07-31",
        "d".repeat(64),
        [
          { name: "Bank - Demo Main", debit: 0, credit: 2500 },
          { name: "Supplier Demo B", debit: 2500, credit: 0 },
        ],
      ]);
      expect(r).toMatchObject({ reconciled: true, differences: 0 });
      expect(
        await one(
          "select source, reconciled from public.acc_tally_reconciliations where org_id = $1 order by created_at desc limit 1",
          [orgA],
        ),
      ).toEqual({ source: "bridge", reconciled: true });
      const drift = await rpc<Record<string, unknown>>("acc_tally_bridge_record_tb", [
        orgA,
        null,
        "2026-07-31",
        "e".repeat(64),
        [{ name: "Bank - Demo Main", debit: 0, credit: 2400 }],
      ]);
      expect(drift).toMatchObject({ reconciled: false });
      expect(Number(drift.differences)).toBeGreaterThan(0);
      // the bypass is the bridge's own: the reconciliation still refuses a call without a person
      expect(
        hint(
          await fails(
            rpc("acc_tally_reconcile", [orgA, null, null, null, "2026-07-31", "f".repeat(64), []]),
          ),
        ),
      ).toBe("not_permitted");
    });

    it("a voucher cancelled in Tally since it was mirrored is reversed in the mirror, once", async () => {
      const cancelled = pulledXml()
        .replace("<ALTERID>500</ALTERID>", "<ALTERID>501</ALTERID><ISCANCELLED>Yes</ISCANCELLED>");
      const v = parseTallyXml(new TextEncoder().encode(cancelled)).vouchers[0];
      expect(v).toMatchObject({ cancelled: true, alterId: 501 });
      const items = [{ guid: v.guid, alter_id: v.alterId }];
      expect(await rpc("acc_tally_bridge_pull_cancelled", [orgA, null, items])).toEqual({ reversed: 1, refused: 0 });
      expect(
        await one("select status from public.acc_journals where org_id = $1 and tally_guid = $2 and source_kind = 'tally_import'", [
          orgA,
          remote,
        ]),
      ).toEqual({ status: "reversed" });
      expect(await rpc("acc_tally_bridge_pull_cancelled", [orgA, null, items])).toEqual({ reversed: 0, refused: 0 });
      // an older ALTERID never reverses a newer mirror
      expect(await rpc("acc_tally_bridge_pull_cancelled", [orgA, null, [{ guid: remote, alter_id: 400 }]])).toEqual({
        reversed: 0,
        refused: 0,
      });
    });
  });

  describe("reading a slice's journal without posting it", () => {
    it("a bank transfer waiting for the ledger start: its journal, nothing posted, and a candidate", async () => {
      const acc = async (sql: string) => (await one<{ id: string }>(sql, [orgA])).id;
      const bank = await acc(
        "select id from public.acc_accounts where org_id = $1 and control = 'bank' and not is_group and is_active order by code limit 1",
      );
      const cash = await acc(
        "select id from public.acc_accounts where org_id = $1 and control = 'cash' and not is_group and is_active order by code limit 1",
      );
      const t = await rpc<{ id: string; status: string }>("acc_bank_transfer_create", [
        orgA,
        users.chief,
        {
          kind: "transfer",
          transfer_date: "2026-07-20",
          from_account_id: bank,
          to_account_id: cash,
          amount: 75,
          narration: "Float top-up",
        },
      ]);
      expect(t.status).toBe("waiting_ledger_start");
      const journals = await n("select count(*) as n from public.acc_journals where org_id = $1", [
        orgA,
      ]);
      const cap = await rpc<Record<string, unknown>>("acc_tally_bridge_capture", [
        orgA,
        "bank_transfer",
        t.id,
      ]);
      expect(cap).toMatchObject({
        source_kind: "bank_transfer",
        source_id: t.id,
        date: "2026-07-20",
        voucher_type: "contra",
      });
      expect(cap.lines).toEqual([
        expect.objectContaining({ account_id: cash, debit: 75 }),
        expect.objectContaining({ account_id: bank, credit: 75 }),
      ]);
      expect(
        await n("select count(*) as n from public.acc_journals where org_id = $1", [orgA]),
      ).toBe(journals);
      expect(
        await one("select status from public.acc_bank_transfers where id = $1", [t.id]),
      ).toEqual({ status: "waiting_ledger_start" });
      // nothing for another org's item, nor for an unknown kind
      expect(await rpc("acc_tally_bridge_capture", [orgB, "bank_transfer", t.id])).toBeNull();
      // the candidates list it once it has settled (two minutes)
      await q("set session_replication_role = replica");
      try {
        await q(
          "update public.acc_bank_transfers set updated_at = now() - interval '5 minutes' where id = $1",
          [t.id],
        );
      } finally {
        await q("set session_replication_role = origin");
      }
      const cands = await rpc<Array<Record<string, unknown>>>("acc_tally_bridge_candidates", [
        orgA,
        null,
        null,
        50,
      ]);
      expect(cands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "bank_transfer",
            id: t.id,
            state: "ready",
            date: "2026-07-20",
          }),
        ]),
      );
    });
  });

  describe("who sees what", () => {
    it("accounting.import reads the queue and the log; others and other orgs see nothing; nobody reads devices", async () => {
      const seen = async (u: string, table: string) =>
        asUser(c, users[u], async () =>
          Number((await q(`select count(*) as n from public.${table}`)).rows[0].n),
        );
      expect(await seen("chief", "acc_tally_push")).toBeGreaterThan(0);
      expect(await seen("chief", "acc_tally_sync_log")).toBeGreaterThan(0);
      expect(await seen("acct", "acc_tally_push")).toBe(0);
      expect(await seen("bob", "acc_tally_push")).toBe(0);
      expect(await seen("chief", "acc_tally_devices")).toBe(0);
      expect(await seen("alice", "acc_tally_devices")).toBe(0);
      // no write policy: a signed-in person changes nothing directly
      const changed = await asUser(c, users.chief, async () => {
        try {
          return (await q("update public.acc_tally_push set status = 'done'")).rowCount ?? 0;
        } catch {
          return 0;
        }
      });
      expect(changed).toBe(0);
    });
  });
});
