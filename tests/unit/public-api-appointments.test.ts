import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/public-api/keys";
import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

let admin: FakeAdmin;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

import * as list from "@/app/api/public/v1/appointments/route";
import * as byId from "@/app/api/public/v1/appointments/[id]/route";

const A1 = "5b0c1d2e-3f40-4a51-8b62-7c8d9e0f1a2b";
const A_OTHER_ORG = "6c1d2e3f-4051-4b62-8c73-8d9e0f1a2b3c";
const reader = generateApiKey();
const contactsOnly = generateApiKey();

const appt = (id: string, org: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  org_id: org,
  number: 1,
  contact_id: null,
  location_id: null,
  specialist_id: null,
  service_id: null,
  department_id: null,
  starts_at: "2026-03-11T06:00:00Z",
  ends_at: "2026-03-11T06:30:00Z",
  status: "confirmed",
  source: "portal",
  created_at: createdAt,
  updated_at: createdAt,
  notes: "private clinical note",
  external_id: "UNITE-123",
  unite_clinic_id: "DHA-1",
  custom: { secret: true },
  ...extra,
});

beforeEach(() => {
  const key = (id: string, hash: string, scopes: string[]) => ({ id, org_id: "org1", key_hash: hash, scopes, expires_at: null, revoked_at: null, last_used_at: new Date().toISOString() });
  admin = createFakeAdmin({
    api_keys: [key("kR", reader.hash, ["appointments:read"]), key("kC", contactsOnly.hash, ["contacts:read"])],
    appointments: [
      appt(A1, "org1", "2026-03-01T00:00:00Z"),
      appt("7d2e3f40-5162-4c73-8d84-9e0f1a2b3c4d", "org1", "2026-03-02T00:00:00Z", { status: "no_show" }),
      appt(A_OTHER_ORG, "org2", "2026-03-03T00:00:00Z"),
    ],
  });
});

const get = (handler: (r: Request, c: { params: Promise<unknown> }) => Promise<Response>, key: string | null, url = "https://x.test/api/public/v1/appointments", params: unknown = {}) =>
  handler(new Request(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} }), { params: Promise.resolve(params) });

describe("GET /appointments", () => {
  it("needs the appointments:read scope", async () => {
    expect((await get(list.GET, null)).status).toBe(401);
    const res = await get(list.GET, contactsOnly.key);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("insufficient_scope");
  });

  it("lists only this org's appointments, newest first, and never exposes notes or Unite identifiers", async () => {
    const res = await get(list.GET, reader.key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((a: { id: string }) => a.id)).not.toContain(A_OTHER_ORG);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].created_at > body.data[1].created_at).toBe(true);
    const text = JSON.stringify(body);
    for (const leaked of ["private clinical note", "UNITE-123", "DHA-1", "secret"]) expect(text).not.toContain(leaked);
    expect(body.next_cursor).toBeNull();
  });

  it("filters by status and paginates with a cursor", async () => {
    const filtered = await (await get(list.GET, reader.key, "https://x.test/api/public/v1/appointments?status=no_show")).json();
    expect(filtered.data.map((a: { status: string }) => a.status)).toEqual(["no_show"]);

    const page = await (await get(list.GET, reader.key, "https://x.test/api/public/v1/appointments?limit=1")).json();
    expect(page.data).toHaveLength(1);
    expect(typeof page.next_cursor).toBe("string");
  });

  it("rejects bad input with 422/400 rather than querying", async () => {
    expect((await get(list.GET, reader.key, "https://x.test/api/public/v1/appointments?status=bogus")).status).toBe(422);
    expect((await get(list.GET, reader.key, "https://x.test/api/public/v1/appointments?cursor=not-a-cursor")).status).toBe(400);
  });
});

describe("GET /appointments/:id", () => {
  it("returns an appointment of this org and 404s for another org's or a malformed id", async () => {
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: A1 })).status).toBe(200);
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: A_OTHER_ORG })).status).toBe(404);
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: "nope" })).status).toBe(404);
  });
});
