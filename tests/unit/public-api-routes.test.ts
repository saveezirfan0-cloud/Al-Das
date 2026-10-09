import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/public-api/keys";
import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

let admin: FakeAdmin;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: vi.fn(async () => 1), scheduleJob: vi.fn(async () => undefined) }));

import * as contacts from "@/app/api/public/v1/contacts/route";
import * as contactById from "@/app/api/public/v1/contacts/[id]/route";
import * as sendTemplate from "@/app/api/public/v1/send-template/route";

const C1 = "5b0c1d2e-3f40-4a51-8b62-7c8d9e0f1a2b";
const TEMPLATE_ID = "7a1f3a52-0a3b-4b8e-9a43-1f2e3d4c5b6a";
const writeOnly = generateApiKey();
const readWrite = generateApiKey();
const sender = generateApiKey();

function seed() {
  admin = createFakeAdmin(
    {
      api_keys: [
        { id: "kW", org_id: "org1", key_hash: writeOnly.hash, scopes: ["contacts:write"], expires_at: null, revoked_at: null, last_used_at: new Date().toISOString() },
        { id: "kRW", org_id: "org1", key_hash: readWrite.hash, scopes: ["contacts:read", "contacts:write"], expires_at: null, revoked_at: null, last_used_at: new Date().toISOString() },
        { id: "kS", org_id: "org1", key_hash: sender.hash, scopes: ["messages:send_template"], expires_at: null, revoked_at: null, last_used_at: new Date().toISOString() },
      ],
      contacts: [{ id: C1, org_id: "org1", phone_e164: "+971501111111", first_name: "Amal", last_name: "Khan", dob: "1990-02-28", email: "amal@example.test", external_id: "PIN-1", stop_marketing: false, deleted_at: null }],
      contact_phones: [],
      orgs: [{ id: "org1", settings: {} }],
      channels: [{ id: "ch1", org_id: "org1", waba_id: "w1", status: "active" }],
      wa_templates: [{ id: TEMPLATE_ID, org_id: "org1", waba_id: "w1", name: "appt", language: "en", status: "APPROVED", category: "UTILITY", archived_at: null, components: [{ type: "BODY", text: "Hi {{1}}" }] }],
      conversations: [],
      messages: [],
      audit_log: [],
      api_idempotency: [],
    },
    {
      unique: { contacts: [["org_id", "phone_e164"], ["org_id", "external_id"]], api_idempotency: [["api_key_id", "idempotency_key"]] },
      defaults: {
        contacts: () => ({ first_name: "", last_name: "", email: null, dob: null, external_id: null, stop_marketing: false, promotions_opt_in: false, source: "manual", deleted_at: null, merged_into_id: null }),
        conversations: () => ({ status: "open", unread_count: 0 }),
        api_idempotency: () => ({ response_status: null, response: null }),
      },
    },
  );
}

