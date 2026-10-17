/**
 * Sanoflow contact CSV export → contacts. Idempotent: rows are matched by the Sanoflow contact id
 * (external_refs source='sanoflow'), then by E.164 phone, then by external id (Unite PIN).
 * For everything else in the export folder use `pnpm import:sanoflow:all` (it runs this step too).
 *
 *   pnpm import:sanoflow --file=exports/contacts.csv --org=al-das --dry-run
 *   pnpm import:sanoflow --file=exports/contacts.csv --org=al-das
 *   pnpm import:sanoflow --file=... --map=mapping.json      # override header → field mapping
 *   pnpm import:sanoflow --file=... --mode=skip             # never update existing contacts (default: update)
 *
 * The report (docs/audit/import-report-sanoflow-<ts>.md) holds counts and
 * line numbers only — never names or phones.
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

import { parseCsv } from "@/lib/csv";

import {
  adminFromEnv,
  mdTable,
  parseArgs,
  resolveOrg,
  writeReport,
  recordImportRuns,
  writeSummary,
} from "./import/common";
import { loadCustomFieldsForScript } from "./import/custom-fields";
import { runSanoflowContacts } from "./import/sanoflow/contacts";

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const mode = opts.mode === "skip" ? "skip" : "update";
  if (!opts.file) {
    console.error(
      "usage: pnpm import:sanoflow --file=<csv> [--org=<slug>] [--dry-run] [--map=<json>] [--mode=skip|update]",
    );
    process.exit(1);
  }

  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);
  const customFields = await loadCustomFieldsForScript(admin, org.id);
  const csv = parseCsv(fs.readFileSync(opts.file, "utf8"));
  const map = opts.map
    ? (JSON.parse(fs.readFileSync(opts.map, "utf8")) as Record<string, string | null>)
    : undefined;

  console.log(`org=${org.slug} rows=${csv.rows.length} dryRun=${dryRun} mode=${mode}`);
  const { run, mapping, idHeader } = await runSanoflowContacts(admin, org.id, csv, {
    file: path.basename(opts.file),
    dryRun,
    mode,
    customFields,
    map,
    onProgress: (n) => console.log(`… ${n} written`),
  });
  const c = run.counters;
  console.log(
    "mapping:",
    mapping,
    idHeader
      ? `(sanoflow id column: "${idHeader}")`
      : "(no sanoflow id column: matching by phone only)",
  );

  const problems = run.problems;
  const report = [
    `# Sanoflow contact import — ${new Date().toISOString()}`,
    ``,
    `- Workspace: \`${org.slug}\``,
    `- File rows: ${c.read}${dryRun ? " (dry run — nothing written)" : ""}`,
    `- Mode: ${mode}`,
    ``,
    mdTable(
      ["Metric", "Count"],
      [
        ["Created", c.created],
        ["Updated", c.updated],
        ["Skipped (existing, mode=skip)", c.skipped],
        ["Invalid rows", c.invalid],
        ["Duplicates within file", c.duplicates],
        ["Ambiguous → sync_reviews", c.review],
        ["Failed writes", c.failed],
      ],
    ),
    ``,
    `## Column mapping`,
    mdTable(
      ["CSV header", "Field"],
      Object.entries(mapping).map(([h, f]) => [h, f ?? "(skipped)"]),
    ),
    ``,
    `## Problem rows (line numbers only)`,
    problems.length ? mdTable(["Line", "Problem"], problems.slice(0, 500)) : "_none_",
    ``,
  ].join("\n");

  const file = writeReport("sanoflow", report);
  const summaries = [
    {
      source: "sanoflow",
      entity: "contact",
      label: "Sanoflow contacts",
      runAt: new Date().toISOString(),
      dryRun,
      since: null,
      includeTestRecords: true,
      counters: {
        read: c.read,
        created: c.created,
        updated: c.updated,
        skipped: c.skipped,
        invalid: c.invalid,
        duplicates: c.duplicates,
        review: c.review,
        failed: c.failed,
      },
    },
  ];
  const summaryFile = writeSummary("sanoflow", summaries);
  console.log(await recordImportRuns(admin, org.id, summaries));
  console.log(report);
  console.log(`report → ${file}`);
  console.log(`summary → ${summaryFile}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
