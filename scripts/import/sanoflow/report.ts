/**
 * Counts-only markdown report and reconcile summaries for a Sanoflow import run. The report holds
 * counts, reason codes, line numbers, CSV header names and unmatched reference names (pipelines,
 * stages, locations, specialists, services): never a patient name, phone, e-mail or message text.
 * `findPii` runs over it before it is written.
 */
import { findPii, type ImportSummary } from "@/lib/migration/reconcile";

import { mdTable } from "../common";
import type { EntityRun } from "./run";
import { outcomes } from "./run";
import type { DynamicSegment } from "./run-segments";

/** Entities whose records count towards migration sign-off (`pnpm reconcile`). */
export const RECONCILED_ENTITIES = [
  "contact",
  "enquiry",
  "enquiry_activity",
  "appointment",
  "segment_member",
] as const;

export function toSummaries(
  runs: EntityRun[],
  opts: { dryRun: boolean; at: string },
): ImportSummary[] {
  return runs
    .filter((r) => !r.fatal && (RECONCILED_ENTITIES as readonly string[]).includes(r.entity))
    .map((r) => ({
      source: "sanoflow",
      entity: r.entity,
      label: `Sanoflow ${r.label.toLowerCase()}`,
      runAt: opts.at,
      dryRun: r.dryRun ?? opts.dryRun,
      since: null,
      includeTestRecords: true,
      skippedByDesign: r.skippedByDesign,
      counters: {
        read: r.counters.read,
        created: r.counters.created,
        // unchanged and adopted rows are linked (have a ref) without being created by this run
        updated: r.counters.updated + r.counters.unchanged + r.counters.adopted,
        skipped: r.counters.skipped,
        invalid: r.counters.invalid,
        duplicates: r.counters.duplicates,
        review: r.counters.review,
        failed: r.counters.failed,
      },
    }));
}

const CODE_HELP: Record<string, string> = {
  unknown_pipeline: "pipeline not in sanoflow-config.json",
  unknown_stage: "stage not in sanoflow-config.json for that pipeline",
  unknown_status: "status not mapped (add it to `statuses` in the config)",
  contact_not_found:
    "no Pulse contact with that Sanoflow id or phone (run the contact import first)",
  contact_ambiguous: "several contacts share the phone (resolve the duplicate, then re-run)",
  slot_taken: "the specialist is busy at that time in Pulse (book by hand, then re-run)",
  enquiry_not_imported: "the activity's enquiry was not imported",
  unknown_location: "location not found (add it to sanoflow-names.json)",
  unknown_specialist: "specialist not found (add it to sanoflow-names.json)",
};

export function renderReport(args: {
  orgSlug: string;
  at: string;
  dryRun: boolean;
  dir: string;
  runs: EntityRun[];
  dynamicSegments: DynamicSegment[];
  notes: string[];
}): string {
  const { runs } = args;
  const lines: string[] = [
    `# Sanoflow import — ${args.at}`,
    ``,
    `- Workspace: \`${args.orgSlug}\``,
    `- Export folder: \`${args.dir}\``,
    `- ${args.dryRun ? "**Dry run: nothing was written.**" : "Real run."}`,
    ...args.notes.map((n) => `- ${n}`),
    ``,
    `## Counts`,
    ``,
    mdTable(
      [
        "Step",
        "Read",
        "Created",
        "Updated",
        "Unchanged",
        "Adopted",
        "Skipped",
        "Invalid",
        "Dupes",
        "Review",
        "Failed",
        "Check",
      ],
      runs.map((r) => {
        const c = r.counters;
        const ok = r.fatal
          ? "FATAL"
          : outcomes(c) === c.read
            ? "ok"
            : `**${c.read - outcomes(c)} unaccounted**`;
        return [
          r.label,
          c.read,
          c.created,
          c.updated,
          c.unchanged,
          c.adopted,
          c.skipped,
          c.invalid,
          c.duplicates,
          c.review,
          c.failed,
          ok,
        ];
      }),
    ),
    ``,
  ];
  for (const r of runs) {
    const parts: string[] = [];
    if (r.fatal) parts.push(`**Not run:** ${r.fatal}`);
    if (r.file) parts.push(`File(s): \`${r.file}\``);
    for (const n of r.notes) parts.push(n);
    const warnings = Object.entries(r.warnings);
    if (warnings.length)
      parts.push(
        mdTable(
          ["Warning", "Rows"],
          warnings.sort().map(([k, v]) => [k, v]),
        ),
      );
    const names = Object.entries(r.unmatchedNames);
    if (names.length)
      parts.push(
        "Unmatched reference names (fix the config or names file):\n\n" +
          mdTable(
            ["Kind", "Names"],
            names.map(([k, v]) => [k, v.map((x) => `\`${x}\``).join(", ")]),
          ),
      );
    if (r.unknownHeaders.length)
      parts.push(`Ignored columns: ${r.unknownHeaders.map((h) => `\`${h}\``).join(", ")}`);
    if (r.problems.length) {
      const byCode = new Map<string, number[]>();
      for (const [line, code] of r.problems) byCode.set(code, [...(byCode.get(code) ?? []), line]);
      parts.push(
        "Rows not imported (line numbers count data rows from 1 across the step's files):\n\n" +
          mdTable(
            ["Reason", "Rows", "Lines (first 50)"],
            [...byCode].map(([code, ls]) => [
              CODE_HELP[code] ? `${code}: ${CODE_HELP[code]}` : code,
              ls.length,
              ls.slice(0, 50).join(", "),
            ]),
          ),
      );
    }
    if (parts.length) lines.push(`## ${r.label}`, ``, parts.join("\n\n"), ``);
  }
  if (args.dynamicSegments.length) {
    lines.push(
      `## Dynamic segments to rebuild by hand`,
      ``,
      `Pulse filters use Pulse fields, so these are not imported. Rebuild each one in Contacts → Segments.`,
      ``,
      mdTable(
        ["Segment", "Sanoflow filter"],
        args.dynamicSegments.map((s) => [
          s.name.replace(/\|/g, "\\|"),
          `\`${s.filter.replace(/[|`\n]/g, " ")}\``,
        ]),
      ),
      ``,
    );
  }
  return lines.join("\n");
}

/** Throws (with reasons only) when the report looks like it holds personal data. */
export function assertNoPii(markdown: string): void {
  const found = findPii(markdown);
  if (found.length)
    throw new Error(
      `refusing to write the import report: it appears to contain ${found.join(", ")}. ` +
        `Check the header names and the names in sanoflow-names.json / the config.`,
    );
}
