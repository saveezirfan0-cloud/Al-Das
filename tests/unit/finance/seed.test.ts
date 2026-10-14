import { describe, expect, it } from "vitest";

import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";
import { FINANCE_SEED_ROLES, seedFinanceSetup } from "@/lib/finance/seed";

type Call = { fn: string; args: Record<string, unknown> };

function fakeAdmin(fail?: string) {
  const calls: Call[] = [];
  const admin = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === fail) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: fn === "seed_finance_roles" ? 4 : null, error: null });
    },
  };
  return { admin: admin as never, calls };
}

const ORG = "00000000-0000-4000-8000-000000000001";

describe("seedFinanceSetup", () => {
  it("runs every idempotent seed for the org and reports the roles added", async () => {
    const { admin, calls } = fakeAdmin();
    await expect(seedFinanceSetup(admin, ORG)).resolves.toEqual({ rolesAdded: 4 });
    expect(calls.map((c) => c.fn)).toEqual([
      "seed_finance_reference",
      "fin_close_seed_steps",
      "fin_seed_settlement_rules",
      "acc_seed_chart",
      "seed_finance_roles",
    ]);
    expect(calls.every((c) => c.args.p_org_id === ORG)).toBe(true);
    expect(calls.at(-1)!.args.p_roles).toEqual(FINANCE_SEED_ROLES);
  });

  it("stops at the first failure and names the step", async () => {
    const { admin, calls } = fakeAdmin("acc_seed_chart");
    await expect(seedFinanceSetup(admin, ORG)).rejects.toThrow("chart of accounts");
    expect(calls.map((c) => c.fn)).not.toContain("seed_finance_roles");
  });

  it("seeds exactly the finance and accounting presets, never Admin", () => {
    expect(FINANCE_SEED_ROLES.map((r) => r.name)).toEqual(
      [...FINANCE_ROLES, ...ACCOUNTING_ROLES].map((r) => r.name),
    );
    expect(FINANCE_SEED_ROLES.some((r) => r.permissions.includes("*"))).toBe(false);
  });
});
