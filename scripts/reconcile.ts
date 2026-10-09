/**
 * pnpm reconcile — migration sign-off report (Phase 11).
 *
 *   pnpm reconcile --org <slug> --source-counts docs/audit/source-counts.json --freeze-at 2026-11-01T18:00:00Z
 *   pnpm reconcile --org <slug> --live-airtable --freeze-at …        # count Airtable records now (read-only)
 *   pnpm reconcile --org <slug> --live-airtable --write-source-counts docs/audit/source-counts.json
 *
 * Options: --allow-open-reviews N (default 0)  --tolerance N (default 0)  --summaries <dir> (default docs/audit)
 *
 * source-counts.json: { "airtable": { "<baseId>.<tableId>": { "label": "Unite patients", "total": 10652 } } }
 * Reads the importers' summaries (docs/audit/import-summary-*.json), asks the database for a counts-only
 * snapshot (public.reconcile_snapshot) and writes docs/audit/reconciliation-<ts>.md/.json.
 * Never writes to Airtable, Sanoflow or Unite. The report is scanned for names/phones/e-mails before it is
 * written and the script aborts if any appear. Exit code 1 = not ready for sign-off.
 */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import {
  findPii,
  reconcile,
  renderReport,
  type DbSnapshot,
  type ImportSummary,
  type SourceCount,
} from "../lib/migration/reconcile";
import { AirtableClient } from "./import/airtable-client";
import { adminFromEnv, parseArgs, resolveOrg } from "./import/common";
import { PATIENT_MAPPERS } from "./import/mappers";

type SourceCountsFile = Record<string, Record<string, { label?: string; total: number }>>;

function loadSummaries(dir: string): ImportSummary[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^import-summary-.*\.json$/.test(f))
    .flatMap((f) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        summaries?: ImportSummary[];
      };
      return parsed.summaries ?? [];
    });
}

async function countAirtable(): Promise<SourceCountsFile> {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) throw new Error("AIRTABLE_PAT is required for --live-airtable");
  const client = new AirtableClient(pat);
  const out: SourceCountsFile = { airtable: {} };
  for (const m of PATIENT_MAPPERS) {
    let n = 0;
    for await (const record of client.records(m.baseId, m.tableId)) {
      void record; // counted in memory, never printed
      n++;
    }
    out.airtable[`${m.baseId}.${m.tableId}`] = { label: m.name, total: n };
    console.log(`  ${m.name}: ${n} records`);
  }
  return out;
}

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);

  let counts: SourceCountsFile = {};
  if (flags.has("live-airtable")) {
    console.log("counting Airtable records (read-only)…");
    counts = await countAirtable();
    if (opts["write-source-counts"]) {
      fs.writeFileSync(opts["write-source-counts"], JSON.stringify(counts, null, 2) + "\n");
      console.log(`source counts → ${opts["write-source-counts"]}`);
    }
  } else if (opts["source-counts"]) {
    counts = JSON.parse(fs.readFileSync(opts["source-counts"], "utf8")) as SourceCountsFile;
  } else {
    console.warn("no --source-counts or --live-airtable: per-entity accounting will be skipped");
  }

  const sources: SourceCount[] = Object.entries(counts).flatMap(([source, entities]) =>
    Object.entries(entities).map(([entity, v]) => ({
      source,
      entity,
      label: v.label ?? entity,
      total: v.total,
    })),
  );

  const { data, error } = await admin.rpc("reconcile_snapshot", { p_org_id: org.id });
  if (error) throw new Error(`reconcile_snapshot: ${error.message}`);
  const db = data as unknown as DbSnapshot;

  const summaries = loadSummaries(opts.summaries ?? path.join(process.cwd(), "docs/audit"));
  const result = reconcile(sources, db, summaries, {
    tolerance: opts.tolerance ? Number(opts.tolerance) : 0,
    allowOpenReviews: opts["allow-open-reviews"] ? Number(opts["allow-open-reviews"]) : 0,
    freezeAt: opts["freeze-at"] ?? null,
  });

  const generatedAt = new Date().toISOString();
  const md = renderReport({
    orgSlug: org.slug,
    generatedAt,
    result,
    db,
    freezeAt: opts["freeze-at"] ?? null,
  });
  const pii = findPii(md);
  if (pii.length)
    throw new Error(`refusing to write the report: it appears to contain ${pii.join(", ")}`);

  const stamp = generatedAt.replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(process.cwd(), "docs/audit");
  fs.mkdirSync(dir, { recursive: true });
  const mdFile = `reconciliation-${stamp}.md`;
  fs.writeFileSync(path.join(dir, mdFile), md);
  fs.writeFileSync(
    path.join(dir, `reconciliation-${stamp}.json`),
    JSON.stringify(
      {
        report: mdFile,
        generatedAt,
        ok: result.ok,
        freezeAt: opts["freeze-at"] ?? null,
        checks: result.checks,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(md);
  console.log(`report → docs/audit/${mdFile}`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
