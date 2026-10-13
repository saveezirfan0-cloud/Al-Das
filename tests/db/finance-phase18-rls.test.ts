/**
 * Phase 18 (finance upgrades): tenant isolation and the permission matrix for every new table, that a browser session can
 * never write the workflow tables, who may edit the new reference tables, the data migration that grants the new finance.*
 * permissions to the existing system roles, and the settings constraints. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  seedPhase18Rows,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 18: finance upgrades, access", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const asRole = <T>(name: string, fn: () => Promise<T>) => asUser(c, users[name], fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "billing", "ins", "ceo", "md", "nobody"])
      users[n] = await createAuthUser(c, `${n}@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await asServiceRole(c, async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true)",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (user: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[user], role],
        );
      await member("fin", "Finance");
      await member("billing", "Billing");
      await member("ins", "Insurance");
      await member("ceo", "CEO");
      await member("md", "Medical Director");
    });
    await seedPhase18Rows(c, orgA, users.alice);
    await seedPhase18Rows(c, orgB, users.bob);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  // table -> roles that may read it (admin '*' always can). Everyone else must see 0 rows.
  const MATRIX: Record<string, string[]> = {
    fin_pre_authorisations: ["fin", "ins"],
    fin_eligibility_checks: ["billing", "ins"],
    ins_denial_cases: ["fin", "ins"],
    ins_denial_notes: ["fin", "ins"],
    ins_appeal_drafts: ["fin", "ins"],
    ins_remittance_batches: ["fin", "ins"],
    ins_remittance_lines: ["fin", "ins"],
    fin_period_closes: ["fin", "ceo"],
    fin_cashups: ["fin", "billing"],
    fin_cashup_lines: ["fin", "billing"],
    fin_recovery_reminders: ["fin", "billing"],
    fin_accounting_exports: ["fin"],
    fin_ref_account_map: ["fin"],
    fin_ref_payer_prices: ["fin", "ins"],
    fin_ref_denial_codes: ["fin", "ins", "ceo", "md"],
    fin_ref_finance_settings: ["fin", "billing", "ins", "ceo", "md"],
  };

  it("gives each finance role exactly the Phase 18 tables its permissions cover", async () => {
    const wrong: string[] = [];
    for (const [table, allowed] of Object.entries(MATRIX)) {
      for (const role of ["alice", "fin", "billing", "ins", "ceo", "md", "nobody"]) {
        const n = await asRole(role, () =>
          count(c, `select 1 from public.${table} where org_id = $1`, [orgA]),
        );
        const should = role === "alice" || allowed.includes(role);
        if (should && n === 0) wrong.push(`${role} should see ${table}`);
        if (!should && n > 0) wrong.push(`${role} must not see ${table} (${n})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never shows another organisation's rows (org B's admin sees only org B)", async () => {
    for (const table of Object.keys(MATRIX)) {
      await asRole("bob", async () => {
        expect(
          await count(c, `select 1 from public.${table} where org_id = $1`, [orgA]),
          table,
        ).toBe(0);
        expect(
          await count(c, `select 1 from public.${table} where org_id = $1`, [orgB]),
          table,
        ).toBeGreaterThan(0);
      });
    }
  });

  it("gives the raw and staged remittance tables to no signed-in member at all", async () => {
    for (const role of ["alice", "fin", "ins"])
      await asRole(role, async () => {
        for (const t of ["fin_raw_remittance_files", "fin_staged_remittance_lines"])
          expect(await count(c, `select 1 from public.${t}`), `${role} ${t}`).toBe(0);
      });
    await asRole("alice", async () => {
      await expect(
        q("insert into public.fin_raw_remittance_files (org_id, file_sha256) values ($1, 'x')", [
          orgA,
        ]),
      ).rejects.toThrow();
    });
  });

  it("refuses every browser write to the workflow tables, even from an admin", async () => {
    const tables = Object.keys(MATRIX).filter((t) => !t.startsWith("fin_ref_"));
    const leaked: string[] = [];
    await asRole("alice", async () => {
      for (const t of tables) {
        await q("begin");
        const ins = await q(`insert into public.${t} (org_id) values ($1)`, [orgA]).then(
          () => "ok",
          (e: { code?: string }) => e.code,
        );
        await q("rollback");
        if (ins === "ok") leaked.push(`${t}: insert`);
        await q("begin");
        const upd = await q(`update public.${t} set org_id = org_id where org_id = $1`, [
          orgA,
        ]).then(
          (r) => r.rowCount ?? 0,
          () => 0,
        );
        await q("rollback");
        if (upd > 0) leaked.push(`${t}: update ${upd}`);
        await q("begin");
        const del = await q(`delete from public.${t} where org_id = $1`, [orgA]).then(
          (r) => r.rowCount ?? 0,
          () => 0,
        );
        await q("rollback");
        if (del > 0) leaked.push(`${t}: delete ${del}`);
      }
    });
    expect(leaked).toEqual([]);
  });

  it("lets only finance.reference.manage edit the new reference tables, and only in its own org", async () => {
    await asRole("fin", async () => {
      await q("update public.fin_ref_finance_settings set denial_warn_days = 5 where org_id = $1", [
        orgA,
      ]);
      await q(
        "insert into public.fin_ref_payer_prices (org_id, payer_id, cpt_code, agreed_price) values ($1, 'P2', '1', 5)",
        [orgA],
      );
      await q(
        "insert into public.fin_ref_account_map (org_id, kind, key, account_code) values ($1, 'vat_output', '*', '2200')",
        [orgA],
      );
      await q(
        "insert into public.fin_ref_denial_codes (org_id, code, description) values ($1, 'ZZZ-1', 'x')",
        [orgA],
      );
      expect(
        await count(c, "select 1 from public.fin_ref_finance_settings where denial_warn_days = 5"),
      ).toBe(1);
    });
    await asRole("ins", async () => {
      const r = await q(
        "update public.fin_ref_finance_settings set denial_warn_days = 9 where org_id = $1",
        [orgA],
      );
      expect(r.rowCount).toBe(0);
      await expect(
        q(
          "insert into public.fin_ref_payer_prices (org_id, payer_id, cpt_code, agreed_price) values ($1, 'P3', '1', 5)",
          [orgA],
        ),
      ).rejects.toThrow();
      await expect(
        q("delete from public.fin_ref_denial_codes where org_id = $1", [orgA]).then((r) => {
          if (!r.rowCount) throw new Error("none");
        }),
      ).rejects.toThrow();
    });
    await asRole("bob", async () => {
      await expect(
        q(
          "insert into public.fin_ref_payer_prices (org_id, payer_id, cpt_code, agreed_price) values ($1, 'P4', '1', 5)",
          [orgA],
        ),
      ).rejects.toThrow();
    });
  });

  it("seeds the settings row and the starter denial families for every org, marking the families as placeholders", async () => {
    await asServiceRole(c, async () => {
      for (const org of [orgA, orgB]) {
        expect(
          await count(c, "select 1 from public.fin_ref_finance_settings where org_id = $1", [org]),
        ).toBe(1);
        expect(
          await count(
            c,
            "select 1 from public.fin_ref_denial_codes where org_id = $1 and is_family and is_placeholder",
            [org],
          ),
        ).toBeGreaterThanOrEqual(8);
      }
      const { rows } = await q(
        "select recovery_enabled, ready_start_date, denial_cases_start_date from public.fin_ref_finance_settings where org_id = $1",
        [orgA],
      );
      // every outward-facing or noisy feature starts switched off
      expect(rows[0]).toEqual({
        recovery_enabled: false,
        ready_start_date: null,
        denial_cases_start_date: null,
      });
      // a second seed run changes nothing
      await q("select public.seed_finance_reference($1)", [orgA]);
      expect(
        await count(c, "select 1 from public.fin_ref_finance_settings where org_id = $1", [orgA]),
      ).toBe(1);
    });
  });

  it("rejects settings that make no sense", async () => {
    await asServiceRole(c, async () => {
      const bad = (set: string) =>
        q("begin")
          .then(() =>
            q(`update public.fin_ref_finance_settings set ${set} where org_id = $1`, [orgA]),
          )
          .then(
            () => "ok",
            (e: { code?: string }) => e.code,
          )
          .finally(() => q("rollback"));
      expect(await bad("scorecard_denial_rate_alert = 0.01")).toBe("23514"); // alert below warn
      expect(await bad("scorecard_days_to_pay_alert = 10")).toBe("23514");
      expect(await bad("forecast_default_collection_rate = 1.5")).toBe("23514");
      expect(await bad("recovery_max_reminders = 0")).toBe("23514");
      expect(await bad("short_pay_tolerance_amount = -1")).toBe("23514");
      expect(["23503", "23514"]).toContain(await bad("recovery_template_id = gen_random_uuid()")); // not a template of this org
    });
  });

  it("adds the new permission to existing system roles once, idempotently, and matches the code presets", async () => {
    const sql = fs.readFileSync(
      path.join(
        __dirname,
        "../../supabase/migrations/20261016000100_finance_upgrades_foundation.sql",
      ),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(block, "the data-migration block was not found").toBeTruthy();
    const orgC = await asServiceRole(c, async () => {
      const { rows } = await q(
        "insert into public.orgs (name, slug) values ('Org C', 'org-c') returning id",
      );
      const id = rows[0].id as string;
      // the five presets as they were BEFORE Phase 18
      const old: Record<string, string[]> = {
        Finance: [
          "reports.view",
          "finance.view",
          "finance.invoices.view",
          "finance.claims.view",
          "finance.reference.manage",
        ],
        Billing: ["finance.invoices.view", "finance.exceptions.manage"],
        Insurance: ["finance.claims.view", "finance.claims.import", "finance.exceptions.manage"],
        CEO: ["reports.view", "finance.view", "finance.invoices.view", "finance.claims.view"],
        "Medical Director": ["reports.view", "finance.view"],
      };
      for (const [name, perms] of Object.entries(old))
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
          [id, name, JSON.stringify(perms)],
        );
      // a custom role that happens to share a name must be left alone
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Custom finance', '', '[\"finance.view\"]'::jsonb, false)",
        [id],
      );
      return id;
    });
    const read = async () =>
      Object.fromEntries(
        (
          await asServiceRole(c, () =>
            q("select name, permissions from public.roles where org_id = $1", [orgC]),
          )
        ).rows.map((r) => [r.name, r.permissions as string[]]),
      );
    await asServiceRole(c, () => q(block!));
    const first = await read();
    // finance.payment_links arrived with Phase 19a (migration 20261018000100 grants it); the cost and profit keys and
    // the Cost / Payroll role arrived with F8 (20261021000100, tested in finance-blueprint.test.ts); the flash keys arrived
    // with Phase 20A (20261023000100, tested in finance-flash.test.ts), the payables, voucher and Tally keys with Phase 20D
    // (20261024000100, tested in finance-payables.test.ts), the follow-up key with Phase 20I (20261026000100, tested in
    // finance-followup.test.ts), finance.close.tasks with Phase 20G (20261029000100, tested in
    // finance-close-timetable.test.ts), the bank keys with Phase 20C (20261028000100, tested in finance-bank.test.ts) and the
    // invoice-change keys and the Operations role with Phase 20J (20261031000100, tested in
    // finance-invoice-changes.test.ts) and the revenue-share keys with Phase 20F (20261101000100, tested in
    // finance-revenue-share.test.ts) and finance.inbox.manage with Phase 20B (20261103000100, tested in
    // finance-intake.test.ts); this migration predates them.
    const later = (p: string) =>
      p === "finance.payment_links" ||
      p === "finance.close.tasks" ||
      p === "finance.flash.view" ||
      p === "finance.targets.manage" ||
      p === "finance.followup.manage" ||
      p === "finance.inbox.manage" ||
      p.startsWith("finance.payables.") ||
      p.startsWith("finance.vouchers.") ||
      p === "finance.tally.export" ||
      p.startsWith("finance.bank.") ||
      p.startsWith("finance.changes.") ||
      p.startsWith("finance.revshare.") ||
      p.startsWith("finance.costs.") ||
      p.startsWith("finance.profit.");
    for (const preset of FINANCE_ROLES.filter((r) => first[r.name]))
      expect([...first[preset.name]].sort(), preset.name).toEqual(
        preset.permissions.filter((p) => !later(p)).sort(),
      );
    expect(first["Custom finance"]).toEqual(["finance.view"]);
    await asServiceRole(c, () => q(block!));
    expect(await read()).toEqual(first);
  });
});
