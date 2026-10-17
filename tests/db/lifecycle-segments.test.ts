/**
 * Track P4/P5: the lifecycle view and age band against the shared synthetic fixture (parity with the TypeScript rule),
 * the segment filters (visits, doctor, department, chronic condition, diagnosis group, lifecycle) counted on synthetic
 * patients, the consent rule (a marketing audience from a clinical filter is refused, a care audience with the same
 * filter is counted), and org isolation of the views. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { audiencePurposeProblem, segmentAudience } from "@/lib/campaigns/audience";
import { compileContactPredicate } from "@/lib/contacts/query";
import { and, cond, type Filter } from "@/lib/filters/ast";
import { buildContactFieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";

import fx from "../unit/contacts/fixtures/lifecycle.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const registry = buildContactFieldRegistry();

describe.skipIf(!TEST_DATABASE_URL)("Lifecycle and segments v2 (Track P4/P5)", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let stranger: string;
  const id: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const one = async (sql: string, p: unknown[] = []) =>
    (await q(`${sql} returning id::text`, p)).rows[0].id as string;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  async function countFor(filter: Filter): Promise<number> {
    const { sql, params } = compileContactPredicate(registry, filter, null, "UTC");
    return svc(async () => {
      const { rows } = await q("select public.contacts_count($1, $2, $3::jsonb) as n", [
        org,
        sql,
        JSON.stringify(params),
      ]);
      return Number(rows[0].n);
    });
  }
  const f = (...conds: ReturnType<typeof cond>[]): Filter => ({
    include: and(...conds),
    exclude: null,
  });

  /** A supabase-js look-alike over pg for the few calls segmentAudience makes (service role). */
  function shim() {
    const calls: string[] = [];
    const admin = {
      from(table: string) {
        const where: string[] = [];
        const args: unknown[] = [];
        const b: Record<string, unknown> = {};
        const run = async () => {
          const { rows } = await svc(() =>
            q(
              `select * from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""}`,
              args,
            ),
          );
          return rows;
        };
        b.select = () => b;
        b.order = () => b;
        b.eq = (k: string, v: unknown) => (args.push(v), where.push(`${k} = $${args.length}`), b);
        b.in = (k: string, vs: unknown[]) => (
          args.push(vs),
          where.push(`${k} = any($${args.length})`),
          b
        );
        b.maybeSingle = async () => ({ data: (await run())[0] ?? null, error: null });
        b.then = (resolve: (v: unknown) => void) =>
          run().then((rows) =>
            resolve({ data: rows.map((r) => ({ ...r, contact_tags: [] })), error: null }),
          );
        return b;
      },
      async rpc(name: string, a: Record<string, unknown>) {
        calls.push(name);
        const keys = Object.keys(a);
        const vals = keys.map((k) =>
          a[k] !== null && typeof a[k] === "object" ? JSON.stringify(a[k]) : a[k],
        );
        const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
        const { rows } = await svc(() => q(sql, vals));
        return {
          data: name === "contacts_ids" ? rows.map((r) => r.contacts_ids) : rows[0][name],
          error: null,
        };
      },
    } as unknown as AdminClient;
    return { admin, calls };
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-p45@example.test");
    stranger = await createAuthUser(c, "stranger-p45@example.test");
    org = await createOrg(c, "Org P45", "org-p45", owner);
    otherOrg = await createOrg(c, "Org P45 Other", "org-p45-other", stranger);

    await svc(async () => {
      await q("update public.orgs set timezone = 'UTC' where id = $1", [org]);
      await q("select public.seed_phase8_defaults($1)", [org]);
      const group = (key: string) =>
        q("select id::text from public.ref_condition_groups where org_id = $1 and key = $2", [
          org,
          key,
        ]).then((r) => r.rows[0].id as string);
      id.gHtn = await group("hypertension");
      id.gDm = await group("diabetes");
      id.drA = await one("insert into public.specialists (org_id, name) values ($1, 'Dr Demo-A')", [
        org,
      ]);
      id.drB = await one("insert into public.specialists (org_id, name) values ($1, 'Dr Demo-B')", [
        org,
      ]);
      const dx = (code: string, chronic: boolean, g: string | null) =>
        one(
          "insert into public.ref_diagnoses (org_id, code, chronic, condition_group_id) values ($1, $2, $3, $4)",
          [org, code, chronic, g],
        );
      id.htn = await dx("I10", true, id.gHtn);
      id.dm = await dx("E11.9", true, id.gDm);
      const person = (
        first: string,
        n: number,
        pin: string | null,
        dob: string | null,
        uniteDaysAgo: number | null,
      ) =>
        one(
          `insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in, external_id, dob, unite_last_visit_date)
           values ($1, $2, 'Synthetic', $3, true, $4, $5, current_date - $6::int)`,
          [org, first, `+4477009000${String(n).padStart(2, "0")}`, pin, dob, uniteDaysAgo],
        );
      id.layla = await person("Layla Demo-01", 1, "S-1", "2020-01-01", null);
      id.omar = await person("Omar Demo-02", 2, "S-2", null, null);
      id.sara = await person("Sara Demo-03", 3, "S-3", null, null);
      id.noor = await person("Noor Demo-04", 4, "S-4", null, 100);
      id.hana = await person("Hana Demo-05", 5, null, "1980-05-05", null);
      id.zed = await person("Zed Demo-06", 6, "S-6", null, null);
      const visit = (ext: string, contact: string, days: number, doctor: string, dept: string) =>
        one(
          `insert into public.visits (org_id, contact_id, external_id, visit_date, specialist_id, department_mapped)
           values ($1, $2, $3, current_date - $4::int, $5, $6::public.department_mapped)`,
          [org, contact, ext, days, doctor, dept],
        );
      id.v1 = await visit("SYN-1", id.layla, 400, id.drA, "gp");
      id.v2 = await visit("SYN-2", id.layla, 20, id.drA, "gp");
      await visit("SYN-3", id.omar, 30, id.drB, "paediatrics");
      await visit("SYN-4", id.sara, 700, id.drA, "gynaecology");
      await q(
        "insert into public.visit_diagnoses (org_id, visit_id, contact_id, ref_diagnosis_id, diagnosis_code, visit_date) values ($1, $2, $3, $4, 'I10', current_date - 20)",
        [org, id.v2, id.layla, id.htn],
      );
      await q(
        "insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id, source) values ($1, $2, $3, 'manual')",
        [org, id.layla, id.htn],
      );
      await q(
        "insert into public.contacts (org_id, first_name, last_name, external_id) values ($1, 'Other', 'Org', 'X-1')",
        [otherOrg],
      );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  // ---- parity ----
  it("app.contact_lifecycle_stage matches the TypeScript rule on every fixture case", async () => {
    await svc(async () => {
      for (const t of fx.lifecycle) {
        const { rows } = await q(
          "select app.contact_lifecycle_stage($1, $2::date, $3::date, $4::date, $5, $6) as s",
          [t.pin, t.first, t.last, t.today, t.newPatientDays ?? 90, t.activeMonths ?? 18],
        );
        expect(rows[0].s, t.name).toBe(t.expected);
      }
    });
  });

  it("app.contact_age_band matches the TypeScript rule on every fixture case", async () => {
    await svc(async () => {
      for (const t of fx.ageBand) {
        const { rows } = await q("select app.contact_age_band($1::date, $2::date) as b", [
          t.dob,
          t.today,
        ]);
        expect(rows[0].b, `${t.dob} on ${t.today}`).toBe(t.expected);
      }
    });
  });

  it("app.lifecycle_thresholds matches readLifecycleSettings on every settings case", async () => {
    await svc(async () => {
      for (const t of fx.settings) {
        const { rows } = await q(
          "select new_days, active_months from app.lifecycle_thresholds($1::jsonb)",
          [JSON.stringify(t.settings)],
        );
        expect(
          { newPatientDays: rows[0].new_days, activeMonths: rows[0].active_months },
          t.name,
        ).toEqual(t.expected);
      }
    });
  });

  // ---- the view ----
  const stages = async () =>
    svc(async () => {
      const { rows } = await q(
        "select contact_id::text, stage from public.v_contact_lifecycle where org_id = $1",
        [org],
      );
      return Object.fromEntries(rows.map((r) => [r.contact_id, r.stage])) as Record<string, string>;
    });

  it("derives a stage for every contact from visit dates, the PIN and the org thresholds", async () => {
    const s = await stages();
    expect(s[id.layla]).toBe("active"); // first visit 400 days ago, last 20
    expect(s[id.omar]).toBe("new_patient");
    expect(s[id.sara]).toBe("lapsed"); // 700 days is more than 18 months
    expect(s[id.noor]).toBe("active"); // Unite's patient-level date only
    expect(s[id.hana]).toBe("lead");
    expect(s[id.zed]).toBe("unknown"); // a PIN but no visit date: never guessed
    expect(Object.keys(s)).toHaveLength(6);
  });

  it("reads the thresholds from orgs.settings and survives an unreadable timezone", async () => {
    await svc(async () => {
      await q(
        `update public.orgs set settings = settings || '{"lifecycle":{"newPatientDays":10,"activeMonths":30}}'::jsonb where id = $1`,
        [org],
      );
      let s = await stages();
      expect(s[id.omar]).toBe("active"); // first visit 30 days ago, new window is now 10
      expect(s[id.sara]).toBe("active"); // 700 days is inside 30 months
      await q("update public.orgs set timezone = 'Not/AZone' where id = $1", [org]);
      s = await stages();
      expect(s[id.omar]).toBe("active");
      await q(
        `update public.orgs set timezone = 'UTC', settings = settings - 'lifecycle' where id = $1`,
        [org],
      );
    });
    expect((await stages())[id.omar]).toBe("new_patient");
  });

  it("shows nothing across organisations (RLS through security_invoker)", async () => {
    const mine = await asUser(c, stranger, async () => {
      const { rows } = await q("select org_id::text from public.v_contact_lifecycle");
      return rows;
    });
    expect(mine.length).toBe(1);
    expect(mine.every((r) => r.org_id === otherOrg)).toBe(true);
    const ages = await asUser(
      c,
      stranger,
      async () => (await q("select org_id::text from public.v_contact_age_band")).rows,
    );
    expect(ages.every((r) => r.org_id === otherOrg)).toBe(true);
  });

  // ---- filters ----
  it("counts each new segment filter on synthetic patients", async () => {
    expect(await countFor(f(cond("lifecycle_stage", "eq", "lapsed")))).toBe(1);
    expect(await countFor(f(cond("lifecycle_stage", "in", ["active", "new_patient"])))).toBe(3);
    expect(await countFor(f(cond("lifecycle_stage", "neq", "lapsed")))).toBe(5);
    expect(await countFor(f(cond("visit_count", "gte", 2)))).toBe(1);
    expect(await countFor(f(cond("visit_count", "eq", 0)))).toBe(3);
    expect(await countFor(f(cond("visit_doctor", "eq", id.drA)))).toBe(2);
    expect(await countFor(f(cond("visit_department", "in", ["gp", "paediatrics"])))).toBe(2);
    expect(await countFor(f(cond("last_visit", "within_last", 60)))).toBe(2);
    expect(await countFor(f(cond("last_visit", "older_than", 365)))).toBe(1);
    expect(await countFor(f(cond("last_visit", "is_empty")))).toBe(2);
    expect(await countFor(f(cond("chronic_condition", "has_any", [id.gHtn])))).toBe(1);
    expect(await countFor(f(cond("chronic_condition", "has_any", [id.gDm])))).toBe(0);
    expect(await countFor(f(cond("chronic_condition", "is_not_empty")))).toBe(1);
    expect(await countFor(f(cond("diagnosis_group", "has_any", [id.gHtn])))).toBe(1);
    expect(await countFor(f(cond("age_band", "in", ["0_11"])))).toBe(1);
    expect(await countFor(f(cond("age_band", "eq", "unknown")))).toBe(4);
    expect(await countFor(f(cond("gender", "is_empty")))).toBe(6);
  });

  // ---- the consent rule ----
  it("refuses a marketing audience from a clinical filter; a care audience with the same filter is counted", async () => {
    const filter = f(cond("lifecycle_stage", "in", ["active", "new_patient"]));
    const segId = await svc(async () =>
      one(
        "insert into public.segments (org_id, name, kind, filter) values ($1, 'Synthetic clinical', 'dynamic', $2::jsonb)",
        [org, JSON.stringify(filter)],
      ),
    );
    expect(audiencePurposeProblem(filter, "marketing", registry)).not.toBeNull();

    // Marketing (the default purpose too): refused before anything is counted or written, with and without a campaign.
    const m = shim();
    await expect(
      segmentAudience(m.admin, { orgId: org, segmentId: segId, marketing: true, timezone: "UTC" }),
    ).rejects.toThrow(/Care programmes only/);
    await expect(
      segmentAudience(m.admin, {
        orgId: org,
        segmentId: segId,
        marketing: true,
        purpose: "marketing",
        timezone: "UTC",
        campaignId: "00000000-0000-0000-0000-0000000000aa",
      }),
    ).rejects.toThrow(/Care programmes only/);
    expect(m.calls.filter((n) => n === "campaign_snapshot_segment")).toHaveLength(0);

    // Care (recall, follow-up): the same segment is counted.
    const care = shim();
    const r = await segmentAudience(care.admin, {
      orgId: org,
      segmentId: segId,
      marketing: false,
      purpose: "care",
      timezone: "UTC",
    });
    expect(r.counts.total).toBe(3);
    expect(r.counts.eligible).toBe(3);

    // A non-clinical segment still builds a marketing audience.
    const plain = await svc(async () =>
      one(
        "insert into public.segments (org_id, name, kind, filter) values ($1, 'Synthetic plain', 'dynamic', $2::jsonb)",
        [org, JSON.stringify(f(cond("age_band", "in", ["0_11"])))],
      ),
    );
    const ok = await segmentAudience(shim().admin, {
      orgId: org,
      segmentId: plain,
      marketing: true,
      timezone: "UTC",
    });
    expect(ok.counts.total).toBe(1);
    expect(ok.counts.eligible).toBe(1);
  });
});
