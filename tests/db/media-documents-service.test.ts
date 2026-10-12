/**
 * Phase 16 services against a real Postgres through PostgREST: the nightly documents_maintenance task (insurance
 * card reminders, unfinished uploads, retention) and the storage usage summary. Storage is replaced by a fake bucket
 * that records what was removed; nothing leaves the machine. Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and
 * TEST_SERVICE_JWT. Synthetic data only.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runDocumentsMaintenance } from "@/lib/jobs/handlers/documents-maintenance";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import { queueOutbound } from "@/lib/inbox/send";
import { loadStorageUsage } from "@/lib/documents/server";
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

const NOW = new Date("2026-10-12T04:00:00Z");
const day = (offset: number) => new Date(Date.UTC(2026, 9, 12 + offset)).toISOString().slice(0, 10);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "documents maintenance and storage usage",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let org: string;
    let otherOrg: string;
    let contact: string;
    const removed: Array<{ bucket: string; paths: string[] }> = [];
    const signed: Array<{ bucket: string; path: string; expiresIn: number }> = [];
    let failRemoval = false;
    const logs: unknown[] = [];
    const log: JobLogger = {
      info: (...a: unknown[]) => void logs.push(a),
      warn: (...a: unknown[]) => void logs.push(a),
      error: (...a: unknown[]) => void logs.push(a),
    } as JobLogger;

    async function one(sql: string, params: unknown[]): Promise<string> {
      const { rows } = await c.query<{ id: string }>(sql + " returning id::text", params);
      return rows[0].id;
    }
    async function doc(over: {
      org?: string;
      contact?: string;
      category: string;
      status?: string;
      expires_on?: string | null;
      created_at?: string;
      notified?: boolean;
      size?: number;
      scan?: string;
    }): Promise<{ id: string; path: string }> {
      const id = (await c.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0].id;
      const o = over.org ?? org;
      const ct = over.contact ?? contact;
      const path = `${o}/${ct}/${id}.pdf`;
      await asServiceRole(c, async () => {
        await c.query(
          `insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status, expires_on, created_at, expiry_notified_at, scan_status)
           values ($1, $2, $3, $4, 'Synthetic document', 'application/pdf', $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            o,
            ct,
            over.category,
            over.size ?? 1000,
            path,
            over.status ?? "ready",
            over.expires_on ?? null,
            over.created_at ?? ago(1),
            over.notified ? ago(5) : null,
            over.scan ?? "unscanned",
          ],
        );
      });
      return { id, path };
    }
    const remaining = async (id: string) =>
      (await c.query("select 1 from public.patient_documents where id = $1", [id])).rowCount;

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
      otherOrg = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      await asServiceRole(c, async () => {
        await c.query("update public.orgs set timezone = 'Asia/Dubai' where id = any ($1)", [
          [org, otherOrg],
        ]);
        contact = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Doc', 'Patient', '+971500000181')",
          [org],
        );
      });
      const real = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      });
      const fakeStorage = {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            if (failRemoval) return { error: { message: "storage down" } };
            removed.push({ bucket, paths });
            return { error: null };
          },
          createSignedUrl: async (path: string, expiresIn: number) => {
            signed.push({ bucket, path, expiresIn });
            return {
              data: {
                signedUrl: `https://storage.example.test/object/sign/${bucket}/${path}?token=t`,
              },
              error: null,
            };
          },
        }),
      };
      admin = new Proxy(real, {
        get(target, prop) {
          if (prop === "storage") return fakeStorage;
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as unknown as AdminClient;
    });

    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    const reset = async () => {
      removed.length = 0;
      logs.length = 0;
      failRemoval = false;
      await c.query("delete from pgmq.q_notifications");
      await asServiceRole(c, async () => {
        await c.query("delete from public.patient_documents");
        await c.query("delete from public.tasks");
        await c.query("delete from public.notifications");
        await c.query("delete from public.document_retention_policies");
        await c.query("update public.orgs set settings = '{}'::jsonb");
      });
    };

    describe("insurance card reminders", () => {
      it("reminds once for cards inside the window (and already expired), not for far ones, other categories or already-notified ones", async () => {
        await reset();
        const soon = await doc({ category: "insurance_card", expires_on: day(5) });
        const edge = await doc({ category: "insurance_card", expires_on: day(14) });
        const far = await doc({ category: "insurance_card", expires_on: day(15) });
        const expired = await doc({ category: "insurance_card", expires_on: day(-3) });
        const lab = await doc({ category: "lab_report", expires_on: day(2) });
        const done = await doc({ category: "insurance_card", expires_on: day(3), notified: true });
        const pending = await doc({
          category: "insurance_card",
          expires_on: day(2),
          status: "pending",
        });
        const otherContact = await one(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Other', 'Org')",
          [otherOrg],
        );
        const otherOrgCard = await doc({
          org: otherOrg,
          contact: otherContact,
          category: "insurance_card",
          expires_on: day(2),
        });

        const t1 = await runDocumentsMaintenance(admin, log, NOW);
        expect(t1.reminders).toBe(4); // soon, edge, expired in org A; the card in org B
        const { rows } = await c.query<{ id: string; expiry_notified_at: string | null }>(
          "select id::text, expiry_notified_at from public.patient_documents",
        );
        const flagged = new Set(rows.filter((r) => r.expiry_notified_at).map((r) => r.id));
        for (const d of [soon, edge, expired, done, otherOrgCard])
          expect(flagged.has(d.id)).toBe(true);
        for (const d of [far, lab, pending]) expect(flagged.has(d.id)).toBe(false);

        // Idempotent: a second run (or a retry) reminds about nothing new.
        const t2 = await runDocumentsMaintenance(admin, log, NOW);
        expect(t2.reminders).toBe(0);
        expect(t2.tasks_created).toBe(0);
      });

      it("creates a follow-up task per card with a subject that names no one, due before the expiry", async () => {
        const { rows: raw } = await c.query<{
          subject: string;
          notes: string | null;
          due_at: Date;
          contact_id: string;
          org_id: string;
        }>("select subject, notes, due_at, contact_id, org_id from public.tasks order by due_at");
        const rows = raw.map((t) => ({ ...t, due_at: t.due_at.toISOString() }));
        expect(rows.length).toBe(4);
        for (const t of rows) {
          expect(t.subject).toBe("Insurance card expiring: check the patient's cover");
          expect(t.subject).not.toMatch(/Doc|Patient|Synthetic|\+971/);
          expect(t.notes).toBeNull();
        }
        // the card expiring in 5 days is due two days before it: 2026-10-15 06:00 UTC
        expect(rows.some((t) => t.due_at.startsWith("2026-10-15T06:00"))).toBe(true);
        // the expired card is due right away
        expect(rows.some((t) => new Date(t.due_at).getTime() <= NOW.getTime() + 1000)).toBe(true);
      });

      it("notifies the people who manage documents with a generic message, and puts only ids in the push job", async () => {
        await reset();
        await doc({ category: "insurance_card", expires_on: day(3) });
        await runDocumentsMaintenance(admin, log, NOW);
        const { rows: inApp } = await c.query<{
          user_id: string;
          type: string;
          title: string;
          body: string;
          payload: Record<string, unknown>;
        }>(
          "select user_id::text, type, title, body, payload from public.notifications where type = 'document.expiring'",
        );
        expect(inApp.length).toBe(1);
        expect(inApp[0].user_id).toBe(alice); // the admin ('*') holds documents.manage
        expect(inApp[0].title).toBe("An insurance card is about to expire");
        const everything = JSON.stringify(inApp[0]);
        expect(everything).not.toMatch(/Doc Patient|Synthetic|\+971/);
        expect(Object.keys(inApp[0].payload).sort()).toEqual(["contact_id", "document_id"]);

        const { rows: queue } = await c.query<{ message: Record<string, unknown> }>(
          "select message from pgmq.q_notifications",
        );
        const push = queue.map((q) => q.message).filter((m) => m.type === "push");
        expect(push.length).toBe(1);
        expect(Object.keys(push[0].ids as object).sort()).toEqual(["task_id"]);
        expect(JSON.stringify(queue)).not.toMatch(/Doc Patient|Synthetic|\+971/);
      });

      it("sends one summary instead of one message per card when several are due", async () => {
        await reset();
        for (let i = 1; i <= 3; i++) await doc({ category: "insurance_card", expires_on: day(i) });
        await runDocumentsMaintenance(admin, log, NOW);
        const { rows } = await c.query<{ title: string; payload: Record<string, unknown> }>(
          "select title, payload from public.notifications where type = 'document.expiring'",
        );
        expect(rows.length).toBe(1);
        expect(rows[0].title).toBe("3 insurance cards are about to expire");
        expect(rows[0].payload).toEqual({ count: 3 });
        expect(await c.query("select 1 from public.tasks")).toHaveProperty("rowCount", 3);
      });

      it("follows the lead time and task switch in the settings, and the clinic's own date", async () => {
        await reset();
        await asServiceRole(c, () =>
          c.query(
            "update public.orgs set settings = jsonb_build_object('documents', jsonb_build_object('expiry_lead_days', 3, 'expiry_task', false)) where id = $1",
            [org],
          ),
        );
        const inside = await doc({ category: "insurance_card", expires_on: day(3) });
        const outside = await doc({ category: "insurance_card", expires_on: day(4) });
        const t = await runDocumentsMaintenance(admin, log, NOW);
        expect(t.reminders).toBe(1);
        expect(t.tasks_created).toBe(0);
        expect(
          (
            await c.query("select expiry_notified_at from public.patient_documents where id = $1", [
              inside.id,
            ])
          ).rows[0].expiry_notified_at,
        ).not.toBeNull();
        expect(
          (
            await c.query("select expiry_notified_at from public.patient_documents where id = $1", [
              outside.id,
            ])
          ).rows[0].expiry_notified_at,
        ).toBeNull();
        expect(await c.query("select 1 from public.tasks")).toHaveProperty("rowCount", 0);
      });

      it("two overlapping runs still remind exactly once per card", async () => {
        await reset();
        for (let i = 1; i <= 5; i++) await doc({ category: "insurance_card", expires_on: day(i) });
        const [a, b] = await Promise.all([
          runDocumentsMaintenance(admin, log, NOW),
          runDocumentsMaintenance(admin, log, NOW),
        ]);
        expect(a.reminders + b.reminders).toBe(5);
        expect(await c.query("select 1 from public.tasks")).toHaveProperty("rowCount", 5);
      });

      it("reminds again after the expiry date is changed (the action clears the flag)", async () => {
        await reset();
        const d = await doc({ category: "insurance_card", expires_on: day(2) });
        await runDocumentsMaintenance(admin, log, NOW);
        await asServiceRole(c, () =>
          c.query(
            "update public.patient_documents set expires_on = $2, expiry_notified_at = null where id = $1",
            [d.id, day(6)],
          ),
        );
        const t = await runDocumentsMaintenance(admin, log, NOW);
        expect(t.reminders).toBe(1);
      });
    });

    describe("unfinished uploads", () => {
      it("removes uploads left pending for more than a day (file and row), and leaves fresh ones", async () => {
        await reset();
        const stale = await doc({ category: "other", status: "pending", created_at: ago(30) });
        const fresh = await doc({ category: "other", status: "pending", created_at: ago(2) });
        const ready = await doc({ category: "other", status: "ready", created_at: ago(300) });
        const assetId = (await c.query<{ id: string }>("select gen_random_uuid()::text as id"))
          .rows[0].id;
        await asServiceRole(c, () =>
          c.query(
            "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status, created_at) values ($1, $2, 'Half upload', 'image', 'image/jpeg', 10, $3, 'pending', $4)",
            [assetId, org, `${org}/${assetId}/original.jpg`, ago(48)],
          ),
        );
        const t = await runDocumentsMaintenance(admin, log, NOW);
        expect(t.abandoned_removed).toBe(2);
        expect(await remaining(stale.id)).toBe(0);
        expect(await remaining(fresh.id)).toBe(1);
        expect(await remaining(ready.id)).toBe(1);
        expect(
          await c.query("select 1 from public.media_assets where id = $1", [assetId]),
        ).toHaveProperty("rowCount", 0);
        const paths = removed.flatMap((r) => r.paths);
        expect(paths).toContain(stale.path);
        expect(paths).toContain(`${org}/${assetId}/original.jpg`);
        expect(paths).toContain(`${org}/${assetId}/thumb.jpg`);
      });

      it("keeps the row when the file cannot be removed, so the next run tries again", async () => {
        await reset();
        const stale = await doc({ category: "other", status: "pending", created_at: ago(30) });
        failRemoval = true;
        const t = await runDocumentsMaintenance(admin, log, NOW);
        expect(t.abandoned_removed).toBe(0);
        expect(await remaining(stale.id)).toBe(1);
      });
    });

    describe("retention", () => {
      it("never deletes without a policy, and not when automatic deletion is off", async () => {
        await reset();
        const old = await doc({ category: "referral", created_at: "2020-01-01T00:00:00Z" });
        const t0 = await runDocumentsMaintenance(admin, log, NOW);
        expect(t0.retention_deleted).toBe(0);
        await asServiceRole(c, () =>
          c.query(
            "insert into public.document_retention_policies (org_id, category, retain_days, auto_delete) values ($1, 'referral', 365, false)",
            [org],
          ),
        );
        const t1 = await runDocumentsMaintenance(admin, log, NOW);
        expect(t1.retention_deleted).toBe(0);
        expect(await remaining(old.id)).toBe(1);
        expect(removed).toEqual([]);
      });

      it("deletes files and rows past the period where automatic deletion is on, in that category and org only, and audits counts", async () => {
        await reset();
        await asServiceRole(c, async () => {
          await c.query(
            "insert into public.document_retention_policies (org_id, category, retain_days, auto_delete) values ($1, 'referral', 365, true), ($1, 'consent', 365, false)",
            [org],
          );
        });
        const oldReferral = await doc({ category: "referral", created_at: "2025-01-01T00:00:00Z" });
        const youngReferral = await doc({
          category: "referral",
          created_at: "2026-09-01T00:00:00Z",
        });
        const cardKeptLonger = await doc({
          category: "referral",
          created_at: "2025-01-01T00:00:00Z",
          expires_on: "2026-06-01",
        });
        const oldConsent = await doc({ category: "consent", created_at: "2020-01-01T00:00:00Z" });
        const otherContact = await one(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Other', 'Org')",
          [otherOrg],
        );
        const otherOrgOld = await doc({
          org: otherOrg,
          contact: otherContact,
          category: "referral",
          created_at: "2020-01-01T00:00:00Z",
        });

        const t = await runDocumentsMaintenance(admin, log, NOW);
        expect(t.retention_deleted).toBe(1);
        expect(await remaining(oldReferral.id)).toBe(0);
        for (const d of [youngReferral, cardKeptLonger, oldConsent, otherOrgOld])
          expect(await remaining(d.id)).toBe(1);
        expect(removed).toEqual([{ bucket: "patient-documents", paths: [oldReferral.path] }]);
        const { rows } = await c.query(
          "select user_id, diff from public.audit_log where action = 'documents.retention_deleted'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].diff).toEqual({ deleted: 1, attempted: 1 });
      });

      it("keeps the row when the file cannot be removed", async () => {
        await reset();
        await asServiceRole(c, () =>
          c.query(
            "insert into public.document_retention_policies (org_id, category, retain_days, auto_delete) values ($1, 'referral', 365, true)",
            [org],
          ),
        );
        const old = await doc({ category: "referral", created_at: "2020-01-01T00:00:00Z" });
        failRemoval = true;
        expect((await runDocumentsMaintenance(admin, log, NOW)).retention_deleted).toBe(0);
        expect(await remaining(old.id)).toBe(1);
      });
    });

    describe("a library file as template header media, end to end through the outbound job", () => {
      let channel: string;
      let tpl: string;
      let conversation: string;
      let patient: string;
      let metaCalls: Array<{ url: string; body: Record<string, unknown> }>;
      let spy: ReturnType<typeof vi.spyOn>;

      const components = [
        { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::sample"] } },
        { type: "BODY", text: "Hello {{1}}, see our offer.", example: { body_text: [["Sara"]] } },
      ];

      async function newAsset(
        over: { scan?: string; status?: string; mime?: string; kind?: string } = {},
      ): Promise<string> {
        const id = (await c.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0]
          .id;
        await asServiceRole(c, () =>
          c.query(
            "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status, scan_status) values ($1, $2, 'Offer', $3, $4, 1000, $5, $6, $7)",
            [
              id,
              org,
              over.kind ?? "image",
              over.mime ?? "image/jpeg",
              `${org}/${id}/original.jpg`,
              over.status ?? "ready",
              over.scan ?? "unscanned",
            ],
          ),
        );
        return id;
      }
      async function send(
        values: Record<string, string>,
      ): Promise<{ id: string; status: string; error: string | null }> {
        const msg = await queueOutbound(admin, {
          orgId: org,
          conversationId: conversation,
          spec: { type: "template", template_id: tpl, values },
          body: "Hello Sara, see our offer.",
          sentByUserId: alice,
        });
        await deliverOutbound(admin, msg.id, {
          queue: "outbound",
          msgId: 1,
          readCt: 1,
          enqueuedAt: new Date(),
          admin,
          log,
        });
        const { rows } = await c.query(
          "select status, error_message from public.messages where id = $1",
          [msg.id],
        );
        return { id: msg.id, status: rows[0].status, error: rows[0].error_message };
      }

      beforeAll(async () => {
        process.env.META_SYSTEM_USER_TOKEN = "test-token-not-real";
        await asServiceRole(c, async () => {
          channel = await one(
            "insert into public.channels (org_id, name, phone_number_id, waba_id, status) values ($1, 'Main line', 'pn-lib', 'waba-lib', 'active')",
            [org],
          );
          tpl = await one(
            "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components) values ($1, $2, 'waba-lib', 'offer_lib', 'en', 'UTILITY', 'APPROVED', $3::jsonb)",
            [org, channel, JSON.stringify(components)],
          );
          patient = await one(
            "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Lib', 'Patient', '+971500000182')",
            [org],
          );
          conversation = await one(
            "insert into public.conversations (org_id, channel_id, contact_id, status) values ($1, $2, $3, 'open')",
            [org, channel, patient],
          );
        });
        const realFetch = globalThis.fetch;
        metaCalls = [];
        spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (/graph\.facebook\.com/.test(url)) {
            metaCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
            return new Response(
              JSON.stringify({
                messages: [
                  { id: `wamid.TESTLIB${metaCalls.length}${Math.random().toString(36).slice(2)}` },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return realFetch(input, init);
        }) as typeof fetch);
      });
      afterAll(() => spy.mockRestore());

      it("sends the template with a fresh one-hour signed link in the header, not the library reference", async () => {
        const asset = await newAsset();
        signed.length = 0;
        const r = await send({ "header.media": `media:${asset}`, "body.1": "Sara" });
        expect(r).toMatchObject({ status: "sent", error: null });
        expect(metaCalls).toHaveLength(1);
        const sent = JSON.stringify(metaCalls[0].body);
        expect(sent).toContain(
          `https://storage.example.test/object/sign/media-library/${org}/${asset}/original.jpg`,
        );
        expect(sent).not.toContain("media:");
        expect(signed).toContainEqual({
          bucket: "media-library",
          path: `${org}/${asset}/original.jpg`,
          expiresIn: 3600,
        });
      });

      it("fails the message without calling Meta when the file is blocked, gone or unfinished", async () => {
        for (const [over, text] of [
          [{ scan: "infected" }, /malware/],
          [{ status: "pending" }, /no longer exists/],
        ] as const) {
          metaCalls.length = 0;
          const asset = await newAsset(over);
          const r = await send({ "header.media": `media:${asset}`, "body.1": "Sara" });
          expect(r.status).toBe("failed");
          expect(r.error).toMatch(text);
          expect(metaCalls).toHaveLength(0);
        }
        metaCalls.length = 0;
        const gone = await send({
          "header.media": `media:${(await c.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0].id}`,
          "body.1": "Sara",
        });
        expect(gone.status).toBe("failed");
        expect(metaCalls).toHaveLength(0);
      });

      it("still sends a plain https link as before", async () => {
        metaCalls.length = 0;
        const r = await send({
          "header.media": "https://cdn.example.test/a.jpg",
          "body.1": "Sara",
        });
        expect(r.status).toBe("sent");
        expect(JSON.stringify(metaCalls[0].body)).toContain("https://cdn.example.test/a.jpg");
      });

      it("will not use another organisation's library file", async () => {
        metaCalls.length = 0;
        const otherId = (await c.query<{ id: string }>("select gen_random_uuid()::text as id"))
          .rows[0].id;
        await asServiceRole(c, () =>
          c.query(
            "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status) values ($1, $2, 'Theirs', 'image', 'image/jpeg', 10, $3, 'ready')",
            [otherId, otherOrg, `${otherOrg}/${otherId}/original.jpg`],
          ),
        );
        const r = await send({ "header.media": `media:${otherId}`, "body.1": "Sara" });
        expect(r.status).toBe("failed");
        expect(metaCalls).toHaveLength(0);
      });
    });

    it("logs counts only: no title, path or patient reaches the job log", async () => {
      await reset();
      await doc({ category: "insurance_card", expires_on: day(2) });
      await runDocumentsMaintenance(admin, log, NOW);
      const text = JSON.stringify(logs);
      expect(text).not.toMatch(/Synthetic|Doc Patient|\.pdf|patient-documents|\+971/);
      expect(text).toContain("reminders");
    });

    describe("storage_usage_summary", () => {
      it("adds up files and bytes per category, library kind and month, and counts what needs attention", async () => {
        await reset();
        await asServiceRole(c, () => c.query("delete from public.media_assets"));
        await doc({ category: "lab_report", size: 2000, scan: "clean", created_at: ago(24) });
        await doc({ category: "lab_report", size: 3000, scan: "unscanned", created_at: ago(24) });
        await doc({ category: "consent", size: 500, scan: "infected", created_at: ago(24) });
        await doc({
          category: "insurance_card",
          size: 100,
          scan: "error",
          expires_on: new Date().toISOString().slice(0, 10),
        });
        await doc({ category: "other", size: 999, status: "pending" });
        const otherContact = await one(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Other', 'Org')",
          [otherOrg],
        );
        await doc({ org: otherOrg, contact: otherContact, category: "lab_report", size: 7777 });
        await asServiceRole(c, async () => {
          for (const [kind, size, scan] of [
            ["image", 400, "clean"],
            ["image", 600, "unscanned"],
            ["video", 9000, "clean"],
          ] as const) {
            const id = (await c.query<{ id: string }>("select gen_random_uuid()::text as id"))
              .rows[0].id;
            await c.query(
              "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status, scan_status) values ($1, $2, 'x', $3, $4, $5, $6, 'ready', $7)",
              [
                id,
                org,
                kind,
                kind === "image" ? "image/jpeg" : "video/mp4",
                size,
                `${org}/${id}/original.x`,
                scan,
              ],
            );
          }
        });
        const u = await loadStorageUsage(admin, org);
        expect(u.documents.lab_report).toEqual({ files: 2, bytes: 5000 });
        expect(u.documents.consent).toEqual({ files: 1, bytes: 500 });
        expect(u.documents.other).toBeUndefined(); // pending uploads are not "stored" yet
        expect(u.library.image).toEqual({ files: 2, bytes: 1000 });
        expect(u.library.video).toEqual({ files: 1, bytes: 9000 });
        expect(u.documents_unscanned).toBe(2); // unscanned + error
        expect(u.documents_blocked).toBe(1);
        expect(u.library_unscanned).toBe(1);
        expect(u.pending_uploads).toBe(1);
        expect(u.cards_expiring_30d).toBe(1);
        expect(u.documents_by_month.reduce((n, m) => n + m.files, 0)).toBe(4);
        // org B's file never shows up in org A's numbers
        expect(JSON.stringify(u)).not.toContain("7777");
      });
    });
  },
);
