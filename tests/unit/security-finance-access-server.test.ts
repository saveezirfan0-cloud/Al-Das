import { beforeEach, describe, expect, it, vi } from "vitest";

// noteFinanceDenial: one alert draft per refusal, ids/reason/network/hash only, never the full address, never throws.

const raiseAlert = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/security/alerts", () => ({ raiseAlert: (...a: unknown[]) => raiseAlert(...a) }));
vi.mock("@/lib/security/hash", () => ({ hashValue: (v: string) => `h(${v.length})` }));

const { noteFinanceDenial } = await import("@/lib/security/finance-access-server");
const { parseIp } = await import("@/lib/security/client-ip");
const { financeAccessAlert } = await import("@/lib/security/finance-access");

const base = {
  orgId: "org-1",
  userId: "11111111-1111-4111-8111-111111111111",
  org: { timezone: "Asia/Dubai" },
};

describe("noteFinanceDenial", () => {
  beforeEach(() => raiseAlert.mockClear());

  it("raises the finance_access_denied alert with the network and a hash, never the address", async () => {
    await noteFinanceDenial({
      ...base,
      financeAccess: { allowed: false, reason: "ip_not_allowed" },
      clientIp: parseIp("203.0.113.77"),
    });
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    const [, orgId, draft] = raiseAlert.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(orgId).toBe("org-1");
    expect(draft).toMatchObject({
      kind: "finance_access_denied",
      userId: base.userId,
      detail: { reason: "ip_not_allowed", network: "203.0.113.0/24", ip_hash: "h(12)" },
    });
    expect(JSON.stringify(draft)).not.toContain("203.0.113.77");
  });

  it("does nothing for an allowed request", async () => {
    await noteFinanceDenial({
      ...base,
      financeAccess: { allowed: true, reason: "inside" },
      clientIp: null,
    });
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("never throws when alerting fails", async () => {
    raiseAlert.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      noteFinanceDenial({
        ...base,
        financeAccess: { allowed: false, reason: "outside_hours" },
        clientIp: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("financeAccessAlert", () => {
  it("dedupes per member per local day in the org timezone", () => {
    const at = (iso: string) =>
      financeAccessAlert({
        userId: "u",
        reason: "outside_hours",
        now: new Date(iso),
        timeZone: "Asia/Dubai",
        network: null,
        ipHash: null,
      }).dedupeKey;
    // 19:59Z and 20:00Z on 12 Oct are 23:59 Monday and 00:00 Tuesday in Dubai
    expect(at("2026-10-12T19:59:00Z")).toBe("finance_access:u:2026-10-12");
    expect(at("2026-10-12T20:00:00Z")).toBe("finance_access:u:2026-10-13");
    expect(at("2026-10-12T08:00:00Z")).toBe(at("2026-10-12T19:00:00Z"));
  });
});
