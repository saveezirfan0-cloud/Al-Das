import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isAllowedEndpoint, parseUniteConfig } from "@/lib/unite/config";

/**
 * CLAUDE.md rule 7: Unite is read-only in the MVP and the Finance API (sync-once: each call
 * permanently dequeues records) is never called. These tests pin that down at the source level.
 */
const dir = path.resolve(__dirname, "../../lib/unite");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, src: readFileSync(path.join(dir, f), "utf8") }));

describe("lib/unite is read-only", () => {
  it("never uses a write method", () => {
    for (const f of files) {
      expect(f.src, f.name).not.toMatch(/method:\s*["'](PUT|PATCH|DELETE)["']/);
    }
  });

  it("only the token refresh in auth.ts is allowed to POST", () => {
    for (const f of files) {
      const posts = f.src.match(/method:\s*["']POST["']/g) ?? [];
      expect(posts.length, f.name).toBe(f.name === "auth.ts" ? 1 : 0);
    }
  });

  it("refuses any endpoint that looks like the Finance API, however it is configured", () => {
    const cfg = parseUniteConfig({
      paths: { patients: "getfinancedata", doctors: "Finance/Invoices" },
    });
    expect(isAllowedEndpoint(cfg, "getfinancedata")).toBe(false);
    expect(isAllowedEndpoint(cfg, "Finance/Invoices")).toBe(false);
    expect(isAllowedEndpoint(cfg, "getallappointments")).toBe(true);
    expect(isAllowedEndpoint(cfg, "deletesomething")).toBe(false); // not on the allow-list
  });

  it("exposes no mutating methods on the client", async () => {
    const mod = await import("@/lib/unite/client");
    const client = mod.createUniteClient({
      baseUrl: "https://unite.example.test",
      config: parseUniteConfig({}),
      auth: { getToken: async () => "t" },
      breaker: {
        isOpen: async () => false,
        recordSuccess: async () => {},
        recordFailure: async () => false,
      },
      fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    expect(Object.keys(client).sort()).toEqual(["getAppointments", "listAll", "listPage"]);
  });
});
