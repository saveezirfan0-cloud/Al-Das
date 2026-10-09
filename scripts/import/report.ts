/**
 * Reconciliation report (markdown). Counts, Airtable record ids and field ids only: no names,
 * phones, message text or any other cell value (CLAUDE.md rules 9–10).
 */
import { mdTable } from "./common";
import type { ImportRun } from "./orchestrator";
import { expectedRefs, type TableResult, type Verdict } from "./results";

export type Overall = "PASS" | "PASS_WITH_WARNINGS" | "FAIL";

export function overallVerdict(results: TableResult[]): Overall {
  if (results.some((r) => r.verdict === "FAIL")) return "FAIL";
  if (results.some((r) => r.verdict === "WARN")) return "PASS_WITH_WARNINGS";
  return "PASS";
}

const ICON: Record<Verdict, string> = {
  OK: "OK",
  WARN: "WARN",
  FAIL: "FAIL",
  PENDING: "pending Phase 6",
  SKIPPED: "skipped",
};

function summaryRow(r: TableResult): Array<string | number> {
  const c = r.counters;
  const inScope = r.outcome === "imported" || r.outcome === "validated";
  return [
    r.name,
    r.target,
    inScope ? c.read : "-",
    inScope ? expectedRefs(c) : "-",
    inScope ? c.created : "-",
    inScope ? c.updated : "-",
    inScope ? c.unchanged : "-",
    inScope ? c.adopted : "-",
    inScope ? c.skipped + c.invalid : "-",
    inScope ? c.review : "-",
    inScope ? c.failed : "-",
    r.refsAfter ?? "-",
    r.rowsAfter ?? "-",
    r.auditedCount ?? "-",
    ICON[r.verdict],
  ];
}

export function renderReport(run: ImportRun, meta: { org: string }): string {
  const overall = overallVerdict(run.results);
  const unmatchedTotal = run.results.reduce(
    (n, r) => n + r.unmatched.reduce((m, u) => m + u.count, 0),
    0,
  );
  const lines: string[] = [
    `# Airtable import reconciliation — ${run.startedAt}`,
    ``,
    `- Workspace: \`${meta.org}\`${run.dryRun ? " — **dry run, nothing written** (counts show what a real run would do)" : ""}`,
    `- Scope: ${run.since ? `delta since ${run.since} (full-table reconciliation not applicable)` : "full tables"}`,
    `- Test records: ${run.includeTest ? "included" : "skipped"}`,
    `- **Overall: ${overall.replace(/_/g, " ")}**`,
    `- Unmatched links: ${unmatchedTotal}`,
    ``,
  ];
  if (run.missingDependencies.length)
    lines.push(
      `> Selected tables whose dependencies were not selected (their links may stay unmatched): ` +
        run.missingDependencies.map((m) => `\`${m.key}\` → \`${m.dependsOn}\``).join(", "),
      ``,
    );

  lines.push(
    `## Counts per table`,
    ``,
    `"Importable" = read − skipped (test) − unidentifiable − sent to review. A full import passes when every importable record has an \`external_refs\` row (“refs after”) and nothing failed.`,
    ``,
    mdTable(
      [
        "Table",
        "Target",
        "Read",
        "Importable",
        "Created",
        "Updated",
        "Unchanged",
        "Adopted",
        "Skipped/invalid",
        "Review",
        "Failed",
        "Refs after",
        "Rows after",
        "Audit-time count",
        "Result",
      ],
      run.results.map(summaryRow),
    ),
    ``,
    `## Unmatched links`,
    ``,
  );
  const unmatched = run.results.flatMap((r) =>
    r.unmatched.map((u) => [u.label, u.count, u.sample.join(", ")] as Array<string | number>),
  );
  lines.push(
    unmatched.length
      ? mdTable(["Link", "Records", "Sample Airtable record ids"], unmatched)
      : "_every link resolved_",
    ``,
  );

  for (const r of run.results) {
    lines.push(`## ${r.name} (\`${r.entity}\`) — ${ICON[r.verdict]}`, ``);
    if (r.note) lines.push(r.note, ``);
    if (
      r.outcome === "skipped_pending" ||
      r.outcome === "skipped_by_design" ||
      r.outcome === "not_selected"
    )
      continue;
    const c = r.counters;
    lines.push(
      mdTable(
        ["Metric", "Count"],
        [
          ["Airtable records read", c.read],
          [run.dryRun || r.outcome === "validated" ? "Would create" : "Created", c.created],
          ["Updated", c.updated],
          ["Unchanged", c.unchanged],
          ["Adopted (matched on natural key)", c.adopted],
          ["Duplicates (same row as another record)", c.duplicates],
          ["Skipped (test records)", c.skipped],
          ["Unidentifiable / missing required value", c.invalid],
          ["Ambiguous → sync_reviews", c.review],
          ["Failed writes", c.failed],
          ["Links resolved", r.linksResolved],
        ],
      ),
      ``,
      `Mapper warnings: ${
        Object.entries(r.warnings)
          .map(([k, v]) => `${k} ×${v}`)
          .join(", ") || "none"
      }`,
      ``,
    );
    if (r.createdCustomFields.length)
      lines.push(`Custom fields created: ${r.createdCustomFields.join(", ")}`, ``);
    lines.push(
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
    );
  }
  return lines.join("\n");
}
