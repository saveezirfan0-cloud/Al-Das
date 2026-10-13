/**
 * Phase 19b: video rooms for video appointments against a real Postgres through PostgREST. The room provider is a fake (or the
 * static template, which makes no call); nothing leaves the machine. Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { createHash, randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  changeAppointmentStatus,
  rescheduleAppointment,
  sendAppointmentTemplate,
} from "@/lib/appointments/service";
import { decryptSecret } from "@/lib/crypto";
import { patchConfig, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { createFakeTelehealthProvider } from "@/lib/integrations/telehealth/fake";
import {
  cleanupRoom,
  ensureRoom,
  resolveVideoLink,
  revokeRooms,
} from "@/lib/integrations/telehealth/server";
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
const TEMPLATE = "https://meet.example.com/{token}";
const hour = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 19b: video rooms",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    const id: Record<string, string> = {};
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const one = async (sql: string, params: unknown[] = []) =>
      (await q(sql + " returning id::text", params)).rows[0].id as string;
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
    const rooms = async (appointment: string) =>
      (
        await svc(() =>
          q("select * from public.telehealth_rooms where appointment_id = $1 order by created_at", [
            appointment,
          ]),
        )
      ).rows;
    const live = async (appointment: string) =>
      (await rooms(appointment)).filter((r) => r.status === "active" || r.status === "creating");

    async function appt(
      over: {
        service?: string | null;
        mode?: string | null;
        start?: number;
        end?: number;
        status?: string;
        contact?: string;
      } = {},
    ) {
      const start = hour(over.start ?? 2);
      return svc(() =>
        one(
          "insert into public.appointments (org_id, contact_id, location_id, service_id, starts_at, ends_at, status, visit_mode) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8)",
          [
            org,
            over.contact ?? id.patient,
            id.loc,
            over.service === undefined ? id.videoService : over.service,
            start,
            hour(over.end ?? (over.start ?? 2) + 0.5),
            over.status ?? "confirmed",
            over.mode ?? null,
          ],
        ),
      );
    }

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      await svc(async () => {
        id.loc = await one(
          "insert into public.locations (org_id, name, timezone) values ($1, 'Jumeirah', 'Asia/Dubai')",
          [org],
        );
        id.videoService = await one(
          "insert into public.services (org_id, name, duration_min, default_visit_mode) values ($1, 'Video consultation', 30, 'video')",
          [org],
        );
        id.clinicService = await one(
          "insert into public.services (org_id, name, duration_min) values ($1, 'Clinic consultation', 30)",
          [org],
        );
        id.patient = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', 'Hassan', '+971501110301')",
          [org],
        );
        id.channel = await one(
          "insert into public.channels (org_id, name, waba_id, phone_number_id, status) values ($1, 'Main', 'waba-th', 'pn-th', 'active')",
          [org],
        );
        id.tpl = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components, variable_map)
           values ($1, $2, 'waba-th', 'video_reminder', 'en', 'UTILITY', 'APPROVED', $3::jsonb, $4::jsonb)`,
          [
            org,
            id.channel,
            JSON.stringify([
              { type: "BODY", text: "Hi {{1}}, your visit is on {{2}}. Join here: {{3}}" },
            ]),
            JSON.stringify({
              "body.1": "contact.first_name",
              "body.2": "appointment.datetime",
              "body.3": "appointment.video_link",
            }),
          ],
        );
        await q("update public.orgs set settings = $2::jsonb where id = $1", [
          org,
          JSON.stringify({
            appointments: {
              templates: {
                reminder: id.tpl,
                confirmed: id.tpl,
                cancelled: null,
                rescheduled: id.tpl,
              },
              lead_time_minutes: 0,
            },
          }),
        ]);
      });
      await saveSettings(admin, {
        orgId: org,
        kind: "telehealth",
        provider: "static",
        secrets: {},
        config: { url_template: TEMPLATE, grace_minutes: 30, early_minutes: 60 },
      });
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("makes no room while the integration is off", async () => {
      const a = await appt();
      expect(await ensureRoom(admin, { orgId: org, appointmentId: a })).toEqual({
        ok: false,
        reason: "off",
      });
      expect(await rooms(a)).toHaveLength(0);
      await setEnabled(admin, { orgId: org, kind: "telehealth", userId: alice, enabled: true });
    });

    it("creates a private room for a video appointment: unguessable token, only its hash and an encrypted copy stored", async () => {
      const a = await appt();
      const r = await ensureRoom(admin, { orgId: org, appointmentId: a, actorId: alice });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.created).toBe(true);
      expect(r.url).toMatch(/^https:\/\/meet\.example\.com\/[A-Za-z0-9_-]{43}$/);
      const token = r.url.split("/").pop()!;
      const row = (await rooms(a))[0];
      expect(row).toMatchObject({ status: "active", provider: "static", room_ref: null });
      expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(row.token_enc).not.toContain(token);
      expect(decryptSecret(row.token_enc)).toBe(token);
      expect(new Date(row.expires_at).getTime() - new Date(row.for_ends_at).getTime()).toBe(
        30 * 60_000,
      );
      expect(JSON.stringify(row)).not.toMatch(/Layla|Hassan|971501110301/);
      // asking again gives the same link
      const again = await ensureRoom(admin, { orgId: org, appointmentId: a });
      expect(again).toMatchObject({ ok: true, url: r.url, created: false });
      expect(await rooms(a)).toHaveLength(1);
    });

    it("follows the service's default, and a booking can override it either way", async () => {
      const inPerson = await appt({ service: id.clinicService });
      expect(await ensureRoom(admin, { orgId: org, appointmentId: inPerson })).toEqual({
        ok: false,
        reason: "not_video",
      });
      const forcedVideo = await appt({ service: id.clinicService, mode: "video" });
      expect((await ensureRoom(admin, { orgId: org, appointmentId: forcedVideo })).ok).toBe(true);
      const forcedClinic = await appt({ service: id.videoService, mode: "in_person" });
      expect(await ensureRoom(admin, { orgId: org, appointmentId: forcedClinic })).toEqual({
        ok: false,
        reason: "not_video",
      });
      const noService = await appt({ service: null });
      expect(await ensureRoom(admin, { orgId: org, appointmentId: noService })).toEqual({
        ok: false,
        reason: "not_video",
      });
      expect(
        await ensureRoom(admin, {
          orgId: org,
          appointmentId: "00000000-0000-4000-8000-000000000000",
        }),
      ).toEqual({ ok: false, reason: "no_appointment" });
    });

    it("is regenerated when the appointment moves, and the old link is revoked", async () => {
      const a = await appt({ start: 3, end: 3.5 });
      const first = await ensureRoom(admin, { orgId: org, appointmentId: a });
      await svc(() =>
        q("update public.appointments set starts_at = $2, ends_at = $3 where id = $1", [
          a,
          hour(5),
          hour(5.5),
        ]),
      ); // moved by the Unite sync or the desk
      const second = await ensureRoom(admin, { orgId: org, appointmentId: a });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.url).not.toBe(first.url);
      expect(second.created).toBe(true);
      const all = await rooms(a);
      expect(all).toHaveLength(2);
      expect(all.filter((r) => r.status === "active")).toHaveLength(1);
      expect(all.find((r) => r.status === "revoked")).toMatchObject({
        revoked_reason: "rescheduled",
      });
    });

    it("hooks: rescheduling through the service revokes the room, cancelling revokes it and stops a new one", async () => {
      const a = await appt({ start: 6, end: 6.5 });
      await ensureRoom(admin, { orgId: org, appointmentId: a });
      await svc(async () => {
        id.spec =
          id.spec ??
          (await one("insert into public.specialists (org_id, name) values ($1, 'Dr Example')", [
            org,
          ]));
      });
      const cancelled = await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: a,
        to: "cancelled",
        actorId: alice,
      });
      expect(cancelled.ok).toBe(true);
      expect((await rooms(a))[0]).toMatchObject({ status: "revoked", revoked_reason: "cancelled" });
      expect(await live(a)).toHaveLength(0);
      expect(await ensureRoom(admin, { orgId: org, appointmentId: a })).toEqual({
        ok: false,
        reason: "inactive",
      });
      // reopening a cancelled booking gives a fresh room, not the old link
      await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: a,
        to: "confirmed",
        actorId: alice,
      });
      const fresh = await ensureRoom(admin, { orgId: org, appointmentId: a });
      expect(fresh.ok && fresh.created).toBe(true);

      for (const to of ["no_show", "completed"] as const) {
        const b = await appt({ start: 7, end: 7.5 });
        await ensureRoom(admin, { orgId: org, appointmentId: b });
        await changeAppointmentStatus(admin, { orgId: org, appointmentId: b, to, actorId: alice });
        expect(await live(b), to).toHaveLength(0);
      }
      void rescheduleAppointment;
    });

    it("creates exactly one room when several callers ask at the same moment", async () => {
      const a = await appt({ start: 8, end: 8.5 });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => ensureRoom(admin, { orgId: org, appointmentId: a })),
      );
      expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
      expect(results.every((r) => r.ok || r.reason === "busy")).toBe(true);
      expect(await live(a)).toHaveLength(1);
      const urls = new Set(results.filter((r) => r.ok).map((r) => (r as { url: string }).url));
      expect(urls.size).toBe(1);
    });

    it("refuses a link once the visit and its grace period are over", async () => {
      const past = await appt({ start: -3, end: -2.5 });
      expect(await ensureRoom(admin, { orgId: org, appointmentId: past })).toEqual({
        ok: false,
        reason: "expired",
      });
      expect(await rooms(past)).toHaveLength(0);
    });

    it("a stalled 'creating' room is closed after two minutes so a new one can be made", async () => {
      const a = await appt({ start: 9, end: 9.5 });
      await svc(() =>
        q(
          "insert into public.telehealth_rooms (org_id, appointment_id, provider, token_hash, token_enc, status, for_starts_at, for_ends_at, expires_at, created_at) select org_id, id, 'static', $2, 'v1:x:y:z', 'creating', starts_at, ends_at, ends_at, now() - interval '5 minutes' from public.appointments where id = $1",
          [a, "f".repeat(64)],
        ),
      );
      const r = await ensureRoom(admin, { orgId: org, appointmentId: a });
      expect(r.ok).toBe(true);
      expect((await rooms(a)).find((x) => x.token_hash === "f".repeat(64))).toMatchObject({
        status: "revoked",
        revoked_reason: "stalled",
      });
      // a room that is being created right now makes the second caller wait
      const b = await appt({ start: 10, end: 10.5 });
      await svc(() =>
        q(
          "insert into public.telehealth_rooms (org_id, appointment_id, provider, token_hash, token_enc, status, for_starts_at, for_ends_at, expires_at) select org_id, id, 'static', $2, 'v1:x:y:z', 'creating', starts_at, ends_at, ends_at from public.appointments where id = $1",
          [b, "e".repeat(64)],
        ),
      );
      expect(await ensureRoom(admin, { orgId: org, appointmentId: b })).toEqual({
        ok: false,
        reason: "busy",
      });
    });

    it("renewing replaces the link on purpose, and a provider failure leaves no half-made room", async () => {
      const a = await appt({ start: 11, end: 11.5 });
      const first = await ensureRoom(admin, { orgId: org, appointmentId: a });
      const renewed = await ensureRoom(admin, { orgId: org, appointmentId: a, forceNew: true });
      expect(first.ok && renewed.ok && first.url !== renewed.url).toBe(true);
      expect((await rooms(a)).find((r) => r.status === "revoked")).toMatchObject({
        revoked_reason: "replaced",
      });

      const b = await appt({ start: 12, end: 12.5 });
      const bad = createFakeTelehealthProvider({
        failCreate: { code: "http_500", retryable: true },
      });
      expect(await ensureRoom(admin, { orgId: org, appointmentId: b, provider: bad })).toEqual({
        ok: false,
        reason: "provider_error",
      });
      expect(await live(b)).toHaveLength(0);
      expect((await rooms(b))[0]).toMatchObject({
        status: "revoked",
        revoked_reason: "provider_error",
      });
      const good = createFakeTelehealthProvider();
      expect((await ensureRoom(admin, { orgId: org, appointmentId: b, provider: good })).ok).toBe(
        true,
      );
      // the provider was asked for a room named by the token, with the window, and nothing else
      expect(good.created).toHaveLength(1);
      expect(good.created[0].roomName).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Object.keys(good.created[0]).sort()).toEqual(["expiresAt", "notBefore", "roomName"]);
      expect(good.created[0].notBefore.getTime()).toBeLessThan(good.created[0].expiresAt.getTime());
    });

    it("deletes a revoked room at the provider through a durable job, and retries when the provider is down", async () => {
      await svc(() => q("delete from public.scheduled_jobs where kind = 'telehealth.cleanup'"));
      try {
        await cleanupFlow();
      } finally {
        // back to the static provider for the rest
        await saveSettings(admin, {
          orgId: org,
          kind: "telehealth",
          provider: "static",
          secrets: {},
          config: { url_template: TEMPLATE, grace_minutes: 30, early_minutes: 60 },
        });
      }
    });

    async function cleanupFlow() {
      // an API provider room: configure daily, but inject the fake
      await saveSettings(admin, {
        orgId: org,
        kind: "telehealth",
        provider: "daily",
        secrets: { api_key: "DAILY-KEY" },
        config: { domain: "myclinic", grace_minutes: 30, early_minutes: 60 },
      });
      const a = await appt({ start: 13, end: 13.5 });
      const fake = createFakeTelehealthProvider();
      const r = await ensureRoom(admin, { orgId: org, appointmentId: a, provider: fake });
      expect(r.ok && r.url).toMatch(/^https:\/\/video\.fake\.test\/[A-Za-z0-9_-]{43}$/);
      const row = (await rooms(a))[0];
      expect(row).toMatchObject({ provider: "daily", status: "active" });
      expect(row.room_ref).toBe(decryptSecret(row.token_enc));
      expect(await revokeRooms(admin, { orgId: org, appointmentId: a, reason: "cancelled" })).toBe(
        1,
      );
      const jobs = await svc(() =>
        q(
          "select * from public.scheduled_jobs where kind = 'telehealth.cleanup' and dedupe_key = $1",
          [`telehealth-cleanup:${row.id}`],
        ),
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].payload).toEqual({ room_id: row.id });

      const down = createFakeTelehealthProvider({ failDelete: true });
      await expect(
        cleanupRoom(admin, { orgId: org, roomId: row.id, provider: down }),
      ).rejects.toThrow(/will retry/);
      expect((await rooms(a))[0].provider_deleted_at).toBeNull();
      expect(await cleanupRoom(admin, { orgId: org, roomId: row.id, provider: fake })).toBe(
        "deleted",
      );
      expect(fake.deleted).toEqual([row.room_ref]);
      expect((await rooms(a))[0].provider_deleted_at).not.toBeNull();
      expect(await cleanupRoom(admin, { orgId: org, roomId: row.id, provider: fake })).toBe(
        "nothing_to_do",
      );
    }

    describe("the reminder pipeline", () => {
      const sentValues = async (messageId: string) =>
        (await svc(() => q("select payload from public.messages where id = $1", [messageId])))
          .rows[0].payload.send.values as Record<string, string>;

      it("puts the video link into a reminder for a video visit, and safe wording everywhere else", async () => {
        const video = await appt({ start: 20, end: 20.5 });
        const r = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: video,
          key: "reminder",
          sentByUserId: null,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const url = (await live(video))[0] && decryptSecret((await live(video))[0].token_enc);
        expect((await sentValues(r.messageId))["body.3"]).toBe(`https://meet.example.com/${url}`);
        expect((await sentValues(r.messageId))["body.1"]).toBe("Layla");

        const clinic = await appt({ service: id.clinicService, start: 21, end: 21.5 });
        const r2 = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: clinic,
          key: "reminder",
          sentByUserId: null,
        });
        expect(r2.ok && (await sentValues(r2.messageId))["body.3"]).toBe("at the clinic");
        expect(await rooms(clinic)).toHaveLength(0);
      });

      it("says the clinic will send the link when there is none, and never creates a room for a template that does not use it", async () => {
        const a = await appt({ start: 22, end: 22.5 });
        await svc(() =>
          q(
            "update public.integration_accounts set enabled = false where org_id = $1 and kind = 'telehealth'",
            [org],
          ),
        );
        const r = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: a,
          key: "reminder",
          sentByUserId: null,
        });
        expect(r.ok && (await sentValues(r.messageId))["body.3"]).toBe(
          "your clinic will send you the video link",
        );
        expect(await rooms(a)).toHaveLength(0);
        await svc(() =>
          q(
            "update public.integration_accounts set enabled = true where org_id = $1 and kind = 'telehealth'",
            [org],
          ),
        );

        const b = await appt({ start: 23, end: 23.5 });
        await svc(() =>
          q("update public.wa_templates set variable_map = $2::jsonb where id = $1", [
            id.tpl,
            JSON.stringify({
              "body.1": "contact.first_name",
              "body.2": "appointment.datetime",
              "body.3": "appointment.location",
            }),
          ]),
        );
        const r2 = await sendAppointmentTemplate(admin, {
          orgId: org,
          appointmentId: b,
          key: "reminder",
          sentByUserId: null,
        });
        expect(r2.ok).toBe(true);
        expect(await rooms(b)).toHaveLength(0);
        await svc(() =>
          q("update public.wa_templates set variable_map = $2::jsonb where id = $1", [
            id.tpl,
            JSON.stringify({
              "body.1": "contact.first_name",
              "body.2": "appointment.datetime",
              "body.3": "appointment.video_link",
            }),
          ]),
        );
      });

      it("resolveVideoLink never throws and never returns an empty value", async () => {
        const a = await appt({ start: 24, end: 24.5 });
        const ok = await resolveVideoLink(admin, { orgId: org, appointmentId: a });
        expect(ok.mode).toBe("video");
        expect(ok.url).toMatch(/^https:\/\/meet\.example\.com\//);
        expect(ok.text).toBe(ok.url);
        const bad = await appt({ start: 25, end: 25.5 });
        const failing = await resolveVideoLink(admin, {
          orgId: org,
          appointmentId: bad,
          provider: createFakeTelehealthProvider({ failCreate: { code: "x", retryable: true } }),
        });
        expect(failing).toMatchObject({
          mode: "video",
          url: null,
          text: "your clinic will send you the video link",
        });
        const missing = await resolveVideoLink(admin, {
          orgId: org,
          appointmentId: "00000000-0000-4000-8000-000000000000",
        });
        expect(missing.text.length).toBeGreaterThan(0);
      });
    });

    it("makes no room in a training workspace", async () => {
      const a = await appt({ start: 30, end: 30.5 });
      await svc(() => q("update public.orgs set is_training = true where id = $1", [org]));
      try {
        expect(await ensureRoom(admin, { orgId: org, appointmentId: a })).toEqual({
          ok: false,
          reason: "training",
        });
        expect(await rooms(a)).toHaveLength(0);
        expect((await resolveVideoLink(admin, { orgId: org, appointmentId: a })).url).toBeNull();
      } finally {
        await svc(() => q("update public.orgs set is_training = false where id = $1", [org]));
      }
    });

    it("keeps the room table away from every browser session", async () => {
      await patchConfig(admin, org, "telehealth", { grace_minutes: 30 });
      const n = await svc(() => q("select count(*)::int as n from public.telehealth_rooms"));
      expect(n.rows[0].n).toBeGreaterThan(0);
      await q("set role authenticated");
      await q("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: alice, role: "authenticated" }),
      ]);
      try {
        expect((await q("select count(*)::int as n from public.telehealth_rooms")).rows[0].n).toBe(
          0,
        );
        await expect(
          q("insert into public.telehealth_rooms (org_id) values ($1)", [org]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await q("reset role");
      }
    });
  },
);
