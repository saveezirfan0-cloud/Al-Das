import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/public-api/keys";
import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

let admin: FakeAdmin;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

import * as list from "@/app/api/public/v1/enquiries/route";
import * as byId from "@/app/api/public/v1/enquiries/[id]/route";

const E1 = "5b0c1d2e-3f40-4a51-8b62-7c8d9e0f1a2b";
const E_OTHER_ORG = "6c1d2e3f-4051-4b62-8c73-8d9e0f1a2b3c";
const E_DELETED = "8e3f4051-6273-4d84-8e95-0f1a2b3c4d5e";
const reader = generateApiKey();
const contactsOnly = generateApiKey();

const enq = (id: string, org: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  org_id: org,
  number: 1,
  pipeline_id: "p1",
  stage_id: "s1",
  status: "open",
  contact_id: null,
  channel_id: null,
  source: "whatsapp",
  assignee_id: null,
  est_value: 100,
  location_id: null,
  department_id: null,
  specialist_id: null,
  service_id: null,
  appt_date: null,
  first_touch_at: null,
  closed_at: null,
  created_at: createdAt,
  updated_at: createdAt,
  deleted_at: null,
  title: "Amal Khan knee pain",
  lost_reason: "went elsewhere",
  custom: { secret: true },
  ...extra,
});

beforeEach(() => {
  const key = (id: string, hash: string, scopes: string[]) => ({ id, org_id: "org1", key_hash: hash, scopes, expires_at: null, revoked_at: null, last_used_at: new Date().toISOString() });
  admin = createFakeAdmin({
    api_keys: [key("kR", reader.hash, ["enquiries:read"]), key("kC", contactsOnly.hash, ["contacts:read"])],
    enquiries: [
      enq(E1, "org1", "2026-03-01T00:00:00Z"),
      enq("7d2e3f40-5162-4c73-8d84-9e0f1a2b3c4d", "org1", "2026-03-02T00:00:00Z", { status: "lost" }),
      enq(E_OTHER_ORG, "org2", "2026-03-03T00:00:00Z"),
      enq(E_DELETED, "org1", "2026-03-04T00:00:00Z", { deleted_at: "2026-03-05T00:00:00Z" }),
    ],
  });
});

const get = (handler: (r: Request, c: { params: Promise<unknown> }) => Promise<Response>, key: string | null, url = "https://x.test/api/public/v1/enquiries", params: unknown = {}) =>
  handler(new Request(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} }), { params: Promise.resolve(params) });

describe("GET /enquiries", () => {
  it("needs the enquiries:read scope", async () => {
    expect((await get(list.GET, null)).status).toBe(401);
    const res = await get(list.GET, contactsOnly.key);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("insufficient_scope");
  });

  it("lists this org's live enquiries only, and never exposes titles, reasons or custom fields", async () => {
    const body = await (await get(list.GET, reader.key)).json();
    const ids = body.data.map((e: { id: string }) => e.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(E_OTHER_ORG);
    expect(ids).not.toContain(E_DELETED);
    const text = JSON.stringify(body);
    for (const leaked of ["Amal Khan", "went elsewhere", "secret", "title"]) expect(text).not.toContain(leaked);
  });

  it("filters, paginates and rejects bad input", async () => {
    const lost = await (await get(list.GET, reader.key, "https://x.test/api/public/v1/enquiries?status=lost")).json();
    expect(lost.data.map((e: { status: string }) => e.status)).toEqual(["lost"]);
    const page = await (await get(list.GET, reader.key, "https://x.test/api/public/v1/enquiries?limit=1")).json();
    expect(page.data).toHaveLength(1);
    expect(typeof page.next_cursor).toBe("string");
    expect((await get(list.GET, reader.key, "https://x.test/api/public/v1/enquiries?status=bogus")).status).toBe(422);
    expect((await get(list.GET, reader.key, "https://x.test/api/public/v1/enquiries?cursor=nope")).status).toBe(400);
  });
});

describe("GET /enquiries/:id", () => {
  it("returns one of this org's enquiries; other orgs', deleted and malformed ids are 404", async () => {
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: E1 })).status).toBe(200);
    for (const id of [E_OTHER_ORG, E_DELETED, "nope"]) expect((await get(byId.GET, reader.key, "https://x.test/x", { id })).status).toBe(404);
  });
});
