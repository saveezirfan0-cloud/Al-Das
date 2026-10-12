import { describe, expect, it, vi } from "vitest";

import { auditApiRead, READ_AUDIT_WINDOW_MS } from "@/lib/public-api/audit-read";
import { createFakeAdmin } from "../helpers/fake-admin";

const ctx = { keyId: "k1", orgId: "org1", scopes: ["contacts:read"] };
const NOW = new Date("2026-10-12T10:00:00Z");

describe("public API read audit", () => {
  it("records the first read per key and resource, with the count and never the content", async () => {
    const admin = createFakeAdmin({ audit_log: [] });
    await auditApiRead(admin as never, ctx, "contacts", 37, NOW);
    const rows = admin._rows("audit_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: "org1", action: "api.contacts_read", entity: "contacts", user_id: null });
    expect(rows[0].diff).toEqual({ api_key_id: "k1", records: 37, sampled_window_minutes: 15 });
  });

  it("skips the row when this key already read this resource inside the window, and asks only for that key's rows", async () => {
    const filters: Array<[string, unknown]> = [];
    const insert = vi.fn(async () => ({ error: null }));
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte"]) chain[m] = (...a: unknown[]) => { filters.push([m + ":" + String(a[0]), a[1]]); return chain; };
    chain.limit = async () => ({ data: [{ id: "already" }], error: null });
    const admin = { from: () => ({ ...chain, insert }) } as never;
    await auditApiRead(admin, ctx, "contacts", 5, NOW);
    expect(insert).not.toHaveBeenCalled();
    expect(filters).toContainEqual(["eq:diff->>api_key_id", "k1"]);
    expect(filters).toContainEqual(["gte:created_at", "2026-10-12T09:45:00.000Z"]);
    expect(filters).toContainEqual(["eq:action", "api.contacts_read"]);
  });

  it("is best effort: a failing audit table never breaks the read", async () => {
    const boom = { from: () => { throw new Error("db down"); } } as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(auditApiRead(boom, ctx, "enquiries", 1, NOW)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("uses a 15 minute window", () => {
    expect(READ_AUDIT_WINDOW_MS).toBe(15 * 60_000);
  });
});
