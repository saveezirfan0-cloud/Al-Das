/**
 * Airtable → Pulse (Phase 9: every importable table). Spec: scripts/import-airtable.README.md.
 * Table mappers: scripts/import/tables/*, patient mappers: scripts/import/mappers/*,
 * order and skip reasons: scripts/import/registry.ts.
 *
 *   pnpm import:airtable --dry-run                 # map + resolve links for everything, write nothing
 *   pnpm import:airtable --org=al-das              # import every ready table, in dependency order
 *   pnpm import:airtable --only=unite.diagnosis,unite.items
 *   pnpm import:airtable --only=app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB    # an entity also works
 *   pnpm import:airtable --since=2026-10-01T00:00:00Z                  # delta (records modified after)
 *   pnpm import:airtable --include-test-records    # default: "Is Test Record" rows are skipped
 *   pnpm import:airtable --list                    # tables, targets, status, skip reasons
 *
 * Idempotent through external_refs(source='airtable', entity='<baseId>.<tableId>', external_id=<recId>):
 * a re-run finds the same rows, reports them as unchanged and creates nothing. Tables whose target
 * is created in Phase 6 are validated by --dry-run and skipped by a real run. Never writes to
 * Airtable, never logs record contents; the report (docs/audit/import-report-airtable-<ts>.md,
 * gitignored) holds counts and ids only.
 */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { AirtableClient } from "./import/airtable-client";
import { adminFromEnv, parseArgs, resolveOrg, writeReport } from "./import/common";
import { runImport } from "./import/orchestrator";
import { runPatientTable } from "./import/patients";
import { REGISTRY } from "./import/registry";
import { renderReport, overallVerdict } from "./import/report";
import { SupabaseStore } from "./import/store";

/** docs/audit/airtable-raw/counts.json → { tableId: count } for the "audit-time count" column. */
function loadAuditedCounts(): Record<string, number> {
  try {
    const file = path.join(process.cwd(), "docs/audit/airtable-raw/counts.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      counts?: Record<string, Record<string, number | null>>;
    };
    const out: Record<string, number> = {};
    for (const base of Object.values(raw.counts ?? {}))
      for (const [label, n] of Object.entries(base)) {
        const id = label.match(/^(tbl[A-Za-z0-9]+)\s/)?.[1];
        if (id && typeof n === "number" && !label.includes("Top 30")) out[id] = n;
      }
    return out;
  } catch {
    return {};
  }
}

function printList() {
  for (const e of REGISTRY) {
    if (e.type === "skip") console.log(`skip     ${e.key.padEnd(34)} ${e.reason}`);
    else if (e.type === "patients") console.log(`ready    ${e.key.padEnd(34)} → contacts`);
    else
      console.log(
        `${e.mapper.status === "ready" ? "ready   " : "phase 6 "} ${e.key.padEnd(34)} → ${e.mapper.target}`,
      );
  }
}

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  if (flags.has("list")) return printList();
  const dryRun = flags.has("dry-run");
  const PAT = process.env.AIRTABLE_PAT;
  if (!PAT) {
    console.error("AIRTABLE_PAT missing (.env.local)");
    process.exit(1);
  }

  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);
  const store = new SupabaseStore(admin, org.id);
  const batch = `airtable-${Date.now().toString(36)}`;

  const tagIds = new Map<string, string>();
  {
    const { data: tags } = await admin
      .from("tags")
      .select("id, name")
      .eq("org_id", org.id)
      .eq("scope", "contact");
    for (const t of tags ?? []) tagIds.set(t.name.toLowerCase(), t.id);
  }

  if (!dryRun) {
    // Idempotent per-org seeds the reference tables depend on (condition groups, clinical settings, portal registry).
    for (const fn of [
      "seed_condition_groups",
      "seed_clinical_settings",
      "seed_portal_objects",
    ] as const) {
      const { error } = await (
        admin as unknown as {
          rpc: (f: string, a: object) => Promise<{ error: { message: string } | null }>;
        }
      ).rpc(fn, { p_org: org.id });
      if (error) throw new Error(`${fn} failed: ${error.message}`);
    }
  } else {
    console.log(
      "dry run: per-org seeds (condition groups, clinical settings) are not applied, so lookups against them reflect the current database.",
    );
  }

  console.log(
    `org=${org.slug} dryRun=${dryRun} since=${opts.since ?? "-"} only=${opts.only ?? "(all)"}`,
  );
  const run = await runImport(
    {
      store,
      source: new AirtableClient(PAT),
      runPatients: (entry, ctx) =>
        runPatientTable(
          { ...entry.mapper, key: entry.key },
          { ...ctx, admin, orgId: org.id, batch, tagIds },
        ),
    },
    {
      only: opts.only
        ? opts.only
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      dryRun,
      includeTest: flags.has("include-test-records"),
      since: opts.since,
      auditedCounts: loadAuditedCounts(),
      log: (l) => console.log(l),
    },
  );

  const md = renderReport(run, { org: org.slug });
  const file = writeReport("airtable", md);
  console.log(md);
  console.log(`report → ${file}`);
  if (overallVerdict(run.results) === "FAIL") process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
