/**
 * Every Sanoflow export in one folder, in dependency order (Phase 20a; see scripts/import/sanoflow/all.ts).
 *
 *   pnpm import:sanoflow:all --dir=exports/ --org=al-das --dry-run
 *   pnpm import:sanoflow:all --dir=exports/ --org=al-das                       # everything but appointments
 *   pnpm import:sanoflow:all --dir=exports/ --org=al-das --with-appointments   # cut-over day
 *   options: --mode=skip (never change rows an earlier run created)  --only=config,lists,contacts,segments,enquiries,activity,campaigns,appointments
 *
 * Writes docs/audit/import-report-sanoflow-all-<ts>.md (counts only), import-summary-sanoflow-all-<ts>.json
 * (read by `pnpm reconcile`) and sanoflow-source-counts-<ts>.json (records per entity in the export, for
 * `pnpm reconcile --sanoflow-counts latest`). Never calls Sanoflow; reads local files only.
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

import {
  adminFromEnv,
  nowStamp,
  parseArgs,
  resolveOrg,
  writeReport,
  recordImportRuns,
  writeSummary,
} from "./import/common";
import { runAll } from "./import/sanoflow/all";
import {
  RECONCILED_ENTITIES,
  assertNoPii,
  renderReport,
  runSummaries,
  toSummaries,
} from "./import/sanoflow/report";

const STEPS = [
  "config",
  "lists",
  "contacts",
  "segments",
  "enquiries",
  "activity",
  "campaigns",
  "appointments",
];

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  if (!opts.dir) {
    console.error(
      "usage: pnpm import:sanoflow:all --dir=<exports folder> [--org=<slug>] [--dry-run] [--with-appointments] [--mode=skip|update] [--only=<steps>]",
    );
    process.exit(1);
  }
  const only = opts.only ? new Set(opts.only.split(",").map((s) => s.trim())) : undefined;
  for (const s of only ?? [])
    if (!STEPS.includes(s)) throw new Error(`unknown step "${s}" (steps: ${STEPS.join(", ")})`);
  const dryRun = flags.has("dry-run");
  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);
  const at = new Date().toISOString();
  console.log(
    `org=${org.slug} dir=${opts.dir} dryRun=${dryRun} appointments=${flags.has("with-appointments") ? "live" : "dry"}`,
  );

  const res = await runAll(admin, org, {
    dir: opts.dir,
    dryRun,
    mode: opts.mode === "skip" ? "skip" : "update",
    withAppointments: flags.has("with-appointments"),
    only,
    log: (m) => console.log(m),
  });

  const md = renderReport({
    orgSlug: org.slug,
    at,
    dryRun,
    dir: path.basename(path.resolve(opts.dir)),
    runs: res.runs,
    dynamicSegments: res.dynamicSegments,
    notes: res.notes,
  });
  assertNoPii(md);
  const report = writeReport("sanoflow-all", md);
  const summary = writeSummary("sanoflow-all", toSummaries(res.runs, { dryRun, at }));
  console.log(await recordImportRuns(admin, org.id, runSummaries(res.runs, { dryRun, at })));

  const counts = Object.fromEntries(
    RECONCILED_ENTITIES.map((e) => [
      e,
      { label: `Sanoflow ${e.replace(/_/g, " ")}`, total: res.counts[e] ?? 0 },
    ]),
  );
  const countsFile = path.join(
    process.cwd(),
    "docs/audit",
    `sanoflow-source-counts-${nowStamp()}.json`,
  );
  fs.writeFileSync(countsFile, JSON.stringify({ sanoflow: counts }, null, 2) + "\n");

  console.log(md);
  console.log(`report → ${report}\nsummary → ${summary}\nsource counts → ${countsFile}`);
  if (res.runs.some((r) => r.fatal || r.counters.failed > 0)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
