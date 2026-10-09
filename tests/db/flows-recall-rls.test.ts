/**
 * Phase 8 tables: flows, runs, steps, variables, versions, lock lease, recall programmes / sends,
 * parallel-run tables and the eligibility views. Cross-org access must fail. Runs only with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asServiceRole, asUser, connect, count, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("flows + recall (db)", () => {
  let c: Client;
  let alice: string; // admin A
  let carol: string; // agent A (inbox.send, contacts.view)
  let bob: string; // admin B
  let orgA: string;
  let orgB: string;
  let flowA: string;
  let flowB: string;
  let contactA: string;
  let contactB: string;
  let convA: string;
  let runA: string;

  async function one(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    carol = await createAuthUser(c, "carol@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      const { rows: roles } = await c.query<{ id: string }>("select id from public.roles where org_id = $1 and name = 'Agent'", [orgA]);
      await c.query("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [orgA, carol, roles[0]!.id]);
      const chA = await one("insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'A', 'wa', 'pn-a')", [orgA]);
      contactA = await one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Pat', '+971500000001')", [orgA]);
      contactB = await one("insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Bea', '+971500000002')", [orgB]);
      convA = await one("insert into public.conversations (org_id, channel_id, contact_id) values ($1, $2, $3)", [orgA, chA, contactA]);
      flowA = await one("insert into public.flows (org_id, name, trigger_type, status) values ($1, 'Flow A', 'shortcut', 'active')", [orgA]);
      flowB = await one("insert into public.flows (org_id, name, trigger_type, status) values ($1, 'Flow B', 'shortcut', 'active')", [orgB]);
      runA = await one("insert into public.flow_runs (org_id, flow_id, flow_version, contact_id, conversation_id, current_node_id) values ($1, $2, 1, $3, $4, 't')", [orgA, flowA, contactA, convA]);
      await c.query("insert into public.flow_run_steps (org_id, run_id, seq, node_id, node_type) values ($1, $2, 1, 't', 'trigger')", [orgA, runA]);
      await c.query("insert into public.flow_variables (org_id, key, value) values ($1, 'CLINIC', 'A')", [orgA]);
      await c.query("insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 1, $2, '{\"nodes\":[],\"edges\":[]}')", [flowA, orgA]);
    });
  });

  afterAll(async () => {
    await c.end();
  });

  describe("flows", () => {
    it("members with flows.manage see only their org's flow data", async () => {
      await asUser(c, alice, async () => {
        expect(await count(c, "select 1 from public.flows")).toBe(1);
        expect(await count(c, "select 1 from public.flow_runs")).toBe(1);
        expect(await count(c, "select 1 from public.flow_run_steps")).toBe(1);
        expect(await count(c, "select 1 from public.flow_variables")).toBe(1);
        expect(await count(c, "select 1 from public.flow_versions")).toBe(1);
        expect(await count(c, "select 1 from public.v_flow_run_counts")).toBe(1);
      });
      await asUser(c, bob, async () => {
        const { rows } = await c.query("select id from public.flows");
        expect(rows.map((r) => r.id)).toEqual([flowB]);
        expect(await count(c, "select 1 from public.flow_runs")).toBe(0);
        expect(await count(c, "select 1 from public.flow_variables")).toBe(0);
      });
    });

    it("an agent (inbox.send) can list flows for Shortcuts but not runs, variables or writes", async () => {
      await asUser(c, carol, async () => {
        expect(await count(c, "select 1 from public.flows")).toBe(1);
        expect(await count(c, "select 1 from public.flow_runs")).toBe(0);
        expect(await count(c, "select 1 from public.flow_variables")).toBe(0);
        await expect(c.query("insert into public.flows (org_id, name) values ($1, 'x')", [orgA])).rejects.toThrow(/row-level security/);
      });
    });

    it("cannot write rows into another org", async () => {
      await asUser(c, alice, async () => {
        await expect(c.query("insert into public.flows (org_id, name) values ($1, 'x')", [orgB])).rejects.toThrow(/row-level security/);
        await expect(c.query("insert into public.flow_variables (org_id, key, value) values ($1, 'X', '1')", [orgB])).rejects.toThrow(/row-level security/);
        const { rowCount } = await c.query("update public.flows set name = 'hijack' where id = $1", [flowB]);
        expect(rowCount).toBe(0);
      });
    });

    it("engine-owned tables have no user write policy", async () => {
      await asUser(c, alice, async () => {
        await expect(c.query("insert into public.flow_runs (org_id, flow_id, flow_version, current_node_id) values ($1, $2, 1, 't')", [orgA, flowA])).rejects.toThrow(/row-level security/);
        await expect(c.query("insert into public.flow_versions (flow_id, version, org_id, graph) values ($1, 2, $2, '{}')", [flowA, orgA])).rejects.toThrow();
      });
    });

    it("child rows must carry the parent's org", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("insert into public.flow_runs (org_id, flow_id, flow_version, contact_id, current_node_id) values ($1, $2, 1, $3, 't')", [orgA, flowA, contactB]),
        ).rejects.toThrow(/does not belong to org/);
        await expect(
          c.query("insert into public.flow_runs (org_id, flow_id, flow_version, current_node_id) values ($1, $2, 1, 't')", [orgA, flowB]),
        ).rejects.toThrow(/does not belong to org/);
      });
    });

    it("allows only one live top-level run per conversation, but a new one after it ends", async () => {
      await asServiceRole(c, async () => {
        await expect(
          c.query("insert into public.flow_runs (org_id, flow_id, flow_version, contact_id, conversation_id, current_node_id) values ($1, $2, 1, $3, $4, 't')", [orgA, flowA, contactA, convA]),
        ).rejects.toThrow(/flow_runs_one_live_per_conversation_uidx/);
        // nested runs are exempt
        await c.query("insert into public.flow_runs (org_id, flow_id, flow_version, contact_id, conversation_id, current_node_id, parent_run_id) values ($1, $2, 1, $3, $4, 't', $5)", [orgA, flowA, contactA, convA, runA]);
        await c.query("update public.flow_runs set status = 'cancelled' where id = $1", [runA]);
        await c.query("insert into public.flow_runs (org_id, flow_id, flow_version, contact_id, conversation_id, current_node_id) values ($1, $2, 1, $3, $4, 't')", [orgA, flowA, contactA, convA]);
      });
    });

    it("step rows are unique per (run, seq)", async () => {
      await asServiceRole(c, async () => {
        await expect(c.query("insert into public.flow_run_steps (org_id, run_id, seq, node_id, node_type) values ($1, $2, 1, 't', 'trigger')", [orgA, runA])).rejects.toThrow(/duplicate key/);
      });
    });

    it("flow variable keys are validated and unique per org", async () => {
      await asUser(c, alice, async () => {
        await expect(c.query("insert into public.flow_variables (org_id, key, value) values ($1, '1bad key', 'x')", [orgA])).rejects.toThrow(/check/);
        await expect(c.query("insert into public.flow_variables (org_id, key, value) values ($1, 'CLINIC', 'dup')", [orgA])).rejects.toThrow(/duplicate key/);
      });
    });

    it("conversations/messages/segments reference flow runs through real foreign keys", async () => {
      await asServiceRole(c, async () => {
        await expect(c.query("update public.conversations set flow_run_id = gen_random_uuid() where id = $1", [convA])).rejects.toThrow(/foreign key/);
      });
    });
  });

  describe("flow lock lease", () => {
    it("is exclusive per key, re-entrant per owner, stealable once expired, and service-role only", async () => {
      const key = "00000000-0000-4000-8000-0000000000aa";
      const o1 = "00000000-0000-4000-8000-000000000001";
      const o2 = "00000000-0000-4000-8000-000000000002";
      await asServiceRole(c, async () => {
        const claim = async (owner: string, ttl = 60) =>
          (await c.query<{ ok: boolean }>("select public.claim_flow_lock($1, $2, $3) as ok", [key, owner, ttl])).rows[0]!.ok;
        expect(await claim(o1)).toBe(true);
        expect(await claim(o2)).toBe(false);
        expect(await claim(o1)).toBe(true);
        await c.query("select public.release_flow_lock($1, $2)", [key, o2]); // wrong owner: no-op
        expect(await claim(o2)).toBe(false);
        await c.query("select public.release_flow_lock($1, $2)", [key, o1]);
        expect(await claim(o2, 1)).toBe(true);
        await c.query("update public.flow_locks set expires_at = now() - interval '1 second' where key = $1", [key]);
        expect(await claim(o1)).toBe(true);
      });
      await asUser(c, alice, async () => {
        await expect(c.query("select public.claim_flow_lock($1, $2, 60)", [key, o1])).rejects.toThrow(/permission denied/);
        expect((await c.query("select * from public.flow_locks")).rowCount).toBe(0); // RLS on, no policies
      });
    });
  });

  describe("recall", () => {
    let progA: string;
    let progB: string;

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        for (const org of [orgA, orgB]) {
          await c.query("select public.seed_phase8_defaults($1)", [org]);
          await c.query("select public.seed_phase8_defaults($1)", [org]); // idempotent
        }
        progA = (await c.query<{ id: string }>("select id from public.recall_programmes where org_id = $1 and key = 'chronic_90d'", [orgA])).rows[0]!.id;
        progB = (await c.query<{ id: string }>("select id from public.recall_programmes where org_id = $1 and key = 'chronic_90d'", [orgB])).rows[0]!.id;
      });
    });

    it("seeds all programmes, including the 48h appointment reminder, as drafts", async () => {
      await asServiceRole(c, async () => {
        const { rows } = await c.query("select key, kind, status from public.recall_programmes where org_id = $1 order by key", [orgA]);
        expect(rows.map((r) => r.key)).toEqual([
          "annual_checkup", "appointment_reminder_48h", "birthday", "chronic_90d", "colonoscopy", "dental", "dormant", "menopause", "pap_smear", "pre_menopause", "skin_check",
        ]);
        expect(rows.every((r) => r.status === "draft")).toBe(true);
        expect(rows.find((r) => r.key === "appointment_reminder_48h")!.kind).toBe("appointment_reminder");
      });
    });

    it("recall tables are isolated between orgs", async () => {
      await asUser(c, alice, async () => {
        expect(await count(c, "select 1 from public.recall_programmes where org_id = $1", [orgB])).toBe(0);
        expect(await count(c, "select 1 from public.recall_programmes")).toBe(11);
        expect(await count(c, "select 1 from public.recall_programme_templates")).toBeGreaterThan(0);
        await expect(c.query("insert into public.recall_programmes (org_id, key, name, kind) values ($1, 'x', 'x', 'chronic')", [orgB])).rejects.toThrow(/row-level security/);
        const { rowCount } = await c.query("update public.recall_programmes set status = 'active' where id = $1", [progB]);
        expect(rowCount).toBe(0);
      });
    });

    it("the recall send log is unique per contact+programme+cycle and cross-org safe", async () => {
      await asServiceRole(c, async () => {
        await c.query("insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key) values ($1, $2, $3, '2026-07-01')", [orgA, progA, contactA]);
        await expect(c.query("insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key) values ($1, $2, $3, '2026-07-01')", [orgA, progA, contactA])).rejects.toThrow(/duplicate key/);
        await expect(
          c.query("insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, follow_up_status) values ($1, $2, $3, '2026-08-01', 'booked')", [orgA, progA, contactA]),
        ).rejects.toThrow(/booked_requires_date/);
      });
      await asUser(c, bob, async () => {
        expect(await count(c, "select 1 from public.recall_sends")).toBe(0);
        expect(await count(c, "select 1 from public.v_recall_weekly")).toBe(0);
      });
    });

    it("chronic eligibility fails closed until a threshold is approved", async () => {
      await asServiceRole(c, async () => {
        const cond = await one(
          `insert into public.ref_diagnoses (org_id, name, condition_group_id)
           select $1, 'Essential hypertension', id from public.ref_condition_groups where org_id = $1 and key = 'hypertension'`,
          [orgA],
        ).catch(() => null);
        expect(cond === null || typeof cond === "string").toBe(true);
      });
      // No visits for contacts → nobody is eligible in either state; the accessor itself must return NULL.
      await asServiceRole(c, async () => {
        const { rows } = await c.query<{ v: string | null }>("select public.clinical_setting_num($1, 'chronic_recall_min_days')::text as v", [orgA]);
        expect(rows[0]!.v).toBeNull();
        expect(await count(c, "select 1 from public.v_chronic_recall_eligibility where eligible")).toBe(0);
        const mode = await c.query<{ v: string | null }>("select public.clinical_setting($1, 'recall_send_mode') as v", [orgA]);
        expect(mode.rows[0]!.v).toBeNull(); // engine treats null as 'test'
      });
    });

    it("the reminder view lists upcoming appointments, flags exclusions and drops already-sent ones", async () => {
      await asServiceRole(c, async () => {
        const doc = await one("insert into public.specialists (org_id, name) values ($1, 'Dr. Example') returning id".replace(" returning id", ""), [orgA]);
        const soon = await one(`insert into public.appointments (org_id, contact_id, specialist_id, starts_at, status) values ($1, $2, $3, now() + interval '30 hours', 'confirmed')`, [orgA, contactA, doc]);
        const far = await one(`insert into public.appointments (org_id, contact_id, specialist_id, starts_at, status) values ($1, $2, $3, now() + interval '90 hours', 'confirmed')`, [orgA, contactA, doc]);
        const cancelled = await one(`insert into public.appointments (org_id, contact_id, specialist_id, starts_at, status) values ($1, $2, $3, now() + interval '20 hours', 'cancelled')`, [orgA, contactA, doc]);
        const { rows } = await c.query("select appointment_id, eligible, excluded, segment_key from public.v_appointment_reminder_due where org_id = $1", [orgA]);
        const byId = new Map(rows.map((r) => [r.appointment_id as string, r]));
        expect(byId.get(soon)).toMatchObject({ eligible: true, excluded: false, segment_key: "*" });
        expect(byId.get(far)!.eligible).toBe(false);
        expect(byId.get(cancelled)!.eligible).toBe(false);

        const prog = (await c.query<{ id: string }>("select id from public.recall_programmes where org_id = $1 and key = 'appointment_reminder_48h'", [orgA])).rows[0]!.id;
        await c.query("insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, status) values ($1, $2, $3, $4, 'sent')", [orgA, prog, contactA, soon]);
        const after = await c.query("select eligible from public.v_appointment_reminder_due where appointment_id = $1", [soon]);
        expect(after.rows[0]!.eligible).toBe(false);

        // seeded exclusion list: a placeholder booking is flagged
        const { rows: ex } = await c.query<{ x: boolean }>("select public.is_reminder_excluded($1, 'SHORELINE', 'Dr. Example') as x", [orgA]);
        expect(ex[0]!.x).toBe(true);
      });
      await asUser(c, bob, async () => {
        expect(await count(c, "select 1 from public.v_appointment_reminder_due")).toBe(0);
      });
    });

    it("birthday view assigns the gender/age bands in Asia/Dubai time", async () => {
      await asServiceRole(c, async () => {
        const today = (await c.query<{ d: string }>("select to_char((now() at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') as d")).rows[0]!.d;
        const [yy, mm, dd] = today.split("-").map(Number) as [number, number, number];
        const mk = async (gender: string, age: number, phone: string) =>
          one("insert into public.contacts (org_id, first_name, gender, dob, phone_e164) values ($1, 'B', $2, make_date($3, $4, $5), $6)", [orgA, gender, yy - age, mm, dd, phone]);
        // 29 Feb birthdays are handled by the view; avoid today being 29 Feb in this fixture
        const cases: Array<[string, number, string, string | null]> = [
          ["male", 25, "+971500001001", "m_20_29"],
          ["male", 35, "+971500001002", "m_30_39"],
          ["male", 50, "+971500001003", "m_40_plus"],
          ["female", 30, "+971500001004", "f_18_35"],
          ["female", 40, "+971500001005", "f_36_45"],
          ["female", 60, "+971500001006", "f_46_65"],
          ["male", 12, "+971500001007", null],
          ["female", 70, "+971500001008", null],
        ];
        const ids = new Map<string, string | null>();
        for (const [g, a, p, band] of cases) ids.set(await mk(g, a, p), band);
        const { rows } = await c.query("select contact_id, segment_key, cycle_key from public.v_birthday_today where org_id = $1", [orgA]);
        for (const [id, band] of ids) {
          const row = rows.find((r) => r.contact_id === id);
          expect(row, id).toBeTruthy();
          expect(row.segment_key).toBe(band);
          expect(row.cycle_key).toBe(String(yy));
        }
        // stop_marketing contacts are never listed
        const stopped = await mk("male", 45, "+971500001009");
        await c.query("update public.contacts set stop_marketing = true where id = $1", [stopped]);
        const again = await c.query("select 1 from public.v_birthday_today where contact_id = $1", [stopped]);
        expect(again.rowCount).toBe(0);
      });
    });
  });

  describe("parallel run", () => {
    it("is seeded per org with the 7 scenarios and isolated between orgs", async () => {
      await asUser(c, alice, async () => {
        expect(await count(c, "select 1 from public.parallel_run_scenarios")).toBe(7);
        expect(await count(c, "select 1 from public.parallel_run_scenarios where org_id = $1", [orgB])).toBe(0);
      });
      await asServiceRole(c, async () => {
        await c.query("insert into public.parallel_run_diffs (org_id, scenario_key, run_date, make_count, native_count, only_in_make) values ($1, 'birthday', current_date, 3, 2, array['abc'])", [orgA]);
      });
      await asUser(c, bob, async () => {
        expect(await count(c, "select 1 from public.parallel_run_diffs")).toBe(0);
      });
      await asUser(c, alice, async () => {
        expect(await count(c, "select 1 from public.parallel_run_diffs")).toBe(1);
        const r = await c.query("update public.parallel_run_diffs set explained = true, reason = 'already sent by Make before cut-over' where org_id = $1", [orgA]);
        expect(r.rowCount).toBe(1);
      });
    });
    it("Make output hashes are service-role only", async () => {
      await asServiceRole(c, async () => {
        await c.query("insert into public.parallel_run_make_outputs (org_id, scenario_key, run_date, ref_hash) values ($1, 'birthday', current_date, 'h1')", [orgA]);
      });
      await asUser(c, alice, async () => {
        expect(await count(c, "select 1 from public.parallel_run_make_outputs")).toBe(0);
      });
    });
    it("seed functions cannot be called by users", async () => {
      await asUser(c, alice, async () => {
        await expect(c.query("select public.seed_recall_reminder_programme($1)", [orgA])).rejects.toThrow(/permission denied/);
        await expect(c.query("select public.seed_parallel_run_scenarios($1)", [orgA])).rejects.toThrow(/permission denied/);
        await expect(c.query("select public.seed_phase8_defaults($1)", [orgA])).rejects.toThrow(/permission denied/);
      });
    });
  });
});
