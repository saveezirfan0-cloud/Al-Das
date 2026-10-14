import type { SupabaseClient } from "@supabase/supabase-js";

import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";
import type { Database } from "@/lib/supabase/types";

/** The Finance & Insurance and Accounting role presets, in the shape `seed_finance_roles` takes. */
export const FINANCE_SEED_ROLES = [...FINANCE_ROLES, ...ACCOUNTING_ROLES].map((r) => ({
  name: r.name,
  description: r.description,
  permissions: [...r.permissions],
}));

/**
 * Adds the finance reference rows, the close checklist, the starter settlement rules, the default chart of accounts
 * and the Finance/Accounting role presets to one org. Every step is idempotent and never overwrites an edit (a role
 * with the same name is left as it is). Service role only; the caller checks who may run it. Shared by
 * `pnpm finance:seed`, workspace creation (/onboarding) and Settings, Roles. Returns how many roles were new.
 */
export async function seedFinanceSetup(
  admin: SupabaseClient<Database>,
  orgId: string,
): Promise<{ rolesAdded: number }> {
  const run = async (step: string, call: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await call;
    if (error) throw new Error(`${step}: ${error.message}`);
  };
  await run("finance reference", admin.rpc("seed_finance_reference", { p_org_id: orgId }));
  // Phase 20G close checklist (owners are assigned in the app) and 20C starter settlement rules.
  await run("close checklist", admin.rpc("fin_close_seed_steps", { p_org_id: orgId }));
  await run("settlement rules", admin.rpc("fin_seed_settlement_rules", { p_org_id: orgId }));
  // Phase 22A: entity, groups, ledgers, tax codes.
  await run("chart of accounts", admin.rpc("acc_seed_chart", { p_org_id: orgId }));
  const roles = await admin.rpc("seed_finance_roles", {
    p_org_id: orgId,
    p_roles: FINANCE_SEED_ROLES,
  });
  if (roles.error) throw new Error(`roles: ${roles.error.message}`);
  return { rolesAdded: Number(roles.data ?? 0) };
}