const call = (handler: (r: Request, c: { params: Promise<unknown> }) => Promise<Response>, key: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string>; url?: string; params?: unknown } = {}) =>
  handler(
    new Request(init.url ?? "https://x.test/api/public/v1/x", {
      method: init.method ?? "POST",
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve(init.params ?? {}) },
  );

beforeEach(seed);

describe("POST /contacts: what a key may read back", () => {
  it("a write-only key gets the id only, never the record, for new and existing patients", async () => {
    const created = await call(contacts.POST, writeOnly.key, { body: { phone: "+971502222222", first_name: "New" } });
    expect(created.status).toBe(201);
    expect(Object.keys(await created.json())).toEqual(["id"]);

    const existing = await call(contacts.POST, writeOnly.key, { body: { phone: "+971501111111" } });
    expect(existing.status).toBe(200);
    const body = await existing.json();
    expect(Object.keys(body)).toEqual(["id"]);
    expect(JSON.stringify(body)).not.toMatch(/Amal|Khan|1990|PIN-1|example\.test/);
  });

  it("a key with contacts:read gets the full public record", async () => {
    const res = await call(contacts.POST, readWrite.key, { body: { phone: "+971501111111" } });
    expect(await res.json()).toMatchObject({ id: C1, first_name: "Amal", last_name: "Khan", dob: "1990-02-28", external_id: "PIN-1" });
  });

  it("PATCH follows the same rule", async () => {
    const w = await call(contactById.PATCH, writeOnly.key, { method: "PATCH", body: { first_name: "Z" }, params: { id: C1 } });
    expect(await w.json()).toEqual({ id: C1 });
    const rw = await call(contactById.PATCH, readWrite.key, { method: "PATCH", body: { first_name: "Y" }, params: { id: C1 } });
    expect(await rw.json()).toMatchObject({ id: C1, first_name: "Y" });
  });

  it("a conflict does not reveal which value clashed", async () => {
    const res = await call(contacts.POST, writeOnly.key, { body: { phone: "+971503333333", external_id: "PIN-1" } });
    expect(res.status).toBe(409);
    const msg = (await res.json()).error.message as string;
    expect(msg).toBe("That value conflicts with an existing contact.");
    expect(msg).not.toMatch(/external/i);
  });
});

describe("auditing", () => {
  it("records API writes with the key id and no patient data", async () => {
    await call(contacts.POST, writeOnly.key, { body: { phone: "+971502222222", first_name: "Secret Name" } });
    await call(contactById.PATCH, readWrite.key, { method: "PATCH", body: { email: "pat@example.test" }, params: { id: C1 } });
    const log = admin._rows("audit_log");
    expect(log.map((l) => l.action)).toEqual(["api.contact_created", "api.contact_updated"]);
    expect(log[0]).toMatchObject({ org_id: "org1", user_id: null, entity: "contact", diff: { api_key_id: "kW" } });
    expect(log[1].diff).toEqual({ api_key_id: "kRW", fields: ["email"] }); // field names, never values
    expect(JSON.stringify(log)).not.toMatch(/Secret Name|pat@example/);
  });
});

describe("GET /contacts filters", () => {
  it("rejects a * in the email filter (PostgREST would treat it as a wildcard)", async () => {
    const res = await call(contacts.GET, readWrite.key, { method: "GET", url: "https://x.test/api/public/v1/contacts?email=a*@example.test" });
    expect(res.status).toBe(422);
  });

  it("refuses a key without the contacts:read scope", async () => {
    const res = await call(contacts.GET, writeOnly.key, { method: "GET" });
    expect(res.status).toBe(403);
  });
});

describe("POST /send-template idempotency, end to end", () => {
  const body = { to: "+971504444444", template: "appt", language: "en", variables: { "body.1": "Amal" } };
  const post = (over: { key?: string | null; body?: unknown } = {}) =>
    call(sendTemplate.POST, sender.key, { headers: over.key === null ? {} : { "Idempotency-Key": over.key ?? "k-1" }, body: over.body ?? body });

  it("requires the Idempotency-Key header", async () => {
    const res = await post({ key: null });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("idempotency_key_required");
    expect(admin._rows("messages")).toHaveLength(0);
  });

  it("sends once, replays the response for the same key and body, and audits the send", async () => {
    const first = await post();
    expect(first.status).toBe(202);
    const a = await first.json();
    const second = await post();
    expect(second.status).toBe(202);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await second.json()).toEqual(a);
    expect(admin._rows("messages")).toHaveLength(1); // not sent twice
    expect(admin._rows("audit_log").filter((l) => l.action === "api.template_sent")).toHaveLength(1);
    expect(admin._rows("audit_log")[0].diff).toEqual({ api_key_id: "kS", template: "appt", language: "en" });
  });

  it("refuses the same key with a different body", async () => {
    await post();
    const res = await post({ body: { ...body, variables: { "body.1": "Someone else" } } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("idempotency_key_reused");
    expect(admin._rows("messages")).toHaveLength(1);
  });

  it("releases the key after a failed attempt so the corrected request can reuse it", async () => {
    const bad = await post({ body: { ...body, to: "12" } });
    expect(bad.status).toBe(422);
    const fixed = await post({ body: { ...body, to: "+971504444444" } });
    expect(fixed.status).toBe(202);
  });

  it("scopes keys per API key: another key can reuse the same string", async () => {
    await post();
    const other = generateApiKey();
    admin._rows("api_keys").push({ id: "kS2", org_id: "org1", key_hash: other.hash, scopes: ["messages:send_template"], expires_at: null, revoked_at: null, last_used_at: new Date().toISOString() });
    const res = await call(sendTemplate.POST, other.key, { headers: { "Idempotency-Key": "k-1" }, body });
    expect(res.status).toBe(202);
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();
  });
});
