/**
 * Airtable → contacts (Phase 2: patient-related tables only; Phase 9 adds the rest).
 * Spec: scripts/import-airtable.README.md. Mappers: scripts/import/mappers/*.
 *
 *   pnpm import:airtable --dry-run                       # counts + mapping coverage, writes nothing
 *   pnpm import:airtable --org=al-das                    # import every patient table
 *   pnpm import:airtable --only=app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB
 *   pnpm import:airtable --since=2026-10-01T00:00:00Z    # delta (records modified after)
 *   pnpm import:airtable --include-test-records          # default: Acute "Is Test Record" rows are skipped
 *
 * Idempotent through external_refs(source='airtable', entity='<baseId>.<tableId>', external_id=<recId>).
 * Patients are matched to existing contacts by Unite PIN → E.164 phone → name + DOB; ambiguous
 * matches go to sync_reviews and are never auto-merged. Never writes to Airtable, never logs
 * record contents. The report (docs/audit/import-report-airtable-<ts>.md) uses ids only.
 */
import "dotenv/config";

import {
  findExternalRef,
  matchContact,
  queueSyncReview,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";

import { AirtableClient } from "./import/airtable-client";
import {
  adminFromEnv,
  counters,
  mdTable,
  parseArgs,
  resolveOrg,
  writeReport,
  writeSummary,
  type Counters,
} from "./import/common";
import { ensureCustomFields } from "./import/custom-fields";
import { PATIENT_MAPPERS } from "./import/mappers";

async function main() {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const includeTest = flags.has("include-test-records");
  const PAT = process.env.AIRTABLE_PAT;
  if (!PAT) {
    console.error("AIRTABLE_PAT missing (.env.local)");
    process.exit(1);
  }

  const mappers = PATIENT_MAPPERS.filter(
    (m) => !opts.only || `${m.baseId}.${m.tableId}` === opts.only,
  );
  if (mappers.length === 0) {
    console.error(
      `--only did not match a mapper. Known: ${PATIENT_MAPPERS.map((m) => `${m.baseId}.${m.tableId}`).join(", ")}`,
    );
    process.exit(1);
  }

  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);
  const airtable = new AirtableClient(PAT);
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

  type TableReport = {
    name: string;
    entity: string;
    counters: Counters;
    unmappedFields: Array<{ id: string; name: string; type: string }>;
    createdCustomFields: string[];
    warnings: Record<string, number>;
    failures: Array<[string, string]>;
  };
  const reports: TableReport[] = [];

  console.log(
    `org=${org.slug} dryRun=${dryRun} since=${opts.since ?? "-"} tables=${mappers.map((m) => m.name).join(" | ")}`,
  );

  for (const mapper of mappers) {
    const entity = `${mapper.baseId}.${mapper.tableId}`;
    const c = counters();
    const warnings: Record<string, number> = {};
    const failures: Array<[string, string]> = [];

    const { defs: customFields, created: createdCustomFields } = await ensureCustomFields(
      admin,
      org.id,
      mapper.customFields,
      dryRun,
    );
    const schema = await airtable.tableFields(mapper.baseId, mapper.tableId);
    const SKIP_TYPES = new Set([
      "formula",
      "rollup",
      "lookup",
      "multipleLookupValues",
      "count",
      "createdTime",
      "lastModifiedTime",
      "autoNumber",
      "multipleRecordLinks",
    ]);
    const unmappedFields = schema
      .filter((f) => !mapper.fieldIds.includes(f.id) && !SKIP_TYPES.has(f.type))
      .map((f) => ({ id: f.id, name: f.name, type: f.type }));

    for await (const record of airtable.records(mapper.baseId, mapper.tableId, {
      since: opts.since,
    })) {
      c.read++;
      let mapped;
      try {
        mapped = mapper.map(record);
      } catch (e) {
        c.failed++;
        failures.push([record.id, `mapper threw: ${(e as Error).message}`]);
        continue;
      }
      for (const w of mapped.warnings) warnings[w] = (warnings[w] ?? 0) + 1;
      if (mapped.isTestRecord && !includeTest) {
        c.skipped++;
        continue;
      }
      const ct = mapped.contact;
      if (!ct.phone_e164 && !ct.external_id && !(ct.first_name && ct.dob)) {
        c.invalid++;
        continue; // nothing to identify the patient by
      }

      // 1. Already imported? (idempotent re-run)
      let existingId: string | null = null;
      let existingCustom: Record<string, unknown> | null = null;
      const ref = await findExternalRef(admin, {
        orgId: org.id,
        source: "airtable",
        entity,
        externalId: record.id,
      });
      if (ref) {
        const { data } = await admin
          .from("contacts")
          .select("id, custom, merged_into_id")
          .eq("id", ref.localId)
          .maybeSingle();
        const target = data?.merged_into_id ?? data?.id ?? null;
        if (target) {
          const { data: live } = await admin
            .from("contacts")
            .select("id, custom")
            .eq("id", target)
            .is("deleted_at", null)
            .maybeSingle();
          if (live) {
            existingId = live.id;
            existingCustom = (live.custom as Record<string, unknown>) ?? {};
          }
        }
      }
      // 2. Match an existing patient: PIN → phone → name + DOB
      if (!existingId) {
        const m = await matchContact(admin, org.id, {
          externalId: ct.external_id,
          phone: ct.phone_e164,
          fullName: `${ct.first_name} ${ct.last_name}`.trim(),
          dob: ct.dob,
        });
        if (m.kind === "ambiguous") {
          c.review++;
          if (!dryRun)
            await queueSyncReview(admin, {
              orgId: org.id,
              source: "airtable",
              entity,
              externalId: record.id,
              reason: `multiple_${m.candidates[0]?.matched_on ?? "matches"}`,
              candidates: m.candidates,
            });
          continue;
        }
        if (m.kind === "match") {
          existingId = m.id;
          existingCustom = m.custom;
        }
      }

      const res = await writePreparedContact(admin, {
        orgId: org.id,
        existingId,
        existingCustom,
        contact: ct,
        defaultSource: "import_airtable",
        customFields,
        tagIds,
        actorId: null,
        batch,
        dryRun,
      });
      if (!res.ok) {
        c.failed++;
        failures.push([record.id, res.error]);
        continue;
      }
      if (res.created) c.created++;
      else c.updated++;
      if (!dryRun) {
        await upsertExternalRef(admin, {
          orgId: org.id,
          source: "airtable",
          entity,
          externalId: record.id,
          localTable: "contacts",
          localId: res.id,
          meta: mapped.meta,
        });
        for (const [source, externalId] of Object.entries(mapped.refs))
          await upsertExternalRef(admin, {
            orgId: org.id,
            source,
            entity: "contact",
            externalId,
            localTable: "contacts",
            localId: res.id,
          });
      }
      if (c.read % 500 === 0)
        console.log(`  ${mapper.name}: ${c.read} read, ${c.created} created, ${c.updated} updated`);
    }

    reports.push({
      name: mapper.name,
      entity,
      counters: c,
      unmappedFields,
      createdCustomFields,
      warnings,
      failures,
    });
    console.log(`${mapper.name}: ${JSON.stringify(c)}`);
  }

  const { count: openReviews } = await admin
    .from("sync_reviews")
    .select("id", { count: "exact", head: true })
    .eq("org_id", org.id)
    .eq("status", "open");

  const md = [
    `# Airtable patient import — ${new Date().toISOString()}`,
    ``,
    `- Workspace: \`${org.slug}\`${dryRun ? " — **dry run, nothing written**" : ""}`,
    `- Delta since: ${opts.since ?? "(full)"}`,
    `- Test records: ${includeTest ? "included" : "skipped"}`,
    `- Open sync reviews after run: ${openReviews ?? "?"}`,
    ``,
    ...reports.flatMap((r) => [
      `## ${r.name} (\`${r.entity}\`)`,
      ``,
      mdTable(
        ["Metric", "Count"],
        [
          ["Airtable records read", r.counters.read],
          ["Created", r.counters.created],
          ["Updated (matched existing)", r.counters.updated],
          ["Skipped (test records)", r.counters.skipped],
          ["Unidentifiable (no PIN, phone or name+DOB)", r.counters.invalid],
          ["Ambiguous → sync_reviews", r.counters.review],
          ["Failed writes", r.counters.failed],
        ],
      ),
      ``,
      `Field warnings: ${
        Object.entries(r.warnings)
          .map(([k, v]) => `${k} ×${v}`)
          .join(", ") || "none"
      }`,
      ``,
      `Custom fields created: ${r.createdCustomFields.join(", ") || "none"}`,
      ``,
      `### Mapping coverage — unmapped non-computed fields`,
      r.unmappedFields.length
        ? mdTable(
            ["Field ID", "Name", "Type"],
            r.unmappedFields.map((f) => [f.id, f.name, f.type]),
          )
        : "_all data fields mapped_",
      ``,
      `### Failed records (Airtable ids only)`,
      r.failures.length ? mdTable(["Record", "Error"], r.failures.slice(0, 500)) : "_none_",
      ``,
    ]),
    `Linked-record fields (Medical Records Data, Chronic Diagnosis, Medication) are not imported in Phase 2; they resolve in Phase 6/9 once visits and reference tables exist.`,
    ``,
  ].join("\n");

  const file = writeReport("airtable", md);
  const summaryFile = writeSummary(
    "airtable",
    reports.map((r) => ({
      source: "airtable",
      entity: r.entity,
      label: r.name,
      runAt: new Date().toISOString(),
      dryRun,
      since: opts.since ?? null,
      includeTestRecords: includeTest,
      counters: r.counters,
    })),
  );
  console.log(md);
  console.log(`report → ${file}`);
  console.log(`summary → ${summaryFile}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
