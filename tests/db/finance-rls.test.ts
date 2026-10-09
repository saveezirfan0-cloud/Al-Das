/**
 * Finance & Insurance foundation: tenant isolation, role matrix, constraints,
 * views and the capture lease. Synthetic data only. Runs only with TEST_DATABASE_URL.
 */
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
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Finance row level security", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  let invA: string;
  let invB: string;
  let lineA: string;
  let excInsurance: string;
  let excBilling: string;
  let excAdmin: string;

  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const asRole = <T>(name: string, fn: () => Promise<T>) => asUser(c, users[name], fn);

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    await q("truncate public.fin_raw_unite_batches, public.fin_capture_lease cascade");
    for (const n of ["alice", "bob", "fin", "billing", "ins", "ceo"])
      users[n] = await createAuthUser(c, `${n}@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);

    await asServiceRole(c, async () => {
      for (const r of FINANCE_ROLES) {
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true)",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      }
      const member = async (user: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[user], role],
        );
      await member("fin", "Finance");
      await member("billing", "Billing");
      await member("ins", "Insurance");
      await member("ceo", "CEO");

      const batch = async (org: string) =>
        (
          await q(
            `insert into public.fin_raw_unite_batches (org_id, from_date, to_date, count_requested, record_count, payload)
             values ($1, '2026-01-01', '2026-10-09', 50, 1, '{"Data":[]}') returning id`,
            [org],
          )
        ).rows[0].id as string;
      const batchA = await batch(orgA);
      const batchB = await batch(orgB);

      const invoice = async (org: string, batchId: string, no: string) =>
        (
          await q(
            `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, inv_type,
               gross, discount, net, vat, total, record_hash, last_batch_id)
             values ($1, $2, '2026-03-02', 'PIN-TEST-1', 'P', 'INSURANCE', 100, 0, 100, 5, 105, 'h', $3) returning id`,
            [org, no, batchId],
          )
        ).rows[0].id as string;
      invA = await invoice(orgA, batchA, "ADMC/C/90001");
      invB = await invoice(orgB, batchB, "ADMC/C/90001"); // same number, different org: allowed

      lineA = (
        await q(
          `insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, cpt_code, qty, line_gross, line_discount, line_net, vat)
           values ($1, $2, 'ADMC/C/90001|T-TEST-1|1', 1, 'T-TEST-1', '99213', 1, 100, 0, 100, 5) returning id`,
          [orgA, invA],
        )
      ).rows[0].id;
      await q(
        `insert into public.fin_payments (org_id, invoice_id, payment_key, instalment, payment_mode, paid, paid_date)
         values ($1, $2, 'ADMC/C/90001|1|R1', '1', 'CARD', 105, '2026-03-02')`,
        [orgA, invA],
      );
      await q(
        `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, matched_invoice_id, matched_line_id, match_status,
           transaction_date, cpt_code, payer_id, net, remitted, rejected, claim_year, claim_month)
         values ($1, 'CA-TEST-1', 'admc/c/90001', $2, $3, 'matched', '2026-03-02', '99213', 'PAYER1', 100, 60, 40, 2026, 3)`,
        [orgA, invA, lineA],
      );

      const exc = async (rule: string, owner: string, key: string) =>
        (
          await q(
            "insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, owner_role) values ($1, $2, 'invoice', $3, $4) returning id",
            [orgA, rule, key, owner],
          )
        ).rows[0].id as string;
      excInsurance = await exc("E01", "insurance", "ADMC/C/90001");
      excBilling = await exc("E03", "billing", "ADMC/C/90001");
      excAdmin = await exc("E07", "admin", "ADMC/C/90001");
    });
  });

  afterAll(async () => {
    await c.end();
  });

  it("seeds branches, exception rules and a disabled capture setting for every org", async () => {
    await asServiceRole(c, async () => {
      for (const org of [orgA, orgB]) {
        expect(
          await count(c, "select 1 from public.fin_ref_branches where org_id = $1", [org]),
        ).toBe(3);
        expect(
          await count(c, "select 1 from public.fin_ref_exception_rules where org_id = $1", [org]),
        ).toBe(10);
        const { rows } = await q(
          "select enabled from public.fin_capture_settings where org_id = $1",
          [org],
        );
        expect(rows[0].enabled).toBe(false);
      }
    });
  });

  it("seed_finance_roles adds presets once and never overwrites", async () => {
    await asServiceRole(c, async () => {
      const roles = FINANCE_ROLES.map((r) => ({
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      }));
      const first = await q("select public.seed_finance_roles($1, $2::jsonb) as n", [
        orgB,
        JSON.stringify(roles),
      ]);
      expect(first.rows[0].n).toBe(FINANCE_ROLES.length);
      const again = await q("select public.seed_finance_roles($1, $2::jsonb) as n", [
        orgB,
        JSON.stringify(roles),
      ]);
      expect(again.rows[0].n).toBe(0);
    });
  });

  it("raw tables return nothing to any authenticated member, even an admin", async () => {
    await asRole("alice", async () => {
      for (const t of [
        "fin_raw_unite_batches",
        "fin_raw_diligence_files",
        "fin_capture_settings",
        "fin_capture_lease",
      ])
        expect(await count(c, `select 1 from public.${t}`)).toBe(0);
    });
  });

  it("raw writes are denied to authenticated members", async () => {
    await asRole("alice", async () => {
      await expect(
        q(
          "insert into public.fin_raw_unite_batches (org_id, from_date, to_date, count_requested) values ($1, '2026-01-01', '2026-01-02', 1)",
          [orgA],
        ),
      ).rejects.toThrow();
    });
  });

  it("billing reads invoices, lines and payments but not claims", async () => {
    await asRole("billing", async () => {
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(1);
      expect(await count(c, "select 1 from public.fin_invoice_lines")).toBe(1);
      expect(await count(c, "select 1 from public.fin_payments")).toBe(1);
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(0);
      expect(await count(c, "select 1 from public.v_fin_monthly_summary")).toBe(0);
    });
  });

  it("insurance reads claims and the matching view but not invoices or payments", async () => {
    await asRole("ins", async () => {
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(1);
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(0);
      expect(await count(c, "select 1 from public.fin_payments")).toBe(0);
      expect(await count(c, "select 1 from public.v_ins_invoice_match")).toBe(1);
      expect(await count(c, "select 1 from public.v_ins_invoice_line_match")).toBe(1);
    });
    await asRole("billing", async () => {
      expect(await count(c, "select 1 from public.v_ins_invoice_match")).toBe(0);
    });
  });

  it("finance and CEO read aggregates; summary numbers are right", async () => {
    for (const who of ["fin", "ceo"]) {
      await asRole(who, async () => {
        const { rows } = await q(
          "select branch_code, generated, claimed, remitted, rejected, outstanding, self_pay_collected from public.v_fin_monthly_summary",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].branch_code).toBe("P");
        expect(Number(rows[0].generated)).toBe(100);
        expect(Number(rows[0].claimed)).toBe(100);
        expect(Number(rows[0].remitted)).toBe(60);
        expect(Number(rows[0].rejected)).toBe(40);
        expect(Number(rows[0].outstanding)).toBe(40);
        expect(rows[0].self_pay_collected).toBeNull(); // the only invoice is INSURANCE
        expect(await count(c, "select 1 from public.v_fin_revenue_daily")).toBe(1);
        expect(await count(c, "select 1 from public.v_fin_claims_status")).toBe(1);
        expect(await count(c, "select 1 from public.v_fin_receivables_ageing")).toBe(1);
        expect(await count(c, "select 1 from public.v_fin_denials")).toBe(1);
        expect(await count(c, "select 1 from public.v_fin_collections_daily")).toBe(1);
      });
    }
  });

  it("revenue view excludes deleted invoices and non-current lines", async () => {
    await asServiceRole(c, async () => {
      await q("update public.fin_invoice_lines set is_current = false where id = $1", [lineA]);
    });
    await asRole("fin", async () => {
      expect(await count(c, "select 1 from public.v_fin_revenue_daily")).toBe(0);
    });
    await asServiceRole(c, async () => {
      await q("update public.fin_invoice_lines set is_current = true where id = $1", [lineA]);
      await q("update public.fin_invoices set is_deleted = true where id = $1", [invA]);
    });
    await asRole("fin", async () => {
      expect(await count(c, "select 1 from public.v_fin_revenue_daily")).toBe(0);
      expect(
        await count(c, "select 1 from public.v_fin_monthly_summary where generated is not null"),
      ).toBe(0);
    });
    await asServiceRole(c, async () => {
      await q("update public.fin_invoices set is_deleted = false where id = $1", [invA]);
    });
  });

  it("another org's admin sees none of org A's finance data", async () => {
    await asRole("bob", async () => {
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(1); // only their own
      const { rows } = await q("select id from public.fin_invoices");
      expect(rows[0].id).toBe(invB);
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(0);
      expect(await count(c, "select 1 from public.ops_exceptions")).toBe(0);
      expect(
        await count(c, "select 1 from public.v_fin_monthly_summary where org_id = $1", [orgA]),
      ).toBe(0);
    });
  });

  it("finance data cannot be written by authenticated members", async () => {
    await asRole("alice", async () => {
      await expect(
        q(
          "insert into public.fin_invoices (org_id, inv_display_number, record_hash) values ($1, 'X/1', 'h')",
          [orgA],
        ),
      ).rejects.toThrow();
      const upd = await q("update public.fin_invoices set net = 1 where id = $1", [invA]);
      expect(upd.rowCount).toBe(0);
    });
  });

  it("children must belong to the same org as their invoice", async () => {
    await asServiceRole(c, async () => {
      await expect(
        q(
          "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position) values ($1, $2, 'cross|1|1', 1)",
          [orgB, invA],
        ),
      ).rejects.toThrow(/does not belong to org/);
      await expect(
        q("update public.ins_claim_activities set matched_invoice_id = $1 where org_id = $2", [
          invB,
          orgA,
        ]),
      ).rejects.toThrow(/does not belong to org/);
    });
  });

  it("exceptions are visible only to the owning role", async () => {
    await asRole("ins", async () => {
      const { rows } = await q("select id from public.ops_exceptions");
      expect(rows.map((r) => r.id)).toEqual([excInsurance]);
    });
    await asRole("billing", async () => {
      const { rows } = await q("select id from public.ops_exceptions");
      expect(rows.map((r) => r.id)).toEqual([excBilling]);
    });
    await asRole("alice", async () => {
      expect(await count(c, "select 1 from public.ops_exceptions")).toBe(3);
    });
    await asRole("ceo", async () => {
      // read-only oversight of billing + insurance queues, but not admin-owned (capture) exceptions
      const { rows } = await q("select id from public.ops_exceptions");
      expect(rows.map((r) => r.id).sort()).toEqual([excInsurance, excBilling].sort());
      expect(rows.map((r) => r.id)).not.toContain(excAdmin);
    });
    await asRole("fin", async () => {
      expect(await count(c, "select 1 from public.ops_exceptions")).toBe(2); // visibility of billing + insurance queues
    });
  });

  it("insurance can comment and close its own exception, not another role's", async () => {
    await asRole("ins", async () => {
      await q(
        "insert into public.ops_exception_comments (org_id, exception_id, user_id, comment) values ($1, $2, $3, 'chasing payer')",
        [orgA, excInsurance, users.ins],
      );
      await expect(
        q(
          "insert into public.ops_exception_comments (org_id, exception_id, user_id, comment) values ($1, $2, $3, 'nope')",
          [orgA, excBilling, users.ins],
        ),
      ).rejects.toThrow();
      const other = await q(
        "update public.ops_exceptions set status = 'in_progress' where id = $1",
        [excBilling],
      );
      expect(other.rowCount).toBe(0);
    });
    await asRole("billing", async () => {
      expect(await count(c, "select 1 from public.ops_exception_comments")).toBe(0);
    });
  });

  it("a manual close needs a note and the open-exception key is unique", async () => {
    await asRole("ins", async () => {
      await expect(
        q("update public.ops_exceptions set status = 'closed', closed_at = now() where id = $1", [
          excInsurance,
        ]),
      ).rejects.toThrow(/check/);
      await q(
        "update public.ops_exceptions set status = 'closed', closed_at = now(), closure_note = 'claim received' where id = $1",
        [excInsurance],
      );
    });
    await asServiceRole(c, async () => {
      await expect(
        q(
          "insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, owner_role) values ($1, 'E03', 'invoice', 'ADMC/C/90001', 'billing')",
          [orgA],
        ),
      ).rejects.toThrow(/duplicate key/);
      // closed one no longer blocks a new open exception for the same key
      await q(
        "insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, owner_role) values ($1, 'E01', 'invoice', 'ADMC/C/90001', 'insurance')",
        [orgA],
      );
    });
  });

  it("reference data: only finance.reference.manage writes, only in its own org", async () => {
    await asRole("fin", async () => {
      await q("insert into public.fin_ref_services (org_id, item_code) values ($1, 'T-TEST-9')", [
        orgA,
      ]);
      const { rows } = await q(
        "select service_category from public.fin_ref_services where item_code = 'T-TEST-9'",
      );
      expect(rows[0].service_category).toBe("Unmapped");
      await expect(
        q("insert into public.fin_ref_services (org_id, item_code) values ($1, 'T-X')", [orgB]),
      ).rejects.toThrow();
      expect(await count(c, "select 1 from public.fin_ref_branches")).toBe(3);
    });
    await asRole("billing", async () => {
      await expect(
        q("insert into public.fin_ref_services (org_id, item_code) values ($1, 'T-TEST-8')", [
          orgA,
        ]),
      ).rejects.toThrow();
      expect(await count(c, "select 1 from public.fin_ref_branches")).toBe(3); // billing may read reference data
    });
    await asRole("bob", async () => {
      expect(
        await count(c, "select 1 from public.fin_ref_services where org_id = $1", [orgA]),
      ).toBe(0);
    });
  });

  it("capture lease allows one holder at a time", async () => {
    await asServiceRole(c, async () => {
      const lease = async (holder: string) =>
        (await q("select public.fin_capture_try_lease($1, $2, 300) as ok", [orgA, holder])).rows[0]
          .ok as boolean;
      expect(await lease("run-1")).toBe(true);
      expect(await lease("run-2")).toBe(false);
      expect(await lease("run-1")).toBe(true); // holder may renew
      await q("select public.fin_capture_release_lease($1, 'run-1')", [orgA]);
      expect(await lease("run-2")).toBe(true);
      expect(
        await q("select public.fin_capture_try_lease($1, 'run-3', 0)", [orgB]).then(
          (r) => r.rows[0].fin_capture_try_lease,
        ),
      ).toBe(true);
    });
    await asRole("alice", async () => {
      await expect(q("select public.fin_capture_try_lease($1, 'x', 60)", [orgA])).rejects.toThrow();
    });
  });
});
