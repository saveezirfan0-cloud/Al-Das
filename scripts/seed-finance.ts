/**
 * Adds the Finance & Insurance and Accounting role presets, the finance reference rows and the default chart of
 * accounts to an existing org (new orgs get all of it at /onboarding; an Admin can also run it under Settings, Roles).
 * Idempotent; never overwrites edits. The steps live in lib/finance/seed.ts.
 *   pnpm finance:seed --org=al-das
 */
import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

import { seedFinanceSetup } from "../lib/finance/seed";
import type { Database } from "../lib/supabase/types";

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
  const admin = createClient<Database>(url, key, { auth: { persistSession: false } });

  const { data: org, error } = await admin.from("orgs").select("id").eq("slug", slug).maybeSingle();
  if (error || !org) {
    console.error(`org '${slug}' not found`);
    process.exit(1);
  }

  const { rolesAdded } = await seedFinanceSetup(admin, org.id);
  console.log(`finance reference data ensured; ${rolesAdded} new role(s) added`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
