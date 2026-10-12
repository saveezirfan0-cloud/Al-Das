import { describe, expect, it } from "vitest";

import {
  conversationSpecs,
  demoPerson,
  demoPhone,
  isDemoPhone,
  rng,
  CAMPAIGN_OUTCOMES,
  PIPELINES,
} from "@/lib/demo/data";
import { assertDemoAllowed, DemoGuardError, isLocalHost } from "@/lib/demo/guard";
import { demoFinanceBatch } from "@/lib/demo/finance";
import { mapBatch } from "@/lib/finance/map-invoice";
import { uniteFinanceResponseSchema } from "@/lib/finance/unite-payload";

const local = { DEMO_RESET_OK: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };

describe("demo reset safety catch", () => {
  it("refuses without DEMO_RESET_OK=1, whatever the URL", () => {
    expect(() => assertDemoAllowed({ ...local, DEMO_RESET_OK: undefined })).toThrow(DemoGuardError);
    expect(() => assertDemoAllowed({ ...local, DEMO_RESET_OK: "true" })).toThrow(/DEMO_RESET_OK=1/);
    expect(() => assertDemoAllowed({ ...local, DEMO_RESET_OK: "0" })).toThrow(DemoGuardError);
  });

  it("allows a database on this machine", () => {
    for (const url of [
      "http://127.0.0.1:54321",
      "http://localhost:3998",
      "http://[::1]:8000",
      "http://host.docker.internal:54321",
      "http://127.0.0.5/",
    ]) {
      expect(
        assertDemoAllowed({ DEMO_RESET_OK: "1", NEXT_PUBLIC_SUPABASE_URL: url }).why,
        url,
      ).toBe("local");
    }
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("example.com")).toBe(false);
  });

  it("refuses a hosted project unless it is recognisably a demo project", () => {
    const hosted = "https://abcdefghijklmnop.supabase.co";
    expect(() =>
      assertDemoAllowed({ DEMO_RESET_OK: "1", NEXT_PUBLIC_SUPABASE_URL: hosted }),
    ).toThrow(/not recognisably a demo project/);
    // the hosted URL carries the project reference, not its name, so the name may be stated
    expect(
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: hosted,
        SUPABASE_PROJECT_NAME: "Pulse Demo",
      }),
    ).toMatchObject({ why: "demo project name" });
    expect(
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: hosted,
        DEMO_PROJECT_NAME: "pulse-DEMO-2",
      }).why,
    ).toBe("demo project name");
    expect(
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://pulsedemoabc.supabase.co",
      }).why,
    ).toBe("demo project reference");
    // a name that does not say demo is not enough
    expect(() =>
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: hosted,
        SUPABASE_PROJECT_NAME: "Pulse",
      }),
    ).toThrow(DemoGuardError);
  });

  it("never runs against anything that says production, even if it also says demo", () => {
    expect(() =>
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://demo-prod-ref.supabase.co",
      }),
    ).toThrow(/production/);
    expect(() =>
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
        SUPABASE_PROJECT_NAME: "demo (production copy)",
      }),
    ).toThrow(/production/);
  });

  it("refuses a missing, malformed or non-http URL", () => {
    expect(() => assertDemoAllowed({ DEMO_RESET_OK: "1" })).toThrow(/not set/);
    expect(() =>
      assertDemoAllowed({ DEMO_RESET_OK: "1", NEXT_PUBLIC_SUPABASE_URL: "not a url" }),
    ).toThrow(/valid URL/);
    expect(() =>
      assertDemoAllowed({
        DEMO_RESET_OK: "1",
        NEXT_PUBLIC_SUPABASE_URL: "postgres://localhost:5432/x",
      }),
    ).toThrow(/valid URL/);
  });
});

describe("demo content is obviously synthetic", () => {
  it("uses only reserved fictional phone numbers", () => {
    expect(demoPhone(0)).toBe("+447700900000");
    expect(demoPhone(999)).toBe("+447700900999");
    expect(() => demoPhone(1000)).toThrow();
    for (let i = 0; i < 80; i++) {
      const p = demoPerson(i);
      expect(isDemoPhone(p.phone!), String(i)).toBe(true);
      expect(p.last).toMatch(/^Demo-\d\d$/);
    }
    expect(demoPerson(3, { withPhone: false }).phone).toBeNull();
    expect(isDemoPhone("+971500000001")).toBe(false);
  });

  it("is deterministic: the same seed gives the same workspace", () => {
    const a = rng(7);
    const b = rng(7);
    expect([a.int(0, 100), a.int(0, 100), a.next()]).toEqual([
      b.int(0, 100),
      b.int(0, 100),
      b.next(),
    ]);
    expect(demoPerson(12)).toEqual(demoPerson(12));
  });

  it("describes 30 conversations in at least five different states, 3 pipelines and a campaign that adds up", () => {
    const specs = conversationSpecs();
    expect(specs).toHaveLength(30);
    expect(new Set(specs.map((s) => s.state)).size).toBeGreaterThanOrEqual(5);
    expect(specs.some((s) => s.language === "ar")).toBe(true);
    expect(PIPELINES).toHaveLength(3);
    expect(CAMPAIGN_OUTCOMES.reduce((n, o) => n + o.count, 0)).toBe(38);
  });

  it("builds finance records the real mapper accepts, with PINs only (no names or Emirates IDs)", () => {
    const batch = demoFinanceBatch(new Date("2026-10-14T10:00:00Z"));
    expect(uniteFinanceResponseSchema.safeParse(batch).success).toBe(true);
    const { invoices, duplicates } = mapBatch((batch as { Data: unknown[] }).Data);
    expect(invoices).toHaveLength(9);
    expect(duplicates).toBe(0);
    const text = JSON.stringify(batch);
    expect(text).not.toMatch(/EmiratesID|PatientName/);
    expect(text).toMatch(/DEMO-PIN-/);
  });
});
