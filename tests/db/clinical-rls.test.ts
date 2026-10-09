/**
 * Clinical tables: cross-org isolation, PHI read gating, sign-off integrity, the audit trail, the
 * patient-facing gate function and the engine-owned-column guard. Runs only with TEST_DATABASE_URL.
 * Fake data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

describe.skipIf(!TEST_DATABASE_URL)("clinical RLS and SQL", () => {
  let c: Client;
  const u: Record<string, string> = {};
  let orgA: string;
  let orgB: string;
  const id: Record<string, string> = {};

  async function insert(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await c.query<{ id: string }>(sql + " returning id", params);
    return rows[0].id;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["admin", "bob", "marketing", "reader", "queue", "worker", "signer"])
      u[n] = await createAuthUser(c, `${n}@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", u.admin);
    orgB = await createOrg(c, "Org B", "org-b", u.bob);

    await asServiceRole(c, async () => {
      const roles: Array<[string, string, string[]]> = [
        ["marketing", "Marketing", ["contacts.view", "campaigns.view"]],
        ["reader", "Reader", ["portal.*.read"]], // Agent-style: reads every portal object
        ["queue", "Queue only", ["portal.clinical_followups.read"]],
        ["worker", "Worker", ["portal.clinical_followups.read", "portal.clinical_followups.write"]],
        ["signer", "Signer", ["clinical.settings.manage"]],
      ];
      for (const [user, name, perms] of roles) {
        const roleId = await insert(
          "insert into public.roles (org_id, name, permissions) values ($1,$2,$3::jsonb)",
          [orgA, name, JSON.stringify(perms)],
        );
        await c.query(
          "insert into public.memberships (org_id, user_id, role_id, status) values ($1,$2,$3,'active')",
          [orgA, u[user], roleId],
        );
      }
      await c.query("select public.seed_clinical_settings($1)", [orgA]);
      await c.query("select public.seed_clinical_settings($1)", [orgB]);
      for (const [tag, org] of [
        ["a", orgA],
        ["b", orgB],
      ] as const) {
        id[`contact_${tag}`] = await insert(
          "insert into public.contacts (org_id, first_name) values ($1,'Test')",
          [org],
        );
        id[`visit_${tag}`] = await insert(
          "insert into public.visits (org_id, contact_id, external_id, visit_date) values ($1,$2,$3,'2026-03-10')",
          [org, id[`contact_${tag}`], `V-${tag}`],
        );
        id[`rx_${tag}`] = await insert(
          "insert into public.prescriptions (org_id, visit_id, external_key, medication_code) values ($1,$2,$3,'M1')",
          [org, id[`visit_${tag}`], `V-${tag}-1`],
        );
        await c.query(
          "insert into public.prescription_sequences (org_id, prescription_id) values ($1,$2)",
          [org, id[`rx_${tag}`]],
        );
        id[`eval_${tag}`] = await insert(
          `insert into public.visit_rule_evaluations (org_id, visit_id, engine_version, rules_fired, trigger_category, dedupe_key)
           values ($1,$2,'1','{GP-04-PROC}','post_procedure',$3)`,
          [org, id[`visit_${tag}`], `V-${tag}-post_procedure`],
        );
        id[`fu_${tag}`] = await insert(
          `insert into public.clinical_followups (org_id, visit_id, contact_id, rule_evaluation_id, trigger_category, dedupe_key)
           values ($1,$2,$3,$4,'post_procedure',$5)`,
          [
            org,
            id[`visit_${tag}`],
            id[`contact_${tag}`],
            id[`eval_${tag}`],
            `V-${tag}-post_procedure`,
          ],
        );
        await c.query(
          "insert into public.clinical_feedback (org_id, contact_id, stage, score) values ($1,$2,'day3_antibiotics',7)",
          [org, id[`contact_${tag}`]],
        );
        await c.query(
          "insert into public.clinical_message_log (org_id, template_key, idempotency_key, contact_id) values ($1,'ABX_DAY3',$2,$3)",
          [org, `rx-${tag}:ABX_DAY3`, id[`contact_${tag}`]],
        );
      }
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  const PHI = [
    "visits",
    "prescriptions",
    "prescription_sequences",
    "visit_rule_evaluations",
    "clinical_followups",
    "clinical_feedback",
    "clinical_message_log",
  ];

  it("seeds the settings with the four blocking items, the gate closed and nothing signed by accident", async () => {
    const { rows } = await c.query(
      "select count(*)::int as total, count(*) filter (where sign_off_status='blocking')::int as blocking, count(*) filter (where sign_off_status='approved')::int as approved from public.clinical_settings where org_id=$1",
      [orgA],
    );
    expect(rows[0].total).toBeGreaterThanOrEqual(65);
    expect(rows[0].blocking).toBe(4);
    expect(rows[0].approved).toBe(3); // the three governance rows already approved in Airtable
    const { rows: gate } = await c.query("select app.clinical_messaging_enabled($1) as on", [orgA]);
    expect(gate[0].on).toBe(false);
    // re-running the seed adds nothing
    await asServiceRole(c, () => c.query("select public.seed_clinical_settings($1)", [orgA]));
    expect(await count(c, "select 1 from public.clinical_settings where org_id=$1", [orgA])).toBe(
      rows[0].total,
    );
  });

  it("keeps each org's clinical data invisible to the other", async () => {
    for (const t of [...PHI, "clinical_settings", "clinical_settings_history"]) {
      expect(
        await asUser(c, u.admin, () =>
          count(c, `select 1 from public.${t} where org_id = $1`, [orgB]),
        ),
        t,
      ).toBe(0);
    }
    expect(await asUser(c, u.admin, () => count(c, "select 1 from public.visits"))).toBe(1);
  });

  it("gates clinical reads on a portal permission: marketing sees none of it, readers see it", async () => {
    for (const t of PHI) {
      expect(
        await asUser(c, u.marketing, () => count(c, `select 1 from public.${t}`)),
        `marketing/${t}`,
      ).toBe(0);
      expect(
        await asUser(c, u.reader, () => count(c, `select 1 from public.${t}`)),
        `reader/${t}`,
      ).toBe(1);
    }
    // the queue permission alone reads the queue and its evaluations, not the visits themselves
    expect(
      await asUser(c, u.queue, () => count(c, "select 1 from public.clinical_followups")),
    ).toBe(1);
    expect(
      await asUser(c, u.queue, () => count(c, "select 1 from public.visit_rule_evaluations")),
    ).toBe(1);
    expect(await asUser(c, u.queue, () => count(c, "select 1 from public.visits"))).toBe(0);
    expect(await asUser(c, u.queue, () => count(c, "select 1 from public.prescriptions"))).toBe(0);
    // the portal view is security-invoker: same gate
    expect(
      await asUser(c, u.marketing, () => count(c, "select 1 from public.v_followup_queue")),
    ).toBe(0);
    expect(await asUser(c, u.reader, () => count(c, "select 1 from public.v_followup_queue"))).toBe(
      1,
    );
  });

  it("only the permission holder edits the queue, and never the engine-owned columns", async () => {
    const upd = (user: string, sql: string) => asUser(c, u[user], () => c.query(sql, [id.fu_a]));
    expect(
      (await upd("reader", "update public.clinical_followups set notes='x' where id=$1")).rowCount,
    ).toBe(0);
    expect(
      (
        await upd(
          "worker",
          "update public.clinical_followups set call_status='completed', notes='called' where id=$1",
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      upd("worker", "update public.clinical_followups set dedupe_key='tampered' where id=$1"),
    ).rejects.toThrow(/engine-owned/);
    await expect(
      upd("worker", "update public.clinical_followups set trigger_category='vitals' where id=$1"),
    ).rejects.toThrow(/engine-owned/);
    // the engine (service role, no auth.uid) may
    expect(
      (
        await asServiceRole(c, () =>
          c.query("update public.clinical_followups set trigger_category='vitals' where id=$1", [
            id.fu_a,
          ]),
        )
      ).rowCount,
    ).toBe(1);
    await asServiceRole(c, () =>
      c.query(
        "update public.clinical_followups set trigger_category='post_procedure' where id=$1",
        [id.fu_a],
      ),
    );
  });

  it("writes to engine-owned tables are service-role only", async () => {
    await expect(
      asUser(c, u.worker, () =>
        c.query("update public.visits set temp_c = 41 where id = $1", [id.visit_a]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      asUser(c, u.admin, () =>
        c.query(
          "insert into public.clinical_message_log (org_id, template_key, idempotency_key) values ($1,'X','k')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  describe("sign-off", () => {
    const sign = (user: string, key: string, value: string | null, status = "approved") =>
      asUser(c, u[user], () =>
        c.query(
          `update public.clinical_settings set approved_value=$3, sign_off_status=$4::public.sign_off_status,
             signed_by = case when $4 = 'approved' then 'Dr Signer' else null end,
             signed_at = case when $4 = 'approved' then current_date else null end
           where org_id=$1 and key=$2`,
          [orgA, key, value, status],
        ),
      );
    const setting = async (key: string) =>
      (await c.query("select public.clinical_setting($1,$2) as v", [orgA, key])).rows[0].v as
        string | null;

    it("members read thresholds; only clinical.settings.manage signs", async () => {
      expect(
        await asUser(c, u.marketing, () => count(c, "select 1 from public.clinical_settings")),
      ).toBeGreaterThan(60);
      expect((await sign("worker", "adult_fever_temp_c", "39.0")).rowCount).toBe(0);
      expect((await sign("signer", "adult_fever_temp_c", "39.0")).rowCount).toBe(1);
    });

    it("an unsigned setting is NULL to the rules; signing makes it available", async () => {
      expect(await setting("adult_pulse_high")).toBeNull();
      expect(await setting("adult_fever_temp_c")).toBe("39.0");
      expect(
        (await c.query("select public.clinical_setting_num($1,'adult_fever_temp_c') as n", [orgA]))
          .rows[0].n,
      ).toBe("39.0");
    });

    it("rejects a half-signed row in either direction", async () => {
      await expect(
        asUser(c, u.signer, () =>
          c.query(
            "update public.clinical_settings set sign_off_status='approved' where org_id=$1 and key='adult_pulse_high'",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/approved_requires_signature/);
      await expect(
        asUser(c, u.signer, () =>
          c.query(
            "update public.clinical_settings set approved_value='110' where org_id=$1 and key='adult_pulse_high'",
            [orgA],
          ),
        ),
      ).rejects.toThrow(/approved_value_requires_approved_status/);
    });

    it("records who changed what in the history, including revocation", async () => {
      await sign("signer", "adult_fever_temp_c", null, "awaiting");
      expect(await setting("adult_fever_temp_c")).toBeNull();
      const { rows } = await c.query(
        "select changed_by, old_row->>'approved_value' as was, new_row->>'approved_value' as now from public.clinical_settings_history where org_id=$1 and setting_key='adult_fever_temp_c' order by id",
        [orgA],
      );
      const byUser = rows.filter((r) => r.changed_by === u.signer);
      expect(byUser.map((r) => [r.was, r.now])).toEqual([
        [null, "39.0"],
        ["39.0", null],
      ]);
      expect(rows.some((r) => r.changed_by === null)).toBe(true); // the service-role seed
      // only the sign-off permission reads the trail
      expect(
        await asUser(c, u.signer, () =>
          count(c, "select 1 from public.clinical_settings_history where org_id=$1", [orgA]),
        ),
      ).toBeGreaterThan(0);
      expect(
        await asUser(c, u.reader, () => count(c, "select 1 from public.clinical_settings_history")),
      ).toBe(0);
    });

    it("proposed values stand in only after allow_unsigned_defaults is itself signed off", async () => {
      expect(await setting("adult_pulse_high")).toBeNull();
      await sign("signer", "allow_unsigned_defaults", "true");
      expect(await setting("adult_pulse_high")).toBe("110"); // proposed value, validation mode
      await sign("signer", "allow_unsigned_defaults", null, "awaiting");
      expect(await setting("adult_pulse_high")).toBeNull();
    });

    it("the patient-facing gate opens only for a signed-off true, never via unsigned defaults", async () => {
      const gate = async () =>
        (await c.query("select app.clinical_messaging_enabled($1) as on", [orgA])).rows[0].on;
      expect(await gate()).toBe(false);
      await sign("signer", "allow_unsigned_defaults", "true"); // validation mode on
      await asServiceRole(c, () =>
        c.query(
          "update public.clinical_settings set proposed_value='true' where org_id=$1 and key='clinical_messaging_enabled'",
          [orgA],
        ),
      );
      expect(await gate()).toBe(false); // proposed true + unsigned defaults is still closed
      await sign("signer", "clinical_messaging_enabled", "false");
      expect(await gate()).toBe(false);
      await sign("signer", "clinical_messaging_enabled", "true");
      expect(await gate()).toBe(true);
      expect(
        (await c.query("select app.clinical_messaging_enabled($1) as on", [orgB])).rows[0].on,
      ).toBe(false); // per org
      await sign("signer", "clinical_messaging_enabled", null, "awaiting"); // revoked again
      expect(await gate()).toBe(false);
      await sign("signer", "allow_unsigned_defaults", null, "awaiting");
    });
  });

  it("enforces data integrity", async () => {
    // rules fired ⇔ category ⇔ key
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.visit_rule_evaluations (org_id, visit_id, engine_version, is_current, rules_fired) values ($1,$2,'1',false,'{GP-04-PROC}')",
          [orgA, id.visit_a],
        ),
      ),
    ).rejects.toThrow(/category_iff_rules/);
    // one live follow-up per key
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.clinical_followups (org_id, visit_id, trigger_category, dedupe_key) values ($1,$2,'post_procedure','V-a-post_procedure')",
          [orgA, id.visit_a],
        ),
      ),
    ).rejects.toThrow(/duplicate key/);
    // a closed one frees the key
    await asServiceRole(c, () =>
      c.query(
        "update public.clinical_followups set closed_at=now(), closed_reason='superseded' where id=$1",
        [id.fu_a],
      ),
    );
    await asServiceRole(c, () =>
      c.query(
        "insert into public.clinical_followups (org_id, visit_id, trigger_category, dedupe_key) values ($1,$2,'post_procedure','V-a-post_procedure')",
        [orgA, id.visit_a],
      ),
    );
    // dual notification is all-or-nothing
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.clinical_feedback (org_id, stage, score, needs_doctor_review, doctor_notified_at) values ($1,'day3_antibiotics',2,true,now())",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/red_flag_notification_pair/);
    // a test record can never have been sent live
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.clinical_message_log (org_id, template_key, idempotency_key, is_test_record, send_mode, status) values ($1,'X','live-test','true','live','sent')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/test_records_never_live/);
    // implausible vitals and out-of-range scores are refused
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.visits (org_id, external_id, visit_date, spo2) values ($1,'V-bad','2026-03-10',140)",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/spo2_plausible/);
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.clinical_feedback (org_id, stage, score) values ($1,'day3_antibiotics',11)",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/score_in_range/);
    // cross-org references
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.visits (org_id, external_id, visit_date, contact_id) values ($1,'V-x','2026-03-10',$2)",
          [orgA, id.contact_b],
        ),
      ),
    ).rejects.toThrow(/does not belong to org/);
    // heuristic classifications can't take effect
    await expect(
      asServiceRole(c, () =>
        c.query(
          "insert into public.ref_medication_classes (org_id, unite_local_code, class, classified_by) values ($1,'C1','antibiotic','heuristic')",
          [orgA],
        ),
      ),
    ).rejects.toThrow(/heuristic_is_unclassified/);
  });
});
