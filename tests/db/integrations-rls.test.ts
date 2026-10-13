/**
 * Phase 19a: tenant isolation and the permission matrix for the integration tables, that a browser session can never write
 * them, their constraints, the housekeeping jobs, and the data migration that grants the new permissions. Synthetic data only.
 * Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES, SYSTEM_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  PHASE19_SERVICE_ONLY_TABLES,
  PHASE19_TABLES,
  resetDb,
  seedPhase19Rows,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 19a: integrations, access and constraints", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let ids: Record<string, string>;
  const users: Record<string, string> = {};
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "error",
    );
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "cal", "pay", "mgr", "ads", "docs", "nobody"])
      users[n] = await createAuthUser(c, `${n}@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      const role = async (name: string, perms: string[]) =>
        q(
          "insert into public.roles (org_id, name, description, permissions) values ($1, $2, '', $3::jsonb)",
          [orgA, name, JSON.stringify(perms)],
        );
      await role("Calendar only", ["integrations.calendar"]);
      await role("Payments only", ["finance.payment_links"]);
      await role("Integrations admin", ["integrations.manage"]);
      await role("Ads only", ["ads.view"]);
      await role("Documents viewer", ["documents.view"]);
      const member = (user: string, name: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[user], name],
        );
      await member("cal", "Calendar only");
      await member("pay", "Payments only");
      await member("mgr", "Integrations admin");
      await member("ads", "Ads only");
      await member("docs", "Documents viewer");
    });
    ids = await seedPhase19Rows(c, orgA, users.alice);
    await seedPhase19Rows(c, orgB, users.bob);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const MATRIX: Record<string, string[]> = {
    ad_attributions: ["ads"],
    calendar_feeds: ["cal"],
    capi_events: ["ads"],
    esign_requests: ["docs"],
    fin_payment_requests: ["pay"],
    integration_calls: ["mgr"],
    integration_usage_daily: ["mgr"],
    review_requests: ["mgr"],
    sms_messages: ["mgr"],
  };

  it("covers every Phase 19 table in the matrix", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PHASE19_TABLES].sort());
  });

  it("shows each table to exactly the permission that owns it, and only for the member's org", async () => {
    for (const [table, allowed] of Object.entries(MATRIX)) {
      for (const user of ["alice", "cal", "pay", "mgr", "ads", "docs", "nobody", "bob"]) {
        const n = await asUser(c, users[user], () => count(c, `select 1 from public.${table}`));
        const mayRead = user === "alice" ? true : allowed.includes(user);
        if (user === "bob")
          expect(n, `${table} as bob`).toBe(1); // bob's own org row only
        else expect(n > 0, `${table} as ${user}`).toBe(mayRead);
      }
    }
  });

  it("hides org A's rows from org B's admin and the service-only tables from every signed-in user", async () => {
    for (const t of PHASE19_TABLES)
      expect(
        await asUser(c, users.bob, () =>
          count(c, `select 1 from public.${t} where org_id = $1`, [orgA]),
        ),
        t,
      ).toBe(0);
    for (const t of PHASE19_SERVICE_ONLY_TABLES)
      expect(await asUser(c, users.alice, () => count(c, `select 1 from public.${t}`)), t).toBe(0);
    expect(
      await svc(() =>
        count(c, "select 1 from public.integration_accounts where org_id = $1", [orgA]),
      ),
    ).toBe(1);
  });

  it("never lets a browser session write any of them, whatever its role", async () => {
    for (const user of ["alice", "mgr", "cal", "pay", "ads", "docs"]) {
      await asUser(c, users[user], async () => {
        for (const t of [...PHASE19_TABLES, ...PHASE19_SERVICE_ONLY_TABLES]) {
          await q("begin");
          const ins = await code(q(`insert into public.${t} (org_id) values ($1)`, [orgA]));
          await q("rollback");
          expect(ins, `${user} insert ${t}`).toBe("42501");
          await q("begin");
          const upd = await q(`update public.${t} set org_id = org_id where org_id = $1`, [
            orgA,
          ]).catch(() => ({ rowCount: 0 }));
          const del = await q(`delete from public.${t} where org_id = $1`, [orgA]).catch(() => ({
            rowCount: 0,
          }));
          await q("rollback");
          expect(upd.rowCount ?? 0, `${user} update ${t}`).toBe(0);
          expect(del.rowCount ?? 0, `${user} delete ${t}`).toBe(0);
        }
      });
    }
  });

  it("starts every integration switched off", async () => {
    await svc(async () => {
      const { rows } = await q(
        "insert into public.integration_accounts (org_id, kind, config_enc) values ($1, 'payments', 'v1:a:b:c') returning enabled, status",
        [orgA],
      );
      expect(rows[0]).toEqual({ enabled: false, status: "active" }); // the app creates rows as 'disabled'; the flag is what gates
      await q("delete from public.integration_accounts where org_id = $1 and kind = 'payments'", [
        orgA,
      ]);
    });
  });

  describe("calendar_feeds", () => {
    const insert = (over: Record<string, unknown> = {}) => {
      const v = {
        org_id: orgA,
        kind: "specialist",
        specialist_id: ids.specialist,
        user_id: null,
        label: "F",
        token_hash: "a".repeat(64),
        ...over,
      };
      return svc(() =>
        q(
          "insert into public.calendar_feeds (org_id, kind, specialist_id, user_id, label, token_hash) values ($1, $2, $3, $4, $5, $6)",
          [v.org_id, v.kind, v.specialist_id, v.user_id, v.label, v.token_hash],
        ),
      );
    };

    it("requires exactly one target matching its kind", async () => {
      expect(await code(insert({ specialist_id: null }))).toBe("23514");
      expect(await code(insert({ kind: "user", user_id: users.alice }))).toBe("23514"); // specialist_id also set
      expect(await code(insert({ kind: "user", specialist_id: null, user_id: null }))).toBe(
        "23514",
      );
    });

    it("accepts only a SHA-256 hex hash and keeps hashes unique", async () => {
      expect(await code(insert({ token_hash: "short" }))).toBe("23514");
      expect(await code(insert({ token_hash: "G".repeat(64) }))).toBe("23514");
      expect(await code(insert({ token_hash: "b".repeat(64) }))).toBeNull();
      expect(await code(insert({ token_hash: "b".repeat(64) }))).toBe("23505");
    });

    it("refuses a doctor from another org and a person who is not a member", async () => {
      const other = await svc(
        async () =>
          (
            await q(
              "insert into public.specialists (org_id, name) values ($1, 'Dr Other') returning id",
              [orgB],
            )
          ).rows[0].id as string,
      );
      expect(await code(insert({ specialist_id: other, token_hash: "c".repeat(64) }))).toBe(
        "23514",
      );
      expect(
        await code(
          insert({
            kind: "user",
            specialist_id: null,
            user_id: users.bob,
            token_hash: "d".repeat(64),
          }),
        ),
      ).toBe("23514");
      expect(
        await code(
          insert({
            kind: "user",
            specialist_id: null,
            user_id: users.cal,
            token_hash: "e".repeat(64),
          }),
        ),
      ).toBeNull();
    });

    it("counts accesses atomically", async () => {
      await svc(async () => {
        await q("select public.calendar_feed_touch($1)", [ids.feed]);
        await q("select public.calendar_feed_touch($1)", [ids.feed]);
        const { rows } = await q(
          "select access_count::int as n, last_access_at is not null as seen from public.calendar_feeds where id = $1",
          [ids.feed],
        );
        expect(rows[0]).toEqual({ n: 2, seen: true });
      });
    });
  });

  describe("fin_payment_requests", () => {
    const base = (over: Record<string, unknown> = {}) => ({
      org_id: orgA,
      invoice_id: ids.invoice,
      invoice_number: "INV-SEED-19",
      provider: "stripe",
      amount_minor: 100,
      currency: "AED",
      status: "created",
      provider_ref: null as string | null,
      ...over,
    });
    const insert = (over: Record<string, unknown> = {}) => {
      const v = base(over);
      return svc(() =>
        q(
          "insert into public.fin_payment_requests (org_id, invoice_id, invoice_number, provider, amount_minor, currency, status, provider_ref) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            v.org_id,
            v.invoice_id,
            v.invoice_number,
            v.provider,
            v.amount_minor,
            v.currency,
            v.status,
            v.provider_ref,
          ],
        ),
      );
    };
    let invoice2: string;
    beforeAll(async () => {
      invoice2 = await svc(
        async () =>
          (
            await q(
              "insert into public.fin_invoices (org_id, inv_display_number, patient_pin, total, record_hash) values ($1, 'INV-SEED-19B', 'PIN-B', 99, 'h2') returning id",
              [orgA],
            )
          ).rows[0].id as string,
      );
    });

    it("allows one live request per invoice, and a new one after the old one is closed", async () => {
      // the seeded request is 'sent' (live)
      expect(await code(insert())).toBe("23505");
      await svc(() =>
        q("update public.fin_payment_requests set status = 'cancelled' where id = $1", [
          ids.payment,
        ]),
      );
      expect(await code(insert())).toBeNull();
      expect(await code(insert())).toBe("23505");
      await svc(() =>
        q(
          "update public.fin_payment_requests set status = 'paid' where org_id = $1 and invoice_id = $2 and status = 'created'",
          [orgA, ids.invoice],
        ),
      );
      expect(await code(insert())).toBeNull(); // paid is not live
    });

    it("keeps gateway references unique per org and provider", async () => {
      expect(await code(insert({ invoice_id: invoice2, provider_ref: "cs_test_1" }))).toBeNull();
      await svc(() =>
        q("update public.fin_payment_requests set status = 'cancelled' where invoice_id = $1", [
          invoice2,
        ]),
      );
      expect(await code(insert({ invoice_id: invoice2, provider_ref: "cs_test_1" }))).toBe("23505");
      expect(
        await code(
          insert({ invoice_id: invoice2, provider_ref: "cs_test_1", provider: "paytabs" }),
        ),
      ).toBeNull();
    });

    it("rejects zero amounts, lower-case currencies, unknown statuses and providers, and another org's invoice", async () => {
      expect(await code(insert({ invoice_id: invoice2, amount_minor: 0 }))).toBe("23514");
      expect(await code(insert({ invoice_id: invoice2, currency: "aed" }))).toBe("23514");
      expect(await code(insert({ invoice_id: invoice2, status: "refunded" }))).toBe("23514");
      expect(await code(insert({ invoice_id: invoice2, provider: "paypal" }))).toBe("23514");
      const otherInvoice = await svc(
        async () =>
          (await q("select id from public.fin_invoices where org_id = $1 limit 1", [orgB])).rows[0]
            .id as string,
      );
      expect(await code(insert({ invoice_id: otherInvoice }))).toBe("23514");
    });

    it("closes links past their expiry with the scheduled statement, and only those", async () => {
      const cmd = (
        await q("select command from cron.job where jobname = 'pulse:fin_payment_expiry'")
      ).rows[0]?.command as string | undefined;
      expect(cmd, "cron entry").toBeTruthy();
      const invoice3 = await svc(
        async () =>
          (
            await q(
              "insert into public.fin_invoices (org_id, inv_display_number, patient_pin, total, record_hash) values ($1, 'INV-SEED-19C', 'PIN-C', 99, 'h3') returning id",
              [orgA],
            )
          ).rows[0].id as string,
      );
      const invoice4 = await svc(
        async () =>
          (
            await q(
              "insert into public.fin_invoices (org_id, inv_display_number, patient_pin, total, record_hash) values ($1, 'INV-SEED-19D', 'PIN-D', 99, 'h4') returning id",
              [orgA],
            )
          ).rows[0].id as string,
      );
      await svc(async () => {
        await q(
          "insert into public.fin_payment_requests (org_id, invoice_id, invoice_number, provider, amount_minor, currency, status, expires_at) values ($1, $2, 'C', 'stripe', 100, 'AED', 'sent', now() - interval '1 hour')",
          [orgA, invoice3],
        );
        await q(
          "insert into public.fin_payment_requests (org_id, invoice_id, invoice_number, provider, amount_minor, currency, status, expires_at) values ($1, $2, 'D', 'stripe', 100, 'AED', 'sent', now() + interval '1 hour')",
          [orgA, invoice4],
        );
        await q(cmd!);
        const { rows } = await q(
          "select invoice_number, status from public.fin_payment_requests where invoice_number in ('C','D') order by 1",
        );
        expect(rows).toEqual([
          { invoice_number: "C", status: "expired" },
          { invoice_number: "D", status: "sent" },
        ]);
      });
    });
  });

  describe("sms_messages", () => {
    const insert = (over: Record<string, unknown> = {}) => {
      const v = {
        dedupe_key: "reminder:1",
        provider: "twilio",
        status: "queued",
        segments: null as number | null,
        provider_message_id: null as string | null,
        ...over,
      };
      return svc(() =>
        q(
          "insert into public.sms_messages (org_id, contact_id, provider, dedupe_key, status, segments, provider_message_id) values ($1, $2, $3, $4, $5, $6, $7)",
          [
            orgA,
            ids.contact,
            v.provider,
            v.dedupe_key,
            v.status,
            v.segments,
            v.provider_message_id,
          ],
        ),
      );
    };

    it("dedupes per org and keeps provider ids unique", async () => {
      expect(await code(insert())).toBeNull();
      expect(await code(insert())).toBe("23505");
      expect(
        await code(insert({ dedupe_key: "reminder:2", provider_message_id: "SM1" })),
      ).toBeNull();
      expect(await code(insert({ dedupe_key: "reminder:3", provider_message_id: "SM1" }))).toBe(
        "23505",
      );
    });

    it("checks status and segment ranges, and keeps other orgs' contacts out", async () => {
      expect(await code(insert({ dedupe_key: "x1", status: "delivered?" }))).toBe("23514");
      expect(await code(insert({ dedupe_key: "x2", segments: 0 }))).toBe("23514");
      expect(await code(insert({ dedupe_key: "x3", segments: 21 }))).toBe("23514");
      const otherContact = await svc(
        async () =>
          (await q("select id from public.contacts where org_id = $1 limit 1", [orgB])).rows[0]
            .id as string,
      );
      expect(
        await code(
          svc(() =>
            q(
              "insert into public.sms_messages (org_id, contact_id, provider, dedupe_key) values ($1, $2, 'twilio', 'x4')",
              [orgA, otherContact],
            ),
          ),
        ),
      ).toBe("23514");
    });

    it("stores no phone number, name or text anywhere in the table", async () => {
      const cols = (
        await q(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sms_messages'",
        )
      ).rows.map((r) => r.column_name as string);
      for (const bad of ["phone", "to", "body", "text", "message", "name"])
        expect(
          cols.some((x) => x === bad || x.includes(`${bad}_e164`)),
          bad,
        ).toBe(false);
    });

    it("closes a message stuck in 'sending' after 30 minutes without re-sending it", async () => {
      const cmd = (await q("select command from cron.job where jobname = 'pulse:sms_stalled'"))
        .rows[0]?.command as string | undefined;
      expect(cmd, "cron entry").toBeTruthy();
      await svc(async () => {
        await q(
          "insert into public.sms_messages (org_id, contact_id, provider, dedupe_key, status, updated_at) values ($1, $2, 'twilio', 'stuck', 'sending', now() - interval '2 hours'), ($1, $2, 'twilio', 'fresh', 'sending', now())",
          [orgA, ids.contact],
        );
        await q(cmd!);
        const { rows } = await q(
          "select dedupe_key, status, error_code from public.sms_messages where dedupe_key in ('stuck','fresh') order by 1",
        );
        expect(rows).toEqual([
          { dedupe_key: "fresh", status: "sending", error_code: null },
          { dedupe_key: "stuck", status: "failed", error_code: "stalled" },
        ]);
      });
    });
  });

  describe("usage counters and housekeeping", () => {
    it("adds up per day and metric", async () => {
      await svc(async () => {
        await q("select public.integration_usage_bump($1, 'sms', 'segments', 3)", [orgA]);
        await q("select public.integration_usage_bump($1, 'sms', 'segments', 2)", [orgA]);
        await q("select public.integration_usage_bump($1, 'sms', 'segments')", [orgA]);
        const { rows } = await q(
          "select value::int as v from public.integration_usage_daily where org_id = $1 and provider = 'sms' and metric = 'segments' and day = current_date",
          [orgA],
        );
        expect(rows[0].v).toBe(6);
      });
    });

    it("summarises calls by provider and outcome for the health page", async () => {
      await svc(async () => {
        await q(
          "insert into public.integration_calls (org_id, provider, operation, outcome) values ($1, 'twilio', 'sms.send', 'timeout'), ($1, 'twilio', 'sms.send', 'ok'), ($1, 'stripe', 'payments.create', 'ok')",
          [orgA],
        );
        const { rows } = await q(
          "select provider, outcome, calls::int as calls from public.integration_call_stats($1, now() - interval '1 day') order by 1, 2",
          [orgA],
        );
        expect(rows).toEqual([
          { provider: "stripe", outcome: "ok", calls: 1 },
          { provider: "twilio", outcome: "ok", calls: 2 }, // the seeded one plus this one
          { provider: "twilio", outcome: "timeout", calls: 1 },
        ]);
        const other = await q(
          "select * from public.integration_call_stats($1, now() - interval '1 day')",
          [orgB],
        );
        expect(other.rows.length).toBe(1);
      });
    });

    it("prunes old calls, webhook keys and counters with the scheduled statement", async () => {
      const cmd = (
        await q("select command from cron.job where jobname = 'pulse:housekeeping_integrations'")
      ).rows[0]?.command as string | undefined;
      expect(cmd, "cron entry").toBeTruthy();
      await svc(async () => {
        await q(
          "insert into public.integration_calls (org_id, provider, operation, outcome, at) values ($1, 'twilio', 'old', 'ok', now() - interval '31 days')",
          [orgA],
        );
        await q(
          "insert into public.integration_webhook_events (org_id, provider, event_key, received_at) values ($1, 'twilio', 'old', now() - interval '15 days')",
          [orgA],
        );
        await q(
          "insert into public.integration_usage_daily (org_id, provider, day, metric, value) values ($1, 'sms', current_date - 401, 'old', 1)",
          [orgA],
        );
        await q(cmd!);
        expect(
          await count(c, "select 1 from public.integration_calls where operation = 'old'"),
        ).toBe(0);
        expect(
          await count(c, "select 1 from public.integration_webhook_events where event_key = 'old'"),
        ).toBe(0);
        expect(
          await count(c, "select 1 from public.integration_usage_daily where metric = 'old'"),
        ).toBe(0);
        expect(
          await count(c, "select 1 from public.integration_calls where operation = 'sms.send'"),
        ).toBeGreaterThan(0);
        expect(
          await count(
            c,
            "select 1 from public.integration_webhook_events where event_key = 'SMseed:delivered' and org_id = $1",
            [orgA],
          ),
        ).toBe(1);
      });
    });

    it("claims a webhook event key once", async () => {
      await svc(async () => {
        await q(
          "insert into public.integration_webhook_events (org_id, provider, event_key) values ($1, 'stripe', 'evt_1')",
          [orgA],
        );
        expect(
          await code(
            q(
              "insert into public.integration_webhook_events (org_id, provider, event_key) values ($1, 'stripe', 'evt_1')",
              [orgA],
            ),
          ),
        ).toBe("23505");
        await q(
          "insert into public.integration_webhook_events (org_id, provider, event_key) values ($1, 'stripe', 'evt_1')",
          [orgB],
        ); // another org may use the same key
      });
    });
  });

  it("grants the new permissions to the right existing roles once, idempotently, and matches the code presets", async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261018000100_integrations_foundation.sql"),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(block, "the data-migration block was not found").toBeTruthy();
    const orgC = await svc(async () => {
      const id = (
        await q("insert into public.orgs (name, slug) values ('Org C', 'org-c') returning id")
      ).rows[0].id as string;
      const old: Record<string, string[]> = {
        Manager: ["inbox.send", "contacts.view", "kb.manage"],
        Agent: ["inbox.send"],
        Finance: ["finance.view", "finance.recovery.manage"],
        Billing: ["finance.invoices.view"],
        Insurance: ["finance.claims.view"],
        CEO: ["finance.view"],
      };
      for (const [name, perms] of Object.entries(old))
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
          [id, name, JSON.stringify(perms)],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Custom finance', 'custom', '[\"finance.view\"]'::jsonb, false)",
        [id],
      );
      return id;
    });
    const read = async () =>
      Object.fromEntries(
        (
          await svc(() =>
            q(
              "select name, permissions, is_system from public.roles where org_id = $1 and is_system",
              [orgC],
            ),
          )
        ).rows.map((r) => [r.name, r.permissions as string[]]),
      );
    await svc(() => q(block!));
    const first = await read();
    const has = (n: string, k: string) => first[n].includes(k);
    expect(has("Manager", "integrations.calendar")).toBe(true);
    expect(has("Finance", "finance.payment_links")).toBe(true);
    expect(has("Billing", "finance.payment_links")).toBe(true);
    for (const n of ["Agent", "Insurance", "CEO"])
      expect(first[n]).not.toContain("finance.payment_links");
    expect(first.Agent).not.toContain("integrations.calendar");
    for (const n of Object.keys(first)) expect(first[n], n).not.toContain("integrations.manage");
    const custom = await svc(() =>
      q("select permissions from public.roles where org_id = $1 and not is_system", [orgC]),
    );
    expect(custom.rows[0].permissions).toEqual(["finance.view"]);
    await svc(() => q(block!));
    expect(await read()).toEqual(first);
    // the code presets (used for new orgs) agree
    const preset = (name: string) =>
      [...SYSTEM_ROLES, ...FINANCE_ROLES].find((r) => r.name === name)!.permissions;
    expect(preset("Manager")).toContain("integrations.calendar");
    expect(preset("Finance")).toContain("finance.payment_links");
    expect(preset("Billing")).toContain("finance.payment_links");
  });
});
