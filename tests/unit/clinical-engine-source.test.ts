import { describe, expect, it } from "vitest";

import { evaluateRecentVisits } from "@/lib/clinical/engine";

/** A chainable stand-in for the supabase-js builder that records every call and resolves to no rows. */
function recordingAdmin() {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const admin = {
    from(table: string) {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then")
              return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
            return (...args: unknown[]) => {
              calls.push({ table, method: prop, args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { admin: admin as never, calls };
}

describe("evaluateRecentVisits", () => {
  it("only selects visits delivered by the Unite sync, never imported history", async () => {
    const { admin, calls } = recordingAdmin();
    const res = await evaluateRecentVisits(admin, "org-1");
    expect(res).toEqual({ checked: 0, evaluated: 0, created: 0 });
    const visitCalls = calls.filter((c) => c.table === "visits");
    expect(visitCalls.map((c) => c.method)).toContain("eq");
    const filters = visitCalls.filter((c) => c.method === "eq").map((c) => c.args.join("="));
    expect(filters).toContain("org_id=org-1");
    expect(filters).toContain("source=unite");
  });

  it("still limits by date window and count", async () => {
    const { admin, calls } = recordingAdmin();
    await evaluateRecentVisits(admin, "org-1", { sinceDays: 7, limit: 50 });
    const visitCalls = calls.filter((c) => c.table === "visits");
    expect(visitCalls.find((c) => c.method === "gte")?.args[0]).toBe("visit_date");
    expect(visitCalls.find((c) => c.method === "limit")?.args[0]).toBe(50);
  });
});
