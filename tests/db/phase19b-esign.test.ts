/**
 * Phase 19b: e-signature for consent forms against a real Postgres through PostgREST. The provider is a fake, storage is in memory and
 * the webhook route is called in-process with signed Request objects; nothing leaves the machine. Synthetic data only.
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAccount, saveSettings, setEnabled } from "@/lib/integrations/accounts";
import { eventHash } from "@/lib/integrations/esign/dropbox-sign";
import { createFakeEsignProvider, FAKE_SIGNED_PDF } from "@/lib/integrations/esign/fake";
import {
  cancelEsignRequest,
  cancelPendingForErasure,
  createEsignRequest,
  esignWebhookSpec,
} from "@/lib/integrations/esign/server";
import type { EsignStorage } from "@/lib/integrations/esign/storage";
import { receiveIntegrationWebhook } from "@/lib/integrations/webhook-route";
import { buildPatientExport } from "@/lib/privacy/export-bundle";
import { DOCUMENT_BUCKET, LIBRARY_BUCKET } from "@/lib/media/paths";
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
const API_KEY = "DBX-SYNTHETIC-API-KEY";

/** Storage in memory: a map of "bucket/path" to bytes. */
function memoryStorage(opts: { failUploads?: { n: number } } = {}) {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const storage: EsignStorage = {
    async signedUrl(bucket, path) {
      return files.has(`${bucket}/${path}`)
        ? `https://storage.example.test/${bucket}/${path}?token=SYNTHETIC`
        : null;
    },
    async upload(bucket, path, bytes) {
      if (opts.failUploads && opts.failUploads.n > 0) {
        opts.failUploads.n--;
        return false;
      }
      files.set(`${bucket}/${path}`, bytes);
      return true;
    },
    async probe(bucket, path) {
      const b = files.get(`${bucket}/${path}`);
      return b ? { size: b.length, contentType: "application/pdf", head: b.slice(0, 64) } : null;
    },
    async remove(bucket, paths) {
      for (const p of paths) {
        files.delete(`${bucket}/${p}`);
        removed.push(`${bucket}/${p}`);
      }
      return true;
    },
    async scan() {
      return { verdict: "unscanned", engine: "none" };
    },
  };
  return { storage, files, removed };
}

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 19b: e-signature",
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
    const mem = memoryStorage();
    const rows = async (where = "true", params: unknown[] = []) =>
      (
        await svc(() =>
          q(
            `select * from public.esign_requests where org_id = $1 and ${where} order by created_at`,
            [org, ...params],
          ),
        )
      ).rows;
    const reqRow = async (requestId: string) => (await rows("id = $2", [requestId]))[0];

    async function consentDoc(
      contact = id.patient,
      over: { category?: string; mime?: string; scan?: string; title?: string } = {},
    ) {
      const docId = crypto.randomUUID();
      const path = `${org}/${contact}/${docId}.pdf`;
      mem.files.set(`${DOCUMENT_BUCKET}/${path}`, FAKE_SIGNED_PDF);
      await svc(() =>
        q(
          "insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status, scan_status) values ($1, $2, $3, $4, $5, $6, 100, $7, 'ready', $8)",
          [
            docId,
            org,
            contact,
            over.category ?? "consent",
            over.title ?? "Surgery consent for knee arthroscopy",
            over.mime ?? "application/pdf",
            path,
            over.scan ?? "unscanned",
          ],
        ),
      );
      return docId;
    }
    const create = (
      over: Partial<Parameters<typeof createEsignRequest>[2]> = {},
      provider = createFakeEsignProvider(),
      storage = mem.storage,
    ) =>
      createEsignRequest(
        admin,
        { provider, storage },
        {
          orgId: org,
          actorId: alice,
          contactId: id.patient,
          source: { kind: "patient_document", id: id.doc },
          signerName: "Sara Ahmed",
          signerEmail: "sara.ahmed@example.com",
          ...over,
        },
      );

    /** A provider callback as the provider sends it: multipart/form-data with a json field and a signed event hash. */
    function callback(
      type: string,
      requestId: string | null,
      over: { complete?: boolean; hashKey?: string; time?: string; clientRef?: string } = {},
    ) {
      const time = over.time ?? "1792400000";
      const json = JSON.stringify({
        event: {
          event_time: time,
          event_type: type,
          event_hash: eventHash(over.hashKey ?? API_KEY, time, type),
          event_metadata: {},
        },
        ...(requestId
          ? {
              signature_request: {
                signature_request_id: requestId,
                is_complete: over.complete ?? true,
                metadata: over.clientRef ? { pulse_request: over.clientRef } : {},
              },
            }
          : {}),
      });
      const body = `--BOUND\r\nContent-Disposition: form-data; name="json"\r\n\r\n${json}\r\n--BOUND--\r\n`;
      return new Request(`https://pulse.test/api/webhooks/integrations/esign/${accountId}`, {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=BOUND",
          "x-forwarded-for": "203.0.113.9",
        },
        body,
      });
    }
    let accountId = "";
    const deliver = async (
      req: Request,
      provider = createFakeEsignProvider(),
      storage = mem.storage,
    ) =>
      receiveIntegrationWebhook(
        req,
        accountId,
        "esign",
        esignWebhookSpec({ provider, storage: () => storage }),
        { admin },
      );

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
        id.patient = await one(
          "insert into public.contacts (org_id, first_name, last_name, phone_e164, email) values ($1, 'Sara', 'Ahmed', '+971501110401', 'sara.ahmed@example.com')",
          [org],
        );
        id.stranger = await one(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Other', 'Patient')",
          [org],
        );
        id.foreign = await one(
          "insert into public.contacts (org_id, first_name, last_name) values ($1, 'Foreign', 'Patient')",
          [other],
        );
      });
      id.doc = await consentDoc();
      await saveSettings(admin, {
        orgId: org,
        kind: "esign",
        provider: "dropbox_sign",
        secrets: { api_key: API_KEY },
        config: { test_mode: "yes", expiry_days: 7 },
      });
      accountId = (await loadAccount(admin, org, "esign"))!.id;
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    it("refuses while the integration is off, while patient documents are off, and in a training workspace", async () => {
      const off = await create();
      expect(off).toMatchObject({ ok: false });
      expect(await rows()).toHaveLength(0);
      await setEnabled(admin, { orgId: org, kind: "esign", userId: alice, enabled: true });
      // documents are not switched on yet
      const noDocs = await create();
      expect(noDocs.ok ? "" : noDocs.error).toMatch(/Patient documents are switched off/);
      await svc(() =>
        q(
          "update public.orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{documents}', '{\"enabled\": true}') where id = $1",
          [org],
        ),
      );
      await svc(() => q("update public.orgs set is_training = true where id = $1", [org]));
      try {
        const training = await create();
        expect(training.ok ? "" : training.error).toMatch(/training workspace/);
      } finally {
        await svc(() => q("update public.orgs set is_training = false where id = $1", [org]));
      }
      expect(await rows()).toHaveLength(0);
    });

    it("sends a patient's consent PDF for one signer, with fixed wording, and stores only a masked hint of the e-mail", async () => {
      const provider = createFakeEsignProvider();
      const r = await create({}, provider);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(provider.created).toHaveLength(1);
      const sent = provider.created[0];
      expect(sent).toMatchObject({
        title: "Consent form",
        message: "Please review and sign this document.",
        signer: { name: "Sara Ahmed", email: "sara.ahmed@example.com" },
        clientRef: r.requestId,
        testMode: true,
      });
      expect(sent.fileUrl).toContain(`/${DOCUMENT_BUCKET}/${org}/${id.patient}/`);
      expect(JSON.stringify({ ...sent, signer: undefined, fileUrl: undefined })).not.toMatch(
        /Surgery|knee|arthroscopy|Sara|Ahmed|971501110401/,
      );
      expect(sent.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
      const row = await reqRow(r.requestId);
      expect(row).toMatchObject({
        status: "pending",
        provider: "dropbox_sign",
        provider_request_id: expect.stringMatching(/^fake-sig-\d+$/),
        source_kind: "patient_document",
        source_document_id: id.doc,
        signer_hint: "s***@example.com",
        test_mode: true,
        requested_by: alice,
      });
      expect(JSON.stringify(row)).not.toContain("sara.ahmed");
      const tl = await svc(() =>
        q(
          "select type from public.timeline_events where contact_id = $1 and type = 'esign.requested'",
          [id.patient],
        ),
      );
      expect(tl.rows).toHaveLength(1);
    });

    it("can send a blank form from the Media Library", async () => {
      const assetId = crypto.randomUUID();
      const path = `${org}/${assetId}/original.pdf`;
      mem.files.set(`${LIBRARY_BUCKET}/${path}`, FAKE_SIGNED_PDF);
      await svc(() =>
        q(
          "insert into public.media_assets (id, org_id, name, kind, mime_type, size_bytes, storage_path, status) values ($1, $2, 'Consent template', 'document', 'application/pdf', 100, $3, 'ready')",
          [assetId, org, path],
        ),
      );
      const provider = createFakeEsignProvider();
      const r = await create({ source: { kind: "library_asset", id: assetId } }, provider);
      expect(r.ok ? "" : r.error).toBe("");
      expect(provider.created[0].fileUrl).toContain(`/${LIBRARY_BUCKET}/${org}/${assetId}/`);
      if (r.ok)
        expect(await reqRow(r.requestId)).toMatchObject({
          source_kind: "library_asset",
          source_asset_id: assetId,
          source_document_id: null,
        });
    });

    it("refuses sources it should not send: another category, another patient, another org, a non-PDF, a blocked file, a missing file", async () => {
      const provider = createFakeEsignProvider();
      const before = (await rows()).length;
      const referral = await consentDoc(id.patient, { category: "referral" });
      const strangers = await consentDoc(id.stranger);
      const word = await consentDoc(id.patient, { mime: "application/msword" });
      const infected = await consentDoc(id.patient, { scan: "infected" });
      const bad = [
        { source: { kind: "patient_document" as const, id: referral }, text: /consent form/i },
        { source: { kind: "patient_document" as const, id: strangers }, text: /not found/i },
        { source: { kind: "patient_document" as const, id: word }, text: /PDF/ },
        { source: { kind: "patient_document" as const, id: infected }, text: /malware/ },
        {
          source: { kind: "patient_document" as const, id: crypto.randomUUID() },
          text: /not found/i,
        },
        { source: { kind: "library_asset" as const, id: crypto.randomUUID() }, text: /not found/i },
      ];
      for (const b of bad) {
        const r = await create({ source: b.source }, provider);
        expect(r.ok ? "" : r.error, JSON.stringify(b.source)).toMatch(b.text);
      }
      // a document of another org
      const foreignDoc = crypto.randomUUID();
      await svc(() =>
        q(
          "insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status) values ($1, $2, $3, 'consent', 'x', 'application/pdf', 10, $4, 'ready')",
          [foreignDoc, other, id.foreign, `${other}/${id.foreign}/${foreignDoc}.pdf`],
        ),
      );
      expect(
        (await create({ source: { kind: "patient_document", id: foreignDoc } }, provider)).ok,
      ).toBe(false);
      // the file is not in storage
      const lost = await consentDoc();
      mem.files.delete(`${DOCUMENT_BUCKET}/${org}/${id.patient}/${lost}.pdf`);
      const r = await create({ source: { kind: "patient_document", id: lost } }, provider);
      expect(r.ok ? "" : r.error).toMatch(/could not be read/);
      expect(provider.created).toHaveLength(0);
      // the unreadable one left a 'failed' row; nothing else was written
      expect((await rows()).length - before).toBe(1);
      expect((await rows("status = 'failed'")).at(-1)).toMatchObject({
        error_code: "source_unreadable",
      });
    });

    it("validates the signer before anything is created", async () => {
      const provider = createFakeEsignProvider();
      const n = (await rows()).length;
      for (const [over, text] of [
        [{ signerEmail: "not-an-email" }, /e-mail/],
        [{ signerEmail: "a@b.com, c@d.com" }, /e-mail/],
        [{ signerName: "  " }, /name/],
        [{ contactId: id.foreign }, /Patient not found/],
      ] as const) {
        const r = await create(over, provider);
        expect(r.ok ? "" : r.error).toMatch(text);
      }
      expect(provider.created).toHaveLength(0);
      expect((await rows()).length).toBe(n);
    });

    it("never repeats a create after an unknown answer, and records a bad key as a clean failure", async () => {
      const ambiguous = createFakeEsignProvider({
        create: [{ ok: false, code: "timeout", retryable: false, ambiguous: true }],
      });
      const r = await create({}, ambiguous);
      expect(r.ok ? "" : r.error).toMatch(/not known whether the signer was e-mailed/);
      expect((await rows("status = 'failed'")).at(-1)).toMatchObject({
        error_code: "unknown_delivery",
        provider_request_id: null,
      });
      expect(ambiguous.created).toHaveLength(1);
      const auth = createFakeEsignProvider({
        create: [{ ok: false, code: "auth", retryable: false, ambiguous: false }],
      });
      const r2 = await create({}, auth);
      expect(r2.ok ? "" : r2.error).toMatch(/rejected the credentials/);
      expect((await rows("status = 'failed'")).at(-1)).toMatchObject({ error_code: "auth" });
      const acct = await svc(() =>
        q(
          "select last_error from public.integration_accounts where org_id = $1 and kind = 'esign'",
          [org],
        ),
      );
      expect(acct.rows[0].last_error).not.toMatch(new RegExp(API_KEY));
    });

    describe("the provider's callback", () => {
      let requestId: string;
      let providerId: string;
      beforeAll(async () => {
        const r = await create(
          {},
          createFakeEsignProvider({ create: [{ ok: true, providerRequestId: "sig-live-1" }] }),
        );
        if (!r.ok) throw new Error("setup");
        requestId = r.requestId;
        providerId = "sig-live-1";
      });

      it("rejects a wrong hash, a wrong body and an unknown or switched-off account the right way", async () => {
        const bad = await deliver(
          callback("signature_request_signed", providerId, { hashKey: "wrong-key" }),
        );
        expect(bad.status).toBe(401);
        const junk = new Request("https://pulse.test/x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "nope",
        });
        expect((await deliver(junk)).status).toBe(401);
        const ghost = await receiveIntegrationWebhook(
          callback("signature_request_signed", providerId),
          crypto.randomUUID(),
          "esign",
          esignWebhookSpec({ storage: () => mem.storage }),
          { admin },
        );
        expect(ghost.status).toBe(404);
        expect((await reqRow(requestId)).status).toBe("pending");
      });

      it("acknowledges with the plain text the provider wants, and ignores a callback test and events it does not track", async () => {
        const test = await deliver(callback("callback_test", null));
        expect(test.status).toBe(200);
        expect(await test.text()).toBe("Hello API Event Received");
        const viewed = await deliver(callback("signature_request_viewed", providerId));
        expect(viewed.status).toBe(200);
        expect((await reqRow(requestId)).status).toBe("pending");
        const partial = await deliver(
          callback("signature_request_signed", providerId, { complete: false, time: "1792400001" }),
        );
        expect(partial.status).toBe(200);
        expect((await reqRow(requestId)).status).toBe("pending");
      });

      it("a signed event stores the signed PDF as a consent document, links it, tells the requester and records it", async () => {
        const res = await deliver(
          callback("signature_request_all_signed", providerId, { time: "1792400100" }),
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("Hello API Event Received");
        const row = await reqRow(requestId);
        expect(row.status).toBe("signed");
        expect(row.completed_at).not.toBeNull();
        expect(row.signed_document_id).toBeTruthy();
        const doc = (
          await svc(() =>
            q("select * from public.patient_documents where id = $1", [row.signed_document_id]),
          )
        ).rows[0];
        expect(doc).toMatchObject({
          org_id: org,
          contact_id: id.patient,
          category: "consent",
          mime_type: "application/pdf",
          status: "ready",
          scan_status: "unscanned",
          uploaded_by: alice,
        });
        expect(doc.title).toMatch(/^Signed consent form, \d{4}-\d{2}-\d{2}$/);
        expect(doc.storage_path).toBe(`${org}/${id.patient}/${doc.id}.pdf`);
        expect(mem.files.get(`${DOCUMENT_BUCKET}/${doc.storage_path}`)).toBeTruthy();
        // the requester was told, with generic text
        const note = await svc(() =>
          q(
            "select title, body from public.notifications where user_id = $1 and type = 'esign.update'",
            [alice],
          ),
        );
        expect(note.rows.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(note.rows)).not.toMatch(/Sara|Ahmed|Surgery|knee/);
        const audit = await svc(() =>
          q(
            "select action, diff from public.audit_log where entity = 'esign_request' and entity_id = $1",
            [requestId],
          ),
        );
        expect(audit.rows.map((r) => r.action)).toContain("esign.signed");
        expect(JSON.stringify(audit.rows)).not.toMatch(/sara\.ahmed/);
        const tl = await svc(() =>
          q(
            "select type from public.timeline_events where contact_id = $1 and type = 'esign.signed'",
            [id.patient],
          ),
        );
        expect(tl.rows).toHaveLength(1);
      });

      it("a repeated or later event changes nothing: idempotent, forward only, one document", async () => {
        const again = await deliver(
          callback("signature_request_all_signed", providerId, { time: "1792400100" }),
        );
        expect(again.status).toBe(200);
        const declinedAfter = await deliver(
          callback("signature_request_declined", providerId, { time: "1792400200" }),
        );
        expect(declinedAfter.status).toBe(200);
        const row = await reqRow(requestId);
        expect(row.status).toBe("signed");
        const docs = await svc(() =>
          q(
            "select count(*)::int as n from public.patient_documents where contact_id = $1 and category = 'consent' and title like 'Signed consent form%'",
            [id.patient],
          ),
        );
        expect(docs.rows[0].n).toBe(1);
        const keys = await svc(() =>
          q(
            "select outcome from public.integration_webhook_events where org_id = $1 and provider = 'dropbox_sign' order by id",
            [org],
          ),
        );
        expect(keys.rows.map((r) => r.outcome)).toContain("applied_signed");
        expect(keys.rows.map((r) => r.outcome)).toContain("already_signed");
      });

      it("never moves a request backwards in the database either", async () => {
        await expect(
          svc(() =>
            q("update public.esign_requests set status = 'pending' where id = $1", [requestId]),
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          svc(() =>
            q("update public.esign_requests set status = 'declined' where id = $1", [requestId]),
          ),
        ).rejects.toMatchObject({ code: "23514" });
      });

      it("declined and expired events close a waiting request; a cancelled one is not announced", async () => {
        const mk = async (pid: string) => {
          const r = await create(
            {},
            createFakeEsignProvider({ create: [{ ok: true, providerRequestId: pid }] }),
          );
          if (!r.ok) throw new Error("setup");
          return r.requestId;
        };
        const declined = await mk("sig-d-1");
        const expired = await mk("sig-e-1");
        const cancelled = await mk("sig-c-1");
        await svc(() => q("delete from public.notifications where type = 'esign.update'"));
        expect(
          (await deliver(callback("signature_request_declined", "sig-d-1", { time: "1792401000" })))
            .status,
        ).toBe(200);
        expect(
          (await deliver(callback("signature_request_expired", "sig-e-1", { time: "1792401001" })))
            .status,
        ).toBe(200);
        expect(
          (await deliver(callback("signature_request_canceled", "sig-c-1", { time: "1792401002" })))
            .status,
        ).toBe(200);
        expect((await reqRow(declined)).status).toBe("declined");
        expect((await reqRow(expired)).status).toBe("expired");
        expect((await reqRow(cancelled)).status).toBe("cancelled");
        const notes = await svc(() =>
          q("select count(*)::int as n from public.notifications where type = 'esign.update'"),
        );
        expect(notes.rows[0].n).toBe(2);
      });

      it("matches an event that arrives before the provider's id was stored, by the id we put in its metadata", async () => {
        const r = await create(
          {},
          createFakeEsignProvider({ create: [{ ok: true, providerRequestId: "sig-race-1" }] }),
        );
        if (!r.ok) throw new Error("setup");
        await svc(() =>
          q("update public.esign_requests set provider_request_id = null where id = $1", [
            r.requestId,
          ]),
        );
        const res = await deliver(
          callback("signature_request_declined", "sig-race-1", {
            clientRef: r.requestId,
            time: "1792402000",
          }),
        );
        expect(res.status).toBe(200);
        expect(await reqRow(r.requestId)).toMatchObject({
          status: "declined",
          provider_request_id: "sig-race-1",
        });
      });

      it("ignores an event for a request it never sent", async () => {
        const res = await deliver(
          callback("signature_request_signed", "sig-unknown", { time: "1792403000" }),
        );
        expect(res.status).toBe(200);
        const out = await svc(() =>
          q(
            "select outcome from public.integration_webhook_events where org_id = $1 and event_key like 'sig-unknown%'",
            [org],
          ),
        );
        expect(out.rows[0].outcome).toBe("unknown_request");
      });

      it("a storage failure while saving the signed copy answers 500 so the provider retries, and leaves nothing half-made", async () => {
        const r = await create(
          {},
          createFakeEsignProvider({ create: [{ ok: true, providerRequestId: "sig-retry-1" }] }),
        );
        if (!r.ok) throw new Error("setup");
        const flaky = memoryStorage({ failUploads: { n: 1 } });
        const first = await deliver(
          callback("signature_request_all_signed", "sig-retry-1", { time: "1792404000" }),
          createFakeEsignProvider(),
          flaky.storage,
        );
        expect(first.status).toBe(500);
        expect((await reqRow(r.requestId)).status).toBe("pending");
        const orphan = await svc(() =>
          q(
            "select count(*)::int as n from public.patient_documents where contact_id = $1 and status = 'pending'",
            [id.patient],
          ),
        );
        expect(orphan.rows[0].n).toBe(0);
        const second = await deliver(
          callback("signature_request_all_signed", "sig-retry-1", { time: "1792404000" }),
          createFakeEsignProvider(),
          flaky.storage,
        );
        expect(second.status).toBe(200);
        const row = await reqRow(r.requestId);
        expect(row.status).toBe("signed");
        expect(row.signed_document_id).toBeTruthy();
      });

      it("keeps the request signed but says so when the signed file is not a usable PDF", async () => {
        const r = await create(
          {},
          createFakeEsignProvider({ create: [{ ok: true, providerRequestId: "sig-nopdf-1" }] }),
        );
        if (!r.ok) throw new Error("setup");
        const html = createFakeEsignProvider({
          fetch: [{ ok: true, bytes: new TextEncoder().encode("<html>not a pdf</html>") }],
        });
        const res = await deliver(
          callback("signature_request_all_signed", "sig-nopdf-1", { time: "1792405000" }),
          html,
        );
        expect(res.status).toBe(200);
        expect(await reqRow(r.requestId)).toMatchObject({
          status: "signed",
          signed_document_id: null,
          error_code: "store_not_a_pdf",
        });
        // a file the provider cannot give yet is retried (500), a permanent refusal is recorded
        const r2 = await create(
          {},
          createFakeEsignProvider({ create: [{ ok: true, providerRequestId: "sig-nofile-1" }] }),
        );
        if (!r2.ok) throw new Error("setup");
        const notReady = createFakeEsignProvider({
          fetch: [{ ok: false, code: "not_found", retryable: true }],
        });
        expect(
          (
            await deliver(
              callback("signature_request_all_signed", "sig-nofile-1", { time: "1792406000" }),
              notReady,
            )
          ).status,
        ).toBe(500);
        expect((await reqRow(r2.requestId)).status).toBe("pending");
        const gone = createFakeEsignProvider({
          fetch: [{ ok: false, code: "gone", retryable: false }],
        });
        expect(
          (
            await deliver(
              callback("signature_request_all_signed", "sig-nofile-1", { time: "1792406000" }),
              gone,
            )
          ).status,
        ).toBe(200);
        expect(await reqRow(r2.requestId)).toMatchObject({
          status: "signed",
          signed_document_id: null,
          error_code: "file_gone",
        });
      });
    });

    describe("cancelling", () => {
      it("withdraws a waiting request at the provider and closes it; a final one cannot be cancelled", async () => {
        const provider = createFakeEsignProvider({
          create: [{ ok: true, providerRequestId: "sig-cancel-1" }],
        });
        const r = await create({}, provider);
        if (!r.ok) throw new Error("setup");
        const out = await cancelEsignRequest(
          admin,
          { provider },
          { orgId: org, actorId: alice, requestId: r.requestId },
        );
        expect(out).toMatchObject({ ok: true, providerCancelled: true });
        expect(provider.cancelled).toEqual(["sig-cancel-1"]);
        expect((await reqRow(r.requestId)).status).toBe("cancelled");
        expect(
          (
            await cancelEsignRequest(
              admin,
              { provider },
              { orgId: org, actorId: alice, requestId: r.requestId },
            )
          ).ok,
        ).toBe(false);
      });

      it("stays waiting when the provider could not cancel it", async () => {
        const create1 = createFakeEsignProvider({
          create: [{ ok: true, providerRequestId: "sig-cancel-2" }],
          cancel: { ok: false, code: "down" },
        });
        const r = await create({}, create1);
        if (!r.ok) throw new Error("setup");
        const out = await cancelEsignRequest(
          admin,
          { provider: create1 },
          { orgId: org, actorId: alice, requestId: r.requestId },
        );
        expect(out.ok ? "" : out.error).toMatch(/could not cancel/);
        expect((await reqRow(r.requestId)).status).toBe("pending");
      });

      it("will not touch another org's request", async () => {
        const out = await cancelEsignRequest(
          admin,
          {},
          { orgId: other, actorId: null, requestId: (await rows())[0].id },
        );
        expect(out.ok).toBe(false);
      });
    });

    describe("export, erasure and housekeeping", () => {
      it("lists the patient's requests in the data export without e-mail addresses, links or provider ids", async () => {
        const bundle = await buildPatientExport(admin, org, id.patient);
        const integrations = bundle?.integrations as {
          esign_requests: unknown[];
          review_requests: unknown[];
          ad_clicks: unknown[];
        };
        expect(integrations.esign_requests.length).toBeGreaterThan(3);
        const text = JSON.stringify(integrations);
        expect(text).not.toMatch(/sara\.ahmed|sig-|storage\.example|api\.hellosign/);
        expect(text).toContain("s***@example.com");
      });

      it("withdraws waiting requests and then erase_contact removes every 19b record of the patient", async () => {
        const erasable = await svc(() =>
          one(
            "insert into public.contacts (org_id, first_name, last_name, phone_e164, email) values ($1, 'Era', 'Sable', '+971501110499', 'era.sable@example.com')",
            [org],
          ),
        );
        const provider = createFakeEsignProvider({
          create: [{ ok: true, providerRequestId: "sig-erase-1" }],
        });
        const doc = await consentDoc(erasable);
        const r = await create(
          { contactId: erasable, source: { kind: "patient_document", id: doc } },
          provider,
        );
        if (!r.ok) throw new Error("setup");
        const appt = await svc(() =>
          one(
            "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() + interval '2 hours', now() + interval '3 hours', 'confirmed')",
            [org, erasable],
          ),
        );
        await svc(async () => {
          await q(
            "insert into public.review_requests (org_id, appointment_id, contact_id, recipient_contact_id, status, run_at) values ($1, $2, $3, $3, 'queued', now())",
            [org, appt, erasable],
          );
          await q(
            "insert into public.ad_attributions (org_id, contact_id, ctwa_clid) values ($1, $2, 'erase-click')",
            [org, erasable],
          );
          await q(
            "insert into public.telehealth_rooms (org_id, appointment_id, provider, room_ref, token_hash, token_enc, status, for_starts_at, for_ends_at, expires_at) select org_id, id, 'daily', 'erase-room-ref', encode(sha256('erase-room'::bytea), 'hex'), 'v1:a:b:c', 'active', starts_at, ends_at, ends_at from public.appointments where id = $1",
            [appt],
          );
        });
        const withdrawn = await cancelPendingForErasure(
          admin,
          { provider },
          { orgId: org, contactId: erasable },
        );
        expect(withdrawn).toEqual({ cancelled: 1, failed: 0 });
        expect(provider.cancelled).toEqual(["sig-erase-1"]);
        await svc(() =>
          q("delete from public.patient_documents where contact_id = $1", [erasable]),
        );
        const res = await svc(() =>
          q("select public.erase_contact($1, $2, $3) as r", [org, erasable, alice]),
        );
        expect(res.rows[0].r).toMatchObject({
          review_requests_deleted: 1,
          ad_clicks_deleted: 1,
          esign_requests_deleted: 1,
          video_rooms_revoked: 1,
        });
        for (const t of ["review_requests", "ad_attributions", "esign_requests"])
          expect(
            (
              await svc(() =>
                q(
                  `select count(*)::int as n from public.${t} where org_id = $1 and contact_id = $2`,
                  [org, erasable],
                ),
              )
            ).rows[0].n,
            t,
          ).toBe(0);
        const room = (
          await svc(() =>
            q(
              "select status, revoked_reason, token_enc from public.telehealth_rooms where appointment_id = $1",
              [appt],
            ),
          )
        ).rows[0];
        expect(room).toMatchObject({ status: "revoked", revoked_reason: "erased", token_enc: "" });
        const job = await svc(() =>
          q(
            "select payload from public.scheduled_jobs where kind = 'telehealth.cleanup' and org_id = $1",
            [org],
          ),
        );
        expect(job.rows.length).toBeGreaterThanOrEqual(1);
      });

      it("the daily housekeeping closes requests whose provider never reported an end, and trims old rows", async () => {
        const stale = await svc(() =>
          one(
            "insert into public.esign_requests (org_id, contact_id, source_kind, source_document_id, status, expires_at, signer_hint) values ($1, $2, 'patient_document', $3, 'pending', now() - interval '3 days', 'x***@y.com')",
            [org, id.patient, id.doc],
          ),
        );
        const fresh = await svc(() =>
          one(
            "insert into public.esign_requests (org_id, contact_id, source_kind, source_document_id, status, expires_at) values ($1, $2, 'patient_document', $3, 'pending', now() + interval '3 days')",
            [org, id.patient, id.doc],
          ),
        );
        const cmd = (
          await q("select command from cron.job where jobname = 'pulse:housekeeping_19b'")
        ).rows[0]?.command as string;
        expect(cmd, "cron entry").toBeTruthy();
        await svc(() => q(cmd));
        expect((await reqRow(stale)).status).toBe("expired");
        expect((await reqRow(fresh)).status).toBe("pending");
      });
    });
  },
);
