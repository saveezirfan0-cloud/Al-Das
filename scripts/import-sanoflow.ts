/**
 * Sanoflow contact CSV export → contacts. Idempotent: rows are matched by the
 * Sanoflow contact id (external_refs source='sanoflow'), then by E.164 phone,
 * then by external id (Unite PIN).
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
import "dotenv/config";

import { prepareImport } from "@/lib/contacts/import";
import {
  findExternalRef,
  matchContact,
  queueSyncReview,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";
import { parseCsv } from "@/lib/csv";

import {
  adminFromEnv,
  counters,
  mdTable,
  parseArgs,
  resolveOrg,
  writeReport,
} from "./import/common";
import { findSanoflowIdHeader, sanoflowMapping } from "./import/mappers/sanoflow.contacts";
import { loadCustomFieldsForScript } from "./import/custom-fields";

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
  const mapping = opts.map
    ? (JSON.parse(fs.readFileSync(opts.map, "utf8")) as Record<string, string | null>)
    : sanoflowMapping(csv.headers, customFields);
  const idHeader = findSanoflowIdHeader(csv.headers);
  const idIndex = idHeader ? csv.headers.indexOf(idHeader) : -1;

  console.log(`org=${org.slug} rows=${csv.rows.length} dryRun=${dryRun} mode=${mode}`);
  console.log(
    "mapping:",
    mapping,
    idHeader
      ? `(sanoflow id column: "${idHeader}")`
      : "(no sanoflow id column: matching by phone only)",
  );

  const { rows, summary } = prepareImport(csv.headers, csv.rows, {
    mapping,
    customFields,
    requirePhone: true,
  });
  const c = counters();
  c.read = rows.length;
  c.invalid = summary.invalid;
  c.duplicates = summary.duplicates;
  const problems: Array<[number, string]> = [];
  const failures: Array<[number, string]> = [];
  const batch = `sanoflow-${Date.now().toString(36)}`;
  const tagIds = new Map<string, string>();
  {
    const { data: tags } = await admin
      .from("tags")
      .select("id, name")
      .eq("org_id", org.id)
      .eq("scope", "contact");
    for (const t of tags ?? []) tagIds.set(t.name.toLowerCase(), t.id);
  }

  for (const row of rows) {
    if (row.status !== "ok") {
      problems.push([
        row.line,
        row.status === "duplicate" ? `duplicate of line ${row.duplicateOf}` : row.errors.join("; "),
      ]);
      continue;
    }
    const sanoId = idIndex >= 0 ? (csv.rows[row.line - 1]?.[idIndex] ?? "").trim() : "";
    row.contact.source = "import_sanoflow";

    let existingId: string | null = null;
    let existingCustom: Record<string, unknown> | null = null;
    const ref = sanoId
      ? await findExternalRef(admin, {
          orgId: org.id,
          source: "sanoflow",
          entity: "contact",
          externalId: sanoId,
        })
      : null;
    if (ref) {
      const { data } = await admin
        .from("contacts")
        .select("id, custom")
        .eq("id", ref.localId)
        .is("deleted_at", null)
        .maybeSingle();
      if (data) {
        existingId = data.id;
        existingCustom = (data.custom as Record<string, unknown>) ?? {};
      }
    }
    if (!existingId) {
      const m = await matchContact(admin, org.id, {
        externalId: row.contact.external_id,
        phone: row.contact.phone_e164,
      });
      if (m.kind === "ambiguous") {
        c.review++;
        if (!dryRun && sanoId)
          await queueSyncReview(admin, {
            orgId: org.id,
            source: "sanoflow",
            entity: "contact",
            externalId: sanoId,
            reason: "multiple_matches",
            candidates: m.candidates,
          });
        problems.push([row.line, "ambiguous match → review queue"]);
        continue;
      }
      if (m.kind === "match") {
        existingId = m.id;
        existingCustom = m.custom;
      }
    }
    if (existingId && mode === "skip") {
      c.skipped++;
      continue;
    }
    const res = await writePreparedContact(admin, {
      orgId: org.id,
      existingId,
      existingCustom,
      contact: row.contact,
      defaultSource: "import_sanoflow",
      customFields,
      tagIds,
      actorId: null,
      batch,
      dryRun,
    });
    if (!res.ok) {
      c.failed++;
      failures.push([row.line, res.error]);
      continue;
    }
    if (res.created) c.created++;
    else c.updated++;
    if (!dryRun && sanoId)
      await upsertExternalRef(admin, {
        orgId: org.id,
        source: "sanoflow",
        entity: "contact",
        externalId: sanoId,
        localTable: "contacts",
        localId: res.id,
      });
    if (c.created + c.updated > 0 && (c.created + c.updated) % 500 === 0)
      console.log(`… ${c.created + c.updated} written`);
  }

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
    `## Failed writes`,
    failures.length ? mdTable(["Line", "Error"], failures.slice(0, 500)) : "_none_",
    ``,
  ].join("\n");

  const file = writeReport("sanoflow", report);
  console.log(report);
  console.log(`report → ${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
