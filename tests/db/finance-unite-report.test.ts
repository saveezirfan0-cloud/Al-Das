/**
 * Phase 23A: the Unite collection report upload in the database. Stage (atomic, idempotent by sha256, the database's own
 * reconciliation), commit (branch codes, supersede in range only, never twice, never unreconciled), discard (staged only),
 * service role only (tables and functions), and the permission grant. Rows come from the synthetic workbook through the
 * real parser. Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { parseUniteReport, type UniteReportResult } from "@/lib/finance/parse-unite-report";

import {
  buildUniteReportWorkbook,
  DEFAULT_ROWS,
  SENTINELS,
  wall,
  type FixtureRow,
} from "../unit/finance/fixtures/unite-report-workbook";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("Unite collection report upload (Phase 23A)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );

  type Parsed = { r: UniteReportResult; hash: string };
  const parse = async (
    opts: Parameters<typeof buildUniteReportWorkbook>[0] = {},
  ): Promise<Parsed> => {
    const buf = await buildUniteReportWorkbook(opts);
    return { r: await parseUniteReport(buf), hash: sha(buf) };
  };
  const meta = ({ r, hash }: Parsed, over: Record<string, unknown> = {}) => ({
    from_date: r.fromDate,
    to_date: r.toDate,
    file_sha256: hash,
    report_totals: r.reportTotals,
    problems: r.problems,
    reconciled: r.reconciled,
    ...over,
  });
  const stage = (p: Parsed, over: Record<string, unknown> = {}, org = orgA) =>
    svc(() =>
      q("select public.fin_report_stage($1, $2, $3::jsonb, $4::jsonb) as s", [
        org,
        users.fin,
        JSON.stringify(meta(p, over)),
        JSON.stringify(p.r.rows),
      ]),
    ).then((res) => res.rows[0].s as Record<string, unknown>);
  const commit = (id: string, org = orgA) =>
    svc(() => q("select public.fin_report_commit($1, $2, $3) as s", [org, id, users.fin2])).then(
      (res) => res.rows[0].s as Record<string, number>,
    );
  const discard = (id: string) =>
    svc(() => q("select public.fin_report_discard($1, $2) as s", [orgA, id])).then(
      (res) => res.rows[0].s as Record<string, unknown>,
    );
  const visits = (uploadId: string) =>
    svc(() =>
      q(
        "select row_no, report_date::text, clinic_name, branch_code, is_current, patient_pin, patient_ref from public.fin_report_visits where upload_id = $1 order by row_no",
        [uploadId],
      ),
    ).then((r) => r.rows);
  const currentCount = () =>
    svc(() =>
      q(
        "select count(*)::int as n from public.fin_report_visits where org_id = $1 and is_current",
        [orgA],
      ),
    ).then((r) => r.rows[0].n as number);

  let first: { id: string };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "fin2", "billing"])
      users[n] = await createAuthUser(c, `${n}-unite-report@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    // the analytics key for patient_ref (the vault belongs to the database owner)
    await q("delete from vault.decrypted_secrets where name = 'finance_ref_key'");
    await q("select vault.create_secret('test-key-unite-report-0123', 'finance_ref_key')");
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
      await member("fin2", "Finance Manager");
      await member("billing", "Billing");
      await q(
        "insert into public.fin_ref_branches (org_id, code, name, unite_clinic_long_name, active) values ($1, 'S1', 'Synthetic One', 'Al Das Synthetic Clinic One', true), ($1, 'S2', 'Synthetic Two', 'Al Das Synthetic Clinic Two', true), ($1, 'S3', 'Synthetic Three (closed)', 'Al Das Synthetic Clinic Three', false)",
        [orgA],
      );
    });
  });

  afterAll(async () => {
    await q("delete from vault.decrypted_secrets where name = 'finance_ref_key'");
    await resetDb(c);
    await c.end();
  });

  it("stages a reconciled upload atomically, rows not yet current", async () => {
    const p = await parse();
    const s = await stage(p);
    expect(s).toMatchObject({
      existing: false,
      status: "staged",
      row_count: 5,
      reconciled: true,
      from_date: "2026-09-01",
      to_date: "2026-09-30",
      doctors: 2,
      clinics: 3,
      cancelled_rows: 1,
      unknown_branch_rows: 1, // Clinic Three's branch is inactive
    });
    first = { id: s.upload_id as string };
    const rows = await visits(first.id);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => !r.is_current && r.branch_code === null)).toBe(true);
    // the PIN is kept; the analytics key is set by the trigger
    expect(rows[0].patient_pin).toBe("900000001");
    expect(rows[0].patient_ref).toBeTruthy();
    expect(rows[0].patient_ref).not.toContain("900000001");
  });

  it("re-staging the same file returns the existing upload unchanged", async () => {
    const p = await parse();
    const again = await stage(p);
    expect(again).toMatchObject({
      existing: true,
      upload_id: first.id,
      status: "staged",
      row_count: 5,
    });
    const n = await svc(() =>
      q("select count(*)::int as n from public.fin_report_uploads where org_id = $1", [orgA]),
    );
    expect(n.rows[0].n).toBe(1);
    expect(await visits(first.id)).toHaveLength(5);
  });

  it("commits: rows current, branch codes resolved from fin_ref_branches", async () => {
    const res = await commit(first.id);
    expect(res).toEqual({ rows: 5, superseded: 0, unknown_branch_rows: 1 });
    const rows = await visits(first.id);
    expect(rows.every((r) => r.is_current)).toBe(true);
    const byClinic = Object.fromEntries(rows.map((r) => [r.clinic_name, r.branch_code]));
    expect(byClinic).toEqual({
      "Al Das Synthetic Clinic One": "S1",
      "Al Das Synthetic Clinic Two": "S2",
      "Al Das Synthetic Clinic Three": null,
    });
    const u = await svc(() =>
      q("select status, committed_by, committed_at from public.fin_report_uploads where id = $1", [
        first.id,
      ]),
    );
    expect(u.rows[0]).toMatchObject({ status: "committed", committed_by: users.fin2 });
    expect(u.rows[0].committed_at).toBeTruthy();
  });

  it("refuses to commit the same upload twice", async () => {
    const e = await err(commit(first.id));
    expect(e?.message).toBe("report_not_staged");
    expect(await currentCount()).toBe(5);
  });

  it("a second, overlapping upload supersedes the first one's rows in its range only", async () => {
    const oct: FixtureRow = {
      ...DEFAULT_ROWS[0],
      visit: wall(2026, 10, 5, 11, 0),
      invoice: wall(2026, 10, 5),
      selfpay: "SP-0100",
    };
    const p = await parse({
      title: "Daily Collection from 15-Sep-2026  to 15-Oct-2026 | Generated On: 16-Oct-2026 08:00",
      rows: [DEFAULT_ROWS[2], DEFAULT_ROWS[3], oct],
    });
    const s = await stage(p);
    expect(s).toMatchObject({ existing: false, reconciled: true, row_count: 3 });
    const res = await commit(s.upload_id as string);
    expect(res).toEqual({ rows: 3, superseded: 2, unknown_branch_rows: 0 });

    const old = await visits(first.id);
    expect(old.filter((r) => r.is_current).map((r) => r.report_date)).toEqual([
      "2026-09-01",
      "2026-09-01",
      "2026-09-10",
    ]);
    expect(await currentCount()).toBe(6);
  });

  it("does not reconcile a tampered report, and refuses to commit it", async () => {
    const p = await parse({ tamper: { Cash: 0.01 } });
    const s = await stage(p);
    expect(s).toMatchObject({ existing: false, reconciled: false });
    expect((s.problems as string[]).join(" ")).toContain("Cash");
    const e = await err(commit(s.upload_id as string));
    expect(e?.message).toBe("report_not_reconciled");
    await discard(s.upload_id as string);
  });

  it("re-checks the totals itself: a claimed reconciliation with wrong totals is stored as not reconciled", async () => {
    const p = await parse({ title: "Daily Collection from 01-Sep-2026 to 30-Sep-2026 | v2" });
    const s = await stage(p, {
      report_totals: { ...p.r.reportTotals, gross: p.r.reportTotals.gross + 1 },
    });
    expect(s.reconciled).toBe(false);
    const e = await err(commit(s.upload_id as string));
    expect(e?.message).toBe("report_not_reconciled");
    await discard(s.upload_id as string);
  });

  it("refuses rows dated outside the upload's range and bad input", async () => {
    const p = await parse({ title: "Daily Collection from 01-Sep-2026 to 30-Sep-2026 | v3" });
    const e = await err(stage(p, { to_date: "2026-09-20" }));
    expect(e?.message).toBe("report_rows_out_of_range");
    const bad = await err(stage(p, { file_sha256: "not-a-hash" }));
    expect(bad?.message).toBe("report_bad_input");
    const n = await svc(() =>
      q(
        "select count(*)::int as n from public.fin_report_uploads where org_id = $1 and status = 'staged'",
        [orgA],
      ),
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("discards a staged upload (rows go with it) but never a committed one", async () => {
    const p = await parse({ title: "Daily Collection from 01-Sep-2026 to 30-Sep-2026 | v4" });
    const s = await stage(p);
    const id = s.upload_id as string;
    expect(await discard(id)).toEqual({ upload_id: id, rows: 5 });
    expect(await visits(id)).toHaveLength(0);
    expect((await err(discard(id)))?.message).toBe("report_not_found");

    const e = await err(discard(first.id));
    expect(e?.message).toBe("report_not_staged");
    expect(await visits(first.id)).toHaveLength(5);
  });

  it("keeps uploads to their organisation", async () => {
    expect((await err(commit(first.id, orgB)))?.message).toBe("report_not_found");
    const e = await err(
      svc(() => q("select public.fin_report_upload_summary($1, $2)", [orgB, first.id])),
    );
    expect(e?.message).toBe("report_not_found");
    const ok = await svc(() =>
      q("select public.fin_report_upload_summary($1, $2) as s", [orgA, first.id]),
    );
    expect(ok.rows[0].s).toMatchObject({ upload_id: first.id, status: "committed", row_count: 5 });
  });

  it("never stores a column the parser must not read", async () => {
    const dump = await svc(() =>
      q(
        "select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb)::text as v from public.fin_report_visits v where org_id = $1",
        [orgA],
      ),
    );
    const uploads = await svc(() =>
      q(
        "select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb)::text as u from public.fin_report_uploads u",
        [],
      ),
    );
    for (const s of Object.values(SENTINELS)) {
      expect(dump.rows[0].v).not.toContain(s);
      expect(uploads.rows[0].u).not.toContain(s);
    }
  });

  it("is service role only: signed-in users cannot read the tables or run the functions", async () => {
    for (const u of ["fin", "fin2", "alice"]) {
      for (const sql of [
        "select * from public.fin_report_uploads",
        "select * from public.fin_report_visits",
        `select public.fin_report_upload_summary('${orgA}', '${first.id}')`,
        `select public.fin_report_commit('${orgA}', '${first.id}', '${users[u]}')`,
        `select public.fin_report_discard('${orgA}', '${first.id}')`,
        `select public.fin_report_stage('${orgA}', '${users[u]}', '{}'::jsonb, '[]'::jsonb)`,
      ]) {
        const e = await err(asUser(c, users[u], () => q(sql)));
        expect(e?.code, `${u}: ${sql}`).toBe("42501");
      }
    }
    const fns = await q(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'fin_report_%' order by 1`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([
      "fin_report_commit",
      "fin_report_discard",
      "fin_report_stage",
      "fin_report_upload_summary",
    ]);
    for (const r of fns.rows) expect([r.anon, r.auth, r.svc]).toEqual([false, false, true]);
  });

  it("grants finance.revenue.import to Finance and Finance Manager only", async () => {
    const preset = (n: string) => FINANCE_ROLES.find((r) => r.name === n)!.permissions;
    expect(preset("Finance")).toContain("finance.revenue.import");
    expect(preset("Finance Manager")).toContain("finance.revenue.import");
    expect(preset("Billing")).not.toContain("finance.revenue.import");

    // replay the migration's grant block on system roles that predate the key
    await svc(() =>
      q(
        "update public.roles set permissions = permissions - 'finance.revenue.import' where org_id = $1 and name in ('Finance', 'Finance Manager', 'Billing')",
        [orgA],
      ),
    );
    // the foundation migration (found by name: its number changed once when it was merged)
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_finance_unite_report.sql"))!;
    const sql = readFileSync(join(dir, file), "utf8");
    const grant = /do \$\$[\s\S]*?end \$\$;/.exec(sql)![0];
    await q(grant);
    const holders = await q(
      "select name from public.roles where org_id = $1 and permissions ? 'finance.revenue.import' order by name",
      [orgA],
    );
    expect(holders.rows.map((r) => r.name)).toEqual(["Finance", "Finance Manager"]);
  });
});
