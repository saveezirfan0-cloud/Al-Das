/**
 * Exception rules engine (fin_run_exception_rules): each rule opens exactly the right entities,
 * closes them when the cause clears, respects thresholds and guards, and is idempotent.
 * Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

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

describe.skipIf(!TEST_DATABASE_URL)("Finance exception rules", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let admin: string;
  let billing: string;
  let insurance: string;

  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const run = async (org = orgA) =>
    (await q("select public.fin_run_exception_rules($1) as r", [org])).rows[0].r as Record<
      string,
      { opened?: number; closed?: number; skipped?: boolean }
    >;
  const open = (rule: string, org = orgA) =>
    q(
      "select entity_key from public.ops_exceptions where org_id = $1 and rule_code = $2 and status in ('open','in_progress') order by 1",
      [org, rule],
    ).then((r) => r.rows.map((x) => x.entity_key as string));

  async function invoice(
    no: string,
    o: {
      daysAgo?: number;
      type?: string;
      net?: number;
      deleted?: boolean;
      branch?: string | null;
      appt?: string | null;
      org?: string;
      date?: string;
    } = {},
  ) {
    const { rows } = await q(
      `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, inv_type, net, total, is_deleted, appointment_id, record_hash)
       values ($1, $2, coalesce($3::date, current_date - $4::int), $5, $6, $7, $7, $8, $9, 'h') returning id`,
      [
        o.org ?? orgA,
        no,
        o.date ?? null,
        o.daysAgo ?? 40,
        o.branch === undefined ? "P" : o.branch,
        o.type ?? "INSURANCE",
        o.net ?? 100,
        o.deleted ?? false,
        o.appt ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function claim(n: string, o: Record<string, unknown> = {}) {
    const f = {
      invoice_no: "ADMC/C/1",
      transaction_date: null as string | null,
      net: 100,
      remitted: 0,
      rejected: 0,
      resubmission_count: 0,
      settled: false,
      write_off: 0,
      write_off_status: "",
      match_reason: "ok",
      matched_invoice_id: null as string | null,
      last_remittance_date: null as string | null,
      ...o,
    };
    await q(
      `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, transaction_date, cpt_code, net, initial_net, remitted, rejected,
         resubmission_count, settled, write_off, write_off_status, match_reason, match_status, matched_invoice_id, last_remittance_date)
       values ($1,$2,$3, coalesce($4::date, current_date - 90),'99213',$5,$5,$6,$7,$8,$9,$10,$11,$12,'unmatched',$13,$14::date)`,
      [
        orgA,
        n,
        f.invoice_no,
        f.transaction_date,
        f.net,
        f.remitted,
        f.rejected,
        f.resubmission_count,
        f.settled,
        f.write_off,
        f.write_off_status,
        f.match_reason,
        f.matched_invoice_id,
        f.last_remittance_date,
      ],
    );
  }

  const freshFile = () =>
    q(
      "insert into public.fin_raw_diligence_files (org_id, storage_path, file_sha256, status, committed_at) values ($1,'p',gen_random_uuid()::text,'committed', now() - interval '2 days')",
      [orgA],
    );
  const drained = (balance = 0) =>
    q(
      `insert into public.fin_raw_unite_batches (org_id, from_date, to_date, count_requested, record_count, balance_in_range, process_status, processed_at, payload)
       values ($1,'2026-01-01','2026-10-09',50,0,$2,'processed',now(),'{}')`,
      [orgA, balance],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    admin = await createAuthUser(c, "rules-admin@example.test");
    billing = await createAuthUser(c, "rules-billing@example.test");
    insurance = await createAuthUser(c, "rules-ins@example.test");
    const other = await createAuthUser(c, "rules-other@example.test");
    orgA = await createOrg(c, "Org A", "org-a", admin);
    orgB = await createOrg(c, "Org B", "org-b", other);
    await svc(async () => {
      for (const r of FINANCE_ROLES.filter((x) => ["Billing", "Insurance"].includes(x.name)))
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1,$2,$3,$4::jsonb,true)",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      for (const [u, role] of [
        [billing, "Billing"],
        [insurance, "Insurance"],
      ] as const)
        await q(
          "insert into public.memberships (org_id, user_id, role_id) select $1,$2,id from public.roles where org_id=$1 and name=$3",
          [orgA, u, role],
        );
    });
  });
  beforeEach(async () => {
    await svc(async () => {
      await q(
        "truncate public.ins_claim_activities, public.fin_raw_diligence_files, public.fin_raw_unite_batches, public.fin_invoices, public.ops_exceptions cascade",
      );
      await q("delete from public.appointments");
      await q("update public.fin_ref_exception_rules set active = true, due_days = 7");
      await q(
        "update public.fin_ref_exception_rules set threshold_days = 30 where rule_code = 'E01'",
      );
      await q(
        "update public.fin_ref_exception_rules set threshold_days = 14 where rule_code = 'E04'",
      );
      await q(
        "update public.fin_ref_exception_rules set threshold_days = 60 where rule_code = 'E05'",
      );
    });
  });
  afterAll(async () => {
    await c.end();
  });

  describe("E01: insurance invoice without a claim", () => {
    it("opens for old insurance invoices only, and closes when a claim appears", () =>
      svc(async () => {
        await freshFile();
        await invoice("OLD-INS", { daysAgo: 40 });
        await invoice("YOUNG-INS", { daysAgo: 10 });
        await invoice("SELF", { daysAgo: 40, type: "SELF PAID" });
        await invoice("DELETED", { daysAgo: 40, deleted: true });
        await invoice("ZERO", { daysAgo: 40, net: 0 });
        await run();
        expect(await open("E01")).toEqual(["OLD-INS"]);
        await claim("CA-1", { invoice_no: " old-ins " }); // matched by normalised number even before matching ran
        const res = await run();
        expect(res.E01).toMatchObject({ opened: 0, closed: 1 });
        expect(await open("E01")).toEqual([]);
      }));

    it("is skipped, and leaves existing exceptions alone, when claim data is stale", () =>
      svc(async () => {
        await invoice("OLD-INS", { daysAgo: 40 });
        expect((await run()).E01).toEqual({ skipped: true }); // no committed file at all
        await q(
          "insert into public.fin_raw_diligence_files (org_id, storage_path, file_sha256, status, committed_at) values ($1,'p',gen_random_uuid()::text,'committed', now() - interval '20 days')",
          [orgA],
        );
        expect((await run()).E01).toEqual({ skipped: true });
        expect(await open("E01")).toEqual([]);
      }));

    it("uses the threshold from the rules table and respects inactive rules", () =>
      svc(async () => {
        await freshFile();
        await invoice("A", { daysAgo: 12 });
        await q(
          "update public.fin_ref_exception_rules set threshold_days = 10 where org_id = $1 and rule_code = 'E01'",
          [orgA],
        );
        await run();
        expect(await open("E01")).toEqual(["A"]);
        await q(
          "update public.fin_ref_exception_rules set active = false where org_id = $1 and rule_code = 'E01'",
          [orgA],
        );
        await q("delete from public.ops_exceptions");
        expect((await run()).E01).toBeUndefined();
        expect(await open("E01")).toEqual([]);
      }));
  });

  describe("E02 / E03: unmatched and mismatched claims", () => {
    it("E02 needs a drained capture; E03 does not", () =>
      svc(async () => {
        await claim("NOINV", { match_reason: "no_invoice" });
        await claim("DEL", { match_reason: "invoice_deleted" });
        await claim("AMT", { match_reason: "amount_mismatch" });
        await claim("AMB", { match_reason: "ambiguous" });
        await claim("OK", { match_reason: "ok" });
        await run();
        expect(await open("E02")).toEqual([]); // capture has not run: invoices may simply be missing
        expect(await open("E03")).toEqual(["AMB", "AMT"]);

        await drained(5); // still draining
        await run();
        expect(await open("E02")).toEqual([]);
        await drained(0);
        await run();
        expect(await open("E02")).toEqual(["DEL", "NOINV"]);

        await q(
          "update public.ins_claim_activities set match_reason = 'ok' where claim_activity_number = 'NOINV'",
        );
        await q(
          "update public.ins_claim_activities set match_reason = 'ok' where claim_activity_number = 'AMT'",
        );
        const res = await run();
        expect(res.E02).toMatchObject({ closed: 1 });
        expect(await open("E02")).toEqual(["DEL"]);
        expect(await open("E03")).toEqual(["AMB"]);
      }));
  });

  describe("E04: rejected and not resubmitted", () => {
    it("applies every exclusion at the boundary", () =>
      svc(async () => {
        await claim("HIT", {
          rejected: 40,
          last_remittance_date: new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10),
        });
        await claim("YOUNG", {
          rejected: 40,
          last_remittance_date: new Date(Date.now() - 14 * 86_400_000 + 86_400_000)
            .toISOString()
            .slice(0, 10),
        });
        await claim("EXACT", {
          rejected: 40,
          last_remittance_date: new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10),
        });
        await claim("RESUB", {
          rejected: 40,
          resubmission_count: 1,
          last_remittance_date: "2026-01-01",
        });
        await claim("SETTLED", { rejected: 40, settled: true, last_remittance_date: "2026-01-01" });
        await claim("WRITEOFF", {
          rejected: 40,
          write_off: 40,
          write_off_status: "Approved",
          last_remittance_date: "2026-01-01",
        });
        await claim("NOREJECT", { rejected: 0, last_remittance_date: "2026-01-01" });
        await run();
        expect(await open("E04")).toEqual(["EXACT", "HIT"]);
        await q(
          "update public.ins_claim_activities set resubmission_count = 1 where claim_activity_number = 'HIT'",
        );
        await run();
        expect(await open("E04")).toEqual(["EXACT"]);
      }));
  });

  describe("E05: outstanding balance", () => {
    it("sums outstanding per invoice and ages from the oldest outstanding claim", () =>
      svc(async () => {
        const inv = await invoice("INV-1", { daysAgo: 100 });
        await claim("C1", {
          invoice_no: "INV-1",
          matched_invoice_id: inv,
          net: 100,
          remitted: 60,
          transaction_date: new Date(Date.now() - 80 * 86_400_000).toISOString().slice(0, 10),
        });
        await claim("C2", {
          invoice_no: "inv-1",
          matched_invoice_id: inv,
          net: 50,
          remitted: 0,
          transaction_date: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
        });
        await claim("PAID", { invoice_no: "INV-2", net: 100, remitted: 100 });
        await claim("YOUNG", {
          invoice_no: "INV-3",
          net: 100,
          remitted: 0,
          transaction_date: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
        });
        await claim("WO", {
          invoice_no: "INV-4",
          net: 100,
          remitted: 0,
          write_off: 100,
          write_off_status: "approved",
        });
        await run();
        expect(await open("E05")).toEqual(["INV-1"]);
        const d = (await q("select detail from public.ops_exceptions where rule_code = 'E05'"))
          .rows[0].detail;
        expect(Number(d.outstanding)).toBe(90);
        await q(
          "update public.ins_claim_activities set remitted = net where invoice_no ilike 'inv-1'",
        );
        await run();
        expect(await open("E05")).toEqual([]);
      }));
  });

  describe("E07: unknown clinic", () => {
    it("opens for unmapped invoices and closes once a branch is set", () =>
      svc(async () => {
        await invoice("NOBRANCH", { branch: null });
        await invoice("OK");
        await run();
        expect(await open("E07")).toEqual(["NOBRANCH"]);
        await q(
          "update public.fin_invoices set branch_code = 'M' where inv_display_number = 'NOBRANCH'",
        );
        await run();
        expect(await open("E07")).toEqual([]);
      }));
  });

  describe("E08: appointment not found", () => {
    const appt = (id: string, day: string) =>
      q(
        `insert into public.appointments (org_id, source, external_id, starts_at, ends_at) values ($1,'unite',$2,$3::timestamptz,$3::timestamptz + interval '30 minutes')`,
        [orgA, id, day],
      );

    it("is skipped until Unite appointments have been synced", () =>
      svc(async () => {
        await invoice("I1", { date: "2026-03-05", appt: "A-1" });
        expect((await run()).E08).toEqual({ skipped: true });
      }));

    it("flags unresolved ids after the first synced appointment, never earlier history, and closes when synced", () =>
      svc(async () => {
        await appt("A-EXISTS", "2026-03-01T09:00:00Z");
        await invoice("RESOLVED", { date: "2026-03-05", appt: "A-EXISTS" });
        await invoice("MISSING", { date: "2026-03-06", appt: " A-MISSING " });
        await invoice("DIRECT", { date: "2026-03-06", appt: null });
        await invoice("BLANK", { date: "2026-03-06", appt: "  " });
        await invoice("BEFORE", { date: "2026-02-10", appt: "A-OLD" });
        await run();
        expect(await open("E08")).toEqual(["MISSING"]);
        await appt("A-MISSING", "2026-03-06T09:00:00Z");
        await run();
        expect(await open("E08")).toEqual([]);
      }));

    it("reports the resolution rate", () =>
      svc(async () => {
        await appt("A-1", "2026-03-01T09:00:00Z");
        await invoice("R", { daysAgo: 5, appt: "A-1" });
        await invoice("U", { daysAgo: 5, appt: "A-X" });
        await invoice("DIRECT", { daysAgo: 5, appt: null });
        await q(
          "update public.appointments set starts_at = now() - interval '30 days', ends_at = now() - interval '30 days' + interval '30 minutes'",
        );
        const { rows } = await q("select * from public.fin_appointment_resolution($1, 60)", [orgA]);
        expect([Number(rows[0].with_id), Number(rows[0].resolved)]).toEqual([2, 1]);
      }));
  });

  describe("E09: invoice number gaps", () => {
    it("opens one exception per range once capture has drained, leaves capture exceptions alone, closes when filled", () =>
      svc(async () => {
        await invoice("ADMC/C/90001", { date: "2026-03-01" });
        await invoice("ADMC/C/90004", { date: "2026-03-01" });
        await q("select public.fin_open_exception($1,'E09','batch','capture:lost_response')", [
          orgA,
        ]);
        await run();
        expect(await open("E09")).toEqual(["capture:lost_response"]); // not drained: no gap exceptions yet
        await drained(0);
        await run();
        expect(await open("E09")).toEqual(["capture:lost_response", "gap:ADMC/C/:90002-90003"]);
        await invoice("ADMC/C/90002", { date: "2026-03-01" });
        await invoice("ADMC/C/90003", { date: "2026-03-01" });
        await run();
        expect(await open("E09")).toEqual(["capture:lost_response"]);
      }));
  });

  describe("engine behaviour", () => {
    it("is idempotent", () =>
      svc(async () => {
        await freshFile();
        await invoice("A");
        await invoice("B", { branch: null });
        await claim("C1", { match_reason: "amount_mismatch" });
        await run();
        const before = (await q("select count(*)::int n from public.ops_exceptions")).rows[0].n;
        const again = await run();
        expect((await q("select count(*)::int n from public.ops_exceptions")).rows[0].n).toBe(
          before,
        );
        for (const r of Object.values(again)) expect(r.opened ?? 0).toBe(0);
      }));

    it("sets the due date from the rule and never leaks patient fields into detail", () =>
      svc(async () => {
        await freshFile();
        await q(
          "update public.fin_ref_exception_rules set due_days = 3 where org_id = $1 and rule_code = 'E01'",
          [orgA],
        );
        await invoice("A");
        await run();
        const { rows } = await q(
          "select due_date = current_date + 3 as ok, detail from public.ops_exceptions where rule_code = 'E01'",
        );
        expect(rows[0].ok).toBe(true);
        expect(Object.keys(rows[0].detail).sort()).toEqual(["days", "inv_type", "net"]);
      }));

    it("caps new exceptions per run and finishes the rest next time", async () => {
      await svc(async () => {
        for (let i = 0; i < 5; i++) await invoice(`N-${i}`, { branch: null });
      });
      // app.fin_reconcile is internal (not granted to any API role): call it as the table owner
      await q(
        "select app.fin_reconcile($1,'E07',(select jsonb_agg(jsonb_build_object('entity_type','invoice','entity_key',inv_display_number)) from public.fin_invoices), null, 2)",
        [orgA],
      );
      expect((await open("E07")).length).toBe(2);
      await svc(async () => {
        await run();
      });
      expect((await open("E07")).length).toBe(5);
    });

    it("keeps organisations apart", () =>
      svc(async () => {
        await freshFile();
        await invoice("A");
        await run(orgB);
        expect(await open("E01", orgB)).toEqual([]);
        expect(await open("E01")).toEqual([]);
        await run(orgA);
        expect(await open("E01")).toEqual(["A"]);
        expect(await open("E01", orgB)).toEqual([]);
      }));
  });

  describe("access", () => {
    it("the engine functions are closed to members", async () => {
      await asUser(c, admin, async () => {
        await expect(q("select public.fin_run_exception_rules($1)", [orgA])).rejects.toThrow(
          /permission denied/,
        );
        await expect(q("select * from public.fin_rules_context($1)", [orgA])).rejects.toThrow(
          /permission denied/,
        );
      });
    });

    it("v_fin_invoice_list shows claim aggregates to invoice viewers only, within their org", async () => {
      await svc(async () => {
        const inv = await invoice("LIST-1");
        await invoice("LIST-B", { org: orgB });
        await claim("L1", {
          invoice_no: "LIST-1",
          matched_invoice_id: inv,
          net: 100,
          remitted: 60,
          rejected: 40,
        });
        await q(
          "insert into public.fin_payments (org_id, invoice_id, payment_key, paid, is_current) values ($1,$2,'k1',25,true)",
          [orgA, inv],
        );
      });
      await asUser(c, billing, async () => {
        const { rows } = await q(
          "select inv_display_number, claim_count, claimed, remitted, rejected, paid from public.v_fin_invoice_list",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ inv_display_number: "LIST-1", claim_count: "1" });
        expect([
          Number(rows[0].claimed),
          Number(rows[0].remitted),
          Number(rows[0].rejected),
          Number(rows[0].paid),
        ]).toEqual([100, 60, 40, 25]);
        expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(0); // no claim rows for Billing
      });
      await asUser(c, insurance, async () => {
        expect(await count(c, "select 1 from public.v_fin_invoice_list")).toBe(0);
      });
    });

    it("v_fin_revenue_monthly groups current lines by month and is gated by finance.view", async () => {
      await svc(async () => {
        const inv1 = await invoice("REV-1", { date: "2026-03-05", type: "SELF PAID" });
        const inv2 = await invoice("REV-2", { date: "2026-03-20", type: "SELF PAID" });
        await invoice("REV-DEL", { date: "2026-03-21", deleted: true });
        for (const [inv, key, net] of [
          [inv1, "REV-1|A|1", 60],
          [inv2, "REV-2|A|1", 40],
        ] as const)
          await q(
            "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, line_gross, line_discount, line_net, vat) values ($1,$2,$3,1,'A',$4,0,$4,0)",
            [orgA, inv, key, net],
          );
      });
      await asUser(c, admin, async () => {
        const { rows } = await q(
          "select month::text m, branch_code, net from public.v_fin_revenue_monthly",
        );
        expect(rows).toHaveLength(1);
        expect([rows[0].m, rows[0].branch_code, Number(rows[0].net)]).toEqual([
          "2026-03-01",
          "P",
          100,
        ]);
      });
      await asUser(c, billing, async () => {
        expect(await count(c, "select 1 from public.v_fin_revenue_monthly")).toBe(0); // invoice viewers are not report viewers
      });
    });

    it("digests are off by default", async () => {
      const { rows } = await q(
        "select digest_enabled from public.fin_capture_settings where org_id = $1",
        [orgA],
      );
      expect(rows[0].digest_enabled).toBe(false);
    });

    it("an owner can assign, comment on and close an exception in their own queue", async () => {
      let id = "";
      await svc(async () => {
        await freshFile();
        await invoice("QUEUE-1");
        await run();
        id = (await q("select id from public.ops_exceptions where rule_code = 'E01'")).rows[0].id;
      });
      await asUser(c, insurance, async () => {
        expect(
          (
            await q(
              "update public.ops_exceptions set assignee_user_id = $2, status = 'in_progress' where id = $1",
              [id, insurance],
            )
          ).rowCount,
        ).toBe(1);
        await q(
          "insert into public.ops_exception_comments (org_id, exception_id, user_id, comment) values ($1,$2,$3,'chasing payer')",
          [orgA, id, insurance],
        );
        await expect(
          q("update public.ops_exceptions set status = 'closed', closed_at = now() where id = $1", [
            id,
          ]),
        ).rejects.toThrow(/check/);
        expect(
          (
            await q(
              "update public.ops_exceptions set status = 'closed', closed_at = now(), closed_by = $2, closure_note = 'claim submitted' where id = $1",
              [id, insurance],
            )
          ).rowCount,
        ).toBe(1);
      });
      await asUser(c, billing, async () => {
        expect(await count(c, "select 1 from public.ops_exceptions where rule_code = 'E01'")).toBe(
          0,
        ); // not Billing's queue
      });
    });
  });
});
