/**
 * Phase 19b: Google review requests against a real Postgres through PostgREST. Nothing leaves the machine; the only "provider" is
 * the outbound queue, which is inspected. Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { changeAppointmentStatus } from "@/lib/appointments/service";
import { patchConfig, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import {
  loadReviewStats,
  processReviewRequest,
  scheduleReviewRequest,
  sweepReviewRequests,
} from "@/lib/integrations/reviews/server";
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
// 2026-10-19 08:00Z = 12:00 in Dubai: inside the default 09:00 to 20:00 window.
const NOW = new Date("2026-10-19T08:00:00Z");
const BODY = "Hello {{1}}, thank you for visiting {{2}}. Tell others about your visit: {{3}}";
const LINK = "https://g.page/r/CsyntheticReviewLink/review";

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 19b: google review requests",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    let other: string;
    const id: Record<string, string> = {};
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const one = async (sql: string, params: unknown[] = []) =>
      (await q(sql + " returning id::text", params)).rows[0].id as string;
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

    async function patient(
      over: { first?: string; phone?: string | null; optIn?: boolean; stop?: boolean } = {},
    ) {
      return svc(() =>
        one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, promotions_opt_in, stop_marketing) values ($1, $2, 'Synthetic', $3, $4, $5)",
          [
            org,
            over.first ?? "Sara",
            over.phone === undefined
              ? `+9715011${Math.floor(10000 + Math.random() * 89999)}`
              : over.phone,
            over.optIn ?? true,
            over.stop ?? false,
          ],
        ),
      );
    }
    async function visit(
      contact: string,
      over: { status?: string; end?: string; loc?: string | null } = {},
    ) {
      return svc(() =>
        one(
          "insert into public.appointments (org_id, contact_id, location_id, starts_at, ends_at, status) values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6)",
          [
            org,
            contact,
            over.loc === undefined ? id.loc : over.loc,
            new Date(
              new Date(over.end ?? "2026-10-19T07:00:00Z").getTime() - 1_800_000,
            ).toISOString(),
            over.end ?? "2026-10-19T07:00:00Z",
            over.status ?? "completed",
          ],
        ),
      );
    }
    const requestFor = async (appointment: string) =>
      (
        await svc(() =>
          q("select * from public.review_requests where appointment_id = $1", [appointment]),
        )
      ).rows[0];
    const run = async (appointment: string, now = NOW) => {
      const r = await requestFor(appointment);
      return processReviewRequest(admin, {
        orgId: org,
        requestId: r.id,
        now: new Date(Math.max(now.getTime(), new Date(r.run_at).getTime())),
      });
    };
    const queued = async () =>
      (
        await svc(() =>
          q(
            "select m.*, c.contact_id from public.messages m join public.conversations c on c.id = m.conversation_id where m.org_id = $1 and m.direction = 'out' order by m.at",
            [org],
          ),
        )
      ).rows;
    const clearReviewRows = () =>
      svc(async () => {
        await q("delete from public.review_requests where org_id = $1", [org]);
        await q("delete from public.scheduled_jobs where kind = 'review.send'");
      });

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
      other = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      await svc(async () => {
        await q("update public.orgs set timezone = 'Asia/Dubai' where id = any ($1)", [
          [org, other],
        ]);
        id.loc = await one(
          "insert into public.locations (org_id, name, timezone, review_url) values ($1, 'Jumeirah Clinic', 'Asia/Dubai', $2)",
          [org, LINK],
        );
        id.locNoLink = await one(
          "insert into public.locations (org_id, name, timezone) values ($1, 'Annex', 'Asia/Dubai')",
          [org],
        );
        id.channel = await one(
          "insert into public.channels (org_id, name, waba_id, phone_number_id, status) values ($1, 'Main', 'waba-19b', 'pn-19b', 'active')",
          [org],
        );
        id.tpl = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
           values ($1, $2, 'waba-19b', 'review_request', 'en', 'MARKETING', 'APPROVED', $3::jsonb)`,
          [org, id.channel, JSON.stringify([{ type: "BODY", text: BODY }])],
        );
        id.draftTpl = await one(
          `insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components)
           values ($1, $2, 'waba-19b', 'review_draft', 'en', 'MARKETING', 'PENDING', $3::jsonb)`,
          [org, id.channel, JSON.stringify([{ type: "BODY", text: BODY }])],
        );
      });
      await saveSettings(admin, {
        orgId: org,
        kind: "google_reviews",
        provider: "link",
        secrets: {},
        config: { delay_minutes: 120, send_from: "09:00", send_to: "20:00", cap_days: 90 },
      });
      await patchConfig(admin, org, "google_reviews", {
        template_id: id.tpl,
        variable_map: JSON.stringify({
          "body.1": "first_name",
          "body.2": "clinic_name",
          "body.3": "review_link",
        }),
      });
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("does nothing while the integration is off", async () => {
      const p = await patient();
      const a = await visit(p);
      expect(await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW })).toBe(
        "off",
      );
      expect(await requestFor(a)).toBeUndefined();
      await setEnabled(admin, { orgId: org, kind: "google_reviews", userId: alice, enabled: true });
    });

    it("schedules one request per visit, after the delay and inside the sending window", async () => {
      const p = await patient();
      // the visit ended at 07:00Z (11:00 Dubai): +2 h = 09:00Z (13:00 Dubai), inside the window
      const a = await visit(p, { end: "2026-10-19T07:00:00Z" });
      expect(await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW })).toBe(
        "scheduled",
      );
      expect(await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW })).toBe(
        "duplicate",
      );
      const r = await requestFor(a);
      expect(r.status).toBe("scheduled");
      expect(new Date(r.run_at).toISOString()).toBe("2026-10-19T09:00:00.000Z");
      const jobs = await svc(() =>
        q("select * from public.scheduled_jobs where kind = 'review.send' and dedupe_key = $1", [
          `review:${r.id}`,
        ]),
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].payload).toEqual({ request_id: r.id });
      // a visit that ends late in the evening waits for the next morning (21:30 Dubai -> 09:00 next day)
      const b = await visit(await patient(), { end: "2026-10-19T17:30:00Z" });
      await scheduleReviewRequest(admin, {
        orgId: org,
        appointmentId: b,
        now: new Date("2026-10-19T17:35:00Z"),
      });
      expect(new Date((await requestFor(b)).run_at).toISOString()).toBe("2026-10-20T05:00:00.000Z");
      // a visit that is not finished is not scheduled
      const waiting = await visit(await patient(), { status: "confirmed" });
      expect(
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: waiting, now: NOW }),
      ).toBe("not_finished");
      expect(await requestFor(waiting)).toBeUndefined();
      await clearReviewRows();
    });

    it("queues ONE approved template to the patient with the location's link, and records it without any name or link", async () => {
      const p = await patient({ first: "Layla", phone: "+971501110101" });
      const a = await visit(p);
      await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
      expect(await run(a)).toBe("queued");
      const rows = await queued();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("template");
      expect(rows[0].status).toBe("queued");
      expect(rows[0].contact_id).toBe(p);
      expect(rows[0].payload.send).toMatchObject({
        type: "template",
        template_id: id.tpl,
        values: { "body.1": "Layla", "body.2": "Jumeirah Clinic", "body.3": LINK },
      });
      const r = await requestFor(a);
      expect(r).toMatchObject({ status: "queued", recipient_contact_id: p });
      expect(r.message_id).toBe(rows[0].id);
      expect(JSON.stringify(r)).not.toContain("Layla");
      expect(JSON.stringify(r)).not.toContain("g.page");
      const queue = await q("select count(*)::int as n from pgmq.q_outbound");
      const prio = await q("select count(*)::int as n from pgmq.q_outbound_priority");
      expect(queue.rows[0].n + prio.rows[0].n).toBeGreaterThanOrEqual(1);
      // processing it again changes nothing
      const r2 = await requestFor(a);
      expect(await processReviewRequest(admin, { orgId: org, requestId: r2.id, now: NOW })).toBe(
        "not_scheduled",
      );
      expect(await queued()).toHaveLength(1);
      const timeline = await svc(() =>
        q(
          "select type from public.timeline_events where contact_id = $1 and type = 'review.requested'",
          [p],
        ),
      );
      expect(timeline.rows).toHaveLength(1);
    });

    it("enforces the per-person cap in the database, and lets the person be asked again after the period", async () => {
      await clearReviewRows();
      const p = await patient();
      const first = await visit(p, { end: "2026-10-19T07:00:00Z" });
      const second = await visit(p, { end: "2026-10-19T07:30:00Z" });
      for (const a of [first, second])
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
      expect(await run(first)).toBe("queued");
      expect(await run(second)).toBe("cap_blocked");
      expect(await requestFor(second)).toMatchObject({ status: "cap_blocked", reason: "cap" });
      // 91 days later the first claim is outside the window
      await svc(() =>
        q(
          "update public.review_requests set claimed_at = now() - interval '91 days' where appointment_id = $1",
          [first],
        ),
      );
      const third = await visit(p, { end: "2026-10-19T07:45:00Z" });
      await scheduleReviewRequest(admin, { orgId: org, appointmentId: third, now: NOW });
      expect(await run(third)).toBe("queued");
    });

    it("cannot be raced past: concurrent requests for one person queue exactly one message", async () => {
      await clearReviewRows();
      const p = await patient();
      const appts = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => visit(p, { end: `2026-10-19T07:0${i}:00Z` })),
      );
      for (const a of appts)
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
      const before = (await queued()).length;
      const results = await Promise.all(appts.map((a) => run(a)));
      expect(results.filter((r) => r === "queued")).toHaveLength(1);
      expect(results.filter((r) => r === "cap_blocked")).toHaveLength(4);
      expect((await queued()).length - before).toBe(1);
    });

    it("asks a parent of several children once, and addresses the guardian by first name", async () => {
      await clearReviewRows();
      const guardian = await patient({ first: "Mona", phone: "+971501110202" });
      const kid1 = await patient({ first: "Omar", phone: null, optIn: false });
      const kid2 = await patient({ first: "Yara", phone: null, optIn: false });
      for (const k of [kid1, kid2])
        await svc(() =>
          q(
            "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
            [org, guardian, k],
          ),
        );
      const a1 = await visit(kid1);
      const a2 = await visit(kid2);
      for (const a of [a1, a2])
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
      const before = (await queued()).length;
      const [r1, r2] = [await run(a1), await run(a2)];
      expect([r1, r2].sort()).toEqual(["cap_blocked", "queued"]);
      const sent = (await queued()).slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0].contact_id).toBe(guardian);
      expect(sent[0].payload.send.values["body.1"]).toBe("Mona");
      expect(JSON.stringify(sent[0].payload)).not.toContain("Synthetic");
    });

    describe("who is not asked", () => {
      const skipped = async (appointment: string, reason: string) => {
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: appointment, now: NOW });
        const before = (await queued()).length;
        expect(await run(appointment)).toBe("skipped");
        expect(await requestFor(appointment)).toMatchObject({ status: "skipped", reason });
        expect((await queued()).length).toBe(before);
      };

      it("no explicit opt-in", async () =>
        skipped(await visit(await patient({ optIn: false })), "no_opt_in"));
      it("asked to stop marketing", async () =>
        skipped(await visit(await patient({ stop: true })), "stop_marketing"));
      it("the staff 'do not ask' switch", async () => {
        const p = await patient();
        await svc(() =>
          q("update public.contacts set no_review_requests_at = now() where id = $1", [p]),
        );
        await skipped(await visit(p), "do_not_ask");
      });
      it("a test record", async () => {
        const p = await patient();
        await svc(() => q("update public.contacts set is_test_record = true where id = $1", [p]));
        await skipped(await visit(p), "test_record");
      });
      it("an erased, deleted or merged record", async () => {
        const p = await patient();
        await svc(() => q("update public.contacts set erased_at = now() where id = $1", [p]));
        await skipped(await visit(p), "patient_unavailable");
      });
      it("nobody to reach", async () =>
        skipped(await visit(await patient({ phone: null })), "no_recipient"));
      it("a location without a review link", async () =>
        skipped(await visit(await patient(), { loc: id.locNoLink }), "no_link"));
      it("a visit with no location", async () =>
        skipped(await visit(await patient(), { loc: null }), "no_link"));
      it("a visit that was reopened or cancelled after it was scheduled", async () => {
        const a = await visit(await patient());
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
        await svc(() => q("update public.appointments set status = 'no_show' where id = $1", [a]));
        expect(await run(a)).toBe("skipped");
        expect(await requestFor(a)).toMatchObject({
          status: "skipped",
          reason: "visit_not_completed",
        });
      });
      it("a request that waited too long", async () => {
        const a = await visit(await patient(), { end: "2026-10-10T07:00:00Z" });
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
        await svc(() =>
          q("update public.review_requests set run_at = $2 where appointment_id = $1", [
            a,
            "2026-10-10T09:00:00Z",
          ]),
        );
        expect(await run(a)).toBe("skipped");
        expect(await requestFor(a)).toMatchObject({ reason: "too_late" });
      });
      it("a template that is not approved, or not mapped any more", async () => {
        const a = await visit(await patient());
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
        await patchConfig(admin, org, "google_reviews", { template_id: id.draftTpl });
        expect(await run(a)).toBe("skipped");
        expect(await requestFor(a)).toMatchObject({ reason: "template_not_ready" });
        await patchConfig(admin, org, "google_reviews", { template_id: id.tpl });
      });
      it("the integration switched off after scheduling, and a training workspace", async () => {
        const a = await visit(await patient());
        const b = await visit(await patient());
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
        await scheduleReviewRequest(admin, { orgId: org, appointmentId: b, now: NOW });
        await setEnabled(admin, {
          orgId: org,
          kind: "google_reviews",
          userId: alice,
          enabled: false,
        });
        expect(await run(a)).toBe("skipped");
        expect(await requestFor(a)).toMatchObject({ reason: "integration_off" });
        await setEnabled(admin, {
          orgId: org,
          kind: "google_reviews",
          userId: alice,
          enabled: true,
        });
        await svc(() => q("update public.orgs set is_training = true where id = $1", [org]));
        try {
          expect(await run(b)).toBe("skipped");
          expect(await requestFor(b)).toMatchObject({ reason: "training" });
          expect(
            await scheduleReviewRequest(admin, {
              orgId: org,
              appointmentId: await visit(await patient()),
              now: NOW,
            }),
          ).toBe("training");
        } finally {
          await svc(() => q("update public.orgs set is_training = false where id = $1", [org]));
        }
      });
    });

    it("is blind to how the visit went: a complaint or an emergency tag changes nothing", async () => {
      await clearReviewRows();
      const p = await patient();
      const a = await visit(p);
      const channel = id.channel;
      await svc(async () => {
        const conv = await one(
          "insert into public.conversations (org_id, channel_id, contact_id, ai_tags) values ($1, $2, $3, array['complaint','emergency'])",
          [org, channel, p],
        );
        await q(
          "insert into public.tasks (org_id, contact_id, type, subject, due_at) values ($1, $2, 'call', 'Complaint to resolve', now())",
          [org, p],
        );
        void conv;
      });
      await scheduleReviewRequest(admin, { orgId: org, appointmentId: a, now: NOW });
      expect(await run(a)).toBe("queued");
    });

    it("hooks: completing a visit schedules a request, a no-show does not, and the sweep finds only fresh visits", async () => {
      await clearReviewRows();
      const p = await patient();
      const a = await visit(p, { status: "confirmed" });
      const res = await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: a,
        to: "completed",
        actorId: alice,
      });
      expect(res.ok).toBe(true);
      expect(await requestFor(a)).toMatchObject({ status: "scheduled" });
      const ns = await visit(await patient(), { status: "confirmed" });
      await changeAppointmentStatus(admin, {
        orgId: org,
        appointmentId: ns,
        to: "no_show",
        actorId: alice,
      });
      expect(await requestFor(ns)).toBeUndefined();

      // sweep: a visit completed today (after the switch was turned on) is found; yesterday's before it was on, and ones that already have a request, are not
      await svc(() =>
        q(
          "update public.integration_accounts set enabled_at = $2 where org_id = $1 and kind = 'google_reviews'",
          [org, "2026-10-19T06:00:00Z"],
        ),
      );
      const fresh = await visit(await patient(), { end: "2026-10-19T07:00:00Z" });
      const before = await visit(await patient(), { end: "2026-10-18T07:00:00Z" });
      const swept = await sweepReviewRequests(admin, NOW);
      expect(swept.scheduled).toBeGreaterThanOrEqual(1);
      expect(await requestFor(fresh)).toMatchObject({ status: "scheduled" });
      expect(await requestFor(before)).toBeUndefined();
      expect((await sweepReviewRequests(admin, NOW)).scheduled).toBe(0); // idempotent
    });

    it("reports counts by status, reason and place without any name", async () => {
      const before = await loadReviewStats(admin, org, 30);
      const p = await patient({ first: "Layla" });
      const mk = async (status: string, reason: string | null) => {
        const a = await visit(p);
        await svc(() =>
          q(
            "insert into public.review_requests (org_id, appointment_id, contact_id, location_id, status, reason, run_at, claimed_at) values ($1, $2, $3, $4, $5, $6, now(), now())",
            [org, a, p, id.loc, status, reason],
          ),
        );
      };
      await mk("queued", null);
      await mk("queued", null);
      await mk("cap_blocked", "cap");
      await mk("skipped", "no_opt_in");
      const after = await loadReviewStats(admin, org, 30);
      const d = (k: string) => (after.byStatus[k] ?? 0) - (before.byStatus[k] ?? 0);
      expect([d("queued"), d("cap_blocked"), d("skipped")]).toEqual([2, 1, 1]);
      expect((after.skippedByReason.no_opt_in ?? 0) - (before.skippedByReason.no_opt_in ?? 0)).toBe(
        1,
      );
      expect(after.byLocation.some((l) => l.location === "Jumeirah Clinic")).toBe(true);
      expect(JSON.stringify(after)).not.toMatch(/Layla|Synthetic|g\.page|\+971/);
    });

    it("keeps one org's requests away from another", async () => {
      const { rows } = await svc(() =>
        q("select count(*)::int as n from public.review_requests where org_id = $1", [other]),
      );
      expect(rows[0].n).toBe(0);
      const foreign = await svc(() =>
        one("insert into public.contacts (org_id, first_name, last_name) values ($1, 'X', 'Y')", [
          other,
        ]),
      );
      const a = await visit(await patient());
      await expect(
        svc(() =>
          q(
            "insert into public.review_requests (org_id, appointment_id, contact_id, run_at) values ($1, $2, $3, now())",
            [org, a, foreign],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  },
);
