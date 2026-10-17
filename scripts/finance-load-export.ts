/**
 * Load an export of the Unite Finance API that was saved earlier (W1). NEVER calls Unite: it only reads local files.
 *   pnpm finance:load-export --org=<slug> --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run] <file.json> [more files, oldest first]
 *
 * Each file is checked first (nothing is written if any file is unreadable), stored as raw batches exactly as received
 * (`fin_raw_unite_batches`, 500 invoices a batch), then processed by the same code as a live capture. Safe to run
 * again: a batch already stored for the org (same SHA-256) is skipped and an unprocessed one is processed.
 * If processing fails the raw batch stays; fix the cause and run `pnpm finance:replay --failed`.
 */
import "dotenv/config";

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import {
  checkRange,
  LoadExportError,
  monthTotals,
  rawRowFor,
  readSavedExport,
} from "../lib/finance/load-export";
import { processBatch } from "../lib/finance/process-batch";
import { dbProcessDeps } from "../lib/finance/process-deps";
import type { AdminClient } from "../lib/supabase/admin";
import type { Json } from "../lib/supabase/types";

const USAGE =
  "usage: pnpm finance:load-export --org=<slug> --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run] <file.json>...";

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const files = args.filter((a) => !a.startsWith("--"));
  const slug = opt("org");
  const from = opt("from") ?? "";
  const to = opt("to") ?? "";
  const dryRun = args.includes("--dry-run");
  if (!slug || files.length === 0) throw new LoadExportError(USAGE);
  checkRange(from, to);

  // Read and check every file before touching the database.
  const parsed = files.map((f) => ({ name: f, ...readSavedExport(readFileSync(f)) }));
  for (const p of parsed) {
    console.log(
      `${p.name}: ${p.records} invoice(s) in ${p.chunks.length} batch(es), file sha256 ${p.fileSha256.slice(0, 12)}`,
    );
    try {
      for (const m of monthTotals(p.chunks))
        console.log(
          `  ${m.month}  ${m.invoices} invoices  total ${(m.totalCents / 100).toFixed(2)}`,
        );
    } catch (e) {
      // the summary uses the mapper; a mapping problem must not stop the raw data from being stored first
      console.log(
        `  month totals unavailable: ${e instanceof Error ? e.message : "mapping failed"}`,
      );
    }
  }
  if (dryRun) {
    console.log("dry run: nothing was written");
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new LoadExportError(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
    );
  const admin: AdminClient = createClient(url, key, { auth: { persistSession: false } });
  const { data: org } = await admin.from("orgs").select("id").eq("slug", slug).maybeSingle();
  if (!org) throw new LoadExportError(`org '${slug}' not found`);
  const deps = dbProcessDeps(admin);

  let failed = 0;
  for (const p of parsed) {
    for (const [i, chunk] of p.chunks.entries()) {
      const { data: existing, error: findErr } = await admin
        .from("fin_raw_unite_batches")
        .select("id, process_status")
        .eq("org_id", org.id)
        .eq("payload_sha256", chunk.sha256)
        .limit(1)
        .maybeSingle();
      if (findErr) throw new Error(findErr.message);

      let batchId = existing?.id;
      if (existing?.process_status === "processed") {
        console.log(`${p.name} ${i + 1}/${p.chunks.length}: already loaded, skipped`);
        continue;
      }
      if (!batchId) {
        const row = rawRowFor(chunk, p.fileSha256, i + 1, p.chunks.length, { from, to });
        const { data, error } = await admin
          .from("fin_raw_unite_batches")
          .insert({ ...row, org_id: org.id, payload: row.payload as Json })
          .select("id")
          .single();
        if (error) throw new Error(`store raw batch: ${error.message}`);
        batchId = data.id;
      }
      const r = await processBatch(deps, batchId);
      console.log(
        `${p.name} ${i + 1}/${p.chunks.length}:`,
        r.ok ? `ok ${JSON.stringify(r.counts)}` : `FAILED ${r.error}`,
      );
      if (!r.ok) failed++;
    }
  }
  console.log(
    failed ? `${failed} batch(es) failed; raw data is kept, see finance:replay --failed` : "done",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
