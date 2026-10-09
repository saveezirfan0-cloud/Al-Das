/**
 * Import one day of Make output for the parallel-run report. Input is a text/CSV file with one Unite PIN
 * (or Unite appointment id for the reminders scenario) per line; the first column is used and a header line
 * is skipped. Ids are salted-hashed before they reach the database; the file itself stays on your machine
 * (never commit it).
 *
 *   pnpm parallel:ingest --org <org slug> --scenario birthday --date 2026-10-10 --file ./ids.txt [--dry-run]
 *
 * Scenarios: appointment_reminders | birthday | chronic_recall | chronic_update
 */
import "dotenv/config";

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import {
  COMPARABLE,
  makeOutputRows,
  SCENARIO_KEYS,
  type ScenarioKey,
} from "../lib/parallel-run/diff";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const slug = arg("org");
  const scenario = arg("scenario") as ScenarioKey | undefined;
  const day = arg("date");
  const file = arg("file");
  const dry = process.argv.includes("--dry-run");
  if (!slug || !scenario || !day || !file) {
    console.error(
      "usage: pnpm parallel:ingest --org <slug> --scenario <key> --date YYYY-MM-DD --file <ids.txt> [--dry-run]",
    );
    process.exit(1);
  }
  if (!SCENARIO_KEYS.includes(scenario) || !COMPARABLE.has(scenario)) {
    console.error(`Scenario must be one of: ${[...COMPARABLE].join(", ")}`);
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error("--date must be YYYY-MM-DD (clinic-local day)");
    process.exit(1);
  }

  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const ids = lines
    .map((l) => l.split(",")[0]!.replace(/^"|"$/g, "").trim())
    .filter(Boolean)
    .filter((v, i) => !(i === 0 && /^(pin|id|patient|appointment)/i.test(v)));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data: org } = await admin.from("orgs").select("id").eq("slug", slug).maybeSingle();
  if (!org) {
    console.error(`No workspace with slug "${slug}"`);
    process.exit(1);
  }

  const rows = makeOutputRows(org.id, scenario, day, ids);
  console.log(
    `${ids.length} ids read, ${rows.length} unique${dry ? " (dry run: nothing written)" : ""}`,
  );
  if (dry || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin
      .from("parallel_run_make_outputs")
      .upsert(rows.slice(i, i + 500), {
        onConflict: "org_id,scenario_key,run_date,ref_hash",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);
  }
  console.log("Imported. The nightly parallel_run job (or the next run) will compute the diff.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
