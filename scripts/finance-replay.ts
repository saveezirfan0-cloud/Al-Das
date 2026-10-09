/**
 * Re-process raw Unite batches from fin_raw_unite_batches. Never calls Unite.
 *   pnpm finance:replay <batchId>
 *   pnpm finance:replay --failed [--org=<slug>]
 * Safe to run any number of times (fin_apply_invoices is idempotent).
 */
import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

import { processBatch, type ProcessDeps } from "../lib/finance/process-batch";
import type { Json } from "../lib/supabase/types";

async function main() {
  const args = process.argv.slice(2);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const deps: ProcessDeps = {
    loadBatch: async (id) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .select("id, org_id, payload, record_count")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data
        ? { id: data.id, orgId: data.org_id, payload: data.payload, recordCount: data.record_count }
        : null;
    },
    apply: async (orgId, batchId, invoices) => {
      const { data, error } = await admin.rpc("fin_apply_invoices", {
        p_org_id: orgId,
        p_batch_id: batchId,
        p_invoices: invoices as unknown as Json,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, number>;
    },
    markFailed: async (batchId, error) => {
      await admin.rpc("fin_batch_mark_failed", { p_batch_id: batchId, p_error: error });
    },
  };

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
