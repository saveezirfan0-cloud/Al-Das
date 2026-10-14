/**
 * Slice 20K: fin_billing_mix and fin_revenue_trend. Service-role only; per-doctor and clinic aggregation from current
 * invoice lines (deleted invoices, superseded lines, other dates and other orgs excluded; items without a category are
 * Unmapped); the configured doctor basis; the same period last year (weeks 52 weeks back, months by calendar month,
 * 29 Feb onto 28 Feb, cut to the range, flagged when the records do not reach back that far).
 * Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeMix, parseBillingMix, parseTrend } from "@/lib/finance/billing-mix";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type Line = [item: string, net: number, current?: boolean];
type Inv = {
  no: string;
  date: string;
  doctor?: string | null;
  doctorName?: string | null;
  department?: string | null;
  performing?: string | null;
  type: string;
  pin: string;
  branch: string;
  deleted?: boolean;
  lines?: Line[];
  net?: number;
};

describe.skipIf(!TEST_DATABASE_URL)("Finance billing mix and trends (slice 20K)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  const addInvoice = async (org: string, i: Inv) => {
    const lines = i.lines ?? [];
    const net = i.net ?? lines.filter((l) => l[2] !== false).reduce((a, l) => a + l[1], 0);
    const { rows } = await q(
      `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, doctor_dha_id, doctor_name,
         department, performing_doctor_dha_id, inv_type, net, total, patient_pin, record_hash, is_deleted)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, 'h', $12) returning id`,
      [
        org,
        i.no,
        i.date,
        i.branch,
        i.doctor ?? null,
        i.doctorName ?? null,
        i.department ?? null,
        i.performing ?? null,
        i.type,
        net,
        i.pin,
        i.deleted ?? false,
      ],
    );
    let n = 0;
    for (const [item, lineNet, current] of lines) {
      n++;
      await q(
        `insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, line_net, is_current)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [org, rows[0].id, `${i.no}|${item}|${n}`, n, item, lineNet, current ?? true],
      );
    }
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice-mix@example.test");
    const bob = await createAuthUser(c, "bob-mix@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await svc(async () => {
      for (const org of [orgA, orgB]) {
        await q(
          `insert into public.fin_ref_services (org_id, item_code, service_category) values
             ($1, 'C1', 'Consultation'), ($1, 'L1', 'Lab'), ($1, 'R1', 'Radiology'), ($1, 'X1', 'Unmapped'), ($1, 'B1', ' ')
           on conflict (org_id, item_code) do update set service_category = excluded.service_category`,
          [org],
        );
      }
      await q(
        "insert into public.fin_ref_doctors (org_id, dha_id, name, department) values ($1, 'SYN-D1', 'Dr Synthetic Alpha', 'Family Medicine')",
        [orgA],
      );
      const A: Inv[] = [
        // September 2026: the period under test
        {
          no: "I1",
          date: "2026-09-02",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-1",
          branch: "P",
          lines: [
            ["C1", 300],
            ["L1", 200],
            ["C1", 777, false],
          ],
        },
        {
          no: "I2",
          date: "2026-09-15",
          doctor: "SYN-D1",
          doctorName: "Dr Invoice Alpha",
          performing: "SYN-D2",
          type: "INSURANCE",
          pin: "PIN-2",
          branch: "P",
          lines: [
            ["C1", 400],
            ["R1", 600],
            ["L1", 100],
          ],
        },
        {
          no: "I3",
          date: "2026-09-20",
          doctor: "SYN-D1",
          type: "INSURANCE",
          pin: "PIN-1",
          branch: "G",
          lines: [
            ["Z9", 30],
            ["B1", 20],
          ],
        },
        {
          no: "I4",
          date: "2026-09-10",
          doctor: "SYN-D2",
          doctorName: "Dr Synthetic Bravo",
          department: "Orthopaedics",
          type: "SELF PAID",
          pin: "PIN-3",
          branch: "G",
          lines: [
            ["C1", 250],
            ["X1", 150],
          ],
        },
        {
          no: "I5",
          date: "2026-09-11",
          doctor: null,
          type: "CORPORATE",
          pin: "PIN-4",
          branch: "P",
          lines: [["L1", 80]],
        },
        // noise: deleted, outside the range
        {
          no: "I6",
          date: "2026-09-12",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-9",
          branch: "P",
          deleted: true,
          lines: [["C1", 9999]],
        },
        {
          no: "I8",
          date: "2026-10-01",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-1",
          branch: "P",
          lines: [["C1", 1000]],
        },
        // last year (invoice net only; the trend does not read lines)
        {
          no: "LY1",
          date: "2025-09-01",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-1",
          branch: "P",
          net: 900,
        },
        {
          no: "LY2",
          date: "2025-09-16",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-1",
          branch: "G",
          net: 200,
        },
        {
          no: "LY3",
          date: "2025-09-28",
          doctor: "SYN-D2",
          type: "INSURANCE",
          pin: "PIN-5",
          branch: "P",
          net: 100,
        },
        {
          no: "LYDEL",
          date: "2025-09-15",
          doctor: "SYN-D2",
          type: "INSURANCE",
          pin: "PIN-5",
          branch: "P",
          net: 5000,
          deleted: true,
        },
        {
          no: "LY4",
          date: "2025-10-05",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-2",
          branch: "P",
          net: 300,
        },
        {
          no: "LY5",
          date: "2025-10-20",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-2",
          branch: "P",
          net: 444,
        },
        // leap day: 29 Feb 2028 lands on 28 Feb 2029; 1 Mar 2028 does not
        {
          no: "LEAP",
          date: "2028-02-29",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-6",
          branch: "P",
          net: 29,
        },
        {
          no: "MAR",
          date: "2028-03-01",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-6",
          branch: "P",
          net: 31,
        },
        {
          no: "FEB29",
          date: "2029-02-10",
          doctor: "SYN-D1",
          type: "SELF PAID",
          pin: "PIN-6",
          branch: "P",
          net: 70,
        },
      ];
      for (const i of A) await addInvoice(orgA, i);
      await addInvoice(orgB, {
        no: "B1",
        date: "2026-09-02",
        doctor: "SYN-D1",
        type: "SELF PAID",
        pin: "PIN-1",
        branch: "P",
        lines: [["C1", 5000]],
      });
      await addInvoice(orgB, {
        no: "B2",
        date: "2025-09-02",
        doctor: "SYN-D1",
        type: "SELF PAID",
        pin: "PIN-1",
        branch: "P",
        net: 7000,
      });
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const mixFor = async (from: string, to: string, branch: string | null = null) =>
    svc(
      async () =>
        (await q("select public.fin_billing_mix($1, $2, $3, $4) as r", [orgA, from, to, branch]))
          .rows[0].r,
    );
  const trendFor = async (from: string, to: string, grain: string, branch: string | null = null) =>
    svc(
      async () =>
        (
          await q("select public.fin_revenue_trend($1, $2, $3, $4, $5) as r", [
            orgA,
            from,
            to,
            grain,
            branch,
          ])
        ).rows[0].r,
    );

  it("both functions are executable by the service role only", async () => {
    const { rows } = await q(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              p.prosecdef as definer
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('fin_billing_mix', 'fin_revenue_trend') order by 1`,
    );
    expect(rows).toEqual([
      { name: "fin_billing_mix", anon: false, auth: false, svc: true, definer: true },
      { name: "fin_revenue_trend", anon: false, auth: false, svc: true, definer: true },
    ]);
    await expect(
      asUser(c, alice, () =>
        q("select public.fin_billing_mix($1, '2026-09-01', '2026-09-30')", [orgA]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(c, alice, () =>
        q("select public.fin_revenue_trend($1, '2026-09-01', '2026-09-30', 'month')", [orgA]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  describe("fin_billing_mix", () => {
    it("aggregates per doctor and for the clinic from current lines of live invoices in the range and org", async () => {
      const r = await mixFor("2026-09-01", "2026-09-30");
      expect(JSON.stringify(r)).not.toMatch(/PIN-/);
      const mix = parseBillingMix(r);
      expect(mix.rows.map((x) => x.doctorId)).toEqual(["SYN-D1", "SYN-D2", null]);
      expect(mix.rows[0]).toEqual({
        doctorId: "SYN-D1",
        doctorName: "Dr Synthetic Alpha",
        department: "Family Medicine",
        net: 1650,
        invoices: 3,
        lines: 7,
        patients: 2,
        payer: {
          insurance: { net: 1150, invoices: 2 },
          self_pay: { net: 500, invoices: 1 },
          other: { net: 0, invoices: 0 },
        },
        categories: { Consultation: 700, Lab: 300, Radiology: 600, Unmapped: 50 },
      });
      expect(mix.rows[1]).toMatchObject({
        doctorName: "Dr Synthetic Bravo",
        department: "Orthopaedics",
        net: 400,
        patients: 1,
        categories: { Consultation: 250, Unmapped: 150 },
        payer: { self_pay: { net: 400, invoices: 1 } },
      });
      expect(mix.rows[2]).toMatchObject({
        doctorName: null,
        net: 80,
        categories: { Lab: 80 },
        payer: { other: { net: 80, invoices: 1 } },
      });
      expect(mix.clinic).toMatchObject({
        doctorId: null,
        net: 2130,
        invoices: 5,
        lines: 10,
        patients: 4,
        categories: { Consultation: 950, Lab: 380, Radiology: 600, Unmapped: 200 },
        payer: {
          insurance: { net: 1150, invoices: 2 },
          self_pay: { net: 900, invoices: 2 },
          other: { net: 80, invoices: 1 },
        },
      });
    });

    it("feeds the pure view: shares, revenue per patient and the difference from the clinic", async () => {
      const v = describeMix(parseBillingMix(await mixFor("2026-09-01", "2026-09-30")));
      expect(v.categories).toEqual(["Consultation", "Radiology", "Lab", "Unmapped"]);
      expect(v.rows[0].arpp).toBe(825);
      expect(v.rows[0].insuranceShare).toBeCloseTo(1150 / 1650, 10);
      expect(v.rows[0].difference.Radiology).toBe(
        Math.round((600 / 1650 - 600 / 2130) * 1000) / 10,
      );
    });

    it("filters by branch", async () => {
      const mix = parseBillingMix(await mixFor("2026-09-01", "2026-09-30", "G"));
      expect(mix.rows.map((x) => [x.doctorId, x.net])).toEqual([
        ["SYN-D2", 400],
        ["SYN-D1", 50],
      ]);
      expect(mix.clinic!.net).toBe(450);
    });

    it("counts the performing doctor when that is the configured basis, naming them only from their own invoices", async () => {
      await svc(() =>
        q(
          `insert into public.fin_ref_finance_settings (org_id, doctor_basis) values ($1, 'performing')
           on conflict (org_id) do update set doctor_basis = excluded.doctor_basis`,
          [orgA],
        ),
      );
      try {
        const mix = parseBillingMix(await mixFor("2026-09-01", "2026-09-30"));
        expect(mix.doctorBasis).toBe("performing");
        const d2 = mix.rows.find((x) => x.doctorId === "SYN-D2")!;
        expect(d2).toMatchObject({ net: 1500, invoices: 2, doctorName: "Dr Synthetic Bravo" });
        expect(mix.rows.find((x) => x.doctorId === "SYN-D1")!.net).toBe(550);
        expect(mix.clinic!.net).toBe(2130);
      } finally {
        await svc(() =>
          q("update public.fin_ref_finance_settings set doctor_basis = null where org_id = $1", [
            orgA,
          ]),
        );
      }
    });

    it("returns no clinic row and no doctors for an empty period, and refuses a reversed one", async () => {
      expect(await mixFor("2030-01-01", "2030-01-31")).toEqual({
        doctor_basis: null,
        clinic: null,
        rows: [],
      });
      await expect(mixFor("2026-09-30", "2026-09-01")).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("fin_revenue_trend", () => {
    it("gives invoice net, invoices and patients per month with the same months last year, cut to the range", async () => {
      const t = await trendFor("2026-09-01", "2026-10-12", "month");
      expect(JSON.stringify(t)).not.toMatch(/PIN-/);
      expect(t).toEqual({
        grain: "month",
        history_from: "2025-09-01",
        rows: [
          {
            period: "2026-09-01",
            from: "2026-09-01",
            to: "2026-09-30",
            net: 2130,
            invoices: 5,
            patients: 4,
            ly_net: 1200,
            ly_invoices: 3,
            ly_patients: 2,
            ly_covered: true,
          },
          // October is cut at the 12th, and so is last year: 20 Oct 2025 is left out
          {
            period: "2026-10-01",
            from: "2026-10-01",
            to: "2026-10-12",
            net: 1000,
            invoices: 1,
            patients: 1,
            ly_net: 300,
            ly_invoices: 1,
            ly_patients: 1,
            ly_covered: true,
          },
        ],
      });
      const parsed = parseTrend(t);
      expect(parsed.rows.map((r) => r.changePct)).toEqual([77.5, 233.3]);
    });

    it("compares weeks with the week 52 weeks earlier", async () => {
      const t = await trendFor("2026-09-07", "2026-09-20", "week");
      expect(t.rows).toEqual([
        {
          period: "2026-09-07",
          from: "2026-09-07",
          to: "2026-09-13",
          net: 480,
          invoices: 2,
          patients: 2,
          ly_net: 0,
          ly_invoices: 0,
          ly_patients: 0,
          ly_covered: true,
        },
        {
          period: "2026-09-14",
          from: "2026-09-14",
          to: "2026-09-20",
          net: 1150,
          invoices: 2,
          patients: 2,
          ly_net: 200,
          ly_invoices: 1,
          ly_patients: 1,
          ly_covered: true,
        },
      ]);
    });

    it("flags last year as not on record before the first invoice, and filters by branch", async () => {
      const t = await trendFor("2025-09-01", "2025-10-31", "month");
      expect(t.rows.map((r: { ly_covered: boolean }) => r.ly_covered)).toEqual([false, false]);
      expect(parseTrend(t).rows.every((r) => r.lastYear === null && r.changePct === null)).toBe(
        true,
      );
      const p = await trendFor("2026-09-01", "2026-09-30", "month", "P");
      expect(p.rows[0]).toMatchObject({ net: 1680, invoices: 3, ly_net: 1000, ly_invoices: 2 });
    });

    it("puts 29 February on 28 February a year later, and not 1 March", async () => {
      const t = await trendFor("2029-02-01", "2029-02-28", "month");
      expect(t.rows).toEqual([
        {
          period: "2029-02-01",
          from: "2029-02-01",
          to: "2029-02-28",
          net: 70,
          invoices: 1,
          patients: 1,
          ly_net: 29,
          ly_invoices: 1,
          ly_patients: 1,
          ly_covered: true,
        },
      ]);
    });

    it("refuses an unknown grain, a reversed range and a range over three years", async () => {
      await expect(trendFor("2026-09-01", "2026-09-30", "day")).rejects.toMatchObject({
        code: "22023",
      });
      await expect(trendFor("2026-09-30", "2026-09-01", "month")).rejects.toMatchObject({
        code: "22023",
      });
      await expect(trendFor("2020-01-01", "2026-09-30", "week")).rejects.toMatchObject({
        code: "22023",
      });
    });
  });
});
