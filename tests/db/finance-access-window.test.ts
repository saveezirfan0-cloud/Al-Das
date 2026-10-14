/**
 * Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md), database side: security_alerts accepts the new
 * 'finance_access_denied' kind (service role only), still refuses unknown kinds, dedupes per (org, key), and the alert
 * is visible to the org's settings.manage holders only; app.finance_window_reason gives the same answers as the app
 * (shared fixtures); app.has_perm / app.has_perm_wild and RLS follow the days and hours. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { financeAccessAlert } from "@/lib/security/finance-access";

import fixtures from "../unit/finance/fixtures/finance-access-window.synthetic.json";

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

describe.skipIf(!TEST_DATABASE_URL)("finance access window: security alert kind", () => {
  let c: Client;
  let alice: string;
  let bob: string;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const insert = (org: string, kind: string, key: string, userId: string | null) =>
    c.query(
      `insert into public.security_alerts (org_id, kind, user_id, dedupe_key, summary, detail)
       values ($1, $2, $3, $4, 'Finance access refused', '{"reason":"outside_hours"}'::jsonb)
       on conflict (org_id, dedupe_key) do nothing`,
      [org, kind, userId, key],
    );

  it("accepts the new kind with the draft's own dedupe key, once per member per day", async () => {
    const draft = financeAccessAlert({
      userId: alice,
      reason: "outside_hours",
      now: new Date("2026-10-12T20:00:00Z"),
      timeZone: "Asia/Dubai",
      network: "203.0.113.0/24",
      ipHash: null,
    });
    expect(draft.dedupeKey.length).toBeLessThanOrEqual(200);
    expect(draft.summary.length).toBeLessThanOrEqual(300);
    await asServiceRole(c, async () => {
      await insert(orgA, draft.kind, draft.dedupeKey, alice);
      await insert(orgA, draft.kind, draft.dedupeKey, alice);
    });
    expect(
      await count(
        c,
        "select 1 from public.security_alerts where org_id = $1 and kind = 'finance_access_denied'",
        [orgA],
      ),
    ).toBe(1);
  });

  /** Runs one insert as the given role inside a throw-away transaction; returns the error code, or null. */
  async function failsAs(
    role: "service" | string,
    kind: string,
    key: string,
  ): Promise<string | null> {
    await c.query("begin");
    try {
      if (role === "service") await c.query("set local role service_role");
      else {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: role, role: "authenticated" }),
        ]);
      }
      await insert(orgA, kind, key, null);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? "unknown";
    } finally {
      await c.query("rollback");
    }
  }

  it("still refuses an unknown kind", async () => {
    expect(await failsAs("service", "not_a_kind", "x-1")).toBe("23514");
  });

  it("is readable by the org's own admin and never by another org's", async () => {
    const sql = "select 1 from public.security_alerts where kind = 'finance_access_denied'";
    expect(await asUser(c, alice, () => count(c, sql))).toBe(1);
    expect(await asUser(c, bob, () => count(c, sql))).toBe(0);
  });

  it("cannot be written by a signed-in user, even the org's admin", async () => {
    expect(await failsAs(alice, "finance_access_denied", "x-2")).toBe("42501");
    expect(await failsAs(bob, "finance_access_denied", "x-3")).toBe("42501");
    expect(orgB).toBeTruthy();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("finance access window: SQL rule parity", () => {
  let c: Client;
  beforeAll(async () => {
    c = await connect();
  });
  afterAll(async () => {
    await c.end();
  });

  type Case = {
    name: string;
    cfg: unknown;
    now?: string;
    timezone?: string;
    permissions?: string[];
    expect: string;
  };
  const fx = fixtures as { roleId: string; cases: Case[] };

  // A cfg the database refuses to store (app.finance_access_problem, behind the orgs trigger) can never reach the
  // read path, so for those the app must also refuse or not apply the window; every storable case must match exactly.
  it.each(fx.cases.map((k) => [k.name, k] as const))("%s", async (_name, k) => {
    const cfg = k.cfg === null ? null : JSON.stringify(k.cfg);
    const tz = k.timezone ?? "Asia/Dubai";
    const { rows: problem } = await c.query<{ p: string | null }>(
      "select app.finance_access_problem($1::jsonb, $2) as p",
      [cfg, tz],
    );
    if (problem[0].p !== null) {
      expect(["invalid_settings", "admin", "not_in_scope", "off"]).toContain(k.expect);
      return;
    }
    const { rows } = await c.query<{ r: string }>(
      "select app.finance_window_reason($1::jsonb, $2, $3::uuid, $4::jsonb, $5::timestamptz) as r",
      [
        cfg,
        tz,
        fx.roleId,
        JSON.stringify(k.permissions ?? ["finance.view", "inbox.send"]),
        k.now ?? "2026-10-12T08:00:00Z",
      ],
    );
    expect(rows[0].r).toBe(k.expect);
  });

  it("refuses at write time every malformed or incomplete case the app reads as invalid_settings", async () => {
    for (const k of fx.cases.filter((x) => x.expect === "invalid_settings")) {
      const { rows } = await c.query<{ p: string | null }>(
        "select app.finance_access_problem($1::jsonb, $2) as p",
        [k.cfg === null ? null : JSON.stringify(k.cfg), k.timezone ?? "Asia/Dubai"],
      );
      expect(rows[0].p, k.name).not.toBeNull();
    }
  });

  it("still fails closed on the read path when a stored value is ill-typed (written before the check)", async () => {
    const role = fx.roleId;
    for (const cfg of [
      { enabled: "yes" },
      { enabled: true, scope: 5 },
      { enabled: true, scope: null },
      { enabled: true, scope: "selected_roles", role_ids: "all" },
      { enabled: true, limit_hours: "no" },
      { enabled: true, days: "weekdays" },
      { enabled: true, days: [] },
      { enabled: true, start: 7 },
      { enabled: true, end: "25:00" },
      [1, 2],
    ]) {
      const { rows } = await c.query<{ r: string }>(
        "select app.finance_window_hours($1::jsonb, 'Asia/Dubai', $2::uuid, '2026-10-12T08:00:00Z') as r",
        [JSON.stringify(cfg), role],
      );
      expect(rows[0].r, JSON.stringify(cfg)).toBe("invalid_settings");
    }
  });

  it("is not callable by signed-in users directly", async () => {
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      for (const sql of [
        "select app.finance_window_reason(null, 'UTC', null, '[]'::jsonb, now())",
        "select app.finance_window_hours(null, 'UTC', null, now())",
        "select app.finance_access_problem(null, 'UTC')",
      ]) {
        await c.query("savepoint s");
        const err = await c.query(sql).catch((e: { code?: string }) => e);
        expect((err as { code?: string }).code, sql).toBe("42501");
        await c.query("rollback to savepoint s");
      }
    } finally {
      await c.query("rollback");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "finance access window: has_perm, has_perm_wild and RLS",
  () => {
    let c: Client;
    let admin: string;
    let fin: string;
    let wild: string;
    let org: string;

    /** A window that is open only for one minute twelve hours from now (UTC), so it is closed now. */
    function closedNow() {
      const h = (new Date().getUTCHours() + 12) % 24;
      const hh = String(h).padStart(2, "0");
      return { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], start: `${hh}:00`, end: `${hh}:01` };
    }
    const openNow = { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "00:00" };

    async function setWindow(cfg: unknown) {
      await asServiceRole(c, () =>
        c.query(
          "update public.orgs set timezone = 'UTC', settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{finance_access}', $2::jsonb) where id = $1",
          [org, JSON.stringify(cfg)],
        ),
      );
    }
    const perm = async (user: string, fn: "has_perm" | "has_perm_wild", key: string) =>
      asUser(c, user, async () => {
        const { rows } = await c.query<{ ok: boolean }>(`select app.${fn}($1, $2) as ok`, [
          org,
          key,
        ]);
        return rows[0].ok;
      });

    beforeAll(async () => {
      c = await connect();
      await resetDb(c);
      admin = await createAuthUser(c, "admin@example.test");
      fin = await createAuthUser(c, "fin@example.test");
      wild = await createAuthUser(c, "wild@example.test");
      org = await createOrg(c, "Org W", "org-w", admin);
      await asServiceRole(c, async () => {
        const { rows: r1 } = await c.query<{ id: string }>(
          `insert into public.roles (org_id, name, permissions)
         values ($1, 'Finance test', '["finance.reference.manage", "accounting.journals.view", "accounting.view", "accounting.ledger.view", "inbox.send"]'::jsonb) returning id`,
          [org],
        );
        const { rows: r2 } = await c.query<{ id: string }>(
          `insert into public.roles (org_id, name, permissions) values ($1, 'Finance wildcard', '["finance.*", "portal.*"]'::jsonb) returning id`,
          [org],
        );
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3), ($1, $4, $5)",
          [org, fin, r1[0].id, wild, r2[0].id],
        );
        await c.query(
          `insert into public.fin_ref_denial_codes (org_id, code, description) values ($1, 'SYN-1', 'Synthetic code')`,
          [org],
        );
        await c.query(
          `insert into public.acc_cost_centres (org_id, code, name) values ($1, 'SYN1', 'Synthetic centre')`,
          [org],
        );
      });
    });

    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("changes nothing while the window is off or absent", async () => {
      await setWindow({ enabled: false, scope: "selected_roles", role_ids: [] });
      expect(await perm(fin, "has_perm", "finance.reference.manage")).toBe(true);
      expect(await perm(wild, "has_perm_wild", "finance.bank.view")).toBe(true);
      await asServiceRole(c, () =>
        c.query("update public.orgs set settings = settings - 'finance_access' where id = $1", [
          org,
        ]),
      );
      expect(await perm(fin, "has_perm", "accounting.journals.view")).toBe(true);
    });

    it("grants finance and accounting keys inside the hours", async () => {
      await setWindow(openNow);
      expect(await perm(fin, "has_perm", "finance.reference.manage")).toBe(true);
      expect(await perm(fin, "has_perm_wild", "accounting.journals.view")).toBe(true);
      expect(await perm(wild, "has_perm_wild", "finance.bank.view")).toBe(true);
      const n = await asUser(c, fin, () =>
        count(c, "select 1 from public.fin_ref_denial_codes where code = 'SYN-1'"),
      );
      expect(n).toBe(1);
    });

    it("refuses finance and accounting keys outside the hours and keeps every other key", async () => {
      await setWindow(closedNow());
      expect(await perm(fin, "has_perm", "finance.reference.manage")).toBe(false);
      expect(await perm(fin, "has_perm", "accounting.journals.view")).toBe(false);
      expect(await perm(fin, "has_perm_wild", "finance.reference.manage")).toBe(false);
      expect(await perm(wild, "has_perm_wild", "finance.bank.view")).toBe(false);
      expect(await perm(fin, "has_perm", "inbox.send")).toBe(true);
      expect(await perm(wild, "has_perm_wild", "portal.claims.read")).toBe(true);
      // a key the role never had stays refused
      expect(await perm(fin, "has_perm", "finance.costs.compensation")).toBe(false);
    });

    it("hides finance rows from direct reads and refuses direct writes outside the hours", async () => {
      await setWindow(closedNow());
      const n = await asUser(c, fin, () =>
        count(c, "select 1 from public.fin_ref_denial_codes where code = 'SYN-1'"),
      );
      expect(n).toBe(0);
      await c.query("begin");
      try {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: fin, role: "authenticated" }),
        ]);
        const err = await c
          .query(
            "insert into public.fin_ref_denial_codes (org_id, code, description) values ($1, 'SYN-2', 'Synthetic')",
            [org],
          )
          .catch((e: { code?: string }) => e);
        expect((err as { code?: string }).code).toBe("42501");
      } finally {
        await c.query("rollback");
      }
    });

    it("never restricts Admin", async () => {
      await setWindow(closedNow());
      expect(await perm(admin, "has_perm", "finance.reference.manage")).toBe(true);
      expect(await perm(admin, "has_perm_wild", "accounting.journals.post")).toBe(true);
      const n = await asUser(c, admin, () =>
        count(c, "select 1 from public.fin_ref_denial_codes where code = 'SYN-1'"),
      );
      expect(n).toBe(1);
    });

    it("fails closed on a malformed window that is switched on, and honours selected roles", async () => {
      // a value written before the check existed: bypass the trigger as the owner
      await c.query("alter table public.orgs disable trigger orgs_finance_access_guard");
      try {
        await c.query(
          "update public.orgs set settings = jsonb_set(settings, '{finance_access}', $2::jsonb) where id = $1",
          [org, JSON.stringify({ enabled: true, days: "weekdays" })],
        );
      } finally {
        await c.query("alter table public.orgs enable trigger orgs_finance_access_guard");
      }
      expect(await perm(fin, "has_perm", "finance.reference.manage")).toBe(false);
      expect(await asUser(c, fin, () => count(c, "select 1 from public.acc_cost_centres"))).toBe(0);
      await setWindow({
        ...closedNow(),
        scope: "selected_roles",
        role_ids: ["22222222-2222-4222-8222-222222222222"],
      });
      expect(await perm(fin, "has_perm", "finance.reference.manage")).toBe(true);
    });

    it("ignores the address list in the database (app-only)", async () => {
      await setWindow({ enabled: true, limit_hours: false, ip_allowlist: ["198.51.100.0/24"] });
      expect(await perm(fin, "has_perm", "finance.reference.manage")).toBe(true);
    });

    it("covers the accounting ledger helpers: outside the hours no acc_* rows, Admin still reads them", async () => {
      await setWindow(openNow);
      const sql = "select 1 from public.acc_cost_centres where code = 'SYN1'";
      expect(await asUser(c, fin, () => count(c, sql))).toBe(1);
      await setWindow(closedNow());
      expect(await asUser(c, fin, () => count(c, sql))).toBe(0);
      expect(await asUser(c, admin, () => count(c, sql))).toBe(1);
      for (const fn of [
        "acc_can_view",
        "acc_can_read_journals",
        "acc_can_read_receivables",
        "acc_can_read_banking",
      ]) {
        const ok = await asUser(c, fin, async () => {
          const { rows } = await c.query<{ ok: boolean }>(`select app.${fn}($1) as ok`, [org]);
          return rows[0].ok;
        });
        expect(ok, fn).toBe(false);
      }
      const adminBudgets = await asUser(c, admin, async () => {
        const { rows } = await c.query<{ ok: boolean }>(
          "select app.acc_can_read_budgets($1) as ok",
          [org],
        );
        return rows[0].ok;
      });
      expect(adminBudgets).toBe(true);
    });

    it("refuses an invalid setting or an offset timezone when written", async () => {
      const code = async (sql: string, params: unknown[]) => {
        await c.query("begin");
        try {
          await c.query(sql, params);
          return null;
        } catch (e) {
          return (e as { code?: string }).code ?? "unknown";
        } finally {
          await c.query("rollback");
        }
      };
      const put =
        "update public.orgs set settings = jsonb_set(settings, '{finance_access}', $2::jsonb) where id = $1";
      expect(
        await code(put, [org, JSON.stringify({ enabled: true, ip_allowlist: ["office"] })]),
      ).toBe("23514");
      expect(await code(put, [org, JSON.stringify({ enabled: false, days: "x" })])).toBe("23514");
      await setWindow(openNow);
      for (const tz of ["+04:00", "UTC+4", "Not/AZone", "posix/Asia/Dubai"])
        expect(
          await code("update public.orgs set timezone = $2 where id = $1", [org, tz]),
          tz,
        ).toBe("23514");
      expect(
        await code("update public.orgs set timezone = 'Asia/Dubai' where id = $1", [org]),
      ).toBeNull();
      // while the window is off the timezone is not the window's business
      await setWindow({ enabled: false });
      expect(
        await code("update public.orgs set timezone = '+04:00' where id = $1", [org]),
      ).toBeNull();
      // and unrelated updates are never held up
      expect(await code("update public.orgs set name = 'Org W2' where id = $1", [org])).toBeNull();
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)("finance access window: guard on permission readers", () => {
  let c: Client;
  beforeAll(async () => {
    c = await connect();
  });
  afterAll(async () => {
    await c.end();
  });

  // Any function that reads roles.permissions for a finance or accounting key must also ask the window. The allowed
  // readers either check the window themselves or are service-role only with an explicit user (user_has_perm).
  const ALLOWED = new Set([
    "app.has_perm",
    "app.has_perm_wild",
    "app.user_has_perm",
    "app.acc_can_view",
    "app.acc_can_read_journals",
    "app.acc_can_read_receivables",
    "app.acc_can_read_banking",
    "app.acc_can_read_budgets",
  ]);
  const WINDOWED = [...ALLOWED].filter((f) => f !== "app.user_has_perm");

  it("finds no other function reading permissions for a finance or accounting key", async () => {
    const { rows } = await c.query<{ fn: string; src: string }>(
      `select n.nspname || '.' || p.proname as fn, p.prosrc as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'public')
         and p.prosrc ~ $1`,
      [String.raw`(permissions\s*(\?|@>)|jsonb_array_elements_text\(\s*\w+\.permissions)`],
    );
    const offenders = rows
      .filter(
        (r) =>
          // a finance/accounting key written in the body, or a key passed in by the caller
          /'(finance|accounting)\./.test(r.src) ||
          /permissions\s*\?\|?\s*p_|perm\.key\s*=\s*p_/.test(r.src),
      )
      .map((r) => r.fn)
      .filter((fn) => !ALLOWED.has(fn));
    expect(offenders).toEqual([]);
  });

  it("every allowed reader except user_has_perm asks the window", async () => {
    for (const fn of WINDOWED) {
      const { rows } = await c.query<{ src: string }>(
        "select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = $1",
        [fn],
      );
      expect(rows.length, fn).toBe(1);
      expect(rows[0].src, fn).toContain("app.finance_window_open");
    }
  });
});
