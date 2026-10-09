import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/public-api/keys";
import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

let admin: FakeAdmin;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

import * as list from "@/app/api/public/v1/tasks/route";
import * as byId from "@/app/api/public/v1/tasks/[id]/route";

const T1 = "5b0c1d2e-3f40-4a51-8b62-7c8d9e0f1a2b";
const T_OTHER_ORG = "6c1d2e3f-4051-4b62-8c73-8d9e0f1a2b3c";
const reader = generateApiKey();
const contactsOnly = generateApiKey();

const task = (id: string, org: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  org_id: org,
  type: "call",
  due_at: "2026-03-11T06:00:00Z",
  done: false,
  done_at: null,
  assignee_id: null,
  contact_id: null,
  enquiry_id: null,
  appointment_id: null,
  created_at: createdAt,
  updated_at: createdAt,
  subject: "Call Jane Doe about her knee results",
  notes: "she prefers mornings, private note",
  completed_by: "7d2e3f40-5162-4c73-8d84-9e0f1a2b3c4d",
  due_notified_for: null,
  ...extra,
});

beforeEach(() => {
  const key = (id: string, hash: string, scopes: string[]) => ({
    id,
    org_id: "org1",
    key_hash: hash,
    scopes,
    expires_at: null,
    revoked_at: null,
    last_used_at: new Date().toISOString(),
  });
  admin = createFakeAdmin({
    api_keys: [
      key("kR", reader.hash, ["tasks:read"]),
      key("kC", contactsOnly.hash, ["contacts:read"]),
    ],
    tasks: [
      task(T1, "org1", "2026-03-01T00:00:00Z"),
      task("7d2e3f40-5162-4c73-8d84-9e0f1a2b3c4e", "org1", "2026-03-02T00:00:00Z", {
        done: true,
        done_at: "2026-03-02T01:00:00Z",
      }),
      task(T_OTHER_ORG, "org2", "2026-03-03T00:00:00Z"),
    ],
  });
});

const get = (
  handler: (r: Request, c: { params: Promise<unknown> }) => Promise<Response>,
  key: string | null,
  url = "https://x.test/api/public/v1/tasks",
  params: unknown = {},
) =>
  handler(new Request(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} }), {
    params: Promise.resolve(params),
  });

describe("GET /tasks", () => {
  it("needs the tasks:read scope", async () => {
    expect((await get(list.GET, null)).status).toBe(401);
    const res = await get(list.GET, contactsOnly.key);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("insufficient_scope");
  });

  it("lists only this org's tasks, newest first, with no subject or notes", async () => {
    const res = await get(list.GET, reader.key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((t: { id: string }) => t.id)).not.toContain(T_OTHER_ORG);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].created_at > body.data[1].created_at).toBe(true);
    const text = JSON.stringify(body);
    for (const leaked of ["Jane Doe", "knee", "private note", "completed_by", "org1"])
      expect(text).not.toContain(leaked);
    expect(body.data[0]).toHaveProperty("appointment_id");
    expect(body.next_cursor).toBeNull();
  });

  it("filters by done and paginates with a cursor", async () => {
    const open = await (
      await get(list.GET, reader.key, "https://x.test/api/public/v1/tasks?done=false")
    ).json();
    expect(open.data.map((t: { done: boolean }) => t.done)).toEqual([false]);

    const page = await (
      await get(list.GET, reader.key, "https://x.test/api/public/v1/tasks?limit=1")
    ).json();
    expect(page.data).toHaveLength(1);
    expect(typeof page.next_cursor).toBe("string");
  });

  it("rejects bad input with 422/400 rather than querying", async () => {
    expect(
      (await get(list.GET, reader.key, "https://x.test/api/public/v1/tasks?done=maybe")).status,
    ).toBe(422);
    expect(
      (await get(list.GET, reader.key, "https://x.test/api/public/v1/tasks?type=bogus")).status,
    ).toBe(422);
    expect(
      (await get(list.GET, reader.key, "https://x.test/api/public/v1/tasks?cursor=not-a-cursor"))
        .status,
    ).toBe(400);
  });
});

describe("GET /tasks/:id", () => {
  it("returns a task of this org and 404s for another org's or a malformed id", async () => {
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: T1 })).status).toBe(200);
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: T_OTHER_ORG })).status).toBe(
      404,
    );
    expect((await get(byId.GET, reader.key, "https://x.test/x", { id: "nope" })).status).toBe(404);
  });
});
