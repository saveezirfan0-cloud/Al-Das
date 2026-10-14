/**
 * Adds the Finance & Insurance and Accounting role presets, the finance reference rows and the default chart of
 * accounts to an existing org (new orgs get all of it automatically). Idempotent; never overwrites edits.
 *   pnpm finance:seed --org=al-das
 */
import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

import { ACCOUNTING_ROLES, FINANCE_ROLES } from "../lib/auth/permissions";

async function main() {
  const slug = process.argv.find((a) => a.startsWith("--org="))?.slice(6);
  if (!slug) {
    console.error("usage: pnpm finance:seed --org=<org slug>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const { data: org, error } = await admin.from("orgs").select("id").eq("slug", slug).maybeSingle();
  if (error || !org) {
    console.error(`org '${slug}' not found`);
    process.exit(1);
  }

  const ref = await admin.rpc("seed_finance_reference", { p_org_id: org.id });
  if (ref.error) throw new Error(ref.error.message);
  // Phase 20G: the standard close checklist (no owners; they are assigned in the app). Never overwrites an edited step.
  const steps = await admin.rpc("fin_close_seed_steps", { p_org_id: org.id });
  if (steps.error) throw new Error(steps.error.message);
  const rules = await admin.rpc("fin_seed_settlement_rules", { p_org_id: org.id }); // Phase 20C starter rules
  if (rules.error) throw new Error(rules.error.message);
  const chart = await admin.rpc("acc_seed_chart", { p_org_id: org.id }); // Phase 22A: entity, groups, ledgers, tax codes
  if (chart.error) throw new Error(chart.error.message);
  const roles = await admin.rpc("seed_finance_roles", {
    p_org_id: org.id,
    p_roles: [...FINANCE_ROLES, ...ACCOUNTING_ROLES].map((r) => ({
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
  });
  if (roles.error) throw new Error(roles.error.message);
  console.log(`finance reference data ensured; ${roles.data} new role(s) added`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
