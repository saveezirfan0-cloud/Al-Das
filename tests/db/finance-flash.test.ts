/**
 * Phase 20A: the flash report's SQL. Who can read reporting lines and targets, that nobody writes them directly, that
 * the report functions are service-role only, that fin_flash_inputs aggregates invoices correctly (parity with the pure
 * report on the shared synthetic fixture) and that fin_flash_set_targets replaces a month atomically.
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import {
  buildFlashSummary,
  parseFlashRows,
  type FlashRow,
  type ReportLine,
  type RevenueTarget,
} from "@/lib/finance/flash";

import fixture from "../unit/finance/fixtures/flash.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const DAY = "2026-10-12";

describe.skipIf(!TEST_DATABASE_URL)("Finance flash report (Phase 20A)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "ceo", "md", "billing", "insurance"])
      users[n] = await createAuthUser(c, `${n}-flash@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fin", "Finance");
      await member("ceo", "CEO");
      await member("md", "Medical Director");
      await member("billing", "Billing");
      await member("insurance", "Insurance");

      for (const org of [orgA, orgB]) {
        for (const l of fixture.lines as ReportLine[])
          await q(
            "insert into public.fin_ref_report_lines (org_id, code, label, match_kind, match_values, in_core, sort_order) values ($1, $2, $3, $4, $5, $6, $7)",
            [org, l.code, l.label, l.matchKind, l.matchValues, l.inCore, l.sortOrder],
          );
        await q(
          "insert into public.fin_ref_revenue_targets (org_id, month, line_code, daily_revenue) values ($1, '2026-10-01', 'PALM', 32593)",
          [org],
        );
      }

      // One invoice per patient visit: each fixture row becomes `patients` invoices whose nets add up to the row's net.
      let n = 0;
      for (const r of fixture.rows as FlashRow[]) {
        const each = Math.floor((r.net / r.patients) * 100) / 100;
        for (let i = 0; i < r.patients; i++) {
          const net = i === r.patients - 1 ? Math.round((r.net - each * (r.patients - 1)) * 100) / 100 : each;
          n++;
          await q(
            `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, department, doctor_dha_id, doctor_name, inv_type, net, total, patient_pin, record_hash)
             values ($1, $2, $3, $4, $5, $6, $7, 'SELF PAID', $8, $8, $9, 'h')`,
            [orgA, `SYN/${n}`, r.date, r.branch, r.department, r.doctorId, r.doctorName, net, `PIN-${r.doctorId}-${r.branch}-${i}`],
          );
        }
      }
      // Noise that must not count: a deleted invoice, another day, another org.
      await q(
        "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, net, total, patient_pin, record_hash, is_deleted) values ($1, 'SYN/DEL', $2, 'P', 9999, 9999, 'PIN-X', 'h', true)",
        [orgA, DAY],
      );
      await q(
        "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, net, total, patient_pin, record_hash) values ($1, 'SYN/NOV', '2026-11-01', 'P', 777, 777, 'PIN-Y', 'h')",
        [orgA],
      );
      await q(
        "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, net, total, patient_pin, record_hash) values ($1, 'SYN/B', $2, 'P', 5555, 5555, 'PIN-Z', 'h')",
        [orgB, DAY],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("access", () => {
    const visible = async (who: string) =>
      asRole(who, async () => ({
        lines: Number((await q("select count(*)::int as n from public.fin_ref_report_lines")).rows[0].n),
        targets: Number((await q("select count(*)::int as n from public.fin_ref_revenue_targets")).rows[0].n),
      }));

    it("Finance, the CEO and the Medical Director read their own org's lines and targets only", async () => {
      for (const who of ["fin", "ceo", "md"]) {
        expect(await visible(who), who).toEqual({ lines: 6, targets: 1 });
      }
    });

    it("Billing and Insurance see nothing", async () => {
      expect(await visible("billing")).toEqual({ lines: 0, targets: 0 });
      expect(await visible("insurance")).toEqual({ lines: 0, targets: 0 });
    });

    it("nobody writes lines or targets directly, not even Finance", async () => {
      await expect(
        asRole("fin", () =>
          q(
            "insert into public.fin_ref_report_lines (org_id, code, label, match_kind, match_values) values ($1, 'X', 'X', 'branch', '{X}')",
            [orgA],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const upd = await asRole("fin", () =>
        q("update public.fin_ref_revenue_targets set daily_revenue = 1 where org_id = $1", [orgA]),
      );
      expect(upd.rowCount).toBe(0);
    });

    it("the report functions run for the service role only", async () => {
      const { rows } = await q(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('fin_flash_inputs', 'fin_flash_set_targets') order by 1`,
      );
      expect(rows).toEqual([
        { name: "fin_flash_inputs", anon: false, auth: false, svc: true },
        { name: "fin_flash_set_targets", anon: false, auth: false, svc: true },
      ]);
    });
  });

  describe("fin_flash_inputs", () => {
    const inputs = async (from = "2026-10-01", to = DAY) =>
      svc(async () => (await q("select public.fin_flash_inputs($1, $2, $3) as r", [orgA, from, to])).rows[0].r);

    it("aggregates per day, branch, department and doctor, without patient identifiers", async () => {
      const r = await inputs();
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/PIN-/);
      const rows = parseFlashRows(r);
      expect(rows).toHaveLength((fixture.rows as FlashRow[]).length);
      const palmAlpha = rows.find((x) => x.doctorId === "SYN-0001")!;
      expect(palmAlpha).toMatchObject({ branch: "P", net: 15232, patients: 20, invoices: 20 });
    });

    it("feeds the pure report the same figures as the clinic's sheet (parity)", async () => {
      const rows = parseFlashRows(await inputs());
      const s = buildFlashSummary({
        rows,
        lines: fixture.lines as ReportLine[],
        targets: fixture.targets as RevenueTarget[],
        from: DAY,
        to: DAY,
      });
      expect(s.kpis.revenue.actual).toBe(51031);
      expect(s.kpis.patients.actual).toBe(64);
      expect(s.grandTotal.revenue).toBe(53121);
      expect(s.otherLines.find((l) => l.code === "CHIRO")!.revenue.actual).toBe(2090);
    });

    it("excludes deleted invoices, other days and other orgs", async () => {
      const rows = parseFlashRows(await inputs("2026-10-01", "2026-11-30"));
      const total = rows.reduce((a, r) => a + r.net, 0);
      expect(Math.round(total * 100) / 100).toBe(53121 + 777);
    });

    it("uses the doctor name from the doctor reference when there is one", async () => {
      await svc(() =>
        q("insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, 'SYN-0002', 'Dr Reference Bravo')", [orgA]),
      );
      const rows = parseFlashRows(await inputs());
      expect(rows.find((x) => x.doctorId === "SYN-0002")!.doctorName).toBe("Dr Reference Bravo");
    });
  });

  describe("fin_flash_set_targets", () => {
    const set = (rows: unknown, month = "2026-10-01") =>
      svc(() => q("select public.fin_flash_set_targets($1, $2, $3::jsonb, $4) as n", [orgA, month, JSON.stringify(rows), users.fin]));
    const targets = () =>
      svc(async () =>
        (
          await q(
            "select line_code, daily_revenue::float8 as rev, daily_patients::float8 as pat, arpp::float8 as arpp from public.fin_ref_revenue_targets where org_id = $1 and month = '2026-10-01' order by line_code nulls last",
            [orgA],
          )
        ).rows,
      );

    it("replaces the month as a whole and skips empty rows", async () => {
      const r = await set([
        { line_code: "PALM", daily_revenue: 32593 },
        { line_code: "GM", daily_revenue: 9402 },
        { line_code: "MTC" },
        { line_code: null, daily_patients: 78.25, arpp: 750 },
      ]);
      expect(r.rows[0].n).toBe(3);
      expect(await targets()).toEqual([
        { line_code: "GM", rev: 9402, pat: null, arpp: null },
        { line_code: "PALM", rev: 32593, pat: null, arpp: null },
        { line_code: null, rev: null, pat: 78.25, arpp: 750 },
      ]);
      await set([{ line_code: "PALM", daily_revenue: 1000 }]);
      expect(await targets()).toEqual([{ line_code: "PALM", rev: 1000, pat: null, arpp: null }]);
    });

    it("rolls back on a bad row and refuses a month that is not the first", async () => {
      await expect(set([{ line_code: "PALM", daily_revenue: 5 }, { line_code: "GM", daily_revenue: -1 }])).rejects.toThrow();
      expect(await targets()).toEqual([{ line_code: "PALM", rev: 1000, pat: null, arpp: null }]);
      await expect(set([], "2026-10-02")).rejects.toThrow(/first day/);
      await expect(set([{ line_code: "bad code!", daily_revenue: 1 }])).rejects.toThrow();
    });

    it("keeps one total row per month", async () => {
      await expect(
        set([
          { line_code: null, arpp: 700 },
          { line_code: null, arpp: 750 },
        ]),
      ).rejects.toThrow();
    });
  });
});
