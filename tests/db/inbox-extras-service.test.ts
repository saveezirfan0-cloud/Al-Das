/**
 * Sanoflow parity G11 through PostgREST: contact cards and catalogue products ride the normal outbound queue.
 *   - queueOutbound stores a `contacts` message (the table accepts the kind) and an interactive product message
 *   - outside the 24-hour window the outbound job fails them with 131047 before any Meta client is built
 *   - in a training workspace a contact card is marked sent on screen and Meta is never called
 *   - unlink_conversation_contact answers through supabase-js with the new contact id
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT. Synthetic data only.
 */
import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildContactCard } from "@/lib/inbox/contact-card";
import { buildProductMessage } from "@/lib/inbox/extras";
import { deliverOutbound } from "@/lib/jobs/handlers/outbound";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import { connect, createAuthUser, createOrg, resetDb, TEST_DATABASE_URL } from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const log = { info: () => {}, warn: () => {}, error: () => {} };
const ctx = (admin: AdminClient) => ({
  queue: "outbound_priority" as const,
  msgId: 1,
  readCt: 1,
  enqueuedAt: new Date(),
  admin,
  log,
});

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "inbox extras through PostgREST",
  () => {
    let c: Client;
    let admin: AdminClient;
    let org: string;
    let user: string;
    let channel: string;
    let contact: string;
    let conv: string;
    const realFetch = globalThis.fetch;
    const metaCalls: string[] = [];

    const q = async (sql: string, p: unknown[]) =>
      (await c.query(sql + " returning id", p)).rows[0].id as string;

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (/facebook\.com/.test(url)) {
          metaCalls.push(url);
          throw new Error("Meta must not be called");
        }
        return realFetch(input, init);
      });

      c = await connect();
      await resetDb(c);
      user = await createAuthUser(c, "admin@example.test");
      org = await createOrg(c, "Org X", "org-x", user);
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as AdminClient;
      await c.query("set role service_role");
      channel = await q(
        "insert into public.channels (org_id, name, waba_id, phone_number_id, catalog_id) values ($1, 'Main', 'WABA1', '109900000000031', '998877')",
        [org],
      );
      contact = await q(
        "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla', 'Demo-07', '+447700900321')",
        [org],
      );
      // Window closed: the patient last wrote 30 hours ago.
      conv = await q(
        "insert into public.conversations (org_id, channel_id, contact_id, last_inbound_at) values ($1, $2, $3, now() - interval '30 hours')",
        [org, channel, contact],
      );
      await c.query("reset role");
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await resetDb(c);
      await c.end();
    });

    async function row(id: string) {
      const { rows } = await c.query(
        "select kind, status, error_code, wa_message_id, body from public.messages where id = $1",
        [id],
      );
      return rows[0];
    }

    it("a contact card and a product outside the window fail with 131047 and never reach Meta", async () => {
      const { queueOutbound } = await import("@/lib/inbox/send");
      const card = buildContactCard({ name: "Demo Lab", phone: "+447700900322" });
      const product = buildProductMessage({ catalogId: "998877", retailerIds: ["sku-1"] });
      if (!card.ok || !product.ok) throw new Error("builders");
      const m1 = await queueOutbound(admin, {
        orgId: org,
        conversationId: conv,
        spec: { type: "contacts", contacts: [card.card] },
        body: card.label,
        sentByUserId: user,
      });
      const m2 = await queueOutbound(admin, {
        orgId: org,
        conversationId: conv,
        spec: { type: "interactive", interactive: product.interactive },
        body: product.label,
        sentByUserId: user,
      });
      expect(await row(m1.id)).toMatchObject({
        kind: "contacts",
        status: "queued",
        body: "Demo Lab",
      });
      expect(await row(m2.id)).toMatchObject({ kind: "interactive", status: "queued" });
      await deliverOutbound(admin, m1.id, ctx(admin));
      await deliverOutbound(admin, m2.id, ctx(admin));
      expect(await row(m1.id)).toMatchObject({ status: "failed", error_code: 131047 });
      expect(await row(m2.id)).toMatchObject({ status: "failed", error_code: 131047 });
      expect(metaCalls).toHaveLength(0);
    });

    it("in a training workspace a contact card inside the window is marked sent on screen only", async () => {
      await c.query("update public.conversations set last_inbound_at = now() where id = $1", [
        conv,
      ]);
      await c.query("update public.orgs set is_training = true where id = $1", [org]);
      try {
        const { queueOutbound } = await import("@/lib/inbox/send");
        const card = buildContactCard({ name: "Reception", phone: "+447700900323" });
        if (!card.ok) throw new Error("card");
        const m = await queueOutbound(admin, {
          orgId: org,
          conversationId: conv,
          spec: { type: "contacts", contacts: [card.card] },
          body: card.label,
          sentByUserId: user,
        });
        await deliverOutbound(admin, m.id, ctx(admin));
        expect(await row(m.id)).toMatchObject({
          status: "sent",
          wa_message_id: `training:${m.id}`,
        });
        expect(metaCalls).toHaveLength(0);
      } finally {
        await c.query("update public.orgs set is_training = false where id = $1", [org]);
      }
    });

    it("moves the chat to a new contact through supabase-js", async () => {
      // The patient wrote from the contact's main number (Meta's `from` is the phone without +).
      await c.query(
        "insert into public.messages (org_id, conversation_id, direction, kind, body, status, payload) values ($1, $2, 'in', 'text', 'synthetic', 'received', $3::jsonb)",
        [org, conv, JSON.stringify({ from: "447700900321", id: "wamid.svc" })],
      );
      const { data, error } = await admin.rpc("unlink_conversation_contact", {
        p_org_id: org,
        p_conversation_id: conv,
        p_first_name: "Omar",
        p_last_name: "Demo-08",
        p_keep_household: true,
        p_relationship: "child",
        p_user_id: user,
      });
      expect(error).toBeNull();
      const r = data as { contact_id: string; old_contact_id: string; conversation_ids: string[] };
      expect(r.old_contact_id).toBe(contact);
      expect(r.conversation_ids).toEqual([conv]);
      const { rows } = await c.query(
        "select contact_id::text from public.conversations where id = $1",
        [conv],
      );
      expect(rows[0].contact_id).toBe(r.contact_id);
      // Every message stayed in its conversation.
      const { rows: msgs } = await c.query(
        "select count(*)::int as n from public.messages where conversation_id = $1",
        [conv],
      );
      expect(msgs[0].n).toBe(4);
    });
  },
);
