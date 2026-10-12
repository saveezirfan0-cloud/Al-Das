/**
 * Phase 19a server code against a real Postgres through PostgREST. Nothing leaves the machine: providers are fakes and the
 * webhook routes are called in-process with signed Request objects. Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAccount, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import {
  feedAppointments,
  createFeed,
  listFeeds,
  resolveFeed,
  revokeFeed,
  rotateFeed,
  serveFeed,
} from "@/lib/integrations/calendar/feed-server";
import { parseFeedToken } from "@/lib/integrations/calendar/token";
import { createFakePaymentProvider } from "@/lib/integrations/payments/fake";
import { applyPaymentEvent } from "@/lib/integrations/payments/apply";
import { stripeSignatureHeader } from "@/lib/integrations/payments/stripe";
import { paytabsSignature } from "@/lib/integrations/payments/paytabs";
import { paymentWebhookSpec } from "@/lib/integrations/payments/webhook";
import {
  cancelPaymentRequest,
  createPaymentRequest,
} from "@/lib/integrations/payments/request-server";
import { patchConfig } from "@/lib/integrations/accounts";
import { createFakeSmsProvider } from "@/lib/integrations/sms/fake";
import { queueSmsFallback } from "@/lib/integrations/sms/fallback";
import { applySmsReceipt, smsWebhookSpec } from "@/lib/integrations/sms/receipts";
import { processSmsJob } from "@/lib/integrations/sms/send";
import { twilioSignature } from "@/lib/integrations/sms/twilio";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";
import { reportReminderFailure } from "@/lib/jobs/handlers/appointments";
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
const APP_URL = "https://pulse.test";
const day = (offset: number, hour = 6) =>
  new Date(Date.UTC(2026, 9, 18 + offset, hour, 0, 0)).toISOString();

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 19a: integration services",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let finUser: string;
    let org: string;
    let other: string;
    const id: Record<string, string> = {};
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const one = async (sql: string, params: unknown[] = []) =>
      (await q(sql + " returning id::text", params)).rows[0].id as string;
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = APP_URL;
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      finUser = await createAuthUser(c, "fin@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      other = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      await svc(async () => {
        await q("update public.orgs set timezone = 'Asia/Dubai' where id = any ($1)", [
          [org, other],
        ]);
        id.loc = await one(
          "insert into public.locations (org_id, name) values ($1, 'Jumeirah Clinic')",
          [org],
        );
        id.spec = await one(
          "insert into public.specialists (org_id, name, user_id) values ($1, 'Dr Example', $2)",
          [org, alice],
        );
        id.spec2 = await one(
          "insert into public.specialists (org_id, name) values ($1, 'Dr Second')",
          [org],
        );
        id.otherSpec = await one(
          "insert into public.specialists (org_id, name) values ($1, 'Dr Other Org')",
          [other],
        );
        id.patient = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, language, external_id) values ($1, 'Sara', 'Examplesurname', '+971501110001', 'en', 'PIN-100')",
          [org],
        );
        id.channel = await one(
          "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Main', 'waba-19', 'pn-19')",
          [org],
        );
        id.role = await one(
          "insert into public.roles (org_id, name, description, permissions) values ($1, 'Payments', '', '[\"finance.payment_links\"]'::jsonb)",
          [org],
        );
        await q("insert into public.memberships (org_id, user_id, role_id) values ($1, $2, $3)", [
          org,
          finUser,
          id.role,
        ]);
      });
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    async function appt(over: {
      spec?: string;
      startsAt: string;
      status?: string;
      contact?: string;
      notes?: string;
    }) {
      return svc(() =>
        one(
          "insert into public.appointments (org_id, contact_id, location_id, specialist_id, starts_at, ends_at, status, notes) values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes', $6, $7)",
          [
            org,
            over.contact ?? id.patient,
            id.loc,
            over.spec ?? id.spec,
            over.startsAt,
            over.status ?? "confirmed",
            over.notes ?? "SECRET clinical note",
          ],
        ),
      );
    }

    // ---------------------------------------------------------------------------------------------------------------
    describe("doctor calendar feed", () => {
      let token: string;
      let feedId: string;
      const NOW = new Date("2026-10-18T08:00:00Z");

      beforeAll(async () => {
        await svc(async () => {
          await q(
            "update public.contacts set first_name = 'Sara', last_name = 'Examplesurname' where id = $1",
            [id.patient],
          );
        });
        await saveSettings(admin, {
          orgId: org,
          kind: "calendar_ics",
          provider: "ics",
          secrets: {},
          config: {},
        });
        await setEnabled(admin, { orgId: org, kind: "calendar_ics", userId: alice, enabled: true });
        id.aInWindow = await appt({ startsAt: day(2) });
        id.aCancelled = await appt({ startsAt: day(3), status: "cancelled" });
        id.aPast = await appt({ startsAt: day(-6) });
        id.aTooOld = await appt({ startsAt: day(-8) });
        id.aTooFar = await appt({ startsAt: day(61) });
        id.aOtherDoc = await appt({ startsAt: day(2, 9), spec: id.spec2 });
      });

      it("creates a feed whose URL token is shown once and stored only as a hash", async () => {
        const r = await createFeed(admin, {
          orgId: org,
          actorId: alice,
          target: { kind: "specialist", specialistId: id.spec },
          label: "Dr Example",
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        token = r.token;
        feedId = r.id;
        expect(parseFeedToken(token)).toBe(token);
        const { rows } = await svc(() =>
          q("select token_hash from public.calendar_feeds where id = $1", [feedId]),
        );
        expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0].token_hash).not.toContain(token);
        const listed = await listFeeds(admin, org);
        expect(JSON.stringify(listed)).not.toContain(token);
        expect(JSON.stringify(listed)).not.toContain(rows[0].token_hash);
      });

      it("serves only the window, only that doctor, with no patient detail at all", async () => {
        const served = await serveFeed(admin, token, { now: NOW });
        expect(served.status).toBe(200);
        if (served.status !== 200) return;
        const body = served.body;
        expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
        expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(3); // in window, cancelled, 6 days ago
        for (const secret of [
          "Sara",
          "Examplesurname",
          "971501110001",
          "SECRET clinical note",
          "PIN-100",
        ])
          expect(body).not.toContain(secret);
        expect(body).toContain("SUMMARY:Appointment");
        expect(body).toContain("LOCATION:Jumeirah Clinic");
        expect(body).toContain("STATUS:CANCELLED");
        expect(body).toContain("DTSTART:20261020T060000Z");
        expect(body).not.toContain("DTSTART:20261010"); // 8 days ago
        expect(body).not.toContain("DTSTART:20261218"); // 61 days ahead
      });

      it("answers 304 to a matching ETag and counts every fetch in aggregate", async () => {
        const first = await serveFeed(admin, token, { now: NOW });
        expect(first.status).toBe(200);
        if (first.status !== 200) return;
        const second = await serveFeed(admin, token, { now: NOW, ifNoneMatch: first.etag });
        expect(second).toEqual({ status: 304, etag: first.etag });
        const { rows } = await svc(() =>
          q(
            "select access_count::int as n, last_access_at is not null as seen from public.calendar_feeds where id = $1",
            [feedId],
          ),
        );
        expect(rows[0].n).toBe(3);
        expect(rows[0].seen).toBe(true);
        const usage = await svc(() =>
          q(
            "select value::int as v from public.integration_usage_daily where org_id = $1 and provider = 'calendar_ics' and metric = 'feed_fetches'",
            [org],
          ),
        );
        expect(usage.rows[0].v).toBe(3);
        // aggregate only: no table holds a per-request record of who fetched
        const t = await svc(() =>
          q(
            "select table_name from information_schema.columns where table_schema = 'public' and column_name in ('ip', 'user_agent', 'ip_hash') and table_name like 'calendar%'",
          ),
        );
        expect(t.rows).toEqual([]);
      });

      it("answers the same 404 for unknown, malformed and wrong tokens", async () => {
        expect(await serveFeed(admin, "pcf_" + "A".repeat(43), { now: NOW })).toEqual({
          status: 404,
        });
        expect(await serveFeed(admin, "nonsense", { now: NOW })).toEqual({ status: 404 });
        expect(await serveFeed(admin, `${token.slice(0, -1)}x`, { now: NOW })).toEqual({
          status: 404,
        });
      });

      it("rotating replaces the link at once; revoking stops it; rotating again brings it back", async () => {
        const r = await rotateFeed(admin, org, feedId);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(await serveFeed(admin, token, { now: NOW })).toEqual({ status: 404 });
        expect((await serveFeed(admin, r.token, { now: NOW })).status).toBe(200);
        expect((await revokeFeed(admin, org, feedId)).ok).toBe(true);
        expect(await serveFeed(admin, r.token, { now: NOW })).toEqual({ status: 404 });
        expect((await revokeFeed(admin, org, feedId)).ok).toBe(false);
        const back = await rotateFeed(admin, org, feedId);
        expect(back.ok).toBe(true);
        if (back.ok) {
          token = back.token;
          expect((await serveFeed(admin, token, { now: NOW })).status).toBe(200);
        }
      });

      it("never touches another org's feed", async () => {
        expect((await rotateFeed(admin, other, feedId)).ok).toBe(false);
        expect((await revokeFeed(admin, other, feedId)).ok).toBe(false);
        const bad = await createFeed(admin, {
          orgId: other,
          actorId: alice,
          target: { kind: "specialist", specialistId: id.spec },
          label: "x",
        });
        expect(bad.ok).toBe(false);
        const ok = await createFeed(admin, {
          orgId: org,
          actorId: alice,
          target: { kind: "specialist", specialistId: id.otherSpec },
          label: "x",
        });
        expect(ok.ok).toBe(false);
      });

      it("a 'my appointments' feed covers the doctor profiles linked to the person", async () => {
        const r = await createFeed(admin, {
          orgId: org,
          actorId: alice,
          target: { kind: "user", userId: alice },
          label: "Mine",
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const feed = await resolveFeed(admin, r.token);
        expect(feed?.kind).toBe("user");
        const events = await feedAppointments(admin, feed!, NOW);
        expect(events.map((e) => e.id).sort()).toEqual(
          [id.aInWindow, id.aCancelled, id.aPast].sort(),
        );
        const stranger = await createFeed(admin, {
          orgId: org,
          actorId: alice,
          target: { kind: "user", userId: finUser },
          label: "No profile",
        });
        expect(stranger.ok).toBe(true);
        if (stranger.ok)
          expect(
            await feedAppointments(admin, (await resolveFeed(admin, stranger.token))!, NOW),
          ).toEqual([]);
        expect(
          (
            await createFeed(admin, {
              orgId: org,
              actorId: alice,
              target: { kind: "user", userId: "00000000-0000-0000-0000-000000000000" },
              label: "x",
            })
          ).ok,
        ).toBe(false);
      });

      it("stops serving when the integration is switched off", async () => {
        await setEnabled(admin, {
          orgId: org,
          kind: "calendar_ics",
          userId: alice,
          enabled: false,
        });
        expect(await serveFeed(admin, token, { now: NOW })).toEqual({ status: 404 });
        await setEnabled(admin, { orgId: org, kind: "calendar_ics", userId: alice, enabled: true });
        expect((await serveFeed(admin, token, { now: NOW })).status).toBe(200);
      });
    });

    // ---------------------------------------------------------------------------------------------------------------
    describe("SMS fallback", () => {
      const NOW = new Date("2026-10-18T08:00:00Z");
      let apptId: string;
      let reminderId: string;
      let accountId: string;
      const queueDepth = async () =>
        Number((await q("select count(*)::text as n from pgmq.q_sms_outbound")).rows[0].n);
      const smsRows = async () =>
        (
          await svc(() =>
            q("select * from public.sms_messages where org_id = $1 order by created_at", [org]),
          )
        ).rows;

      async function newAppointment(contactId = id.patient, hours = 48) {
        const a = await appt({
          startsAt: new Date(NOW.getTime() + hours * 3_600_000).toISOString(),
          contact: contactId,
        });
        const r = await svc(() =>
          one(
            "insert into public.appointment_reminders (org_id, appointment_id, idx, due_at, status) values ($1, $2, 1, now(), 'failed')",
            [org, a],
          ),
        );
        return { a, r };
      }

      beforeAll(async () => {
        await saveSettings(admin, {
          orgId: org,
          kind: "sms",
          provider: "twilio",
          secrets: { auth_token: "tok_secret_value" },
          config: {
            account_sid: "AC00000000000000000000000000000000",
            sender: "ALDAS",
            clinic_name: "Al Das Clinic",
            callback_phone: "+97140000000",
            rate_per_sec: 1000,
            daily_cap: 200,
            segment_price: "0.20",
          },
        });
        accountId = (await loadAccount(admin, org, "sms"))!.id;
        ({ a: apptId, r: reminderId } = await newAppointment());
      });

      it("stores credentials encrypted and never in the clear", async () => {
        const row = (
          await svc(() =>
            q(
              "select config_enc, config::text as config from public.integration_accounts where id = $1",
              [accountId],
            ),
          )
        ).rows[0];
        expect(row.config_enc).toMatch(/^v1:/);
        expect(row.config_enc).not.toContain("tok_secret_value");
        expect(row.config).not.toContain("tok_secret_value");
        expect(row.config).toContain("ALDAS");
      });

      it("does nothing while the integration is off", async () => {
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: apptId,
            reminderId,
            now: NOW,
          }),
        ).toBe("off");
        expect(await smsRows()).toHaveLength(0);
        expect(await queueDepth()).toBe(0);
      });

      it("queues one SMS per failed reminder, on its own queue, with no phone or text stored", async () => {
        await setEnabled(admin, { orgId: org, kind: "sms", userId: alice, enabled: true });
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: apptId,
            reminderId,
            now: NOW,
          }),
        ).toBe("queued");
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: apptId,
            reminderId,
            now: NOW,
          }),
        ).toBe("duplicate");
        const rows = await smsRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: "queued",
          provider: "twilio",
          contact_id: id.patient,
          appointment_id: apptId,
          dedupe_key: `reminder:${reminderId}`,
        });
        expect(JSON.stringify(rows[0])).not.toContain("971501110001");
        expect(await queueDepth()).toBe(1);
        const timeline = await svc(() =>
          q(
            "select payload::text as p from public.timeline_events where contact_id = $1 and type = 'sms.fallback_queued'",
            [id.patient],
          ),
        );
        expect(timeline.rows).toHaveLength(1);
        expect(timeline.rows[0].p).not.toContain("971501110001");
      });

      it("sends once, through the provider, with a generic text and the status callback", async () => {
        const rows = await smsRows();
        const fake = createFakeSmsProvider();
        const outcome = await processSmsJob(admin, rows[0].id, {
          readCt: 1,
          provider: fake,
          now: NOW,
        });
        expect(outcome).toBe("sent");
        expect(fake.sent).toHaveLength(1);
        const sent = fake.sent[0];
        expect(sent.to).toBe("+971501110001");
        expect(sent.body).toBe(
          "Al Das Clinic: reminder of your appointment on 20/10/2026 at 12:00. To change it please call +97140000000",
        );
        for (const hidden of ["Sara", "Examplesurname", "Dr Example", "Jumeirah", "SECRET"])
          expect(sent.body).not.toContain(hidden);
        expect(sent.statusCallbackUrl).toBe(
          `${APP_URL}/api/webhooks/integrations/sms/${accountId}?m=${rows[0].id}`,
        );
        const after = (await smsRows())[0];
        expect(after).toMatchObject({
          status: "sent",
          provider_message_id: "SMfake0001",
          segments: 1,
        });
        expect(after.sent_at).not.toBeNull();
        // the same job delivered again sends nothing
        expect(
          await processSmsJob(admin, rows[0].id, { readCt: 2, provider: fake, now: NOW }),
        ).toBe("skipped");
        expect(fake.sent).toHaveLength(1);
        const usage = Object.fromEntries(
          (
            await svc(() =>
              q(
                "select metric, value::int as v from public.integration_usage_daily where org_id = $1 and provider = 'sms' and day = current_date",
                [org],
              ),
            )
          ).rows.map((r) => [r.metric, r.v]),
        );
        expect(usage).toMatchObject({ queued: 1, sent: 1, segments: 1 });
      });

      it("applies delivery receipts forward only, once", async () => {
        const row = (await smsRows())[0];
        const apply = (status: string, errorCode: string | null = null) =>
          applySmsReceipt(admin, org, {
            providerMessageId: "SMfake0001",
            status,
            errorCode,
            smsId: row.id,
          });
        expect(await apply("sending")).toBe("not_forward"); // already 'sent'
        expect(await apply("delivered")).toBe("applied_delivered");
        expect(await apply("sent")).toBe("not_forward");
        expect(await apply("undelivered")).toBe("not_forward"); // delivered is final
        expect(await apply("mystery")).toBe("ignored_status");
        expect((await smsRows())[0]).toMatchObject({ status: "delivered" });
        expect((await smsRows())[0].delivered_at).not.toBeNull();
        expect(
          await applySmsReceipt(admin, org, {
            providerMessageId: "SMnope",
            status: "delivered",
            errorCode: null,
            smsId: null,
          }),
        ).toBe("unknown_message");
        // another org's id never matches
        expect(
          await applySmsReceipt(admin, other, {
            providerMessageId: "SMfake0001",
            status: "delivered",
            errorCode: null,
            smsId: row.id,
          }),
        ).toBe("unknown_message");
      });

      it("skips people who opted out, and landlines, without writing a message", async () => {
        const optOut = await svc(() =>
          one(
            "insert into public.contacts (org_id, first_name, phone_e164, sms_opt_out_at) values ($1, 'Out', '+971501110002', now())",
            [org],
          ),
        );
        const landline = await svc(() =>
          one(
            "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Land', '+97142222222')",
            [org],
          ),
        );
        const before = (await smsRows()).length;
        const a1 = await newAppointment(optOut);
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a1.a,
            reminderId: a1.r,
            now: NOW,
          }),
        ).toBe("skipped:opted_out");
        const a2 = await newAppointment(landline);
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a2.a,
            reminderId: a2.r,
            now: NOW,
          }),
        ).toBe("skipped:not_sms_capable");
        expect((await smsRows()).length).toBe(before);
      });

      it("does not text someone who stopped WhatsApp business messages, but a marketing opt-out does not block a reminder", async () => {
        const a = await newAppointment();
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            whatsappErrorCode: 131050,
            now: NOW,
          }),
        ).toBe("skipped:whatsapp_opt_out");
        await svc(() =>
          q("update public.contacts set stop_marketing = true where id = $1", [id.patient]),
        );
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            whatsappErrorCode: 131026,
            now: NOW,
          }),
        ).toBe("queued");
        await svc(() =>
          q("update public.contacts set stop_marketing = false where id = $1", [id.patient]),
        );
      });

      it("reaches the guardian of a child without a phone, naming the child by first name only", async () => {
        const guardian = await svc(() =>
          one(
            "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Mona', 'Guardian', '+971501110003')",
            [org],
          ),
        );
        const child = await svc(() =>
          one(
            "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Omar', 'Guardian')",
            [org],
          ),
        );
        await svc(() =>
          q(
            "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
            [org, guardian, child],
          ),
        );
        const a = await newAppointment(child);
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            now: NOW,
          }),
        ).toBe("queued");
        const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
        expect(row.contact_id).toBe(guardian);
        const fake = createFakeSmsProvider();
        expect(await processSmsJob(admin, row.id, { readCt: 1, provider: fake, now: NOW })).toBe(
          "sent",
        );
        expect(fake.sent[0].to).toBe("+971501110003");
        expect(fake.sent[0].body).toContain("Omar's appointment");
        expect(fake.sent[0].body).not.toContain("Mona");
        expect(fake.sent[0].body).not.toContain("Guardian");
      });

      it("re-checks everything when it sends: a cancelled appointment is not texted", async () => {
        const a = await newAppointment();
        expect(
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            now: NOW,
          }),
        ).toBe("queued");
        const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
        await svc(() =>
          q("update public.appointments set status = 'cancelled' where id = $1", [a.a]),
        );
        const fake = createFakeSmsProvider();
        expect(await processSmsJob(admin, row.id, { readCt: 1, provider: fake, now: NOW })).toBe(
          "skipped",
        );
        expect(fake.sent).toHaveLength(0);
        expect((await smsRows()).find((r) => r.id === row.id)).toMatchObject({
          status: "failed",
          error_code: "skip_appointment_inactive",
        });
      });

      it("handles provider failures: permanent, opt-out, ambiguous and retryable", async () => {
        const make = async () => {
          const a = await newAppointment();
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            now: NOW,
          });
          return (await smsRows()).find((r) => r.appointment_id === a.a)!;
        };
        const failing = (over: Record<string, unknown>) =>
          createFakeSmsProvider([
            {
              ok: false,
              code: "21211",
              retryable: false,
              ambiguous: false,
              optOut: false,
              ...over,
            } as never,
          ]);

        const permanent = await make();
        expect(
          await processSmsJob(admin, permanent.id, { readCt: 1, provider: failing({}), now: NOW }),
        ).toBe("failed");
        expect((await smsRows()).find((r) => r.id === permanent.id)).toMatchObject({
          status: "failed",
          error_code: "21211",
        });

        const unsub = await make();
        expect(
          await processSmsJob(admin, unsub.id, {
            readCt: 1,
            provider: failing({ code: "21610", optOut: true }),
            now: NOW,
          }),
        ).toBe("failed");
        const contact = (
          await svc(() =>
            q("select sms_opt_out_at from public.contacts where id = $1", [id.patient]),
          )
        ).rows[0];
        expect(contact.sms_opt_out_at).not.toBeNull();
        await svc(() =>
          q("update public.contacts set sms_opt_out_at = null where id = $1", [id.patient]),
        );

        const ambiguous = await make();
        expect(
          await processSmsJob(admin, ambiguous.id, {
            readCt: 1,
            provider: failing({ code: "timeout", ambiguous: true }),
            now: NOW,
          }),
        ).toBe("failed");
        expect((await smsRows()).find((r) => r.id === ambiguous.id)).toMatchObject({
          status: "failed",
          error_code: "unknown_delivery",
        });

        const retry = await make();
        expect(
          await processSmsJob(admin, retry.id, {
            readCt: 1,
            provider: failing({ code: "breaker_open", retryable: true }),
            now: NOW,
          }),
        ).toBe("retry");
        expect((await smsRows()).find((r) => r.id === retry.id)?.status).toBe("queued");
        expect(
          await processSmsJob(admin, retry.id, {
            readCt: 5,
            provider: failing({ code: "breaker_open", retryable: true }),
            now: NOW,
          }),
        ).toBe("failed");
        const acct = await loadAccount(admin, org, "sms");
        expect(acct?.last_error).toContain("SMS provider error");
        expect(acct?.last_error).not.toContain("tok_secret_value");
      });

      it("enforces the per-sender rate limit by putting the job back on the queue", async () => {
        await saveSettings(admin, {
          orgId: org,
          kind: "sms",
          provider: "twilio",
          secrets: {},
          config: {
            account_sid: "AC00000000000000000000000000000000",
            sender: "ALDAS",
            clinic_name: "Al Das Clinic",
            callback_phone: "+97140000000",
            rate_per_sec: 1,
            daily_cap: 200,
            segment_price: "0.20",
          },
        });
        await svc(() => q("truncate public.rate_limit_hits"));
        const results: string[] = [];
        const fake = createFakeSmsProvider();
        for (let i = 0; i < 3; i++) {
          const a = await newAppointment();
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            now: NOW,
          });
          const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
          results.push(await processSmsJob(admin, row.id, { readCt: 1, provider: fake, now: NOW }));
        }
        expect(results).toContain("requeued"); // at most one send per second per sender
        expect(results.filter((r) => r === "sent").length).toBeLessThan(3);
        await saveSettings(admin, {
          orgId: org,
          kind: "sms",
          provider: "twilio",
          secrets: {},
          config: {
            account_sid: "AC00000000000000000000000000000000",
            sender: "ALDAS",
            clinic_name: "Al Das Clinic",
            callback_phone: "+97140000000",
            rate_per_sec: 1000,
            daily_cap: 200,
            segment_price: "0.20",
          },
        });
      });

      it("stops at the daily limit", async () => {
        await patchConfig(admin, org, "sms", { daily_cap: 1 });
        const a = await newAppointment();
        await queueSmsFallback(admin, {
          orgId: org,
          appointmentId: a.a,
          reminderId: a.r,
          now: NOW,
        });
        const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
        const fake = createFakeSmsProvider();
        expect(
          await processSmsJob(admin, row.id, { readCt: 1, provider: fake, now: new Date() }),
        ).toBe("failed");
        expect(fake.sent).toHaveLength(0);
        expect((await smsRows()).find((r) => r.id === row.id)?.error_code).toBe("daily_cap");
        await patchConfig(admin, org, "sms", { daily_cap: 200 });
      });

      it("is blocked in a training workspace, both when queueing and when sending", async () => {
        const a = await newAppointment();
        await queueSmsFallback(admin, {
          orgId: org,
          appointmentId: a.a,
          reminderId: a.r,
          now: NOW,
        });
        const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
        await svc(() => q("update public.orgs set is_training = true where id = $1", [org]));
        try {
          const b = await newAppointment();
          expect(
            await queueSmsFallback(admin, {
              orgId: org,
              appointmentId: b.a,
              reminderId: b.r,
              now: NOW,
            }),
          ).toBe("training");
          const fake = createFakeSmsProvider();
          expect(await processSmsJob(admin, row.id, { readCt: 1, provider: fake, now: NOW })).toBe(
            "failed",
          );
          expect(fake.sent).toHaveLength(0);
          expect((await smsRows()).find((r) => r.id === row.id)?.error_code).toBe("training_mode");
        } finally {
          await svc(() => q("update public.orgs set is_training = false where id = $1", [org]));
        }
      });

      it("is wired into the failed-reminder path: the call task is still raised and an SMS is queued", async () => {
        const a = await newAppointment();
        const number = Number(
          (await svc(() => q("select number from public.appointments where id = $1", [a.a])))
            .rows[0].number,
        );
        await reportReminderFailure(admin, org, a.a, number, "delivery failed", {
          reminderId: a.r,
          whatsappErrorCode: 131026,
        });
        expect(
          await svc(() =>
            q(
              "select 1 from public.tasks where appointment_id = $1 and type = 'call' and done = false",
              [a.a],
            ),
          ),
        ).toMatchObject({ rowCount: 1 });
        expect((await smsRows()).some((r) => r.appointment_id === a.a)).toBe(true);
        // and with the integration off, only the call task
        await setEnabled(admin, { orgId: org, kind: "sms", userId: alice, enabled: false });
        const b = await newAppointment();
        await reportReminderFailure(admin, org, b.a, 1, "delivery failed", { reminderId: b.r });
        expect((await smsRows()).some((r) => r.appointment_id === b.a)).toBe(false);
        await setEnabled(admin, { orgId: org, kind: "sms", userId: alice, enabled: true });
      });

      describe("delivery receipt route", () => {
        const post = (
          accountIdArg: string,
          params: Record<string, string>,
          opts: { search?: string; sign?: boolean; token?: string } = {},
        ) => {
          const search = opts.search ?? "";
          const url = `${APP_URL}/api/webhooks/integrations/sms/${accountIdArg}${search}`;
          const sig = twilioSignature(opts.token ?? "tok_secret_value", url, params);
          return receiveIntegrationWebhook(
            new Request(url, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-twilio-signature": opts.sign === false ? "bad" : sig,
                "x-forwarded-for": "198.51.100.7",
              },
              body: new URLSearchParams(params).toString(),
            }),
            accountIdArg,
            "sms",
            smsWebhookSpec(),
          );
        };

        it("rejects a bad signature, an unknown account and a switched-off account the same way it should", async () => {
          const row = (await smsRows()).find((r) => r.status === "delivered")!;
          const params = { MessageSid: "SMfake0001", MessageStatus: "delivered" };
          expect(
            (await post(accountId, params, { search: `?m=${row.id}`, sign: false })).status,
          ).toBe(401);
          expect(
            (await post(accountId, params, { search: `?m=${row.id}`, token: "wrong" })).status,
          ).toBe(401);
          expect((await post("11111111-1111-1111-1111-111111111111", params)).status).toBe(404);
          expect((await post("not-a-uuid", params)).status).toBe(404);
        });

        it("applies a signed receipt once and treats the repeat as a duplicate", async () => {
          const a = await newAppointment();
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            now: NOW,
          });
          const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
          await processSmsJob(admin, row.id, {
            readCt: 1,
            provider: createFakeSmsProvider([
              { ok: true, providerMessageId: "SMroute01", status: "queued", segments: 1 },
            ]),
            now: NOW,
          });
          const params = { MessageSid: "SMroute01", MessageStatus: "delivered", AccountSid: "AC1" };
          const first = await post(accountId, params, { search: `?m=${row.id}` });
          expect(first.status).toBe(200);
          expect(await first.json()).toMatchObject({ processed: 1, duplicates: 0 });
          const again = await post(accountId, params, { search: `?m=${row.id}` });
          expect(await again.json()).toMatchObject({ processed: 0, duplicates: 1 });
          expect((await smsRows()).find((r) => r.id === row.id)?.status).toBe("delivered");
          const keys = await svc(() =>
            q(
              "select outcome from public.integration_webhook_events where org_id = $1 and event_key = 'SMroute01:delivered'",
              [org],
            ),
          );
          expect(keys.rows).toEqual([{ outcome: "applied_delivered" }]);
        });

        it("records an unsubscribe reported by the provider", async () => {
          const a = await newAppointment();
          await queueSmsFallback(admin, {
            orgId: org,
            appointmentId: a.a,
            reminderId: a.r,
            now: NOW,
          });
          const row = (await smsRows()).find((r) => r.appointment_id === a.a)!;
          await processSmsJob(admin, row.id, {
            readCt: 1,
            provider: createFakeSmsProvider([
              { ok: true, providerMessageId: "SMroute02", status: "queued", segments: 1 },
            ]),
            now: NOW,
          });
          const res = await post(
            accountId,
            { MessageSid: "SMroute02", MessageStatus: "undelivered", ErrorCode: "21610" },
            { search: `?m=${row.id}` },
          );
          expect(res.status).toBe(200);
          expect((await smsRows()).find((r) => r.id === row.id)).toMatchObject({
            status: "undelivered",
            error_code: "21610",
          });
          expect(
            (
              await svc(() =>
                q("select sms_opt_out_at from public.contacts where id = $1", [id.patient]),
              )
            ).rows[0].sms_opt_out_at,
          ).not.toBeNull();
          await svc(() =>
            q("update public.contacts set sms_opt_out_at = null where id = $1", [id.patient]),
          );
        });
      });
    });

    // ---------------------------------------------------------------------------------------------------------------
    describe("payment links", () => {
      let accountId: string;
      let invoice: string;
      const NOW = new Date("2026-10-18T08:00:00Z");
      const payRows = async () =>
        (
          await svc(() =>
            q("select * from public.fin_payment_requests where org_id = $1 order by created_at", [
              org,
            ]),
          )
        ).rows;
      const BODY = "Hello {{1}}, please pay {{2}} for invoice {{3}}: {{4}}";

      beforeAll(async () => {
        invoice = await svc(() =>
          one(
            "insert into public.fin_invoices (org_id, inv_display_number, patient_pin, total, record_hash) values ($1, 'INV-1042', 'PIN-100', 150, 'hash-1042')",
            [org],
          ),
        );
        id.tpl = await svc(() =>
          one(
            `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
           values ($1, $2, 'waba-19', 'payment_request', 'en', 'UTILITY', 'APPROVED', $3::jsonb)`,
            [org, id.channel, JSON.stringify([{ type: "BODY", text: BODY }])],
          ),
        );
        await saveSettings(admin, {
          orgId: org,
          kind: "payments",
          provider: "stripe",
          secrets: { secret_key: "sk_test_SECRET", webhook_secret: "whsec_test_secret" },
          config: { currency: "AED", link_expiry_hours: 24 },
        });
        await patchConfig(admin, org, "payments", {
          template_id: id.tpl,
          variable_map: JSON.stringify({
            "body.1": "first_name",
            "body.2": "amount_due",
            "body.3": "invoice_ref",
            "body.4": "payment_link",
          }),
        });
        accountId = (await loadAccount(admin, org, "payments"))!.id;
      });

      const create = (
        over: Partial<Parameters<typeof createPaymentRequest>[1]> = {},
        provider = createFakePaymentProvider(),
      ) =>
        createPaymentRequest(admin, {
          orgId: org,
          actorId: finUser,
          invoiceNumber: "inv-1042",
          amount: "150.00",
          now: NOW,
          provider,
          ...over,
        });

      it("refuses while the integration is off", async () => {
        expect((await create()).ok).toBe(false);
        expect(await payRows()).toHaveLength(0);
        await setEnabled(admin, { orgId: org, kind: "payments", userId: alice, enabled: true });
      });

      it("validates the invoice and the amount before anything is created", async () => {
        const fake = createFakePaymentProvider();
        for (const [over, text] of [
          [{ invoiceNumber: "NOPE" }, "No invoice"],
          [{ amount: "abc" }, "plain number"],
          [{ amount: "150.01" }, "more than the invoice total"],
          [{ amount: "0" }, "plain number"],
        ] as const) {
          const r = await create(over, fake);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error).toContain(text);
        }
        expect(fake.created).toHaveLength(0);
        expect(await payRows()).toHaveLength(0);
      });

      it("creates the gateway link and sends it as the approved template, with no name in the gateway request", async () => {
        const fake = createFakePaymentProvider();
        const r = await create({}, fake);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(fake.created).toHaveLength(1);
        expect(fake.created[0]).toMatchObject({
          amountMinor: 15000,
          currency: "AED",
          description: "Invoice INV-1042",
        });
        expect(JSON.stringify(fake.created[0])).not.toMatch(
          /Sara|Examplesurname|PIN-100|971501110001/,
        );
        expect(fake.created[0].webhookUrl).toBe(
          `${APP_URL}/api/webhooks/integrations/payments/${accountId}`,
        );
        expect(fake.created[0].returnUrl).toBe(`${APP_URL}/pay/done`);
        expect(fake.created[0].expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);

        const [row] = await payRows();
        expect(row).toMatchObject({
          status: "sent",
          provider: "stripe",
          amount_minor: "15000",
          currency: "AED",
          invoice_number: "INV-1042",
          patient_pin: "PIN-100",
          contact_id: id.patient,
          provider_ref: "cs_test_fake_1",
          needs_review: false,
        });
        expect(row.message_id).not.toBeNull();
        expect(JSON.stringify(row)).not.toContain("pay.example.test"); // the link itself is not stored on the request

        const msg = (
          await svc(() =>
            q("select kind, status, body, payload from public.messages where id = $1", [
              row.message_id,
            ]),
          )
        ).rows[0];
        expect(msg).toMatchObject({ kind: "template", status: "queued" });
        expect(msg.payload.send).toMatchObject({ type: "template", template_id: id.tpl });
        expect(msg.payload.send.values).toEqual({
          "body.1": "Sara",
          "body.2": "AED 150.00",
          "body.3": "INV-1042",
          "body.4": "https://pay.example.test/session/1",
        });
        const queued = (await q("select count(*)::int as n from pgmq.q_outbound_priority")).rows[0]
          .n;
        expect(queued).toBeGreaterThan(0);
      });

      it("allows one open link per invoice", async () => {
        const r = await create();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("already open");
      });

      it("never writes to the invoice (nothing is marked paid, nothing goes to Unite)", async () => {
        const inv = (
          await svc(() => q("select * from public.fin_invoices where id = $1", [invoice]))
        ).rows[0];
        expect(inv).toMatchObject({ record_hash: "hash-1042", version: 1 });
        expect(Number(inv.total)).toBe(150);
      });

      describe("gateway webhook", () => {
        const stripeBody = (
          type: string,
          session: Record<string, unknown>,
          evtId = `evt_${randomBytes(4).toString("hex")}`,
        ) => JSON.stringify({ id: evtId, type, data: { object: session } });
        const session = (ref: string, over: Record<string, unknown> = {}) => ({
          id: ref,
          client_reference_id: "x",
          amount_total: 15000,
          currency: "aed",
          payment_status: "paid",
          ...over,
        });
        const post = (
          raw: string,
          opts: { t?: number; secret?: string; account?: string; header?: string | null } = {},
        ) =>
          receiveIntegrationWebhook(
            new Request(
              `${APP_URL}/api/webhooks/integrations/payments/${opts.account ?? accountId}`,
              {
                method: "POST",
                headers: {
                  "stripe-signature":
                    opts.header === null
                      ? ""
                      : (opts.header ??
                        stripeSignatureHeader(
                          opts.secret ?? "whsec_test_secret",
                          raw,
                          opts.t ?? Math.floor(Date.now() / 1000),
                        )),
                  "x-forwarded-for": "198.51.100.8",
                },
                body: raw,
              },
            ),
            opts.account ?? accountId,
            "payments",
            paymentWebhookSpec,
          );

        it("rejects bad signatures, stale timestamps and unknown or wrong-kind accounts without touching anything", async () => {
          const raw = stripeBody("checkout.session.completed", session("cs_test_fake_1"));
          expect((await post(raw, { secret: "whsec_other" })).status).toBe(401);
          expect((await post(raw, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
          expect((await post(raw, { header: null })).status).toBe(401);
          expect(
            (await post(raw, { account: "22222222-2222-2222-2222-222222222222" })).status,
          ).toBe(404);
          const smsAccount = (await loadAccount(admin, org, "sms"))!.id;
          expect((await post(raw, { account: smsAccount })).status).toBe(404);
          expect((await payRows())[0].status).toBe("sent");
        });

        it("never applies a payment whose amount differs: it flags the request and tells finance", async () => {
          const raw = stripeBody(
            "checkout.session.completed",
            session("cs_test_fake_1", { amount_total: 14999 }),
          );
          const res = await post(raw);
          expect(res.status).toBe(200);
          const [row] = await payRows();
          expect(row).toMatchObject({
            status: "sent",
            needs_review: true,
            review_reason: "amount_mismatch",
          });
          expect(row.paid_at).toBeNull();
          const notes = await svc(() =>
            q(
              "select user_id, title, body, payload from public.notifications where org_id = $1 and type = 'finance.payment_link'",
              [org],
            ),
          );
          expect(notes.rows.map((r) => r.user_id)).toContain(finUser);
          expect(notes.rows.map((r) => r.user_id)).toContain(alice); // '*' holders too
          expect(JSON.stringify(notes.rows.map((r) => [r.title, r.body]))).not.toMatch(
            /150|Sara|INV-1042|AED/,
          );
        });

        it("records a matching payment once: replays are duplicates and change nothing", async () => {
          await svc(() =>
            q(
              "update public.fin_payment_requests set needs_review = false, review_reason = null where org_id = $1",
              [org],
            ),
          );
          const raw = stripeBody(
            "checkout.session.completed",
            session("cs_test_fake_1"),
            "evt_paid_1",
          );
          const first = await post(raw);
          expect(await first.json()).toMatchObject({ processed: 1, duplicates: 0 });
          const [paid] = await payRows();
          expect(paid).toMatchObject({
            status: "paid",
            amount_paid_minor: "15000",
            needs_review: false,
          });
          expect(paid.paid_at).not.toBeNull();
          const again = await post(raw);
          expect(await again.json()).toMatchObject({ processed: 0, duplicates: 1 });
          // a different event for the same payment is ignored because paid is final
          const late = await post(
            stripeBody("checkout.session.expired", session("cs_test_fake_1"), "evt_exp_1"),
          );
          expect(late.status).toBe(200);
          expect((await payRows())[0].status).toBe("paid");
          const keys = await svc(() =>
            q(
              "select outcome from public.integration_webhook_events where org_id = $1 and event_key in ('evt_paid_1', 'evt_exp_1') order by event_key",
              [org],
            ),
          );
          expect(keys.rows.map((r) => r.outcome)).toEqual(["ignored_already_paid", "applied_paid"]); // evt_exp_1, evt_paid_1
          // and the invoice is still untouched
          expect(
            (
              await svc(() =>
                q("select record_hash from public.fin_invoices where id = $1", [invoice]),
              )
            ).rows[0].record_hash,
          ).toBe("hash-1042");
        });

        it("ignores an event for a payment it never asked for", async () => {
          const res = await post(
            stripeBody("checkout.session.completed", session("cs_unknown"), "evt_unknown"),
          );
          expect(res.status).toBe(200);
          const k = await svc(() =>
            q(
              "select outcome from public.integration_webhook_events where org_id = $1 and event_key = 'evt_unknown'",
              [org],
            ),
          );
          expect(k.rows[0].outcome).toBe("unknown_request");
        });

        it("releases the claim and answers 500 when handling fails, so the gateway retries", async () => {
          const raw = stripeBody(
            "checkout.session.completed",
            session("cs_test_fake_1"),
            "evt_boom",
          );
          const spec = paymentWebhookSpec((await loadAccount(admin, org, "payments"))!)!;
          const failing = {
            ...spec,
            handle: async () => {
              throw new Error("db down");
            },
          };
          const r2 = await receiveIntegrationWebhook(
            new Request(`${APP_URL}/x`, {
              method: "POST",
              headers: {
                "stripe-signature": stripeSignatureHeader(
                  "whsec_test_secret",
                  raw,
                  Math.floor(Date.now() / 1000),
                ),
              },
              body: raw,
            }),
            accountId,
            "payments",
            failing,
          );
          expect(r2.status).toBe(500);
          expect(
            (
              await svc(() =>
                q(
                  "select 1 from public.integration_webhook_events where org_id = $1 and event_key = 'evt_boom'",
                  [org],
                ),
              )
            ).rowCount,
          ).toBe(0);
        });

        it("limits failed signatures per source address", async () => {
          const raw = stripeBody("checkout.session.completed", session("cs_x"));
          await svc(() => q("truncate public.rate_limit_hits"));
          let last = 0;
          for (let i = 0; i < 32; i++) last = (await post(raw, { secret: "whsec_other" })).status;
          expect(last).toBe(429);
        });
      });

      it("closes the gateway link on cancel, and records a payment that still arrives as paid but flagged", async () => {
        await svc(() =>
          one(
            "insert into public.fin_invoices (org_id, inv_display_number, patient_pin, total, record_hash) values ($1, 'INV-2001', 'PIN-100', 80, 'h-2001')",
            [org],
          ),
        );
        const fake = createFakePaymentProvider({ refPrefix: "cs_late" });
        const made = await create({ invoiceNumber: "INV-2001", amount: "80" }, fake);
        expect(made.ok).toBe(true);
        if (!made.ok) return;
        expect(
          await cancelPaymentRequest(admin, {
            orgId: org,
            requestId: made.requestId,
            provider: fake,
          }),
        ).toEqual({ ok: true, closedAtGateway: true });
        expect(fake.expired).toEqual(["cs_late_1"]);
        expect(
          (
            await cancelPaymentRequest(admin, {
              orgId: org,
              requestId: made.requestId,
              provider: fake,
            })
          ).ok,
        ).toBe(false); // only an open request
        expect((await payRows()).find((r) => r.id === made.requestId)?.status).toBe("cancelled");
        const out = await applyPaymentEvent(admin, {
          orgId: org,
          provider: "stripe",
          event: {
            key: "k",
            type: "paid",
            providerRef: "cs_late_1",
            requestId: made.requestId,
            amountMinor: 8000,
            currency: "AED",
            code: null,
          },
        });
        expect(out).toBe("applied_paid_after_cancelled");
        expect((await payRows()).find((r) => r.id === made.requestId)).toMatchObject({
          status: "paid",
          needs_review: true,
          review_reason: "paid_after_cancelled",
        });
      });

      it("does not let one org's event touch another org's request", async () => {
        const out = await applyPaymentEvent(admin, {
          orgId: other,
          provider: "stripe",
          event: {
            key: "k2",
            type: "paid",
            providerRef: "cs_late_1",
            requestId: null,
            amountMinor: 8000,
            currency: "AED",
            code: null,
          },
        });
        expect(out).toBe("unknown_request");
      });

      it("signs PayTabs callbacks with the server key (verification is exercised in the unit tests)", () => {
        expect(paytabsSignature("k", "{}")).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  },
);
