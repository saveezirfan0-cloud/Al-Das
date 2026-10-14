/**
 * M1 management alerts: fin_mgmt_alert_inputs() (current rows only, the month only, branch worked out when read, the
 * latest committed covered day, coverage; amounts and codes only, no PIN, no patient ref, no doctor), the atomic claim
 * fin_mgmt_alert_claim() (once until cleared, then again), the settings checks, and service-role only. Synthetic data
 * only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseMgmtAlertInputs } from "@/lib/finance/management-alerts";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const SHA = (i: number) => i.toString(16).padStart(64, "0");

describe.skipIf(!TEST_DATABASE_URL)("Finance management alerts (M1)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const inputs = (org: string, month: string) =>
    svc(async () => {
      const { rows } = await q("select public.fin_mgmt_alert_inputs($1, $2) as j", [org, month]);
      return rows[0].j as Record<string, unknown>;
    });
  const claim = (org: string, rule: string, scope: string, period: string) =>
    svc(async () => {
      const { rows } = await q("select public.fin_mgmt_alert_claim($1, $2, $3, $4) as won", [
        org,
        rule,
        scope,
        period,
      ]);
      return rows[0].won as boolean;
    });
  const upload = async (org: string, from: string, to: string, status: string, n: number) => {
    const { rows } = await q(
      `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        org,
        from,
        to,
        SHA(n),
        status,
        status === "committed",
        status === "committed" ? new Date().toISOString() : null,
      ],
    );
    return rows[0].id as string;
  };
  let rowNo = 0;
  const visit = (
    org: string,
    uploadId: string,
    date: string,
    v: {
      clinic?: string | null;
      branch?: string | null;
      dept?: string | null;
      net: number;
      current?: boolean;
    },
  ) =>
    q(
      `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, department, doctor_name, doctor_key,
         clinic_name, branch_code, patient_pin, net, is_current)
       values ($1, $2, $3, $4, $5, 'Dr Demo-01', 'dr demo 01', $6, $7, '900000001', $8, $9)`,
      [
        org,
        uploadId,
        ++rowNo,
        date,
        v.dept ?? "Derma",
        v.clinic ?? null,
        v.branch ?? null,
        v.net,
        v.current ?? true,
      ],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-mgmt@example.test");
    const bob = await createAuthUser(c, "bob-mgmt@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      await q(
        `insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name, active)
         values ($1, 'BA', 'Branch A', 'Demo Clinic A', true)`,
        [orgA],
      );
      const sep = await upload(orgA, "2026-09-01", "2026-09-30", "committed", 1);
      const oct = await upload(orgA, "2026-10-01", "2026-10-05", "committed", 2);
      const staged = await upload(orgA, "2026-10-06", "2026-10-12", "staged", 3);
      await visit(orgA, sep, "2026-09-30", { branch: "BA", net: 999 });
      // Branch from the CURRENT clinic mapping (stored code empty), with and without a department; summed per day
      await visit(orgA, oct, "2026-10-01", { clinic: "Demo Clinic A", net: 100.5 });
      await visit(orgA, oct, "2026-10-01", { clinic: "Demo Clinic A", net: 200.255 });
      await visit(orgA, oct, "2026-10-01", { clinic: "Demo Clinic A", dept: " ", net: 10 });
      await visit(orgA, oct, "2026-10-02", { branch: "BB", net: 50 }); // stored code as fallback
      await visit(orgA, oct, "2026-10-03", { branch: "BA", net: 7777, current: false }); // superseded: ignored
      await visit(orgA, staged, "2026-10-07", { branch: "BA", net: 5, current: false });
      const b = await upload(orgB, "2026-10-01", "2026-10-31", "committed", 9);
      await visit(orgB, b, "2026-10-04", { branch: "BA", net: 4444 });
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("returns the month's daily net by branch and department, from current rows only", async () => {
    const j = await inputs(orgA, "2026-10-17");
    expect(j.month).toBe("2026-10-01");
    expect(j.last_covered).toBe("2026-10-05"); // the staged upload does not count
    expect(j.coverage).toEqual([{ from: "2026-10-01", to: "2026-10-05" }]);
    expect(j.rows).toEqual([
      { date: "2026-10-01", branch: "BA", department: "Derma", net: 300.755 },
      { date: "2026-10-01", branch: "BA", department: null, net: 10 },
      { date: "2026-10-02", branch: "BB", department: "Derma", net: 50 },
    ]);
    const parsed = parseMgmtAlertInputs(j);
    expect(parsed.rows.map((r) => r.net)).toEqual([300.755, 10, 50]);
  });

  it("keeps to the org and the month, and returns empty lists without data", async () => {
    const sep = await inputs(orgA, "2026-09-01");
    expect(sep.rows).toEqual([{ date: "2026-09-30", branch: "BA", department: "Derma", net: 999 }]);
    const nov = await inputs(orgA, "2026-11-01");
    expect(nov).toMatchObject({ rows: [], coverage: [], last_covered: "2026-10-05" });
    const fresh = await svc(async () => {
      const { rows } = await q(
        "select public.fin_mgmt_alert_inputs(gen_random_uuid(), '2026-10-01') as j",
      );
      return rows[0].j as Record<string, unknown>;
    });
    expect(fresh).toMatchObject({ rows: [], coverage: [], last_covered: null });
  });

  it("never returns a PIN, a patient ref or a doctor", async () => {
    const text = JSON.stringify(await inputs(orgA, "2026-10-01"));
    expect(text).not.toMatch(/900000001|Demo-01|demo 01|patient|pin/i);
  });

  it("claims an alert once until it clears, then once again; keys are per org, rule, scope and period", async () => {
    expect(await claim(orgA, "revenue_behind", "total", "2026-10")).toBe(true);
    expect(await claim(orgA, "revenue_behind", "total", "2026-10")).toBe(false); // already alerted
    expect(await claim(orgA, "revenue_behind", "line:BA", "2026-10")).toBe(true);
    expect(await claim(orgA, "revenue_behind", "total", "2026-11")).toBe(true);
    expect(await claim(orgB, "revenue_behind", "total", "2026-10")).toBe(true);
    await svc(() =>
      q(
        "update public.fin_mgmt_alert_state set cleared_at = now() where org_id = $1 and rule = 'revenue_behind' and scope = 'total' and period = '2026-10'",
        [orgA],
      ),
    );
    expect(await claim(orgA, "revenue_behind", "total", "2026-10")).toBe(true); // raised again after clearing
    expect(await claim(orgA, "revenue_behind", "total", "2026-10")).toBe(false);
    const { rows } = await svc(() =>
      q(
        "select cleared_at from public.fin_mgmt_alert_state where org_id = $1 and scope = 'total' and period = '2026-10'",
        [orgA],
      ),
    );
    expect(rows).toEqual([{ cleared_at: null }]);
  });

  it("refuses malformed keys", async () => {
    await expect(claim(orgA, "made_up", "all", "-")).rejects.toThrow(/check/);
    await expect(claim(orgA, "report_late", "Robert's ward", "-")).rejects.toThrow(/check/);
    await expect(claim(orgA, "band_below", "all", "2026-13")).rejects.toThrow(/check/);
  });

  it("has the threshold defaults and checks them", async () => {
    await svc(() =>
      q("insert into public.fin_ref_finance_settings (org_id) values ($1) on conflict do nothing", [
        orgA,
      ]),
    );
    const { rows } = await svc(() =>
      q(
        `select alert_report_late_days, alert_revenue_target_pct::text as pct, alert_revenue_target_days,
                alert_band_min_patients from public.fin_ref_finance_settings where org_id = $1`,
        [orgA],
      ),
    );
    expect(rows[0]).toEqual({
      alert_report_late_days: 3,
      pct: "90.00",
      alert_revenue_target_days: 3,
      alert_band_min_patients: 10,
    });
    for (const bad of [
      "alert_report_late_days = 0",
      "alert_revenue_target_pct = 0",
      "alert_revenue_target_pct = 100.5",
      "alert_revenue_target_days = 32",
      "alert_band_min_patients = 0",
    ])
      await expect(
        svc(() => q(`update public.fin_ref_finance_settings set ${bad} where org_id = $1`, [orgA])),
      ).rejects.toThrow(/check/);
  });

  it("signed-in users cannot run the functions or read the state", async () => {
    await expect(
      asUser(c, alice, () => q("select public.fin_mgmt_alert_inputs($1, '2026-10-01')", [orgA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(c, alice, () =>
        q("select public.fin_mgmt_alert_claim($1, 'report_late', 'all', '-')", [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
    const { rows: seen } = await asUser(c, alice, () =>
      q("select * from public.fin_mgmt_alert_state"),
    );
    expect(seen).toEqual([]);
    const { rows: priv } = await q(
      `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc, p.prosecdef as definer,
              array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('fin_mgmt_alert_claim', 'fin_mgmt_alert_inputs')
       order by 1`,
    );
    const expected = {
      anon: false,
      auth: false,
      svc: true,
      definer: true,
      config: 'search_path=""',
    };
    expect(priv).toEqual([
      { name: "fin_mgmt_alert_claim", ...expected },
      { name: "fin_mgmt_alert_inputs", ...expected },
    ]);
  });
});
