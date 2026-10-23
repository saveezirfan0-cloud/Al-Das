/**
 * Phase 20I: insurance follow-up SQL. Parity of the worklist and the receivables report with the pure rules on the shared
 * synthetic fixture, configurable buckets, who reads follow-ups and raised stages (and that nobody writes them directly),
 * service-role-only functions, and the daily task step: off until a start date, one task per claim and stage, atomic and
 * idempotent (also when two runs race), balanced assignment that keeps a claim with its person, closing tasks of claims
 * that were paid. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import {
  aggregateReceivables,
  followupRows,
  followupTaskSubject,
  parseReceivables,
  parseWorklist,
  receivablesMatrix,
  type ClaimInput,
  type FollowupAgeBasis,
} from "@/lib/finance/followup";

import fixture from "../unit/finance/fixtures/followup.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const TODAY = fixture.today;
const NOW = `${TODAY}T05:00:00Z`;
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!TEST_DATABASE_URL)("Insurance follow-up (Phase 20I)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const ids: Record<string, string> = {}; // claim number -> id in org A
  let claimB: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const claims = fixture.claims as ClaimInput[];
  const opts = {
    today: TODAY,
    bucketDays: fixture.settings.bucketDays,
    stageDays: fixture.settings.stageDays,
    acceptedStatuses: fixture.settings.acceptedStatuses,
    ageBasis: fixture.settings.ageBasis as FollowupAgeBasis,
  };

  const insertClaims = async (org: string, prefix: string) => {
    for (const cl of claims) {
      let invoice: string | null = null;
      if (cl.branch) {
        invoice = (
          await q(
            `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, inv_type, net, total, patient_pin, record_hash)
             values ($1, $2, coalesce($3::date, date '2026-01-01'), $4, 'INSURANCE', $5, $5, $6, 'h') returning id`,
            [
              org,
              `${prefix}/${cl.claimActivityNumber}`,
              cl.transactionDate,
              cl.branch,
              cl.net,
              `PIN-SYN-${cl.claimActivityNumber}`,
            ],
          )
        ).rows[0].id;
      }
      const id = (
        await q(
          `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, matched_invoice_id, match_status, cpt_code,
             payer_id, transaction_date, net, remitted, rejected, write_off, write_off_status, claim_status, resubmission_count, last_resubmission_date)
           values ($1, $2, $3, $4, $5, '99213', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
          [
            org,
            `${prefix}-${cl.claimActivityNumber}`,
            `${prefix}/${cl.claimActivityNumber}`,
            invoice,
            invoice ? "matched" : "unmatched",
            cl.payerId,
            cl.transactionDate,
            cl.net,
            cl.remitted,
            cl.rejected,
            cl.writeOff,
            cl.writeOffStatus,
            cl.claimStatus,
            cl.resubmissionCount,
            cl.lastResubmissionDate,
          ],
        )
      ).rows[0].id;
      if (org === orgA) ids[cl.claimActivityNumber] = id;
      else claimB ??= id;
    }
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "ins", "ins2", "ceo", "md", "billing"])
      users[n] = await createAuthUser(c, `${n}-followup@example.test`);
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
      await member("ins", "Insurance");
      await member("ins2", "Insurance");
      await member("ceo", "CEO");
      await member("md", "Medical Director");
      await member("billing", "Billing");
      for (const org of [orgA, orgB]) {
        await q(
          "update public.fin_ref_finance_settings set accepted_claim_statuses = $2, followup_stage_days = $3, followup_age_basis = $4 where org_id = $1",
          [
            org,
            fixture.settings.acceptedStatuses,
            fixture.settings.stageDays,
            fixture.settings.ageBasis,
          ],
        );
        for (const p of fixture.payers)
          await q(
            "insert into public.fin_ref_payers (org_id, payer_id, payer_name) values ($1, $2, $3) on conflict (org_id, payer_id) do update set payer_name = excluded.payer_name",
            [org, p.payerId, p.payerName],
          );
      }
      await insertClaims(orgA, "A");
      await insertClaims(orgB, "B");
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const worklist = async (
    args: { stage?: number; payer?: string; branch?: string; today?: string } = {},
  ) =>
    parseWorklist(
      (
        await svc(() =>
          q("select public.fin_followup_worklist($1, $2, $3, $4, $5, 500) as r", [
            orgA,
            args.today ?? TODAY,
            args.stage ?? null,
            args.payer ?? null,
            args.branch ?? null,
          ]),
        )
      ).rows[0].r,
    );
  const receivables = async (branch: string | null = null) =>
    parseReceivables(
      (
        await svc(() =>
          q("select public.fin_receivables_by_payer_age($1, $2, $3) as r", [orgA, TODAY, branch]),
        )
      ).rows[0].r,
    );
  const runTasks = async (today = TODAY, now = NOW, org = orgA) =>
    (
      await svc(() =>
        q("select public.fin_followup_create_tasks($1, $2, $3::timestamptz, 500) as r", [
          org,
          today,
          now,
        ]),
      )
    ).rows[0].r as Record<string, number | string | null>;
  const strip = (n: string) => n.replace(/^[AB]-/, "");

  describe("worklist and receivables (parity with the pure rules)", () => {
    it("lists the open claims with the same age, bucket, stage, amounts and evidence as lib/finance/followup.ts", async () => {
      const w = await worklist();
      const pure = followupRows(claims, opts);
      expect(w.rows.map((r) => strip(r.claimActivityNumber))).toEqual(
        pure.map((r) => r.claimActivityNumber),
      );
      for (const r of w.rows) {
        const p = pure.find((x) => x.claimActivityNumber === strip(r.claimActivityNumber))!;
        expect(
          {
            age: r.ageDays,
            bucket: r.bucket,
            stage: r.stage,
            out: r.outstanding,
            ev: r.evidenced,
            branch: r.branch,
          },
          r.claimActivityNumber,
        ).toEqual({
          age: p.ageDays,
          bucket: p.bucket,
          stage: p.stage,
          out: p.outstanding,
          ev: p.evidenced,
          branch: p.branch,
        });
      }
      expect(w.total).toBe(pure.length);
      expect(w.totalOutstanding).toBeCloseTo(
        pure.reduce((n, r) => n + r.outstanding, 0),
        2,
      );
      expect(w.bucketDays).toEqual([30, 60, 90, 120]);
      expect(w.stageDays).toEqual([60, 90, 120]);
      expect(w.tasksEnabled).toBe(false);
      expect(w.rows.find((r) => strip(r.claimActivityNumber) === "CA-SYN-003")!.payerName).toBe(
        "Synthetic Payer B",
      );
      // identifiers and amounts only
      expect(JSON.stringify(w)).not.toMatch(/PIN-SYN/);
    });

    it("filters by stage, payer and branch", async () => {
      const nums = async (a: Parameters<typeof worklist>[0]) =>
        (await worklist(a)).rows.map((r) => strip(r.claimActivityNumber)).sort();
      expect(await nums({ stage: 60 })).toEqual(["CA-SYN-002", "CA-SYN-008"]);
      expect(await nums({ stage: 120 })).toEqual(["CA-SYN-004", "CA-SYN-005", "CA-SYN-011"]);
      expect(await nums({ stage: 0 })).toEqual(["CA-SYN-001", "CA-SYN-007", "CA-SYN-009"]);
      expect(await nums({ payer: "PAY-B" })).toEqual(["CA-SYN-003", "CA-SYN-004"]);
      expect(await nums({ payer: "(no payer)" })).toEqual(["CA-SYN-008"]);
      expect(await nums({ branch: "M" })).toEqual(["CA-SYN-003", "CA-SYN-007", "CA-SYN-011"]);
      const w = await worklist({ stage: 90 });
      expect(w.byStage.find((s) => s.stage === 60)?.claims).toBe(2); // the chips count every stage whatever is picked
      expect(w.branches.sort()).toEqual(["G", "M", "P"]);
    });

    it("the receivables report equals the pure matrix, payer by payer and bucket by bucket", async () => {
      const r = await receivables();
      const sql = receivablesMatrix(r.aggregates, r.bucketDays);
      const names = new Map(fixture.payers.map((p) => [p.payerId, p.payerName]));
      const pure = receivablesMatrix(
        aggregateReceivables(followupRows(claims, opts)).map((a) => ({
          ...a,
          payerName: names.get(a.payerId ?? "") ?? null,
        })),
        opts.bucketDays,
      );
      expect(sql).toEqual(pure);
      expect(sql.totals.claims).toBe(9);
    });

    it("follows the bucket setting, and refuses an invalid one", async () => {
      await svc(() =>
        q(
          "update public.fin_ref_finance_settings set ageing_bucket_days = '{15,45}' where org_id = $1",
          [orgA],
        ),
      );
      try {
        const r = await receivables();
        expect(r.bucketDays).toEqual([15, 45]);
        const pure = receivablesMatrix(
          aggregateReceivables(followupRows(claims, { ...opts, bucketDays: [15, 45] })),
          [15, 45],
        );
        expect(receivablesMatrix(r.aggregates, r.bucketDays).totals).toEqual(pure.totals);
      } finally {
        await svc(() =>
          q(
            "update public.fin_ref_finance_settings set ageing_bucket_days = '{30,60,90,120}' where org_id = $1",
            [orgA],
          ),
        );
      }
      for (const bad of ["{}", "{60,30}", "{0,30}", "{30,30}", "{1,2,3,4,5,6,7,8,9}"])
        await expect(
          svc(() =>
            q(
              "update public.fin_ref_finance_settings set ageing_bucket_days = $2 where org_id = $1",
              [orgA, bad],
            ),
          ),
          bad,
        ).rejects.toMatchObject({ code: "23514" });
      await expect(
        svc(() =>
          q(
            "update public.fin_ref_finance_settings set followup_stage_days = '{1,2,3,4,5,6,7}' where org_id = $1",
            [orgA],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("filters the report by branch (only claims matched to an invoice have one)", async () => {
      const r = await receivables("M");
      expect(r.aggregates.reduce((n, a) => n + a.claims, 0)).toBe(3);
    });

    it("counts follow-up from the submission date when the setting says so, like followupFrom (Insurance, 23 Oct 2026)", async () => {
      const from = async (basis: string, visit: string | null, resub: string | null) =>
        (
          await svc(() =>
            q("select app.fin_followup_from($1, $2::date, $3::date)::text as d", [
              basis,
              visit,
              resub,
            ]),
          )
        ).rows[0].d;
      expect(await from("submission", "2026-07-28", "2026-09-16")).toBe("2026-09-16");
      expect(await from("submission", "2026-07-28", null)).toBe("2026-07-28");
      expect(await from("visit", "2026-07-28", "2026-09-16")).toBe("2026-07-28");

      await svc(() =>
        q(
          "update public.fin_ref_finance_settings set followup_age_basis = 'submission' where org_id = $1",
          [orgA],
        ),
      );
      try {
        const w = await worklist();
        expect(w.ageBasis).toBe("submission");
        const pure = followupRows(claims, { ...opts, ageBasis: "submission" });
        for (const r of w.rows) {
          const p = pure.find((x) => x.claimActivityNumber === strip(r.claimActivityNumber))!;
          expect(
            {
              from: r.followupFrom,
              age: r.followupAgeDays,
              stage: r.stage,
              visitAge: r.ageDays,
              bucket: r.bucket,
            },
            r.claimActivityNumber,
          ).toEqual({
            from: p.followupFrom,
            age: p.followupAgeDays,
            stage: p.stage,
            visitAge: p.ageDays,
            bucket: p.bucket,
          });
        }
        const r3 = w.rows.find((r) => strip(r.claimActivityNumber) === "CA-SYN-003")!;
        expect(r3).toMatchObject({ followupFrom: "2026-09-16", followupAgeDays: 40, stage: null });
      } finally {
        await svc(() =>
          q(
            "update public.fin_ref_finance_settings set followup_age_basis = $2 where org_id = $1",
            [orgA, fixture.settings.ageBasis],
          ),
        );
      }
      await expect(
        svc(() =>
          q(
            "update public.fin_ref_finance_settings set followup_age_basis = 'payment' where org_id = $1",
            [orgA],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("a new organisation counts from submission with one red flag at 120 days", async () => {
      const cols = (
        await q(
          "select column_name, column_default from information_schema.columns where table_schema = 'public' and table_name = 'fin_ref_finance_settings' and column_name in ('followup_stage_days', 'followup_age_basis') order by column_name",
        )
      ).rows.map((r) => `${r.column_name}=${r.column_default}`);
      expect(cols).toEqual([
        "followup_age_basis='submission'::text",
        "followup_stage_days='{120}'::integer[]",
      ]);
    });
  });

  describe("access", () => {
    beforeAll(async () => {
      await svc(async () => {
        await q(
          "insert into public.ins_claim_followups (org_id, claim_activity_id, stage, outcome, note, created_by) values ($1, $2, 60, 'contacted', 'Synthetic note', $3)",
          [orgA, ids["CA-SYN-002"], users.ins],
        );
        await q(
          "insert into public.ins_claim_followup_stages (org_id, claim_activity_id, stage, crossed_on, superseded) values ($1, $2, 120, $3, true)",
          [orgA, ids["CA-SYN-005"], "2026-08-29"],
        );
        await q(
          "insert into public.ins_claim_followups (org_id, claim_activity_id, outcome) values ($1, $2, 'other')",
          [orgB, claimB],
        );
      });
    });

    const seen = (who: string) =>
      asRole(who, async () => ({
        followups: Number(
          (await q("select count(*)::int as n from public.ins_claim_followups")).rows[0].n,
        ),
        stages: Number(
          (await q("select count(*)::int as n from public.ins_claim_followup_stages")).rows[0].n,
        ),
      }));

    it("Finance, Insurance and the CEO read their own org's follow-ups only; Billing and the Medical Director see none", async () => {
      for (const who of ["fin", "ins", "ceo", "alice"])
        expect(await seen(who), who).toEqual({ followups: 1, stages: 1 });
      for (const who of ["billing", "md"])
        expect(await seen(who), who).toEqual({ followups: 0, stages: 0 });
      expect(await seen("bob")).toEqual({ followups: 1, stages: 0 }); // org B's own row only
    });

    it("nobody writes follow-ups or stages directly, not even Insurance", async () => {
      await expect(
        asRole("ins", () =>
          q(
            "insert into public.ins_claim_followups (org_id, claim_activity_id, outcome) values ($1, $2, 'contacted')",
            [orgA, ids["CA-SYN-001"]],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asRole("ins", () =>
          q(
            "insert into public.ins_claim_followup_stages (org_id, claim_activity_id, stage, crossed_on) values ($1, $2, 60, $3)",
            [orgA, ids["CA-SYN-001"], TODAY],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await asRole("ins", () => q("update public.ins_claim_followups set note = 'x'"))).rowCount,
      ).toBe(0);
      expect(
        (await asRole("fin", () => q("delete from public.ins_claim_followup_stages"))).rowCount,
      ).toBe(0);
    });

    it("a follow-up cannot point at another org's claim, and the outcome and note are bounded", async () => {
      await expect(
        svc(() =>
          q(
            "insert into public.ins_claim_followups (org_id, claim_activity_id, outcome) values ($1, $2, 'other')",
            [orgA, claimB],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        svc(() =>
          q(
            "insert into public.ins_claim_followups (org_id, claim_activity_id, outcome) values ($1, $2, 'made_up')",
            [orgA, ids["CA-SYN-001"]],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        svc(() =>
          q(
            "insert into public.ins_claim_followups (org_id, claim_activity_id, outcome, note) values ($1, $2, 'other', $3)",
            [orgA, ids["CA-SYN-001"], "x".repeat(1001)],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("the functions run for the service role only", async () => {
      const { rows } = await q(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'fin_followup%' or p.proname = 'fin_receivables_by_payer_age' order by 1`,
      );
      expect(rows).toEqual([
        { name: "fin_followup_create_tasks", anon: false, auth: false, svc: true },
        { name: "fin_followup_open_claims", anon: false, auth: false, svc: true },
        { name: "fin_followup_worklist", anon: false, auth: false, svc: true },
        { name: "fin_receivables_by_payer_age", anon: false, auth: false, svc: true },
      ]);
      await expect(
        asRole("fin", () => q("select public.fin_followup_worklist($1, $2)", [orgA, TODAY])),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("the worklist shows the last follow-up of each claim", async () => {
      const w = await worklist();
      const r = w.rows.find((x) => strip(x.claimActivityNumber) === "CA-SYN-002")!;
      expect(r.lastFollowup).toMatchObject({
        outcome: "contacted",
        note: "Synthetic note",
        stage: 60,
      });
    });

    afterAll(async () => {
      await svc(() => q("delete from public.ins_claim_followup_stages where org_id = $1", [orgA]));
    });
  });

  it("the migration grants finance.followup.manage to the Finance and Insurance system roles only, idempotently", async () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261026000100_finance_insurance_followup.sql"),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(block, "the grant block was not found").toBeTruthy();
    const orgC = await createOrg(c, "Org C", "org-c", users.alice);
    await svc(async () => {
      for (const [name, system] of [
        ["Finance", true],
        ["Insurance", true],
        ["Billing", true],
        ["CEO", true],
        ["Custom insurance", false],
      ] as const)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '[\"finance.claims.view\"]'::jsonb, $3) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgC, name, system],
        );
    });
    const read = async () =>
      Object.fromEntries(
        (
          await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
        ).rows.map((r) => [
          r.name,
          (r.permissions as string[]).includes("finance.followup.manage"),
        ]),
      );
    await svc(() => q(block!));
    const first = await read();
    expect(first).toMatchObject({
      Finance: true,
      Insurance: true,
      Billing: false,
      CEO: false,
      "Custom insurance": false,
    });
    await svc(() => q(block!));
    expect(await read()).toEqual(first);
    const dup = await svc(() =>
      q("select permissions from public.roles where org_id = $1 and name = 'Finance'", [orgC]),
    );
    expect(
      (dup.rows[0].permissions as string[]).filter((p) => p === "finance.followup.manage"),
    ).toHaveLength(1);
  });

  describe("daily follow-up tasks", () => {
    const stageRows = async () =>
      (
        await svc(() =>
          q(
            `select c.claim_activity_number as num, st.stage, st.superseded, st.task_id, st.assignee_id, t.subject, t.notes, t.done, t.due_at
             from public.ins_claim_followup_stages st
             join public.ins_claim_activities c on c.id = st.claim_activity_id
             left join public.tasks t on t.id = st.task_id
             where st.org_id = $1 order by 1, 2`,
            [orgA],
          ),
        )
      ).rows;

    it("does nothing until finance sets a start date", async () => {
      const r = await runTasks();
      expect(r).toMatchObject({ skipped: "not_enabled", raised: 0, tasks: 0 });
      expect(await stageRows()).toEqual([]);
    });

    it("raises each stage crossed since the start date once, with one task per claim for the highest", async () => {
      await svc(() =>
        q(
          "update public.fin_ref_finance_settings set followup_start_date = $2, followup_task_role = 'Insurance', followup_task_due_days = 3 where org_id = $1",
          [orgA, fixture.tasks.startDate],
        ),
      );
      const r = await runTasks();
      expect(r).toMatchObject({ raised: 7, tasks: 5, superseded: 2, unassigned: 0 });
      const rows = await stageRows();
      const byClaim: Record<string, number[]> = {};
      for (const x of rows) (byClaim[strip(x.num)] ??= []).push(x.stage);
      expect(byClaim).toEqual(fixture.tasks.expectedStages);
      for (const x of rows) {
        const top = (fixture.tasks.expectedTopStage as Record<string, number>)[strip(x.num)];
        if (x.stage === top) {
          expect(x.superseded, x.num).toBe(false);
          expect(x.subject).toBe(followupTaskSubject(x.stage, "visit"));
          expect(x.notes).toContain(ids[strip(x.num)]);
          // ids and the stage only: no payer, amount or patient detail in the task
          expect(`${x.subject} ${x.notes}`).not.toMatch(/PAY-|PIN|Synthetic Payer|\d+\.\d\d/);
          expect(new Date(x.due_at).toISOString()).toBe(
            new Date(Date.parse(NOW) + 3 * 86_400_000).toISOString(),
          );
        } else {
          expect(x.superseded, x.num).toBe(true);
          expect(x.task_id).toBeNull();
        }
      }
      // spread over the Insurance role: 3 and 2
      const load = new Map<string, number>();
      for (const x of rows.filter((y) => y.task_id))
        load.set(x.assignee_id, (load.get(x.assignee_id) ?? 0) + 1);
      expect([...load.keys()].sort()).toEqual([users.ins, users.ins2].sort());
      expect([...load.values()].sort()).toEqual([2, 3]);
      const w = await worklist();
      expect(w.tasksEnabled).toBe(true);
      expect(w.rows.find((x) => strip(x.claimActivityNumber) === "CA-SYN-004")!.task).toMatchObject(
        { stage: 120, done: false },
      );
    });

    it("is idempotent: running again raises nothing", async () => {
      const before = await stageRows();
      const r = await runTasks();
      expect(r).toMatchObject({ raised: 0, tasks: 0 });
      expect(await stageRows()).toEqual(before);
    });

    it("two runs at the same moment never raise a stage twice", async () => {
      const id = await svc(
        async () =>
          (
            await q(
              "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, net) values ($1, 'A-CA-SYN-RACE', 'A/RACE', '99213', 'PAY-A', $2, 100) returning id",
              [orgA, plusDays(TODAY, -60)],
            )
          ).rows[0].id as string,
      );
      const other = await connect();
      try {
        const call = (cl: Client) =>
          (async () => {
            await cl.query("begin");
            await cl.query("set local role service_role");
            const res = await cl.query(
              "select public.fin_followup_create_tasks($1, $2, $3::timestamptz, 500) as r",
              [orgA, TODAY, NOW],
            );
            await new Promise((r) => setTimeout(r, 50));
            await cl.query("commit");
            return res.rows[0].r as { tasks: number };
          })();
        const [x, y] = await Promise.all([call(c), call(other)]);
        expect(x.tasks + y.tasks).toBe(1);
      } finally {
        await other.end();
      }
      const n = await svc(
        async () =>
          (
            await q(
              "select count(*)::int as n from public.ins_claim_followup_stages where claim_activity_id = $1",
              [id],
            )
          ).rows[0].n,
      );
      expect(n).toBe(1);
    });

    it("a month later: the next stages, each kept with the person who had the claim", async () => {
      const first = new Map(
        (await stageRows()).filter((x) => x.task_id).map((x) => [strip(x.num), x.assignee_id]),
      );
      const later = plusDays(TODAY, 30);
      const r = await runTasks(later, `${later}T05:00:00Z`);
      // CA-SYN-002 -> 90, CA-SYN-003 -> 120, CA-SYN-008 -> 90, CA-SYN-009 -> 60, the race claim -> 90
      expect(r).toMatchObject({ raised: 5, tasks: 5, superseded: 0 });
      const rows = await stageRows();
      for (const [num, stage] of [
        ["CA-SYN-002", 90],
        ["CA-SYN-003", 120],
        ["CA-SYN-008", 90],
      ] as const) {
        const row = rows.find((x) => strip(x.num) === num && x.stage === stage)!;
        expect(row.assignee_id, num).toBe(first.get(num));
      }
    });

    it("closes the open follow-up tasks of a claim that has been paid", async () => {
      await svc(() =>
        q("update public.ins_claim_activities set remitted = net where id = $1", [
          ids["CA-SYN-004"],
        ]),
      );
      const r = await runTasks();
      expect(r).toMatchObject({ closed: 1, raised: 0 });
      const row = (await stageRows()).find(
        (x) => strip(x.num) === "CA-SYN-004" && x.stage === 120,
      )!;
      expect(row.done).toBe(true);
    });

    it("records stages without tasks when tasks are switched off, and leaves a task unassigned when the role is empty", async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set followup_start_date = '2026-01-01', followup_task_enabled = false where org_id = $1",
          [orgB],
        );
      });
      const off = await runTasks(TODAY, NOW, orgB);
      expect(Number(off.raised)).toBeGreaterThan(0);
      expect(off.tasks).toBe(0);
      await svc(async () => {
        await q(
          "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, transaction_date, net) values ($1, 'B-CA-SYN-NEW', 'B/NEW', '99213', $2, 100)",
          [orgB, plusDays(TODAY, -60)],
        );
        await q(
          "update public.fin_ref_finance_settings set followup_task_enabled = true, followup_task_role = 'Nobody here' where org_id = $1",
          [orgB],
        );
      });
      const on = await runTasks(TODAY, NOW, orgB);
      expect(on).toMatchObject({ raised: 1, tasks: 1, unassigned: 1 });
      const t = (
        await svc(() =>
          q(
            "select t.assignee_id, t.org_id from public.ins_claim_followup_stages st join public.tasks t on t.id = st.task_id where st.org_id = $1",
            [orgB],
          ),
        )
      ).rows;
      expect(t).toEqual([{ assignee_id: null, org_id: orgB }]);
      // org A untouched by org B's run
      const aTasks = (await stageRows()).filter((x) => x.task_id).length;
      expect(aTasks).toBe(11);
    });
  });
});
