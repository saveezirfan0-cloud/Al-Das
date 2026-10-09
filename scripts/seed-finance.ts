/**
 * Adds the Finance & Insurance role presets and reference rows to an existing
 * org (new orgs get both automatically). Idempotent; never overwrites edits.
 *   pnpm finance:seed --org=al-das
 */
import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

import { FINANCE_ROLES } from "../lib/auth/permissions";

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
  const roles = await admin.rpc("seed_finance_roles", {
    p_org_id: org.id,
    p_roles: FINANCE_ROLES.map((r) => ({
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
