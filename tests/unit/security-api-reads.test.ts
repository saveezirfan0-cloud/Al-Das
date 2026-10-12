import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/public-api/keys";
import { countRows } from "@/lib/public-api/route";
import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

let admin: FakeAdmin;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

import * as contacts from "@/app/api/public/v1/contacts/route";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("countRows", () => {
  it("counts a list, a single record, and nothing else", () => {
    expect(countRows({ data: [{}, {}, {}], next_cursor: null })).toBe(3);
    expect(countRows({ id: "c1", first_name: "x" })).toBe(1);
    expect(countRows({ error: { code: "x" } })).toBe(0);
    expect(countRows(null)).toBe(0);
    expect(countRows("text")).toBe(0);
  });
});

describe("aggregate audit of API reads (Phase 10 gap)", () => {
  const reader = generateApiKey();
  const hourTotals: Record<string, number> = {};

  function seed(rows = 3) {
    for (const k of Object.keys(hourTotals)) delete hourTotals[k];
    admin = createFakeAdmin(
      {
        api_keys: [
          {
            id: "kR",
            org_id: "org1",
            key_hash: reader.hash,
            scopes: ["contacts:read"],
            expires_at: null,
            revoked_at: null,
            last_used_at: new Date().toISOString(),
          },
        ],
        contacts: Array.from({ length: rows }, (_, i) => ({
          id: `c${i}`,
          org_id: "org1",
          phone_e164: `+97150000000${i}`,
          first_name: "A",
          last_name: "B",
          deleted_at: null,
          merged_into_id: null,
          created_at: `2026-01-0${i + 1}T00:00:00Z`,
          updated_at: `2026-01-0${i + 1}T00:00:00Z`,
        })),
        orgs: [{ id: "org1", settings: {} }],
        security_alerts: [],
        memberships: [],
        notifications: [],
        audit_log: [],
      },
      {
        unique: { security_alerts: [["org_id", "dedupe_key"]] },
        rpc: {
          api_read_log_hit: (a) => {
            const k = String(a.p_key);
            hourTotals[k] = (hourTotals[k] ?? 0) + Number(a.p_rows);
            return hourTotals[k];
          },
        },
      },
    );
  }

  const get = () =>
    contacts.GET(
      new Request("https://x.test/api/public/v1/contacts", {
        headers: { Authorization: `Bearer ${reader.key}` },
      }),
      { params: Promise.resolve({}) },
    );

  it("counts a successful read against the key without touching the response", async () => {
    seed(3);
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(3);
    const call = admin._calls.find((c) => c.table === "rpc:api_read_log_hit");
    expect(call?.payload).toEqual({
      p_org: "org1",
      p_key: "kR",
      p_resource: "contacts",
      p_rows: 3,
    });
    expect(admin._rows("security_alerts")).toHaveLength(0);
  });

  it("does not count a rejected request", async () => {
    seed(1);
    const res = await contacts.GET(new Request("https://x.test/api/public/v1/contacts"), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(401);
    expect(admin._calls.some((c) => c.table === "rpc:api_read_log_hit")).toBe(false);
  });

  it("raises one alert when a key reads past the hourly threshold", async () => {
    seed(3);
    hourTotals.kR = 4999; // the hour already holds 4,999 rows; this read adds 3
    await get();
    await get();
    expect(admin._rows("security_alerts")).toEqual([
      expect.objectContaining({ kind: "bulk_api_read" }),
    ]);
  });

  it("still answers when the audit write fails", async () => {
    seed(2);
    (admin as unknown as { rpc: unknown }).rpc = async () => {
      throw new Error("db down");
    };
    const res = await get();
    expect(res.status).toBe(200);
  });
});

