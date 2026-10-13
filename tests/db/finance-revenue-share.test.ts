/**
 * Slice 20F: doctor revenue share in the database. Parity of fin_revshare_inputs with the fixture rules, the calculator's
 * hand-worked results stored as a draft, who reads (Finance and the CEO; not the Medical Director, Billing, Insurance or
 * Cost / Payroll; not another org), nobody writes directly, the two-person rule and the hash binding for schemes and
 * runs, frozen after verification (run, lines and the month's charges), locked-month refusals, posting and payments, the
 * liability, scheme versions (selection, retire, immutability), the SQL rule check against Zod, and the grant block.
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";
import { buildRunSnapshot, parseRule } from "@/lib/finance/revshare";

import { ALL_INVOICES, FIXTURE, revenueFromFixture } from "../unit/finance/revshare-fixture";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const SEP = "2026-09-01";
const AUG = "2026-08-01";
const JUL = "2026-07-01";
type Err = { code?: string; message?: string };

describe.skipIf(!TEST_DATABASE_URL)("Doctor revenue share (slice 20F)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const u: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const as = <T>(n: string, fn: () => Promise<T>) => asUser(c, u[n], fn);
  /** Runs the statement as the service role and returns the error (or null), inside a savepoint-free transaction. */
  const fails = async (sql: string, p: unknown[] = []): Promise<Err | null> =>
    svc(async () => {
      await q("begin");
      try {
        await q(sql, p);
        return null;
      } catch (e) {
        return e as Err;
      } finally {
        await q("rollback");
      }
    });
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;

  const inputs = (org: string, month = SEP) =>
    one<{ j: unknown }>("select public.fin_revshare_inputs($1, $2) as j", [org, month]).then(
      (r) => r.j,
    );
  const store = (org: string, month: string, snap: unknown, user = u.fin) =>
    svc(() =>
      q("select public.fin_revshare_store_draft($1, $2, $3, $4::jsonb) as id", [
        org,
        month,
        user,
        JSON.stringify(snap),
      ]),
    ).then((r) => r.rows[0].id as string);
  const build = async (org: string, month = SEP) =>
    store(org, month, buildRunSnapshot(await inputs(org, month)));
  const run = (org: string, month = SEP) =>
    one<{
      id: string;
      status: string;
      snapshot_hash: string;
      snapshot: unknown;
      total_payout: string;
      verified_by: string | null;
    }>("select * from public.fin_revshare_runs where org_id = $1 and month = $2", [org, month]);
  const runStep = (org: string, id: string, step: string, user: string, hash: string) =>
    svc(() =>
      q("select public.fin_revshare_run_step($1, $2, $3, $4, $5)", [org, id, step, user, hash]),
    );
  const schemeSave = (
    org: string,
    doctor: string,
    from: string,
    rule: unknown,
    user = u.fin,
    id: string | null = null,
  ) =>
    svc(() =>
      q("select public.fin_revshare_scheme_save($1, $2, $3, $4, $5::jsonb, null, $6) as id", [
        org,
        id,
        doctor,
        from,
        JSON.stringify(rule),
        user,
      ]),
    ).then((r) => r.rows[0].id as string);
  const schemeStep = async (org: string, id: string, step: string, user: string) => {
    const { rule_hash } = await one<{ rule_hash: string }>(
      "select rule_hash from public.fin_revshare_schemes where id = $1",
      [id],
    );
    return svc(() =>
      q("select public.fin_revshare_scheme_step($1, $2, $3, $4, $5)", [
        org,
        id,
        step,
        user,
        rule_hash,
      ]),
    );
  };
  const approvedScheme = async (org: string, doctor: string, from: string, rule: unknown) => {
    const id = await schemeSave(org, doctor, from, rule);
    await schemeStep(org, id, "verify", u.fm);
    await schemeStep(org, id, "approve", u.ceo);
    return id;
  };
  const rejects = async (p: Promise<unknown>, re: RegExp, code?: string) => {
    const e = (await p.then(
      () => null,
      (x: Err) => x,
    )) as Err | null;
    expect(e, `expected an error matching ${re}`).not.toBeNull();
    expect(e!.message).toMatch(re);
    if (code) expect(e!.code).toBe(code);
  };

  const seedOrg = async (org: string, scale: number) => {
    for (const [item, cat] of FIXTURE.services)
      await q(
        "insert into public.fin_ref_services (org_id, item_code, service_category) values ($1, $2, $3) on conflict do nothing",
        [org, item, cat],
      );
    for (const d of FIXTURE.doctors)
      await q(
        "insert into public.fin_ref_doctors (org_id, dha_id, name) values ($1, $2, $3) on conflict do nothing",
        [org, d.dha_id, d.name],
      );
    for (const i of ALL_INVOICES) {
      const net = i.lines.reduce((s, l) => s + l[1], 0) * scale;
      const inv = (
        await q(
          `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, doctor_dha_id, inv_type, net, total,
             patient_pin, record_hash, is_deleted)
           values ($1, $2, $3, $4, 'SELF PAY', $5, $5, 'PIN-SYN-1', 'h', $6) returning id`,
          [org, i.no, i.date, i.doctor, net, i.deleted ?? false],
        )
      ).rows[0].id;
      let n = 0;
      for (const [item, lineNet] of i.lines)
        await q(
          `insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, line_net, is_current)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [org, inv, `${i.no}|${++n}`, n, item, lineNet * scale, !i.superseded],
        );
    }
    for (const ch of FIXTURE.charges)
      await q(
        "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount, reference) values ($1, $2, $3, $4, $5, $6)",
        [org, SEP, ch.doctor, ch.kind, ch.amount * scale, ch.reference],
      );
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of [
      "alice",
      "bob",
      "fin",
      "fin2",
      "fm",
      "ceo",
      "md",
      "billing",
      "ins",
      "costp",
      "nobody",
    ])
      u[n] = await createAuthUser(c, `${n}-revshare@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", u.alice);
    orgB = await createOrg(c, "Org B", "org-b", u.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (who: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, u[who], role],
        );
      await member("fin", "Finance");
      await member("fin2", "Finance");
      await member("fm", "Finance Manager");
      await member("ceo", "CEO");
      await member("md", "Medical Director");
      await member("billing", "Billing");
      await member("ins", "Insurance");
      await member("costp", "Cost / Payroll");
      await seedOrg(orgA, 1);
      await seedOrg(orgB, 3); // the other org bills three times as much: nothing of it may leak into org A
    });

    // SYN-0001: an old version, the fixture's version from September, and one that starts later
    await approvedScheme(orgA, "SYN-0001", "2026-01-01", {
      basis: "net_revenue",
      default_rate: 0.9,
      deductions: {},
    });
    for (const s of FIXTURE.schemes)
      await approvedScheme(orgA, s.doctor, s.doctor === "SYN-0001" ? SEP : "2026-01-01", s.rule);
    await approvedScheme(orgA, "SYN-0001", "2026-10-01", {
      basis: "net_revenue",
      default_rate: 0.99,
      deductions: {},
    });
    // SYN-0008: v1, then v2 from June retired; v1 must not come back
    await approvedScheme(orgA, "SYN-0008", "2026-01-01", {
      basis: "net_revenue",
      default_rate: 0.2,
      deductions: {},
    });
    const v2 = await approvedScheme(orgA, "SYN-0008", "2026-06-01", {
      basis: "net_revenue",
      default_rate: 0.25,
      deductions: {},
    });
    await schemeStep(orgA, v2, "retire", u.ceo);
    // org B: one scheme so its run is not empty
    await svc(() =>
      q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Finance', '', '[]'::jsonb, true) on conflict do nothing",
        [orgB],
      ),
    );
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("inputs (step 1)", () => {
    it("are service-role only", async () => {
      for (const who of ["fin", "alice"]) {
        const e = await as(who, () =>
          q("select public.fin_revshare_inputs($1, $2)", [orgA, SEP]).then(
            () => null,
            (x: Err) => x,
          ),
        );
        expect(e?.code, who).toBe("42501");
      }
    });

    it("match the fixture rules: current lines of live invoices in the month, by doctor and category (parity)", async () => {
      const j = (await inputs(orgA)) as {
        revenue: Array<Record<string, unknown>>;
        charges: Array<Record<string, unknown>>;
        schemes: Array<Record<string, unknown>>;
        doctors: Array<Record<string, unknown>>;
        month: string;
        doctor_basis: string | null;
      };
      expect(j.month).toBe(SEP);
      expect(j.doctor_basis).toBeNull();
      expect(j.revenue.map((r) => ({ ...r, net: Number(r.net) }))).toEqual(revenueFromFixture());
      expect(
        j.charges
          .map((ch) => [ch.doctor_dha_id, ch.kind, Number(ch.amount), ch.reference, ch.source])
          .sort(),
      ).toEqual(
        FIXTURE.charges.map((ch) => [ch.doctor, ch.kind, ch.amount, ch.reference, "manual"]).sort(),
      );
      expect(j.doctors.find((d) => d.dha_id === "SYN-0001")?.name).toBe("Dr Synthetic One");
      expect(j.doctors.find((d) => d.dha_id === "SYN-0003")?.name).toBeNull();
    });

    it("pick the newest approved version that has started; a retired version means no scheme", async () => {
      const j = (await inputs(orgA)) as {
        schemes: Array<{ doctor_dha_id: string; rule: unknown; effective_from: string }>;
      };
      expect(j.schemes.map((s) => s.doctor_dha_id)).toEqual(FIXTURE.schemes.map((s) => s.doctor));
      expect(j.schemes[0].rule).toEqual(FIXTURE.schemes[0].rule);
      expect(j.schemes[0].effective_from).toBe(SEP);
      const aug = (await inputs(orgA, AUG)) as {
        schemes: Array<{ doctor_dha_id: string; rule: { default_rate: number } }>;
      };
      expect(aug.schemes.find((s) => s.doctor_dha_id === "SYN-0001")?.rule.default_rate).toBe(0.9);
      expect(aug.schemes.some((s) => s.doctor_dha_id === "SYN-0008")).toBe(false);
      const may = (await inputs(orgA, "2026-05-01")) as {
        schemes: Array<{ doctor_dha_id: string }>;
      };
      expect(may.schemes.some((s) => s.doctor_dha_id === "SYN-0008")).toBe(true);
    });

    it("follow the configured doctor basis", async () => {
      await svc(async () => {
        await q(
          "update public.fin_invoices set performing_doctor_dha_id = 'syn-0002 ' where org_id = $1 and inv_display_number = 'SYN/INV/2'",
          [orgA],
        );
        await q(
          "insert into public.fin_ref_finance_settings (org_id, doctor_basis) values ($1, 'performing') on conflict (org_id) do update set doctor_basis = 'performing'",
          [orgA],
        );
      });
      const j = (await inputs(orgA)) as {
        revenue: Array<{ doctor_dha_id: string; category: string; net: number }>;
      };
      expect(
        j.revenue.find((r) => r.doctor_dha_id === "SYN-0002" && r.category === "Consultation")?.net,
      ).toBe(12000);
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set doctor_basis = null where org_id = $1",
          [orgA],
        );
        await q(
          "update public.fin_invoices set performing_doctor_dha_id = null where org_id = $1 and inv_display_number = 'SYN/INV/2'",
          [orgA],
        );
      });
    });
  });

  describe("the run", () => {
    it("stores the calculator's hand-worked results as a draft with one line per doctor", async () => {
      const snap = buildRunSnapshot(await inputs(orgA));
      for (const e of FIXTURE.expected.results)
        expect(snap.results.find((r) => r.doctor_dha_id === e.doctor)?.payout, e.doctor).toBe(
          e.payout,
        );
      const id = await store(orgA, SEP, snap);
      const r = await run(orgA);
      expect(r.id).toBe(id);
      expect(r.status).toBe("draft");
      expect(Number(r.total_payout)).toBe(FIXTURE.expected.totals.payout);
      const lines = (
        await svc(() =>
          q(
            "select doctor_dha_id, payout::float8 as payout from public.fin_revshare_lines where run_id = $1 order by 1",
            [id],
          ),
        )
      ).rows;
      expect(lines).toEqual(
        FIXTURE.expected.results.map((e) => ({ doctor_dha_id: e.doctor, payout: e.payout })),
      );
      const hash = await one<{ ok: boolean }>(
        "select snapshot_hash = encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') as ok from public.fin_revshare_runs where id = $1",
        [id],
      );
      expect(hash.ok).toBe(true);
    });

    it("refuses a snapshot whose inputs or results do not match the database, and a month that has not ended", async () => {
      const good = buildRunSnapshot(await inputs(orgA));
      const tampered = JSON.parse(JSON.stringify(good));
      tampered.inputs.revenue[0].net += 1;
      await rejects(store(orgA, SEP, tampered), /source data changed/, "23514");
      const dropped = { ...good, results: good.results.slice(1) };
      await rejects(store(orgA, SEP, dropped), /exactly one result/);
      const wrongScheme = JSON.parse(JSON.stringify(good));
      wrongScheme.results[0].scheme_id = wrongScheme.results[1].scheme_id;
      await rejects(store(orgA, SEP, wrongScheme), /exactly one result/);
      await rejects(store(orgA, AUG, good), /another month/);
      await rejects(
        store(orgA, "2026-10-01", { ...good, month: "2026-10-01" }),
        /after it has ended/,
      );
      const org = buildRunSnapshot(await inputs(orgB));
      await rejects(store(orgA, SEP, org), /source data changed/);
    });

    it("is read by Finance and the CEO only; nobody writes it directly", async () => {
      const tables = [
        "fin_revshare_runs",
        "fin_revshare_lines",
        "fin_revshare_schemes",
        "fin_doctor_charges",
      ];
      for (const who of ["fin", "ceo", "alice"])
        await as(who, async () => {
          for (const t of tables)
            expect(
              (await q(`select count(*)::int as n from public.${t}`)).rows[0].n,
              `${who} ${t}`,
            ).toBeGreaterThan(0);
        });
      for (const who of ["md", "billing", "ins", "costp", "bob", "nobody"])
        await as(who, async () => {
          for (const t of tables)
            expect(
              (await q(`select count(*)::int as n from public.${t} where org_id = $1`, [orgA]))
                .rows[0].n,
              `${who} ${t}`,
            ).toBe(0);
        });
      for (const who of ["fin", "ceo"])
        await as(who, async () => {
          for (const sql of [
            `insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ('${orgA}', '${SEP}', 'SYN-0001', 'lab', 1)`,
            "update public.fin_revshare_runs set status = 'approved'",
            "update public.fin_revshare_lines set payout = 1",
            "delete from public.fin_revshare_schemes",
          ]) {
            await q("begin");
            const e = await q(sql).then(
              (r) => (r.rowCount ? { code: "changed" } : null),
              (x: Err) => x,
            );
            await q("rollback");
            if (e) expect(e.code, `${who}: ${sql}`).toBe("42501");
          }
        });
    });

    it("the person who built a run never verifies it (maker and checker are two people)", async () => {
      const r = await run(orgA);
      await rejects(
        runStep(orgA, r.id, "verify", u.fin, r.snapshot_hash),
        /built this run cannot verify it/,
      );
      expect((await run(orgA)).status).toBe("draft");
    });

    it("verification is bound to the hash and checks the inputs are still current", async () => {
      const r = await run(orgA);
      await rejects(
        runStep(orgA, r.id, "verify", u.fm, "0".repeat(64)),
        /changed since you opened it/,
      );
      await svc(() =>
        q(
          "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, 'SYN-0001', 'other', 1)",
          [orgA, SEP],
        ),
      );
      await rejects(
        runStep(orgA, r.id, "verify", u.fm, r.snapshot_hash),
        /rebuild it, then verify/,
      );
      await svc(() =>
        q(
          "delete from public.fin_doctor_charges where org_id = $1 and kind = 'other' and doctor_dha_id = 'SYN-0001'",
          [orgA],
        ),
      );
      await runStep(orgA, r.id, "verify", u.fm, r.snapshot_hash);
      expect((await run(orgA)).status).toBe("verified");
    });

    it("a verified run, its lines and its month's charges are frozen", async () => {
      const r = await run(orgA);
      for (const [sql, re] of [
        ["update public.fin_revshare_runs set snapshot = '{}'::jsonb where id = $1", /frozen/],
        ["update public.fin_revshare_runs set total_payout = 0 where id = $1", /frozen/],
        ["delete from public.fin_revshare_runs where id = $1", /cannot be deleted/],
        [
          "update public.fin_revshare_lines set payout = payout + 1 where run_id = $1",
          /cannot change once written/,
        ],
        ["delete from public.fin_revshare_lines where run_id = $1", /frozen/],
      ] as const)
        expect((await fails(sql, [r.id]))?.message, sql).toMatch(re);
      expect(
        (
          await fails(
            "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, 'SYN-0001', 'lab', 5)",
            [orgA, SEP],
          )
        )?.message,
      ).toMatch(/is verified/);
      expect(
        (
          await fails("delete from public.fin_doctor_charges where org_id = $1 and month = $2", [
            orgA,
            SEP,
          ])
        )?.message,
      ).toMatch(/is verified/);
      await rejects(build(orgA), /verified and cannot be rebuilt/);
    });

    it("the approval must come from a different person, on the same hash", async () => {
      const r = await run(orgA);
      await rejects(runStep(orgA, r.id, "approve", u.fm, r.snapshot_hash), /two different people/);
      await rejects(
        runStep(orgA, r.id, "approve", u.ceo, "f".repeat(64)),
        /changed since you opened it/,
      );
      // the table refuses it too, whoever writes
      expect(
        (
          await fails(
            "update public.fin_revshare_runs set status = 'approved', approved_by = verified_by, approved_at = now() where id = $1",
            [r.id],
          )
        )?.code,
      ).toBe("23514");
      await rejects(
        svc(() => q("select public.fin_revshare_post($1, $2, $3, 'JV-1')", [orgA, r.id, u.fin])),
        /only an approved run/,
      );
      await runStep(orgA, r.id, "approve", u.ceo, r.snapshot_hash);
      expect((await run(orgA)).status).toBe("approved");
      await rejects(
        runStep(orgA, r.id, "withdraw", u.fin, r.snapshot_hash),
        /waiting for approval/,
      );
    });

    it("liability, posting and payments (steps 7 to 9) complete the run", async () => {
      const r = await run(orgA);
      const liability = () =>
        one<{ j: { total: number; runs: unknown[] } }>(
          "select public.fin_revshare_liability($1) as j",
          [orgA],
        ).then((x) => x.j);
      expect(Number((await liability()).total)).toBe(FIXTURE.expected.totals.payout);
      const line = (doctor: string) =>
        one<{ id: string }>(
          "select id from public.fin_revshare_lines where run_id = $1 and doctor_dha_id = $2",
          [r.id, doctor],
        ).then((x) => x.id);
      const pay = (id: string, on: string, ref: string) =>
        svc(() =>
          q("select public.fin_revshare_record_payment($1, $2, $3, $4, $5) as s", [
            orgA,
            id,
            u.fin,
            on,
            ref,
          ]),
        ).then((x) => x.rows[0].s as string);
      await rejects(pay(await line("SYN-0001"), "2026-10-10", "TRF-1"), /once the run is posted/);
      await rejects(
        svc(() => q("select public.fin_revshare_post($1, $2, $3, '  ')", [orgA, r.id, u.fin])),
        /accounting reference/,
      );
      await svc(() =>
        q("select public.fin_revshare_post($1, $2, $3, 'JV-0001')", [orgA, r.id, u.fin]),
      );
      expect((await run(orgA)).status).toBe("posted");
      await rejects(pay(await line("SYN-0004"), "2026-10-10", "TRF-0"), /nothing is payable/);
      await rejects(pay(await line("SYN-0001"), "2026-08-31", "TRF-1"), /payment date/);
      await rejects(pay(await line("SYN-0001"), "2099-01-01", "TRF-1"), /payment date/);
      await rejects(pay(await line("SYN-0001"), "2026-10-10", ""), /payment reference/);
      expect(await pay(await line("SYN-0001"), "2026-10-10", "TRF-WRONG")).toBe("posted");
      expect(await pay(await line("SYN-0001"), "2026-10-10", "TRF-1")).toBe("posted"); // corrected while posted
      expect(Number((await liability()).total)).toBeCloseTo(
        FIXTURE.expected.totals.payout - 2849.5,
        2,
      );
      expect(await pay(await line("SYN-0002"), "2026-10-10", "TRF-2")).toBe("posted");
      expect(await pay(await line("SYN-0003"), "2026-10-11", "TRF-3")).toBe("posted");
      expect(await pay(await line("SYN-0006"), "2026-10-11", "TRF-6")).toBe("paid");
      expect((await run(orgA)).status).toBe("paid");
      expect(Number((await liability()).total)).toBe(0);
      await rejects(pay(await line("SYN-0001"), "2026-10-12", "TRF-9"), /this run is paid/);
      expect(
        (
          await fails("update public.fin_revshare_lines set payment_ref = 'X' where run_id = $1", [
            r.id,
          ])
        )?.message,
      ).toMatch(/payments are recorded/);
      const paid = (
        await svc(() =>
          q(
            "select payment_ref from public.fin_revshare_lines where run_id = $1 and doctor_dha_id = 'SYN-0001'",
            [r.id],
          ),
        )
      ).rows[0];
      expect(paid.payment_ref).toBe("TRF-1");
    });

    it("cannot be reached across orgs", async () => {
      const r = await run(orgA);
      await rejects(runStep(orgB, r.id, "verify", u.bob, r.snapshot_hash), /run not found/);
      await rejects(
        svc(() => q("select public.fin_revshare_post($1, $2, $3, 'JV')", [orgB, r.id, u.bob])),
        /run not found/,
      );
      const lineId = (
        await one<{ id: string }>(
          "select id from public.fin_revshare_lines where run_id = $1 limit 1",
          [r.id],
        )
      ).id;
      await rejects(
        svc(() =>
          q("select public.fin_revshare_record_payment($1, $2, $3, '2026-10-10', 'X')", [
            orgB,
            lineId,
            u.bob,
          ]),
        ),
        /line not found/,
      );
      const lineB = await fails(
        "insert into public.fin_revshare_lines (org_id, run_id, doctor_dha_id, scheme_id, scheme_version, payout) values ($1, $2, 'SYN-0001', gen_random_uuid(), 1, 1)",
        [orgB, r.id],
      );
      expect(lineB?.code).toBe("23514");
    });
  });

  describe("a month locked by the close", () => {
    beforeAll(async () => {
      // July: a draft built before the lock. August: nothing yet. Then both are locked.
      await build(orgA, JUL);
      await svc(async () => {
        for (const m of [JUL, AUG])
          await q(
            `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
             values ($1, $2, 'locked', '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'), now(), now(), now(), now())`,
            [orgA, m],
          );
      });
    });

    it("refuses charges, building and rebuilding", async () => {
      const e = await fails(
        "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, 'SYN-0001', 'lab', 5)",
        [orgA, AUG],
      );
      expect(e?.code).toBe("42501");
      expect(e?.message).toMatch(/locked by the month-end close/);
      await rejects(build(orgA, AUG), /locked/, "42501");
      await rejects(build(orgA, JUL), /locked/, "42501");
    });

    it("still lets a draft built before the lock be verified and approved, but not returned to draft", async () => {
      const r = await run(orgA, JUL);
      await runStep(orgA, r.id, "verify", u.fin2, r.snapshot_hash);
      await rejects(runStep(orgA, r.id, "withdraw", u.fin2, r.snapshot_hash), /locked/, "42501");
      await runStep(orgA, r.id, "approve", u.ceo, r.snapshot_hash);
      expect((await run(orgA, JUL)).status).toBe("approved");
    });
  });

  describe("schemes (step 2)", () => {
    it("an approved version never changes and cannot be deleted", async () => {
      const s = await one<{ id: string }>(
        "select id from public.fin_revshare_schemes where org_id = $1 and doctor_dha_id = 'SYN-0002' and status = 'approved'",
        [orgA],
      );
      for (const sql of [
        `update public.fin_revshare_schemes set rule = jsonb_set(rule, '{default_rate}', '0.9') where id = $1`,
        "update public.fin_revshare_schemes set effective_from = '2026-02-01' where id = $1",
        "update public.fin_revshare_schemes set status = 'draft' where id = $1",
        "delete from public.fin_revshare_schemes where id = $1",
      ])
        expect((await fails(sql, [s.id]))?.code, sql).toBe("23514");
      await rejects(
        schemeSave(orgA, "SYN-0002", "2026-01-01", parseRule(FIXTURE.schemes[1].rule), u.fin, s.id),
        /cannot be edited/,
      );
    });

    it("drafts: one per doctor, editing returns a verified draft to draft, two people bound to the hash", async () => {
      const rule = { basis: "net_revenue", default_rate: 0.3, deductions: { lab: 1 } };
      const id = await schemeSave(orgA, " syn-0009 ", "2026-11-01", rule);
      const row = await one<{
        doctor_dha_id: string;
        version: number;
        status: string;
        rule_hash: string;
      }>("select * from public.fin_revshare_schemes where id = $1", [id]);
      expect([row.doctor_dha_id, row.version, row.status]).toEqual(["SYN-0009", 1, "draft"]);
      await rejects(
        schemeSave(orgA, "SYN-0009", "2026-11-01", rule),
        /already has a version in preparation/,
      );
      await rejects(schemeStep(orgA, id, "approve", u.ceo), /only a verified version/);
      await rejects(schemeStep(orgA, id, "verify", u.fin), /prepared this version cannot verify it/);
      await schemeStep(orgA, id, "verify", u.fm);
      await rejects(schemeStep(orgA, id, "approve", u.fm), /two different people/);
      await rejects(
        svc(() =>
          q("select public.fin_revshare_scheme_step($1, $2, 'approve', $3, $4)", [
            orgA,
            id,
            u.ceo,
            "0".repeat(64),
          ]),
        ),
        /rule changed/,
      );
      // editing a verified draft sends it back to draft with a new hash
      await schemeSave(orgA, "SYN-0009", "2026-11-01", { ...rule, default_rate: 0.35 }, u.fin, id);
      const edited = await one<{ status: string; rule_hash: string; verified_by: string | null }>(
        "select * from public.fin_revshare_schemes where id = $1",
        [id],
      );
      expect(edited.status).toBe("draft");
      expect(edited.verified_by).toBeNull();
      expect(edited.rule_hash).not.toBe(row.rule_hash);
      // a verified version cannot be edited behind the function's back
      await schemeStep(orgA, id, "verify", u.fm);
      expect(
        (
          await fails(
            "update public.fin_revshare_schemes set rule = jsonb_set(rule, '{default_rate}', '0.9') where id = $1",
            [id],
          )
        )?.message,
      ).toMatch(/cannot be edited/);
      await schemeStep(orgA, id, "approve", u.ceo);
      const next = await schemeSave(orgA, "SYN-0009", "2027-01-01", rule);
      expect(
        (
          await one<{ version: number }>(
            "select version from public.fin_revshare_schemes where id = $1",
            [next],
          )
        ).version,
      ).toBe(2);
      await schemeStep(orgA, next, "delete", u.fin);
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.fin_revshare_schemes where id = $1",
            [next],
          )
        ).n,
      ).toBe(0);
    });

    it("the SQL rule check agrees with the Zod rule schema", async () => {
      const ok = { basis: "net_revenue", default_rate: 0.35, deductions: { lab: 1 } };
      const cases: unknown[] = [
        ok,
        {
          ...ok,
          category_rates: { Lab: 0.1, Consultation: 0.3325 },
          threshold: 1000.5,
          minimum_guarantee: 0,
        },
        { ...ok, formula: "x" },
        { ...ok, basis: "collected" },
        { ...ok, default_rate: 1.5 },
        { ...ok, default_rate: 0.12345 },
        { ...ok, default_rate: "0.3" },
        { ...ok, deductions: { rent: 1 } },
        { ...ok, deductions: [] },
        { ...ok, category_rates: { " Lab": 0.1 } },
        {
          ...ok,
          category_rates: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`C${i}`, 0.1])),
        },
        { ...ok, threshold: -1 },
        { ...ok, threshold: 1.005 },
        { ...ok, threshold: null },
        { ...ok, minimum_guarantee: 2e9 },
        { basis: "net_revenue", default_rate: 0.3 },
        [],
        "x",
      ];
      for (const r of cases) {
        const sql = (
          await one<{ v: boolean }>("select app.fin_revshare_rule_valid($1::jsonb) as v", [
            JSON.stringify(r),
          ])
        ).v;
        expect(sql, JSON.stringify(r).slice(0, 80)).toBe(parseRule(r) !== null);
      }
      expect(
        (
          await fails(
            "insert into public.fin_revshare_schemes (org_id, doctor_dha_id, version, effective_from, rule, rule_hash) values ($1, 'SYN-X', 1, '2026-01-01', '{}'::jsonb, '')",
            [orgA],
          )
        )?.code,
      ).toBe("23514");
    });
  });

  describe("doctor charges", () => {
    it("a CSV upload replaces the uploaded charges of the same month and kind, and keeps typed-in ones", async () => {
      const OCT = "2026-10-01";
      const up = (rows: unknown[]) =>
        svc(() =>
          q("select public.fin_doctor_charges_replace_upload($1, $2::jsonb, $3) as r", [
            orgA,
            JSON.stringify(rows),
            u.fin,
          ]),
        ).then((x) => x.rows[0].r as { added: number; removed: number });
      await svc(() =>
        q(
          "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount, source) values ($1, $2, 'SYN-0001', 'lab', 10, 'manual')",
          [orgA, OCT],
        ),
      );
      const row = (doctor: string, kind: string, amount: number) => ({
        month: OCT,
        doctor_dha_id: doctor,
        kind,
        amount,
        reference: null,
        note: null,
      });
      expect(await up([row("SYN-0001", "lab", 100), row("SYN-0002", "lab", 200)])).toEqual({
        added: 2,
        removed: 0,
      });
      expect(await up([row("SYN-0001", "referral", 50)])).toEqual({ added: 1, removed: 0 });
      expect(await up([row("SYN-0001", "lab", 150)])).toEqual({ added: 1, removed: 2 });
      const left = (
        await svc(() =>
          q(
            "select kind, source, amount::float8 as amount from public.fin_doctor_charges where org_id = $1 and month = $2 order by kind, source",
            [orgA, OCT],
          ),
        )
      ).rows;
      expect(left).toEqual([
        { kind: "lab", source: "manual", amount: 10 },
        { kind: "lab", source: "upload", amount: 150 },
        { kind: "referral", source: "upload", amount: 50 },
      ]);
      // all or nothing: one bad row (a locked month) rolls the whole file back
      await rejects(
        up([row("SYN-0001", "lab", 1), { ...row("SYN-0001", "lab", 1), month: AUG }]),
        /locked/,
      );
      expect(
        (
          await one<{ n: number }>(
            "select count(*)::int as n from public.fin_doctor_charges where org_id = $1 and month = $2",
            [orgA, OCT],
          )
        ).n,
      ).toBe(3);
      expect(
        (
          await fails(
            "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, 'syn-1', 'lab', 1)",
            [orgA, OCT],
          )
        )?.code,
      ).toBe("23514");
      expect(
        (
          await fails(
            "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, 'SYN-1', 'lab', 0)",
            [orgA, OCT],
          )
        )?.code,
      ).toBe("23514");
      expect(
        (
          await fails(
            "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount) values ($1, $2, 'SYN-1', 'rent', 1)",
            [orgA, OCT],
          )
        )?.code,
      ).toBe("23514");
    });
  });

  it("the functions are service-role only", async () => {
    const fns = [
      "fin_revshare_inputs",
      "fin_revshare_scheme_save",
      "fin_revshare_scheme_step",
      "fin_doctor_charges_replace_upload",
      "fin_revshare_store_draft",
      "fin_revshare_run_step",
      "fin_revshare_post",
      "fin_revshare_record_payment",
      "fin_revshare_liability",
    ];
    const { rows } = await q(
      `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('service_role', p.oid, 'execute') as svc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any ($1)`,
      [fns],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...fns].sort());
    for (const r of rows)
      expect([r.name, r.auth, r.anon, r.svc]).toEqual([r.name, false, false, true]);
  });

  it("the grant block gives Finance view and manage, the Finance Manager verify and the CEO view and approve, idempotently, and nothing else", async () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261101000100_finance_revenue_share.sql"),
      "utf8",
    );
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
    expect(block, "the grant block was not found").toBeTruthy();
    const orgC = await createOrg(c, "Org C", "org-c", u.alice);
    const names = ["Finance", "Finance Manager", "CEO", "Medical Director", "Billing", "Insurance", "Cost / Payroll"];
    await svc(async () => {
      for (const name of names)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '[\"finance.view\"]'::jsonb, true) on conflict (org_id, name) do update set permissions = excluded.permissions",
          [orgC, name],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Custom finance', '', '[\"finance.view\"]'::jsonb, false)",
        [orgC],
      );
    });
    const read = async () =>
      Object.fromEntries(
        (
          await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
        ).rows.map((r) => [
          r.name,
          (r.permissions as string[]).filter((p) => p.startsWith("finance.revshare.")).sort(),
        ]),
      );
    await svc(() => q(block!));
    const first = await read();
    expect(first.Finance).toEqual(["finance.revshare.manage", "finance.revshare.view"]);
    expect(first["Finance Manager"]).toEqual(["finance.revshare.verify"]);
    expect(first.CEO).toEqual(["finance.revshare.approve", "finance.revshare.view"]);
    for (const n of [
      "Medical Director",
      "Billing",
      "Insurance",
      "Cost / Payroll",
      "Custom finance",
    ])
      expect(first[n], n).toEqual([]);
    await svc(() => q(block!));
    expect(await read()).toEqual(first);
    // an existing workspace then runs the Finance Manager sync, which adds the Finance keys to the checker
    await svc(() =>
      q(
        readFileSync(
          join(process.cwd(), "supabase/migrations/20261102000100_finance_manager_sync.sql"),
          "utf8",
        ),
      ),
    );
    const synced = await read();
    for (const preset of FINANCE_ROLES)
      expect(
        preset.permissions.filter((p) => p.startsWith("finance.revshare.")).sort(),
        preset.name,
      ).toEqual(synced[preset.name] ?? []);
  });
});
