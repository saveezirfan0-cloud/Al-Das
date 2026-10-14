/**
 * Phase C: the daily hr_maintenance task against a real Postgres through PostgREST. Visa and licence reminders are
 * claimed atomically (one reminder per date), go to the people who manage staff as ONE notification per org with ids
 * only, honour the org's lead days, and skip archived staff. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and
 * TEST_SERVICE_JWT. Synthetic data only.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runHrMaintenance } from "@/lib/jobs/handlers/hr-maintenance";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;

const NOW = new Date("2026-10-14T04:00:00Z");
const silent: JobLogger = { info: () => {}, warn: () => {}, error: () => {} } as JobLogger;

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("hr maintenance", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let otherOrg: string;
  let owner: string;
  let hr: string;
  let agent: string;
  const ids: Record<string, string> = {};

  const one = async (sql: string, params: unknown[]) =>
    (await c.query<{ id: string }>(sql + " returning id::text as id", params)).rows[0].id;

  const notes = () =>
    asServiceRole(
      c,
      async () =>
        (
          await c.query<{
            user_id: string;
            org_id: string;
            title: string;
            body: string | null;
            payload: unknown;
          }>(
            "select user_id::text, org_id::text, title, body, payload from public.notifications where type = 'staff.document_expiring' order by created_at",
          )
        ).rows,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    // notify() reads the server env (e-mail and push jobs); point it at the local PostgREST.
    process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
    process.env.JOB_SECRET = "test-job-secret-0123456789";
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.APP_URL = "https://pulse.test";
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as AdminClient;
    owner = await createAuthUser(c, "owner-hrm@example.test");
    hr = await createAuthUser(c, "hr-hrm@example.test");
    agent = await createAuthUser(c, "agent-hrm@example.test");
    const stranger = await createAuthUser(c, "other-hrm@example.test");
    org = await createOrg(c, "Org HR", "org-hr", owner);
    otherOrg = await createOrg(c, "Org HR other", "org-hr-other", stranger);
    await asServiceRole(c, async () => {
      await c.query("update public.orgs set timezone = 'Asia/Dubai' where id in ($1, $2)", [
        org,
        otherOrg,
      ]);
      await c.query(
        "update public.orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{organisation}', '{\"expiry_lead_days\": 7}') where id = $1",
        [otherOrg],
      );
      const hrRole = await one(
        "insert into public.roles (org_id, name, description, permissions) values ($1, 'HR test', 'synthetic', '[\"hr.view\",\"hr.manage\"]'::jsonb)",
        [org],
      );
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, hr, hrRole],
      );
      const agentRole = (
        await c.query<{ id: string }>(
          "select id from public.roles where org_id = $1 and name = 'Agent'",
          [org],
        )
      ).rows[0].id;
      await c.query(
        "insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)",
        [org, agent, agentRole],
      );
      ids.visa = await one(
        "insert into public.staff_members (org_id, full_name, visa_expires_on) values ($1, 'Layla Demo-11', '2026-11-20')",
        [org],
      );
      ids.later = await one(
        "insert into public.staff_members (org_id, full_name, visa_expires_on) values ($1, 'Omar Demo-12', '2027-06-01')",
        [org],
      );
      ids.archived = await one(
        "insert into public.staff_members (org_id, full_name, licence_expires_on, deleted_at) values ($1, 'Old Demo-13', '2026-10-20', now())",
        [org],
      );
      // 30 days out: due for the 60-day org, not for the 7-day one
      ids.otherVisa = await one(
        "insert into public.staff_members (org_id, full_name, visa_expires_on) values ($1, 'Sara Demo-14', '2026-11-13')",
        [otherOrg],
      );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("reminds once per date, to staff managers only, with ids and generic words", async () => {
    const totals = await runHrMaintenance(admin, silent, NOW);
    expect(totals).toMatchObject({
      visas: 1,
      staff_licences: 0,
      doctor_licences: 0,
      notified_orgs: 1,
    });
    const rows = await notes();
    // owner (Admin, '*') and the HR role; never the agent
    expect(rows.map((r) => r.user_id).sort()).toEqual([owner, hr].sort());
    for (const r of rows) {
      expect(r.org_id).toBe(org);
      expect(r.payload).toEqual({ staff_member_id: ids.visa });
      expect(`${r.title} ${r.body}`).not.toMatch(/Demo|2026-/);
    }
    // a second run finds nothing new
    expect((await runHrMaintenance(admin, silent, NOW)).visas).toBe(0);
    expect(await notes()).toHaveLength(2);
  });

  it("re-arms a reminder when the date changes, and counts several in one message", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "update public.staff_members set visa_expires_on = '2026-11-25' where id = $1",
        [ids.visa],
      );
      await c.query(
        "update public.staff_members set licence_expires_on = '2026-10-30' where id = $1",
        [ids.later],
      );
      ids.doctor = await one(
        "insert into public.specialists (org_id, name, licence_expires_on) values ($1, 'Dr Demo-15', '2026-10-01')",
        [org],
      );
    });
    const totals = await runHrMaintenance(admin, silent, NOW);
    expect(totals).toMatchObject({ visas: 1, staff_licences: 1, doctor_licences: 1 });
    const latest = (await notes()).slice(-1)[0];
    expect(latest.payload).toEqual({ count: 3 });
    // the archived record and the other org (7-day window) were never claimed
    const left = await asServiceRole(
      c,
      async () =>
        (
          await c.query<{ id: string }>(
            "select id::text from public.staff_members where (visa_expiry_notified_at is not null or licence_expiry_notified_at is not null) and id in ($1, $2)",
            [ids.archived, ids.otherVisa],
          )
        ).rows,
    );
    expect(left).toEqual([]);
  });
});
