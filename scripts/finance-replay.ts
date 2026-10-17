/**
 * Re-process raw Unite batches from fin_raw_unite_batches. Never calls Unite.
 *   pnpm finance:replay <batchId>
 *   pnpm finance:replay --failed [--org=<slug>]
 * Safe to run any number of times (fin_apply_invoices is idempotent).
 */
import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

import { processBatch } from "../lib/finance/process-batch";
import { dbProcessDeps } from "../lib/finance/process-deps";

async function main() {
  const args = process.argv.slice(2);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const deps = dbProcessDeps(admin);

  let ids: string[];
  if (args.includes("--failed")) {
    const slug = args.find((a) => a.startsWith("--org="))?.slice(6);
    let q = admin
      .from("fin_raw_unite_batches")
      .select("id, org_id")
      .neq("process_status", "processed")
      .order("requested_at", { ascending: true });
    if (slug) {
      const { data: org } = await admin.from("orgs").select("id").eq("slug", slug).maybeSingle();
      if (!org) throw new Error(`org '${slug}' not found`);
      q = q.eq("org_id", org.id);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    ids = (data ?? []).map((b) => b.id);
  } else if (args[0]) {
    ids = [args[0]];
  } else {
    console.error("usage: pnpm finance:replay <batchId> | --failed [--org=<slug>]");
    process.exit(1);
  }

  let failed = 0;
  for (const id of ids) {
    const r = await processBatch(deps, id);
    console.log(id, r.ok ? `ok ${JSON.stringify(r.counts)}` : `FAILED ${r.error}`);
    if (!r.ok) failed++;
  }
  console.log(`${ids.length} batch(es), ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
