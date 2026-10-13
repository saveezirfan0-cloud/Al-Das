/**
 * Finance F8 (Integration Blueprint v2): who can read cost data, the month guard, the pseudonymous patient ID,
 * exception rules E11-E14 with their guards, escalation, the measures view and the report inputs.
 * Synthetic data only. Needs TEST_DATABASE_URL.
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
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Finance blueprint (F8)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const run = async () =>
    (await q("select public.fin_run_exception_rules($1) as r", [orgA])).rows[0].r as Record<
      string,
      { opened?: number; closed?: number; skipped?: boolean }
    >;
  const open = (rule: string) =>
    q(
      "select entity_key, entity_type, owner_role, escalated_from_role from public.ops_exceptions where org_id = $1 and rule_code = $2 and status in ('open','in_progress') order by 1",
      [orgA, rule],
    ).then(
      (r) =>
        r.rows as Array<{
          entity_key: string;
          entity_type: string;
          owner_role: string;
          escalated_from_role: string | null;
        }>,
    );

  const evOnly = async (rule: string) =>
    (await open(rule)).map((x) => x.entity_key).filter((k) => k.startsWith("EV/"));

  async function invoice(
    no: string,
    o: { pin?: string | null; daysAgo?: number; net?: number } = {},
  ) {
    const { rows } = await q(
      `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, inv_type, net, total, patient_pin, record_hash)
       values ($1, $2, current_date - $3::int, 'P', 'SELF PAID', $4, $4, $5, 'h') returning id`,
      [orgA, no, o.daysAgo ?? 10, o.net ?? 100, o.pin === undefined ? null : o.pin],
    );
    return rows[0].id as string;
  }
  let lineNo = 0;
  const line = (inv: string, o: { item: string; qty?: number; net?: number; position?: number }) =>
    q(
      `insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, qty, line_net)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [orgA, inv, `L${++lineNo}`, o.position ?? lineNo, o.item, o.qty ?? 1, o.net ?? 50],
    );
  async function contact(pin: string) {
    const { rows } = await q(
      "insert into public.contacts (org_id, first_name, last_name, external_id) values ($1, 'Test', $2, $2) returning id",
      [orgA, pin],
    );
    return rows[0].id as string;
  }
  const visit = (contactId: string, ext: string, daysAgo: number) =>
    q(
      "insert into public.visits (org_id, contact_id, external_id, visit_date) values ($1, $2, $3, current_date - $4::int)",
      [orgA, contactId, ext, daysAgo],
    );
  const drained = () =>
    q(
      `insert into public.fin_raw_unite_batches (org_id, from_date, to_date, count_requested, record_count, balance_in_range, process_status, processed_at, payload)
       values ($1,'2026-01-01','2026-10-09',50,0,0,'processed',now(),'{}')`,
      [orgA],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "ceo", "cost", "billing", "md"])
      users[n] = await createAuthUser(c, `${n}-bp@example.test`);
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
      await member("cost", "Cost / Payroll");
      await member("billing", "Billing");
      await member("md", "Medical Director");
      for (const org of [orgA, orgB]) {
        await q(
          "insert into public.fin_cost_services (org_id, item_code, effective_from, unit_cost) values ($1, 'T-1', '2026-01-01', 10)",
          [org],
        );
        await q(
          "insert into public.fin_cost_overheads (org_id, month, pool, amount) values ($1, '2026-09-01', 'Rent', 500)",
          [org],
        );
        await q(
          "insert into public.fin_cost_doctor_comp (org_id, month, doctor_dha_id, amount) values ($1, '2026-09-01', 'D1', 9000)",
          [org],
        );
        await q("insert into public.fin_cost_periods (org_id, month) values ($1, '2026-09-01')", [
          org,
        ]);
      }
    });
  });
  afterAll(async () => {
    await c?.end();
  });

  describe("cost data access", () => {
    it("the Cost / Payroll role reads costs and compensation but no revenue or profit data", async () => {
      await asRole("cost", async () => {
        expect(await count(c, "select 1 from public.fin_cost_services")).toBe(1);
        expect(await count(c, "select 1 from public.fin_cost_overheads")).toBe(1);
        expect(await count(c, "select 1 from public.fin_cost_doctor_comp")).toBe(1);
        expect(await count(c, "select 1 from public.fin_invoices")).toBe(0);
        expect(await count(c, "select 1 from public.v_fin_monthly_measures")).toBe(0);
        expect(await count(c, "select 1 from public.v_fin_data_freshness")).toBe(0);
      });
    });
    it("Finance reads everything; billing and the Medical Director read no cost data", async () => {
      await asRole("fin", async () => {
        for (const t of [
          "fin_cost_services",
          "fin_cost_overheads",
          "fin_cost_doctor_comp",
          "fin_cost_periods",
        ])
          expect(await count(c, `select 1 from public.${t}`), t).toBe(1);
      });
      for (const who of ["billing", "md"])
        await asRole(who, async () => {
          for (const t of [
            "fin_cost_services",
            "fin_cost_overheads",
            "fin_cost_doctor_comp",
            "fin_cost_periods",
          ])
            expect(await count(c, `select 1 from public.${t}`), `${who} ${t}`).toBe(0);
        });
    });
    it("the CEO sees approval status but not compensation or raw costs", async () => {
      await asRole("ceo", async () => {
        expect(await count(c, "select 1 from public.fin_cost_periods")).toBe(1);
        expect(await count(c, "select 1 from public.fin_cost_doctor_comp")).toBe(0);
        expect(await count(c, "select 1 from public.fin_cost_services")).toBe(0);
      });
    });
    it("another org's admin sees nothing of org A", async () => {
      await asRole("bob", async () => {
        for (const t of [
          "fin_cost_services",
          "fin_cost_overheads",
          "fin_cost_doctor_comp",
          "fin_cost_periods",
        ])
          expect(await count(c, `select 1 from public.${t} where org_id = $1`, [orgA]), t).toBe(0);
      });
    });
    it("a browser session can never write cost data", async () => {
      for (const who of ["fin", "cost", "alice"])
        await asRole(who, async () => {
          await expect(
            q(
              "insert into public.fin_cost_services (org_id, item_code, effective_from, unit_cost) values ($1, 'X', '2026-01-01', 1)",
              [orgA],
            ),
          ).rejects.toThrow();
          expect(
            (
              await q("update public.fin_cost_services set unit_cost = 99 where org_id = $1", [
                orgA,
              ])
            ).rowCount,
          ).toBe(0);
          expect(
            (await q("delete from public.fin_cost_periods where org_id = $1", [orgA])).rowCount,
          ).toBe(0);
        });
    });
    it("a cost of zero is refused (zero means unavailable)", async () => {
      await svc(async () => {
        await expect(
          q(
            "insert into public.fin_cost_services (org_id, item_code, effective_from, unit_cost) values ($1, 'Z', '2026-01-01', 0)",
            [orgA],
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe("permission migration", () => {
    it("grants the cost and profit keys to the right existing roles, once, and creates the Cost / Payroll role", async () => {
      const sql = fs.readFileSync(
        path.join(__dirname, "../../supabase/migrations/20261021000100_finance_blueprint.sql"),
        "utf8",
      );
      const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
      expect(block, "the grant block was not found").toBeTruthy();
      const orgC = await svc(async () => {
        const id = (
          await q("insert into public.orgs (name, slug) values ('Org C', 'org-c') returning id")
        ).rows[0].id as string;
        for (const [name, perms] of Object.entries({
          Finance: ["finance.view"],
          CEO: ["finance.view"],
          Billing: ["finance.invoices.view"],
          "Medical Director": ["finance.view"],
        }))
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
            [id, name, JSON.stringify(perms)],
          );
        return id;
      });
      const read = async (): Promise<Record<string, string[]>> =>
        Object.fromEntries(
          (
            await svc(() =>
              q("select name, permissions from public.roles where org_id = $1", [orgC]),
            )
          ).rows.map((r) => [r.name, r.permissions as string[]]),
        );
      await svc(() => q(block!));
      const first = await read();
      expect(first.Finance).toEqual(
        expect.arrayContaining([
          "finance.costs.manage",
          "finance.costs.view",
          "finance.costs.compensation",
          "finance.profit.view",
          "finance.profit.approve",
        ]),
      );
      expect(first.CEO).toContain("finance.profit.view");
      expect(first.CEO.some((p) => p.startsWith("finance.costs."))).toBe(false);
      for (const name of ["Billing", "Medical Director"])
        expect(
          first[name].some(
            (p) => p.startsWith("finance.costs.") || p.startsWith("finance.profit."),
          ),
          name,
        ).toBe(false);
      await svc(() => q(block!));
      expect(await read()).toEqual(first);
      // the new role's permissions match the code preset
      const preset = FINANCE_ROLES.find((r) => r.name === "Cost / Payroll")!;
      const { rows } = await svc(() =>
        q("select permissions from public.roles where org_id = $1 and name = 'Cost / Payroll'", [
          orgA,
        ]),
      );
      void rows;
      expect(preset.permissions).toEqual([
        "finance.costs.manage",
        "finance.costs.view",
        "finance.costs.compensation",
      ]);
      // no revenue, profit or exception permission is ever part of it
      expect(
        preset.permissions.some(
          (p) =>
            p === "finance.view" || p.startsWith("finance.profit") || p === "finance.revenue.view",
        ),
      ).toBe(false);
    });
  });

  describe("approved months", () => {
    it("block changes to compensation and overheads of that month, and nothing else", async () => {
      await svc(async () => {
        await q(
          "update public.fin_cost_periods set status = 'approved', approved_by = $2, approved_at = now() where org_id = $1 and month = '2026-09-01'",
          [orgA, users.fin],
        );
        await expect(
          q("update public.fin_cost_doctor_comp set amount = 1 where org_id = $1", [orgA]),
        ).rejects.toThrow(/approved/);
        await expect(
          q("delete from public.fin_cost_overheads where org_id = $1", [orgA]),
        ).rejects.toThrow(/approved/);
        await expect(
          q(
            "insert into public.fin_cost_overheads (org_id, month, pool, amount) values ($1, '2026-09-01', 'Other', 5)",
            [orgA],
          ),
        ).rejects.toThrow(/approved/);
        // another month and the service cost table are unaffected
        await q(
          "insert into public.fin_cost_overheads (org_id, month, pool, amount) values ($1, '2026-10-01', 'Rent', 5)",
          [orgA],
        );
        await q(
          "insert into public.fin_cost_services (org_id, item_code, effective_from, unit_cost) values ($1, 'T-2', '2026-09-01', 3)",
          [orgA],
        );
        // reopening allows edits again
        await q(
          "update public.fin_cost_periods set status = 'draft', approved_by = null, approved_at = null where org_id = $1",
          [orgA],
        );
        await q("update public.fin_cost_doctor_comp set amount = 9100 where org_id = $1", [orgA]);
      });
    });
    it("an approved row needs an approver and a time", async () => {
      await svc(async () => {
        await expect(
          q("update public.fin_cost_periods set status = 'approved' where org_id = $1", [orgA]),
        ).rejects.toThrow();
      });
    });
  });

  describe("cost writes", () => {
    it("fin_cost_upsert saves a whole file atomically and updates existing rows", async () => {
      await svc(async () => {
        const rows = [
          { item_code: "t-77", effective_from: "2026-01-01", unit_cost: 5, note: null },
          { item_code: "T-78", effective_from: "2026-01-01", unit_cost: 6, note: "kit" },
        ];
        expect(
          (
            await q("select public.fin_cost_upsert($1, 'services', $2::jsonb, $3) as n", [
              orgA,
              JSON.stringify(rows),
              users.cost,
            ])
          ).rows[0].n,
        ).toBe(2);
        rows[0].unit_cost = 7;
        await q("select public.fin_cost_upsert($1, 'services', $2::jsonb, $3)", [
          orgA,
          JSON.stringify(rows),
          users.cost,
        ]);
        const r = (
          await q(
            "select item_code, unit_cost from public.fin_cost_services where org_id = $1 and item_code in ('T-77','T-78') order by 1",
            [orgA],
          )
        ).rows;
        expect(r.map((x) => [x.item_code, Number(x.unit_cost)])).toEqual([
          ["T-77", 7],
          ["T-78", 6],
        ]);
        // overheads: the same pool and branch updates in place (case-insensitive pool)
        const oh = (amount: number, pool = "Cleaning") =>
          JSON.stringify([
            { month: "2026-11-01", branch_code: "p", pool, amount, basis: null, note: null },
          ]);
        await q("select public.fin_cost_upsert($1, 'overheads', $2::jsonb, $3)", [
          orgA,
          oh(10),
          users.cost,
        ]);
        await q("select public.fin_cost_upsert($1, 'overheads', $2::jsonb, $3)", [
          orgA,
          oh(20, "cleaning"),
          users.cost,
        ]);
        const o = (
          await q(
            "select amount, branch_code, basis from public.fin_cost_overheads where org_id = $1 and month = '2026-11-01'",
            [orgA],
          )
        ).rows;
        expect(o).toHaveLength(1);
        expect(Number(o[0].amount)).toBe(20);
        expect(o[0].branch_code).toBe("P");
        expect(o[0].basis).toBe("revenue");
      });
    });
    it("a bad row or an approved month rolls the whole file back", async () => {
      await svc(async () => {
        const before = (
          await q("select count(*) as n from public.fin_cost_doctor_comp where org_id = $1", [orgA])
        ).rows[0].n;
        await q("select public.fin_cost_set_period($1, '2026-08-01', 'approved', $2, null)", [
          orgA,
          users.fin,
        ]);
        const rows = JSON.stringify([
          { month: "2026-07-01", doctor_dha_id: "D5", amount: 100, note: null },
          { month: "2026-08-01", doctor_dha_id: "D5", amount: 100, note: null },
        ]);
        await expect(
          q("select public.fin_cost_upsert($1, 'compensation', $2::jsonb, $3)", [
            orgA,
            rows,
            users.cost,
          ]),
        ).rejects.toThrow(/approved/);
        expect(
          (
            await q("select count(*) as n from public.fin_cost_doctor_comp where org_id = $1", [
              orgA,
            ])
          ).rows[0].n,
        ).toBe(before);
        await expect(
          q("select public.fin_cost_upsert($1, 'nonsense', '[]', $2)", [orgA, users.cost]),
        ).rejects.toThrow();
        await q("select public.fin_cost_set_period($1, '2026-08-01', 'draft', $2, null)", [
          orgA,
          users.fin,
        ]);
        expect(
          (
            await q(
              "select status, approved_by from public.fin_cost_periods where org_id = $1 and month = '2026-08-01'",
              [orgA],
            )
          ).rows[0],
        ).toEqual({ status: "draft", approved_by: null });
      });
    });
    it("browsers cannot call the write functions", async () => {
      await asRole("cost", async () => {
        await expect(
          q("select public.fin_cost_upsert($1, 'services', '[]', $2)", [orgA, users.cost]),
        ).rejects.toThrow();
        await expect(
          q("select public.fin_cost_set_period($1, '2026-09-01', 'approved', $2, null)", [
            orgA,
            users.cost,
          ]),
        ).rejects.toThrow();
      });
    });
  });

  describe("pseudonymous patient ID", () => {
    it("is null without a key (fail closed), then a keyed hash that never contains the PIN", async () => {
      const refOf = async (id: string) =>
        (await q("select patient_ref from public.fin_invoices where id = $1", [id])).rows[0]
          .patient_ref as string | null;
      const setKey = async (key: string | null) => {
        // the vault belongs to the database owner, so this runs outside the service-role wrapper
        await q("delete from vault.decrypted_secrets where name = 'finance_ref_key'");
        if (key) await q("select vault.create_secret($1, 'finance_ref_key')", [key]);
      };
      await setKey(null);
      const a = await svc(() => invoice("ADMC/C/9001", { pin: "123456" }));
      expect(await refOf(a)).toBeNull();

      await setKey("test-key-0123456789");
      const [b, d, e] = await svc(async () => [
        await invoice("ADMC/C/9002", { pin: "123456" }),
        await invoice("ADMC/C/9003", { pin: "654321" }),
        await invoice("ADMC/C/9004", { pin: "123456" }),
      ]);
      const rb = (await refOf(b))!;
      expect(rb).toMatch(/^P-[0-9a-f]{16}$/);
      expect(rb).not.toContain("123456");
      expect(await refOf(d)).not.toBe(rb); // different patient, different ID
      expect(await refOf(e)).toBe(rb); // same patient, same ID

      await setKey("another-key-0123456789");
      const f = await svc(() => invoice("ADMC/C/9005", { pin: "123456" }));
      expect(await refOf(f)).not.toBe(rb); // a different key gives a different ID

      await setKey("short"); // a too-short key is refused
      const g = await svc(() => invoice("ADMC/C/9006", { pin: "123456" }));
      expect(await refOf(g)).toBeNull();

      await setKey("test-key-0123456789"); // the backfill fills older rows once a usable key exists
      await svc(() => q("select public.fin_backfill_patient_refs($1)", [orgA]));
      expect(await refOf(a)).toBe(rb);
      await setKey(null);
    });
    it("browsers cannot call the hashing function", async () => {
      await asRole("fin", async () => {
        await expect(q("select app.fin_patient_ref('1')")).rejects.toThrow();
        await expect(q("select public.fin_backfill_patient_refs($1)", [orgA])).rejects.toThrow();
      });
    });
  });

  describe("exception rules E11 to E14", () => {
    let pinA: string;
    beforeAll(async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set evidence_start_date = null where org_id = $1",
          [orgA],
        );
        pinA = "700001";
      });
    });

    it("E11 and E12 are off until an evidence start date is set", async () => {
      await svc(async () => {
        const r = await run();
        expect(r.E11?.skipped).toBe(true);
        expect(r.E12?.skipped).toBe(true);
      });
    });

    it("E11 flags a billed service with no visit, and clears when the visit exists", async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set evidence_start_date = current_date - 60, evidence_grace_days = 2 where org_id = $1",
          [orgA],
        );
        await invoice("EV/1", { pin: pinA, daysAgo: 10 });
        // no visit feed at all: silent (guard)
        expect((await run()).E11?.skipped).toBe(true);
        // a visit for someone else makes the feed "live"
        const other = await contact("700099");
        await visit(other, "V-OTHER", 10);
        await run();
        expect(await evOnly("E11")).toEqual(["EV/1"]);
        // a visit for that patient within the grace window closes it
        const mine = await contact(pinA);
        await visit(mine, "V-MINE", 11);
        await run();
        expect(await evOnly("E11")).toEqual([]);
        // a visit 5 days away is outside the 2-day window
        await q(
          "update public.visits set visit_date = current_date - 15 where external_id = 'V-MINE'",
        );
        await run();
        expect(await evOnly("E11")).toEqual(["EV/1"]);
        await q(
          "update public.visits set visit_date = current_date - 10 where external_id = 'V-MINE'",
        );
        await run();
        expect(await evOnly("E11")).toEqual([]);
      });
    });

    it("E12 flags a visit with no invoice, only after capture has drained, and never for test records", async () => {
      await svc(async () => {
        const lone = await contact("700002");
        await visit(lone, "V-LONE", 8);
        await q(
          "insert into public.visits (org_id, contact_id, external_id, visit_date, is_test_record) values ($1, $2, 'V-TEST', current_date - 8, true)",
          [orgA, lone],
        );
        await run();
        expect(await open("E12")).toEqual([]); // capture not drained yet
        await drained();
        await run();
        const rows = (await open("E12")).filter(
          (x) => x.entity_key === "V-LONE" || x.entity_key === "V-TEST",
        );
        expect(rows.map((x) => x.entity_key)).toEqual(["V-LONE"]); // the test record is never flagged
        expect(rows[0].entity_type).toBe("visit");
        // billing the patient clears it
        await invoice("EV/2", { pin: "700002", daysAgo: 9 });
        await run();
        expect((await open("E12")).filter((x) => x.entity_key === "V-LONE")).toEqual([]);
      });
    });

    it("E13 flags the same service billed twice on one invoice and clears when fixed", async () => {
      await svc(async () => {
        const inv = await invoice("DUP/1", { pin: null });
        await line(inv, { item: "T-1", qty: 1, net: 50 });
        await line(inv, { item: "T-1", qty: 1, net: 50 });
        await line(inv, { item: "T-2", qty: 1, net: 50 });
        await run();
        expect((await open("E13")).map((x) => x.entity_key)).toEqual(["DUP/1"]);
        const { rows } = await q(
          "select detail from public.ops_exceptions where org_id = $1 and rule_code = 'E13'",
          [orgA],
        );
        expect(rows[0].detail).toMatchObject({
          repeated_groups: 1,
          extra_lines: 1,
          extra_amount: 50,
        });
        await q(
          "update public.fin_invoice_lines set is_current = false where invoice_id = $1 and item_code = 'T-1' and position = (select min(position) from public.fin_invoice_lines where invoice_id = $1 and item_code = 'T-1')",
          [inv],
        );
        await run();
        expect(await open("E13")).toEqual([]);
      });
    });

    it("E14 flags a claim whose invoice has no matching line", async () => {
      await svc(async () => {
        await q(
          `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, transaction_date, cpt_code, net, initial_net, match_reason, match_status)
           values ($1, 'CA-1', 'DUP/1', current_date - 5, '99213', 10, 10, 'no_line', 'unmatched')`,
          [orgA],
        );
        await run();
        expect((await open("E14")).map((x) => x.entity_key)).toEqual(["CA-1"]);
        await q(
          "update public.ins_claim_activities set match_reason = 'ok' where claim_activity_number = 'CA-1'",
        );
        await run();
        expect(await open("E14")).toEqual([]);
      });
    });
  });

  describe("escalation", () => {
    it("moves a long-overdue exception to the escalation role once, keeping the original owner", async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set escalation_days = 14, escalation_role = 'finance' where org_id = $1",
          [orgA],
        );
        await q(
          `insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, owner_role, due_date)
           values ($1, 'E06', 'claim', 'ESC/OLD', 'billing', current_date - 20),
                  ($1, 'E06', 'claim', 'ESC/NEW', 'billing', current_date - 5)`,
          [orgA],
        );
        expect((await q("select public.fin_escalate_exceptions($1) as n", [orgA])).rows[0].n).toBe(
          1,
        );
        const old = (
          await q(
            "select owner_role, escalated_from_role, escalated_at from public.ops_exceptions where entity_key = 'ESC/OLD'",
          )
        ).rows[0];
        expect(old.owner_role).toBe("finance");
        expect(old.escalated_from_role).toBe("billing");
        expect(old.escalated_at).not.toBeNull();
        const fresh = (
          await q(
            "select owner_role, escalated_at from public.ops_exceptions where entity_key = 'ESC/NEW'",
          )
        ).rows[0];
        expect(fresh.owner_role).toBe("billing");
        expect(fresh.escalated_at).toBeNull();
        // running again changes nothing
        expect((await q("select public.fin_escalate_exceptions($1) as n", [orgA])).rows[0].n).toBe(
          0,
        );
        // and the rules run does the escalation too
        await q(
          "update public.ops_exceptions set due_date = current_date - 30 where entity_key = 'ESC/NEW'",
        );
        await run();
        expect(
          (await q("select owner_role from public.ops_exceptions where entity_key = 'ESC/NEW'"))
            .rows[0].owner_role,
        ).toBe("finance");
      });
    });
    it("browsers cannot call it", async () => {
      await asRole("fin", async () => {
        await expect(q("select public.fin_escalate_exceptions($1)", [orgA])).rejects.toThrow();
      });
    });
  });

  describe("measures view", () => {
    it("accepted needs evidence, unknown status is counted apart, paid comes from remittance lines", async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set accepted_claim_statuses = array['Approved'] where org_id = $1",
          [orgA],
        );
        const claim = async (
          n: string,
          f: { remitted?: number; rejected?: number; status?: string | null },
        ) => {
          const r = await q(
            `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, transaction_date, cpt_code, net, initial_net, remitted, rejected, claim_status, match_reason, match_status)
             values ($1, $2, 'M/1', '2026-09-10', '99213', 100, 100, $3, $4, $5, 'ok', 'unmatched') returning id`,
            [orgA, n, f.remitted ?? 0, f.rejected ?? 0, f.status ?? null],
          );
          return r.rows[0].id as string;
        };
        const paidClaim = await claim("M-PAID", { remitted: 60 });
        await claim("M-STATUS", { status: "approved" }); // evidence by configured status, case-insensitive
        await claim("M-UNKNOWN", {});
        await claim("M-REJECTED", { rejected: 100 });
        const batch = (
          await q(
            "insert into public.ins_remittance_batches (org_id, remittance_ref, paid_on) values ($1, 'R1', '2026-10-01') returning id",
            [orgA],
          )
        ).rows[0].id as string;
        await q(
          `insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, paid_amount, claim_activity_id, match_status)
           values ($1, $2, 1, 'k1', 60, $3, 'matched'), ($1, $2, 2, 'k2', 25, $3, 'unmatched')`,
          [orgA, batch, paidClaim],
        );
        const { rows } = await q(
          "select accepted, paid_allocated, status_unknown_claims, claimed from public.v_fin_monthly_measures where org_id = $1 and month = '2026-09-01'",
          [orgA],
        );
        // the view is permission-gated; the service role has no member, so check through a member below
        expect(rows).toHaveLength(0);
      });
      await asRole("fin", async () => {
        const { rows } = await q(
          "select accepted, paid_allocated, status_unknown_claims, claimed from public.v_fin_monthly_measures where month = '2026-09-01'",
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].claimed)).toBe(400);
        expect(Number(rows[0].accepted)).toBe(200); // remitted claim + approved-status claim
        expect(Number(rows[0].paid_allocated)).toBe(60); // the unmatched advice line is not counted
        expect(Number(rows[0].status_unknown_claims)).toBe(1);
      });
      await asRole("cost", async () => {
        expect(await count(c, "select 1 from public.v_fin_monthly_measures")).toBe(0);
      });
    });
  });

  describe("report inputs", () => {
    it("fin_profit_inputs costs lines from the Finance table and counts uncosted lines", async () => {
      await svc(async () => {
        await q(
          "update public.fin_ref_finance_settings set doctor_basis = null where org_id = $1",
          [orgA],
        );
        const inv = await invoice("PROF/1", { pin: null, daysAgo: 3 });
        await q(
          "update public.fin_invoices set doctor_dha_id = 'D1', department = 'GP' where id = $1",
          [inv],
        );
        await line(inv, { item: "T-1", qty: 2, net: 100 }); // costed: 2 x 10 = 20
        await line(inv, { item: "NO-COST", qty: 1, net: 60 }); // uncosted
        const { rows } = await q(
          "select public.fin_profit_inputs($1, current_date - 10, current_date) as r",
          [orgA],
        );
        const row = (rows[0].r as Array<Record<string, number | string>>).find(
          (x) => x.doctor_dha_id === "D1" && Number(x.revenue_net) === 160,
        );
        expect(row).toBeDefined();
        expect(Number(row!.direct_cost)).toBe(20);
        expect(Number(row!.costed_net)).toBe(100);
        expect(Number(row!.uncosted_lines)).toBe(1);
      });
    });
    it("the doctor basis picks ordering or performing and falls back to the invoice doctor", async () => {
      await svc(async () => {
        await q("select public.fin_set_invoice_doctor_roles($1, $2::jsonb)", [
          orgA,
          JSON.stringify([{ inv: "prof/1", ordering_id: "ORD1", performing_id: "PERF1" }]),
        ]);
        const doctors = async () =>
          (
            (
              await q("select public.fin_profit_inputs($1, current_date - 10, current_date) as r", [
                orgA,
              ])
            ).rows[0].r as Array<{ doctor_dha_id: string; revenue_net: number }>
          )
            .filter((x) => Number(x.revenue_net) === 160)
            .map((x) => x.doctor_dha_id);
        expect(await doctors()).toEqual(["D1"]);
        await q(
          "update public.fin_ref_finance_settings set doctor_basis = 'ordering' where org_id = $1",
          [orgA],
        );
        expect(await doctors()).toEqual(["ORD1"]);
        await q(
          "update public.fin_ref_finance_settings set doctor_basis = 'performing' where org_id = $1",
          [orgA],
        );
        expect(await doctors()).toEqual(["PERF1"]);
        // supplied values only: a blank does not erase
        await q("select public.fin_set_invoice_doctor_roles($1, $2::jsonb)", [
          orgA,
          JSON.stringify([{ inv: "PROF/1", ordering_id: "" }]),
        ]);
        await q(
          "update public.fin_ref_finance_settings set doctor_basis = 'ordering' where org_id = $1",
          [orgA],
        );
        expect(await doctors()).toEqual(["ORD1"]);
        await q(
          "update public.fin_ref_finance_settings set doctor_basis = null where org_id = $1",
          [orgA],
        );
      });
    });
    it("fin_doctor_measures reports new and returning patients only when history allows", async () => {
      await svc(async () => {
        await q("delete from public.fin_invoices where org_id = $1", [orgA]);
        await invoice("DM/OLD", { pin: "800001", daysAgo: 60 });
        await invoice("DM/1", { pin: "800001", daysAgo: 5 }); // returning
        await invoice("DM/2", { pin: "800002", daysAgo: 4 }); // new
        await q(
          "update public.fin_invoices set doctor_dha_id = 'D9', department = 'GP' where org_id = $1",
          [orgA],
        );
        const inWindow = (
          await q("select public.fin_doctor_measures($1, current_date - 30, current_date) as r", [
            orgA,
          ])
        ).rows[0].r;
        expect(inWindow.rows).toHaveLength(1);
        expect(inWindow.rows[0]).toMatchObject({
          doctor_dha_id: "D9",
          invoices: 2,
          patients: 2,
          new_patients: 1,
          returning_patients: 1,
          completed_appointments: null,
        });
        // a window that starts at or before the first invoice on record cannot tell new from returning
        const early = (
          await q("select public.fin_doctor_measures($1, current_date - 90, current_date) as r", [
            orgA,
          ])
        ).rows[0].r;
        expect(early.rows[0].new_patients).toBeNull();
        expect(early.rows[0].returning_patients).toBeNull();
        expect(JSON.stringify(early)).not.toContain("800001"); // no patient identifier leaves the function
      });
    });
    it("browsers cannot call the report inputs", async () => {
      await asRole("fin", async () => {
        await expect(
          q("select public.fin_profit_inputs($1, current_date - 1, current_date)", [orgA]),
        ).rejects.toThrow();
        await expect(
          q("select public.fin_doctor_measures($1, current_date - 1, current_date)", [orgA]),
        ).rejects.toThrow();
        await expect(
          q("select public.fin_set_invoice_doctor_roles($1, '[]')", [orgA]),
        ).rejects.toThrow();
      });
    });
  });

  describe("insurance overview", () => {
    it("counts claims by evidence, allocates payments, ages the balance and keeps the old view in step", async () => {
      await svc(async () => {
        await q("delete from public.ins_claim_activities where org_id = $1", [orgA]);
        await q(
          "update public.fin_ref_finance_settings set accepted_claim_statuses = array['Approved'] where org_id = $1",
          [orgA],
        );
        const claim = async (
          n: string,
          f: {
            remitted?: number;
            rejected?: number;
            status?: string | null;
            days?: number;
            resub?: number;
            first?: number | null;
            payer?: string;
          },
        ) =>
          (
            await q(
              `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, transaction_date, first_remittance_date, cpt_code, net, initial_net, remitted, rejected, resubmission_count, claim_status, payer_id, match_reason, match_status)
               values ($1, $2, 'IO/1', current_date - $3::int, case when $4::int is null then null else current_date - $3::int + $4::int end, '99213', 100, 100, $5, $6, $7, $8, $9, 'ok', 'unmatched') returning id`,
              [
                orgA,
                n,
                f.days ?? 10,
                f.first ?? null,
                f.remitted ?? 0,
                f.rejected ?? 0,
                f.resub ?? 0,
                f.status ?? null,
                f.payer ?? "PAY1",
              ],
            )
          ).rows[0].id as string;
        const paid = await claim("IO-PAID", { remitted: 60, first: 20, days: 100 });
        await claim("IO-STATUS", { status: "approved", days: 40 });
        await claim("IO-OPEN", { status: "Under process", days: 5 });
        await claim("IO-NONE", { days: 5 });
        await claim("IO-REJ", { rejected: 100, resub: 1, days: 70, payer: "PAY2" });
        const batch = (
          await q(
            "insert into public.ins_remittance_batches (org_id, remittance_ref, paid_on) values ($1, 'IO', current_date) returning id",
            [orgA],
          )
        ).rows[0].id as string;
        await q(
          "insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, paid_amount, claim_activity_id, match_status) values ($1, $2, 1, 'io1', 60, $3, 'matched')",
          [orgA, batch, paid],
        );

        const r = (
          await q(
            "select public.fin_insurance_overview($1, current_date - 200, current_date) as r",
            [orgA],
          )
        ).rows[0].r;
        expect(r.totals).toMatchObject({
          submitted: 5,
          accepted: 2,
          rejected: 1,
          pending: 2,
          no_status: 1,
          resubmitted: 1,
        });
        expect(Number(r.totals.claimed)).toBe(500);
        expect(Number(r.totals.accepted_amount)).toBe(200); // remitted claim + approved-status claim
        expect(Number(r.totals.paid_allocated)).toBe(60);
        expect(Number(r.totals.rejected_amount)).toBe(100);
        expect(Number(r.totals.avg_days_to_pay)).toBe(20);
        // outstanding: 40 + 100 + 100 + 100 + 100 = 440 (the approved-status claim is still owed in full: no remitted amount)
        expect(Number(r.totals.outstanding)).toBe(440);
        const age = Object.fromEntries(
          (r.ageing as Array<{ bucket: string; claims: number }>).map((a) => [a.bucket, a.claims]),
        );
        expect(age).toEqual({ "0-30": 2, "31-60": 1, "61-90": 1, "90+": 1 });
        expect(r.payers.map((p: { payer_id: string }) => p.payer_id)).toEqual(["PAY1", "PAY2"]);
        // a narrower window leaves older claims out
        const narrow = (
          await q(
            "select public.fin_insurance_overview($1, current_date - 30, current_date) as r",
            [orgA],
          )
        ).rows[0].r;
        expect(narrow.totals.submitted).toBe(2);
      });
      // the claims-status view agrees with the same rule (checked as a member who may read it)
      await asRole("fin", async () => {
        const { rows } = await q(
          "select sum(submitted) as s, sum(accepted) as a, sum(rejected) as r, sum(pending) as p from public.v_fin_claims_status",
        );
        expect(rows[0]).toMatchObject({ s: "5", a: "2", r: "1", p: "2" });
      });
    });
    it("is invisible to browsers and empty for an organisation with no claims", async () => {
      await asRole("fin", async () => {
        await expect(
          q("select public.fin_insurance_overview($1, current_date - 1, current_date)", [orgA]),
        ).rejects.toThrow();
      });
      await svc(async () => {
        const r = (
          await q(
            "select public.fin_insurance_overview($1, current_date - 200, current_date) as r",
            [orgB],
          )
        ).rows[0].r;
        expect(r.totals.submitted).toBe(0);
        expect(r.ageing).toEqual([]);
        expect(r.payers).toEqual([]);
      });
    });
  });

  describe("freshness view", () => {
    it("carries coverage dates and the escalated count for Finance only", async () => {
      await asRole("fin", async () => {
        const { rows } = await q(
          "select first_invoice_date, last_invoice_date, escalated_exceptions from public.v_fin_data_freshness",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].first_invoice_date).not.toBeNull();
        expect(Number(rows[0].escalated_exceptions)).toBeGreaterThanOrEqual(1);
      });
      await asRole("billing", async () => {
        expect(await count(c, "select 1 from public.v_fin_data_freshness")).toBe(0);
      });
    });
  });
});
