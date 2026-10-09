/**
 * Parallel run against Make: the shadow run records ids only and never sends, the daily comparison
 * is exact, reminders and recall replies are read from their own tables, and the tables are gated.
 * Runs only when TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT are set. Fake data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runProgramme, type Programme } from "@/lib/recall/engine";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const NOW = new Date("2026-10-12T08:00:00Z");

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("parallel run (db)", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let owner: string;
  let outsider: string;
  let tplId: string;
  let n = 100;

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    (await c.query(sql, params)).rows[0] as T;
  const contact = async (
    over: { pin?: string | null; test?: boolean; dob?: string; gender?: string } = {},
  ) =>
    (
      await one<{ id: string }>(
        `insert into public.contacts (org_id, first_name, phone_e164, external_id, is_test_record, promotions_opt_in, dob, gender)
         values ($1,'Pat',$2,$3,$4,true,$5,$6) returning id`,
        [
          org,
          `+97150001${String(n++).padStart(4, "0")}`,
          over.pin === undefined ? `PIN${n}` : over.pin,
          over.test ?? false,
          over.dob ?? null,
          over.gender ?? null,
        ],
      )
    ).id;
  const prog = async (key: string): Promise<Programme> =>
    (await admin.from("recall_programmes").select("*").eq("org_id", org).eq("key", key).single())
      .data as Programme;
  const compare = async (scenario: string, date = "2026-10-12") =>
    (
      await admin.rpc("parallel_run_compare", {
        p_org: org,
        p_scenario: scenario,
        p_date: date,
        p_tz: "Asia/Dubai",
      })
    ).data!;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
    process.env.JOB_SECRET = "test-job-secret-0123456789";
    c = await connect();
    admin = createClient<Database>(`${POSTGREST_URL}`, SERVICE_JWT!, {
      auth: { persistSession: false },
    }) as unknown as AdminClient;
  });
  afterAll(async () => {
    await c?.end();
  });

  beforeEach(async () => {
    await resetDb(c);
    n = 100;
    owner = await createAuthUser(c, "owner@example.test");
    outsider = await createAuthUser(c, "outsider@example.test");
    org = await createOrg(c, "Clinic", "clinic", owner);
    await createOrg(c, "Other", "other", outsider);
    await c.query("select public.seed_clinical_settings($1)", [org]);
    await c.query("select public.seed_recall_programmes($1)", [org]);
    await c.query("select public.seed_parallel_run_scenarios($1)", [org]);
    const ch = (
      await one<{ id: string }>(
        "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1,'Main','waba-p','pn-p') returning id",
        [org],
      )
    ).id;
    tplId = (
      await one<{ id: string }>(
        `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category, components)
         values ($1,$2,'waba-p','bday','en','APPROVED','MARKETING','[{"type":"BODY","text":"Happy birthday {{1}}","example":{"body_text":[["Sam"]]}}]') returning id`,
        [org, ch],
      )
    ).id;
    await c.query(
      "update public.recall_programme_templates set wa_template_id=$2, variables_map='{\"body.1\":\"{contact.first_name}\"}' where org_id=$1 and segment_key in ('f_18_35','m_20_29') and programme_id=(select id from public.recall_programmes where org_id=$1 and key='birthday')",
      [org, tplId],
    );
    await c.query(
      "update public.recall_programmes set status='active' where org_id=$1 and key='birthday'",
      [org],
    );
    for (const [k, v] of [["recall_send_mode", "test"]])
      await c.query(
        "update public.clinical_settings set approved_value=$3, sign_off_status='approved', signed_by='T', signed_at=current_date where org_id=$1 and key=$2",
        [org, k, v],
      );
  });

  it("a shadow run records the PINs of everyone eligible, real patients included, and sends nothing", async () => {
    const real1 = await contact({ pin: "PIN-A", dob: "1996-10-12", gender: "female" });
    await contact({ pin: "PIN-B", dob: "2001-10-12", gender: "male" });
    await contact({ pin: "PIN-C", dob: "1996-10-12", gender: "female", test: true });
    await contact({ pin: "PIN-D", dob: "1990-03-03", gender: "female" }); // not their birthday
    await contact({ pin: null, dob: "1996-10-12", gender: "female" }); // no PIN to compare on
    void real1;
    const r = await runProgramme(admin, await prog("birthday"), { trigger: "shadow", now: NOW });
    expect(r).toMatchObject({ dryRun: true, queued: 0 });
    expect(r.skipped).toMatchObject({ no_pin_for_comparison: 1 });
    expect(
      (await c.query("select key from public.parallel_run_native_keys order by key")).rows.map(
        (x) => x.key,
      ),
    ).toEqual(["PIN-A", "PIN-B", "PIN-C"]);
    expect(await count(c, "select 1 from public.recall_sends")).toBe(0);
    expect(await count(c, "select 1 from public.messages where direction='out'")).toBe(0);
    expect(
      await one("select trigger, dry_run from public.recall_runs where id=$1", [r.runId]),
    ).toEqual({ trigger: "shadow", dry_run: true });
  });

  it("running the shadow twice does not duplicate keys; a normal Test run still reaches only internal patients", async () => {
    await contact({ pin: "PIN-A", dob: "1996-10-12", gender: "female" });
    await contact({ pin: "PIN-T", dob: "1996-10-12", gender: "female", test: true });
    const p = await prog("birthday");
    await runProgramme(admin, p, { trigger: "shadow", now: NOW });
    await runProgramme(admin, p, { trigger: "shadow", now: new Date(NOW.getTime() + 120_000) });
    expect(await count(c, "select 1 from public.parallel_run_native_keys")).toBe(2);
    const real = await runProgramme(admin, p, {
      trigger: "manual",
      now: new Date(NOW.getTime() + 240_000),
    });
    expect(real.queued).toBe(1);
    expect(
      (
        await c.query(
          "select c.external_id from public.recall_sends s join public.contacts c on c.id=s.contact_id",
        )
      ).rows,
    ).toEqual([{ external_id: "PIN-T" }]);
  });

  it("compares Make's ids with the native ids exactly", async () => {
    await c.query(
      "insert into public.parallel_run_native_keys (org_id, scenario, run_date, key) values ($1,'birthday','2026-10-12','P1'),($1,'birthday','2026-10-12','P2'),($1,'birthday','2026-10-12','P3')",
      [org],
    );
    await c.query(
      "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'birthday','2026-10-12','P2'),($1,'birthday','2026-10-12','P3'),($1,'birthday','2026-10-12','P9'),($1,'birthday','2026-10-11','P1')",
      [org],
    );
    expect(await compare("birthday")).toMatchObject({
      make_count: 3,
      native_count: 3,
      only_in_make: ["P9"],
      only_in_native: ["P1"],
    });
    // recomputing updates the same row
    await c.query(
      "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'birthday','2026-10-12','P1')",
      [org],
    );
    expect(await compare("birthday")).toMatchObject({
      make_count: 4,
      only_in_make: ["P9"],
      only_in_native: [],
    });
    expect(
      await count(c, "select 1 from public.parallel_run_diffs where scenario='birthday'"),
    ).toBe(1);
    // an empty day compares as zero on both sides
    expect(await compare("birthday", "2026-10-05")).toMatchObject({
      make_count: 0,
      native_count: 0,
      only_in_make: [],
      only_in_native: [],
    });
  });

  it("reads appointment reminders from the reminder rows: sent ones and those Test mode held back, not cancelled or other days", async () => {
    const ct = await contact();
    const appt = async (ext: string) =>
      (
        await one<{ id: string }>(
          "insert into public.appointments (org_id, number, contact_id, starts_at, ends_at, source, external_id) values ($1,0,$2,'2026-10-13T08:00:00Z','2026-10-13T08:30:00Z','unite',$3) returning id",
          [org, ct, ext],
        )
      ).id;
    const rem = (id: string, status: string, due: string, reason: string | null = null) =>
      c.query(
        "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, status, exclusion_reason) values ($1,$2,2,$3,$4,$5)",
        [org, id, due, status, reason],
      );
    await rem(await appt("U1"), "sent", "2026-10-12T07:00:00Z");
    await rem(await appt("U2"), "excluded", "2026-10-12T07:00:00Z", "test_mode");
    await rem(await appt("U3"), "excluded", "2026-10-12T07:00:00Z", "exclusion_list");
    await rem(await appt("U4"), "cancelled", "2026-10-12T07:00:00Z");
    await rem(await appt("U5"), "sent", "2026-10-11T07:00:00Z");
    await c.query(
      "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'appointment_reminders','2026-10-12','U1'),($1,'appointment_reminders','2026-10-12','U3')",
      [org],
    );
    expect(await compare("appointment_reminders")).toMatchObject({
      native_count: 2,
      only_in_make: ["U3"],
      only_in_native: ["U2"],
    });
  });

  it("reads 'chronic update' from recall replies and bookings that day", async () => {
    const p = (
      await one<{ id: string }>(
        "select id from public.recall_programmes where org_id=$1 and key='chronic_90d'",
        [org],
      )
    ).id;
    const mk = async (pin: string, replied: string | null, booked: string | null) => {
      const ct = await contact({ pin });
      await c.query(
        "insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, status, sent_at, replied_at, booked_at) values ($1,$2,$3,$4,'sent','2026-10-01T08:00:00Z',$5,$6)",
        [org, p, ct, pin, replied, booked],
      );
    };
    await mk("R1", "2026-10-12T05:00:00Z", null);
    await mk("R2", null, "2026-10-12T06:00:00Z");
    await mk("R3", "2026-10-11T05:00:00Z", null); // another day
    await mk("R4", null, null);
    await c.query(
      "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'chronic_update','2026-10-12','R1')",
      [org],
    );
    expect(await compare("chronic_update")).toMatchObject({
      native_count: 2,
      only_in_native: ["R2"],
      only_in_make: [],
    });
  });

  it("measures the token scenario by Unite call health", async () => {
    await c.query(
      "insert into public.unite_api_calls (org_id, endpoint, http_status, unite_status) select $1,'authorize',200,'Success' from generate_series(1,6)",
      [org],
    );
    await c.query(
      "insert into public.unite_api_calls (org_id, endpoint, http_status, unite_status) values ($1,'getallappointments',200,'Token Expired'),($1,'authorize',500,null)",
      [org],
    );
    const { data } = await admin.rpc("parallel_run_unite_health", { p_org: org, p_days: 7 });
    expect(data?.[0]).toEqual({ total: 8, ok: 6 });
  });

  it("is gated by flows.manage and isolated per organisation; the checklist seed is idempotent", async () => {
    await c.query(
      "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'birthday','2026-10-12','P1')",
      [org],
    );
    await compare("birthday");
    await c.query("select public.seed_parallel_run_scenarios($1)", [org]);
    expect(
      await count(c, "select 1 from public.parallel_run_scenarios where org_id=$1", [org]),
    ).toBe(6);
    expect(
      await count(
        c,
        "select 1 from public.parallel_run_scenarios where key='mrd_sync' and not native_ready and compare_kind='none'",
      ),
    ).toBe(1);
    for (const t of ["parallel_run_scenarios", "parallel_run_make_keys", "parallel_run_diffs"]) {
      expect(
        await asUser(c, owner, () =>
          count(c, `select 1 from public.${t} where org_id = $1`, [org]),
        ),
        t,
      ).toBeGreaterThan(0);
      expect(
        await asUser(c, outsider, () =>
          count(c, `select 1 from public.${t} where org_id = $1`, [org]),
        ),
        t,
      ).toBe(0);
    }
    // identifiers cannot be written by a user session at all
    await expect(
      asUser(c, owner, () =>
        c.query(
          "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'birthday','2026-10-12','X')",
          [org],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(c, owner, () =>
        c.query("select public.parallel_run_compare($1,'birthday','2026-10-12','UTC')", [org]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("a sign-off needs a date, and the key length is bounded", async () => {
    await expect(
      c.query(
        "update public.parallel_run_scenarios set signed_off_by='Someone' where org_id=$1 and key='birthday'",
        [org],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      c.query(
        "insert into public.parallel_run_make_keys (org_id, scenario, run_date, key) values ($1,'birthday','2026-10-12',repeat('x', 81))",
        [org],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
