/**
 * Unite sync end to end against a real Postgres + PostgREST: patient matching and the review queue,
 * idempotent upserts, status mapping, reminders following the appointment, cursors, the token
 * store, and a full runUniteSync with a scripted fetch. No network; fake data only.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "@/lib/crypto";
import { runUniteSync } from "@/lib/jobs/handlers/unite-sync";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import type { UniteCredentials } from "@/lib/unite/auth";
import { parseUniteConfig } from "@/lib/unite/config";
import { resolveSyncReview } from "@/lib/unite/review";
import { syncAppointments, syncDoctors, syncPatients } from "@/lib/unite/sync";

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

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const log = { info: () => {}, warn: () => {}, error: () => {} };

/** dd-mm-yyyy hh:mm, `days` from now, in Dubai wall clock (UTC+4, no DST). */
function slot(days: number, hhmm: string): string {
  const d = new Date(Date.now() + days * 86_400_000 + 4 * 3_600_000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()} ${hhmm}`;
}

function raw(over: Record<string, unknown>) {
  return {
    appointmentid: "A1",
    appointmentstarttime: slot(3, "10:00"),
    appointmentendtime: slot(3, "10:30"),
    clinic_id: "DHA-TEST",
    createdby: "reception",
    doctor_id: "DOC-1",
    doctorname: "Dr Alex Example",
    nationality: "AE",
    patientfullname: "Sara Example",
    patientmobilephone: "971-500000010",
    patientpin: "PIN-1",
    remarks: "",
    status: "YTC",
    ...over,
  };
}

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)("unite sync", () => {
  let c: Client;
  let admin: AdminClient;
  let org: string;
  let orgB: string;
  let user: string;
  const id: Record<string, string> = {};
  const config = parseUniteConfig({ enabled: { appointments: true } });

  async function sync(rows: Array<Record<string, unknown>>, clinicId = "DHA-TEST", cfg = config) {
    return syncAppointments({
      admin,
      orgId: org,
      source: { getAppointments: async () => rows },
      config: cfg,
      clinicId,
      from: new Date(),
      to: new Date(Date.now() + 7 * 86_400_000),
      mode: "incremental",
      log,
    });
  }
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
    process.env.JOB_SECRET = "test-job-secret-0123456789";
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.UNITE_APP_ID = "test-app";
    process.env.UNITE_APP_KEY = "test-key";
    process.env.UNITE_BASE_URL = "https://unite.example.test/gateway/";

    c = await connect();
    await resetDb(c);
    user = await createAuthUser(c, "admin@example.test");
    org = await createOrg(c, "Org U", "org-u", user);
    orgB = await createOrg(c, "Org V", "org-v", await createAuthUser(c, "other@example.test"));
    admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
      auth: { persistSession: false },
    }) as AdminClient;

    await c.query("set role service_role");
    const ins = async (sql: string, p: unknown[]) =>
      (await c.query(sql + " returning id", p)).rows[0].id as string;
    id.loc = await ins(
      "insert into public.locations (org_id, name, external_id) values ($1,'Test Clinic','DHA-TEST')",
      [org],
    );
    id.dept = await ins("insert into public.departments (org_id, name) values ($1,'General')", [
      org,
    ]);
    id.doc = await ins(
      "insert into public.specialists (org_id, name, external_id, department_id) values ($1,'Dr Alex Example','DOC-1',$2)",
      [org, id.dept],
    );
    // an existing contact (no PIN yet) that a Unite phone should adopt
    id.known = await ins(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1,'Known','Patient','+971500000020')",
      [org],
    );
    // two contacts sharing a number via alternates → ambiguous
    id.twinA = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1,'Twin A','+971500000030')",
      [org],
    );
    id.twinB = await ins(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1,'Twin B','+971500000031')",
      [org],
    );
    await c.query(
      "insert into public.contact_phones (org_id, contact_id, phone_e164) values ($1,$2,'+971500000030')",
      [org, id.twinB],
    );
    await c.query("reset role");
  });

  afterAll(async () => {
    await c?.end();
  });

  it("creates appointments, matches and creates patients, queues ambiguous ones, skips unreadable rows", async () => {
    const counters = await sync([
      raw({}), // new patient PIN-1 → contact created
      raw({
        appointmentid: "A2",
        patientpin: "PIN-2",
        patientfullname: "Known Patient",
        patientmobilephone: "971-500000020",
        appointmentstarttime: slot(3, "11:00"),
        appointmentendtime: slot(3, "11:30"),
      }),
      raw({
        appointmentid: "A3",
        patientpin: "PIN-3",
        patientfullname: "Twin",
        patientmobilephone: "971-500000030",
        appointmentstarttime: slot(3, "12:00"),
        appointmentendtime: slot(3, "12:30"),
      }),
      raw({ appointmentid: "A4", appointmentstarttime: "whenever" }),
    ]);
    expect(counters).toMatchObject({
      fetched: 4,
      created: 3,
      skipped: 1,
      reviews: 1,
      unlinked: 1,
      patientsCreated: 1,
    });
    expect(counters.errors).toEqual({ unparseable_time: 1 });

    const appts = await q(
      "select external_id, status, external_status, contact_id, location_id, specialist_id, source from public.appointments order by external_id",
    );
    expect(appts.map((a) => a.external_id)).toEqual(["A1", "A2", "A3"]);
    expect(appts[0]).toMatchObject({
      status: "awaiting",
      external_status: "YTC",
      location_id: id.loc,
      specialist_id: id.doc,
      source: "unite",
    });
    expect(appts[1].contact_id).toBe(id.known);
    expect(appts[2].contact_id).toBeNull(); // waiting in Sync Review

    const created = await q(
      "select id, external_id, source, first_name, last_name, phone_e164 from public.contacts where external_id = 'PIN-1'",
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: "unite",
      first_name: "Sara",
      last_name: "Example",
      phone_e164: "+971500000010",
    });
    expect(
      (await q("select external_id from public.contacts where id = $1", [id.known]))[0].external_id,
    ).toBe("PIN-2");

    const reviews = await q(
      "select external_id, entity, reason, status, candidates, incoming from public.sync_reviews",
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      external_id: "PIN-3",
      entity: "patient",
      status: "open",
      reason: "multiple_phone_matches",
    });
    expect(reviews[0].candidates.map((x: { contact_id: string }) => x.contact_id).sort()).toEqual(
      [id.twinA, id.twinB].sort(),
    );
    expect(reviews[0].incoming).toMatchObject({ pin: "PIN-3", name: "Twin" });

    // reminders follow linked, future appointments only
    const reminders = await q(
      "select a.external_id from public.appointment_reminders r join public.appointments a on a.id = r.appointment_id order by 1",
    );
    expect(reminders.map((r) => r.external_id)).toEqual(["A1", "A2"]);
    // refs and cursor
    expect(
      await count(
        c,
        "select 1 from public.external_refs where source = 'unite' and entity = 'appointment'",
      ),
    ).toBe(3);
    const cur = await q(
      "select scope, last_ok_at, error from public.sync_cursors where entity = 'appointments'",
    );
    expect(cur[0]).toMatchObject({ scope: "DHA-TEST", error: null });
    expect(cur[0].last_ok_at).not.toBeNull();
  });

  it("is idempotent: replaying the same payload changes nothing", async () => {
    const timeline = await count(c, "select 1 from public.timeline_events");
    const jobs = await count(c, "select 1 from public.scheduled_jobs");
    const counters = await sync([
      raw({}),
      raw({
        appointmentid: "A2",
        patientpin: "PIN-2",
        patientfullname: "Known Patient",
        patientmobilephone: "971-500000020",
        appointmentstarttime: slot(3, "11:00"),
        appointmentendtime: slot(3, "11:30"),
      }),
      raw({
        appointmentid: "A3",
        patientpin: "PIN-3",
        patientfullname: "Twin",
        patientmobilephone: "971-500000030",
        appointmentstarttime: slot(3, "12:00"),
        appointmentendtime: slot(3, "12:30"),
      }),
    ]);
    expect(counters).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await count(c, "select 1 from public.timeline_events")).toBe(timeline);
    expect(await count(c, "select 1 from public.scheduled_jobs")).toBe(jobs);
    expect(await count(c, "select 1 from public.appointments")).toBe(3);
    expect(await count(c, "select 1 from public.sync_reviews")).toBe(1);
  });

  it("applies the status map, moves reminders with the appointment and records history", async () => {
    // OQ-23: until the code is mapped, a status code never changes the status.
    let r = await sync([raw({ status: "CNR" })]);
    expect(r.updated).toBe(1); // external_status changed
    expect(
      (
        await q("select status, external_status from public.appointments where external_id = 'A1'")
      )[0],
    ).toEqual({ status: "awaiting", external_status: "CNR" });

    await c.query("set role service_role");
    await c.query(
      "update public.unite_appointment_status_map set status = 'cancelled' where org_id = $1 and code = 'CNR'",
      [org],
    );
    await c.query("reset role");
    r = await sync([raw({ status: "CNR" })]);
    expect(r.updated).toBe(1);
    expect(
      (await q("select status from public.appointments where external_id = 'A1'"))[0].status,
    ).toBe("cancelled");
    expect(
      (
        await q(
          "select r.status from public.appointment_reminders r join public.appointments a on a.id = r.appointment_id where a.external_id = 'A1'",
        )
      )[0].status,
    ).toBe("cancelled");
    const types = (
      await q("select type from public.timeline_events where type like 'appointment.%'")
    ).map((t) => t.type);
    expect(types).toEqual(
      expect.arrayContaining(["appointment.created", "appointment.status_changed"]),
    );

    // moving A2 re-plans its reminder
    const before = (
      await q(
        "select r.due_at from public.appointment_reminders r join public.appointments a on a.id = r.appointment_id where a.external_id = 'A2'",
      )
    )[0].due_at;
    r = await sync([
      raw({
        appointmentid: "A2",
        patientpin: "PIN-2",
        patientfullname: "Known Patient",
        patientmobilephone: "971-500000020",
        appointmentstarttime: slot(4, "11:00"),
        appointmentendtime: slot(4, "11:30"),
        status: "ACF",
      }),
    ]);
    expect(r.updated).toBe(1);
    const after = (
      await q(
        "select r.due_at from public.appointment_reminders r join public.appointments a on a.id = r.appointment_id where a.external_id = 'A2'",
      )
    )[0].due_at;
    expect(new Date(after).getTime() - new Date(before).getTime()).toBe(86_400_000);
  });

  describe("Sync Review", () => {
    const twin = (over: Record<string, unknown> = {}) =>
      raw({
        appointmentid: "A3",
        patientpin: "PIN-3",
        patientfullname: "Twin",
        patientmobilephone: "971-500000030",
        appointmentstarttime: slot(3, "12:00"),
        appointmentendtime: slot(3, "12:30"),
        ...over,
      });
    const review = async (key: string) =>
      (
        await q(
          "select id, status, resolved_contact_id from public.sync_reviews where external_id = $1",
          [key],
        )
      )[0];

    it("links an ambiguous patient: PIN adopted, waiting appointments attached, reminders planned", async () => {
      const r = await review("PIN-3");
      expect(r.status).toBe("open");
      const res = await resolveSyncReview(admin, {
        orgId: org,
        reviewId: r.id,
        userId: user,
        action: { kind: "link", contactId: id.twinA },
      });
      expect(res).toEqual({ ok: true, contactId: id.twinA, linkedAppointments: 1 });
      expect(
        (await q("select contact_id from public.appointments where external_id = 'A3'"))[0]
          .contact_id,
      ).toBe(id.twinA);
      expect(
        (await q("select external_id from public.contacts where id = $1", [id.twinA]))[0]
          .external_id,
      ).toBe("PIN-3");
      expect(
        await count(
          c,
          "select 1 from public.appointment_reminders r join public.appointments a on a.id = r.appointment_id where a.external_id = 'A3' and r.status = 'scheduled'",
        ),
      ).toBe(1);
      expect((await review("PIN-3")).status).toBe("resolved");

      // The decision sticks: the next sync neither re-queues the item nor changes the appointment.
      const again = await sync([twin()]);
      expect(again).toMatchObject({ unchanged: 1, reviews: 0 });
      expect((await review("PIN-3")).status).toBe("resolved");
      // …and a handled item can't be handled twice.
      expect(
        await resolveSyncReview(admin, {
          orgId: org,
          reviewId: r.id,
          userId: user,
          action: { kind: "dismiss" },
        }),
      ).toMatchObject({ ok: false });
    });

    it("refuses to link a patient who already has a different PIN", async () => {
      await sync([twin({ appointmentid: "A5", patientpin: "PIN-5" })]);
      const r = await review("PIN-5");
      expect(r.status).toBe("open");
      const res = await resolveSyncReview(admin, {
        orgId: org,
        reviewId: r.id,
        userId: user,
        action: { kind: "link", contactId: id.twinA }, // twinA is PIN-3 now
      });
      expect(res).toMatchObject({
        ok: false,
        error: expect.stringContaining("different Unite PIN"),
      });
      expect((await review("PIN-5")).status).toBe("open");
    });

    it("dismissing keeps the appointment unlinked and the item closed on later syncs", async () => {
      const r = await review("PIN-5");
      expect(
        await resolveSyncReview(admin, {
          orgId: org,
          reviewId: r.id,
          userId: user,
          action: { kind: "dismiss" },
        }),
      ).toMatchObject({ ok: true });
      const again = await sync([twin({ appointmentid: "A5", patientpin: "PIN-5" })]);
      expect(again.reviews).toBe(0);
      expect((await review("PIN-5")).status).toBe("dismissed");
      expect(
        (await q("select contact_id from public.appointments where external_id = 'A5'"))[0]
          .contact_id,
      ).toBeNull();
    });

    it("creates the patient from what Unite sent when auto-create is off", async () => {
      const manual = parseUniteConfig({
        create_missing_patients: false,
        enabled: { appointments: true },
      });
      const counters = await sync(
        [
          raw({
            appointmentid: "A6",
            patientpin: "PIN-6",
            patientfullname: "Nobody Known",
            patientmobilephone: "971-500000060",
            appointmentstarttime: slot(5, "09:00"),
            appointmentendtime: slot(5, "09:30"),
          }),
        ],
        "DHA-TEST",
        manual,
      );
      expect(counters).toMatchObject({ created: 1, reviews: 1, unlinked: 1, patientsCreated: 0 });
      const r = await review("PIN-6");
      expect(
        (await q("select reason from public.sync_reviews where id = $1", [r.id]))[0].reason,
      ).toBe("no_match");
      const res = await resolveSyncReview(admin, {
        orgId: org,
        reviewId: r.id,
        userId: user,
        action: { kind: "create" },
      });
      expect(res).toMatchObject({ ok: true, linkedAppointments: 1 });
      const made = (
        await q(
          "select first_name, last_name, phone_e164, source from public.contacts where external_id = 'PIN-6'",
        )
      )[0];
      expect(made).toEqual({
        first_name: "Nobody",
        last_name: "Known",
        phone_e164: "+971500000060",
        source: "unite",
      });
      expect(
        (
          await q(
            "select custom->>'unite_patient_name' as n from public.appointments where external_id = 'A6'",
          )
        )[0].n,
      ).toBeNull();
    });
  });

  it("records a failed run in the cursor and rethrows", async () => {
    await expect(
      syncAppointments({
        admin,
        orgId: org,
        source: {
          getAppointments: async () => {
            throw new Error("Unite is down");
          },
        },
        config,
        clinicId: "DHA-FAIL",
        from: new Date(),
        to: new Date(),
        mode: "nightly",
        log,
      }),
    ).rejects.toThrow("Unite is down");
    const cur = await q(
      "select error, last_ok_at from public.sync_cursors where scope = 'DHA-FAIL'",
    );
    expect(cur[0].error).toBe("Unite is down");
    expect(cur[0].last_ok_at).toBeNull();
  });

  it("syncs doctors: creates, updates and adopts a hand-made specialist", async () => {
    await c.query("set role service_role");
    await c.query("insert into public.specialists (org_id, name) values ($1, 'Dr Hand Made')", [
      org,
    ]);
    await c.query("reset role");
    const counters = await syncDoctors({
      admin,
      orgId: org,
      log,
      source: {
        listAll: async () => [
          { doctor_id: "DOC-1", doctor_name: "Dr Alex Example-Smith", department: "General" }, // renamed
          { doctor_id: "DOC-9", doctor_name: "Dr Hand Made" }, // adopts
          { doctor_id: "DOC-10", doctor_name: "Dr New Person", department: "General" }, // new
          { nonsense: true },
        ],
      },
    });
    expect(counters).toMatchObject({ fetched: 4, created: 1, updated: 2, skipped: 1 });
    const rows = await q("select name, external_id from public.specialists order by external_id");
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "Dr Alex Example-Smith", external_id: "DOC-1" },
        { name: "Dr Hand Made", external_id: "DOC-9" },
        { name: "Dr New Person", external_id: "DOC-10" },
      ]),
    );
  });

  it("syncs patients without overwriting what staff typed", async () => {
    await c.query("set role service_role");
    await c.query("update public.contacts set email = 'typed@example.test' where id = $1", [
      id.known,
    ]);
    await c.query("reset role");
    const counters = await syncPatients({
      admin,
      orgId: org,
      config,
      log,
      source: {
        listAll: async () => [
          {
            patientpin: "PIN-2",
            patientfullname: "Someone Else",
            mobile: "050 000 0020",
            email: "unite@example.test",
            dob: "1990-10-10",
            gender: "Female",
          },
          { patientpin: "PIN-7", patientfullname: "Brand New", mobile: "050 000 0070" },
          { patientpin: "" },
        ],
      },
    });
    expect(counters).toMatchObject({ fetched: 3, created: 1, updated: 1, skipped: 1 });
    const known = (
      await q(
        "select first_name, email, dob::text as dob, gender from public.contacts where id = $1",
        [id.known],
      )
    )[0];
    expect(known).toEqual({
      first_name: "Known",
      email: "typed@example.test",
      dob: "1990-10-10",
      gender: "female",
    });
    expect(await count(c, "select 1 from public.contacts where external_id = 'PIN-7'")).toBe(1);
    const cur = (await q("select cursor from public.sync_cursors where entity = 'patients'"))[0]
      .cursor;
    expect(typeof cur.since).toBe("string");
  });

  describe("runUniteSync (scripted fetch)", () => {
    function fakeUnite(rows: Array<Record<string, unknown>>) {
      const seen: Array<{ method: string; path: string }> = [];
      let logins = 0;
      const fn = (async (url: string, init: RequestInit = {}) => {
        const u = new URL(String(url));
        seen.push({ method: init.method ?? "GET", path: u.pathname });
        if (u.pathname.endsWith("/authorize")) {
          logins++;
          return new Response(
            JSON.stringify({
              Status: "Success",
              Message: "",
              Data: { access_token: `tok-${logins}`, refresh_token: "r", expires_in: 240 },
            }),
          );
        }
        return new Response(JSON.stringify({ Status: "Success", Message: "", Data: rows }));
      }) as unknown as typeof fetch;
      return { fn, seen, logins: () => logins };
    }

    it("skips until an account exists and until the entity flag is on", async () => {
      const f = fakeUnite([]);
      const msg = {
        org_id: org,
        entity: "appointments" as const,
        clinic_id: "DHA-TEST",
        mode: "incremental" as const,
      };
      expect(await runUniteSync(admin, msg, log, new Date(), f.fn)).toEqual({
        skipped: "no_account",
      });
      await c.query("set role service_role");
      // The shared account row (credentials are entered under Finance → Capture health).
      const app = { app_id: "app", app_key: "key" };
      await c.query(
        "insert into public.integration_accounts (org_id, kind, config, config_enc) values ($1, 'unite', '{}', $2)",
        [org, encryptJson({ authorize: app, refresh: app } satisfies UniteCredentials)],
      );
      await c.query("reset role");
      expect(await runUniteSync(admin, msg, log, new Date(), f.fn)).toEqual({
        skipped: "disabled",
      });
      expect(f.seen).toHaveLength(0);
    });

    it("logs in once, reuses the encrypted token, and only ever reads", async () => {
      await c.query("set role service_role");
      await c.query("update public.integration_accounts set config = $2::jsonb where org_id = $1", [
        org,
        JSON.stringify({ enabled: { appointments: true }, min_interval_ms: 100 }),
      ]);
      await c.query("reset role");
      const f = fakeUnite([
        raw({
          appointmentid: "A9",
          patientpin: "PIN-9",
          patientfullname: "Run Through",
          patientmobilephone: "971-500000090",
          appointmentstarttime: slot(2, "09:00"),
          appointmentendtime: slot(2, "09:30"),
        }),
      ]);
      const msg = {
        org_id: org,
        entity: "appointments" as const,
        clinic_id: "DHA-TEST",
        mode: "nightly" as const,
      };

      const r1 = (await runUniteSync(admin, msg, log, new Date(), f.fn)) as { created: number };
      expect(r1.created).toBe(1);
      const r2 = (await runUniteSync(admin, msg, log, new Date(), f.fn)) as { unchanged: number };
      expect(r2.unchanged).toBe(1);
      expect(f.logins()).toBe(1); // second run used the stored token

      expect(f.seen.every((s) => s.method === "GET")).toBe(true);
      expect(f.seen.some((s) => /finance/i.test(s.path))).toBe(false);

      // The token is cached inside the same encrypted blob as the credentials, never in the clear.
      const acct = (
        await q("select config_enc from public.integration_accounts where org_id = $1", [org])
      )[0];
      expect(acct.config_enc).toMatch(/^v1:/);
      expect(acct.config_enc).not.toContain("tok-1");
      expect(decryptJson<UniteCredentials>(acct.config_enc).access_token).toBe("tok-1");
      const calls = await q(
        "select endpoint, unite_status from public.unite_api_calls where org_id = $1 order by id",
        [org],
      );
      expect(calls.map((x) => x.endpoint)).toEqual([
        "authorize",
        "getallappointments",
        "getallappointments",
      ]);
      expect(calls.every((x) => x.unite_status === "ok")).toBe(true);
    });
  });

  it("keeps the new tables private to their org", async () => {
    await c.query("set role service_role");
    await c.query(
      "insert into public.unite_api_calls (org_id, endpoint, unite_status) values ($1, 'x', 'ok')",
      [orgB],
    );
    await c.query("reset role");
    // admin of org A sees A's cursors but nothing of B's, and integration_accounts has no policies at all
    expect(
      await asUser(c, user, () =>
        count(c, "select 1 from public.sync_cursors where org_id = $1", [orgB]),
      ),
    ).toBe(0);
    expect(
      await asUser(c, user, () =>
        count(c, "select 1 from public.unite_api_calls where org_id = $1", [orgB]),
      ),
    ).toBe(0);
    expect(
      await asUser(c, user, () =>
        count(c, "select 1 from public.sync_cursors where org_id = $1", [org]),
      ),
    ).toBeGreaterThan(0);
    expect(await asUser(c, user, () => count(c, "select 1 from public.integration_accounts"))).toBe(
      0,
    );
    await expect(
      asUser(c, user, () =>
        c.query(
          "insert into public.sync_cursors (org_id, source, entity) values ($1, 'unite', 'x')",
          [org],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    void asServiceRole;
  });
});
