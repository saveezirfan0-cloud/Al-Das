/**
 * Migration reconciliation (Phase 11). Pure: takes source counts, the database snapshot
 * (public.reconcile_snapshot) and the importers' run summaries, and decides whether the
 * Airtable / Sanoflow → Pulse migration may be signed off.
 *
 * Output contains counts and ids only. `findPii` is run over every report before it is
 * written (CLAUDE.md rules 10 and 16).
 */

export type SourceCount = {
  source: string; // 'airtable' | 'sanoflow'
  entity: string; // e.g. 'app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB' or 'contact'
  label: string;
  /** Records in the source system at freeze time. */
  total: number;
};

export type RunCounters = {
  read: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  duplicates: number;
  review: number;
  failed: number;
};

export type ImportSummary = {
  source: string;
  entity: string;
  label: string;
  runAt: string;
  dryRun: boolean;
  since: string | null;
  includeTestRecords: boolean;
  counters: RunCounters;
};

export type DbSnapshot = {
  refs: Record<string, number>;
  reviews_open: Record<string, number>;
  reviews_dismissed: Record<string, number>;
  reviews_resolved: Record<string, number>;
  orphan_refs: number;
  refs_to_deleted_contacts: number;
  contacts_live: number;
  contacts_imported: number;
  contacts_without_identifier: number;
  duplicate_alternate_phones: number;
  alternate_phone_is_other_primary: number;
  merge_chains_over_1: number;
};

export type Severity = "blocker" | "warning";
export type Check = { id: string; name: string; ok: boolean; severity: Severity; detail: string };

export type EntityRow = {
  source: string;
  entity: string;
  label: string;
  sourceTotal: number | null;
  imported: number;
  openReviews: number;
  dismissedReviews: number;
  testSkipped: number;
  unidentifiable: number;
  failed: number;
  unaccounted: number | null;
};

export type ReconcileOptions = {
  /** Records allowed to stay unaccounted for (default 0). */
  tolerance?: number;
  /** Open sync_reviews allowed at sign-off (default 0: every ambiguous match must be resolved). */
  allowOpenReviews?: number;
  /** ISO time the source systems were frozen; the latest full/delta run must be after it. */
  freezeAt?: string | null;
};

export type ReconcileResult = { ok: boolean; rows: EntityRow[]; checks: Check[] };

const key = (source: string, entity: string) => `${source}/${entity}`;

/** The most recent real (non-dry-run) summary per source/entity. */
export function latestRealRuns(summaries: ImportSummary[]): Map<string, ImportSummary> {
  const out = new Map<string, ImportSummary>();
  for (const s of summaries) {
    if (s.dryRun) continue;
    const k = key(s.source, s.entity);
    const cur = out.get(k);
    if (!cur || s.runAt > cur.runAt) out.set(k, s);
  }
  return out;
}

/** Sum of every outcome a run can report; must equal what it read. */
export function outcomeTotal(c: RunCounters): number {
  return c.created + c.updated + c.skipped + c.invalid + c.duplicates + c.review + c.failed;
}

export function reconcile(
  sources: SourceCount[],
  db: DbSnapshot,
  summaries: ImportSummary[],
  opts: ReconcileOptions = {},
): ReconcileResult {
  const tolerance = opts.tolerance ?? 0;
  const allowOpen = opts.allowOpenReviews ?? 0;
  const checks: Check[] = [];
  const add = (id: string, name: string, ok: boolean, severity: Severity, detail: string) =>
    checks.push({ id, name, ok, severity, detail });

  const allRuns = summaries.filter((s) => !s.dryRun);
  const runs = latestRealRuns(summaries);

  // Per-entity accounting. A full run's `skipped`/`invalid`/`failed` are not in the database, so they
  // come from the importer summary: every source record must be imported, awaiting review,
  // deliberately skipped (test records) or explained.
  const rows: EntityRow[] = sources.map((s) => {
    const k = key(s.source, s.entity);
    const run = runs.get(k);
    const imported = db.refs[k] ?? 0;
    const open = db.reviews_open[k] ?? 0;
    const dismissed = db.reviews_dismissed[k] ?? 0;
    const testSkipped = run && !run.includeTestRecords ? run.counters.skipped : 0;
    const unidentifiable = run?.counters.invalid ?? 0;
    const failed = run?.counters.failed ?? 0;
    // Resolved reviews either created a ref (counted in `imported`) or were attached to an existing
    // contact; they are not added again.
    const accounted = imported + open + dismissed + testSkipped + unidentifiable + failed;
    return {
      source: s.source,
      entity: s.entity,
      label: s.label,
      sourceTotal: s.total,
      imported,
      openReviews: open,
      dismissedReviews: dismissed,
      testSkipped,
      unidentifiable,
      failed,
      unaccounted: s.total - accounted,
    };
  });

  for (const r of rows) {
    const gap = r.unaccounted ?? 0;
    add(
      `count:${r.source}/${r.entity}`,
      `${r.label}: every source record is accounted for`,
      Math.abs(gap) <= tolerance,
      "blocker",
      `source ${r.sourceTotal} = imported ${r.imported} + open reviews ${r.openReviews} + dismissed ${r.dismissedReviews} + test ${r.testSkipped} + unidentifiable ${r.unidentifiable} + failed ${r.failed}; gap ${gap}${tolerance ? ` (tolerance ${tolerance})` : ""}`,
    );
  }

  // Every source entity needs a real run behind it.
  for (const s of sources) {
    const run = runs.get(key(s.source, s.entity));
    add(
      `run:${s.source}/${s.entity}`,
      `${s.label}: a real (non-dry-run) import exists`,
      !!run,
      "blocker",
      run
        ? `last real run ${run.runAt}${run.since ? ` (delta since ${run.since})` : " (full)"}`
        : "only dry runs or no summary found",
    );
  }

  // Importer self-consistency.
  const inconsistent = allRuns.filter((s) => outcomeTotal(s.counters) !== s.counters.read);
  add(
    "summary:consistent",
    "importer runs account for every record they read",
    inconsistent.length === 0,
    "blocker",
    inconsistent.length
      ? inconsistent
          .map(
            (s) =>
              `${key(s.source, s.entity)} @ ${s.runAt}: read ${s.counters.read} vs outcomes ${outcomeTotal(s.counters)}`,
          )
          .join("; ")
      : `${allRuns.length} run(s) checked`,
  );

  const failedWrites = [...runs.values()].reduce((n, s) => n + s.counters.failed, 0);
  add(
    "failed-writes",
    "no failed writes in the latest run of each entity",
    failedWrites === 0,
    "blocker",
    `${failedWrites} failed`,
  );

  // Freeze / freshness.
  if (opts.freezeAt) {
    const stale = sources.filter((s) => {
      const run = runs.get(key(s.source, s.entity));
      return !run || run.runAt < opts.freezeAt!;
    });
    add(
      "fresh",
      "the latest import of every entity ran after the source freeze",
      stale.length === 0,
      "blocker",
      stale.length
        ? `stale: ${stale.map((s) => key(s.source, s.entity)).join(", ")}`
        : `freeze ${opts.freezeAt}`,
    );
  } else {
    add(
      "fresh",
      "the latest import ran after the source freeze",
      false,
      "warning",
      "no --freeze-at given; cannot prove the delta import covered the freeze window",
    );
  }

  // Database-wide integrity.
  const openTotal = Object.values(db.reviews_open).reduce((a, b) => a + b, 0);
  add(
    "reviews",
    "ambiguous matches resolved (sync_reviews)",
    openTotal <= allowOpen,
    "blocker",
    `${openTotal} open (allowed ${allowOpen})`,
  );
  add(
    "orphan-refs",
    "no external_refs point at a missing contact",
    db.orphan_refs === 0,
    "blocker",
    `${db.orphan_refs} orphan`,
  );
  add(
    "refs-deleted",
    "no external_refs point at a deleted, unmerged contact",
    db.refs_to_deleted_contacts === 0,
    "warning",
    `${db.refs_to_deleted_contacts} found`,
  );
  add(
    "alt-phones",
    "no phone number is shared by two live contacts",
    db.duplicate_alternate_phones === 0 && db.alternate_phone_is_other_primary === 0,
    "blocker",
    `${db.duplicate_alternate_phones} alternate phones on several contacts; ${db.alternate_phone_is_other_primary} equal to another contact's primary phone`,
  );
  add(
    "identifiers",
    "every live contact has a phone, BSUID or Unite PIN",
    db.contacts_without_identifier === 0,
    "warning",
    `${db.contacts_without_identifier} without any`,
  );
  add(
    "merge-chains",
    "merged contacts point at a live contact (no chains)",
    db.merge_chains_over_1 === 0,
    "warning",
    `${db.merge_chains_over_1} chains`,
  );

  const ok = checks.every((c) => c.ok || c.severity === "warning");
  return { ok, rows, checks };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Patterns that must never appear in a report. */
const PII: Array<[string, RegExp]> = [
  ["e-mail address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["phone number", /\+?\d[\d\s().-]{8,}\d/],
  ["long digit run", /\b\d{9,}\b/],
];

/** Reasons (not the matched text) why a report is unsafe to write; empty when clean. */
export function findPii(markdown: string): string[] {
  // Airtable record/table/base ids and ISO timestamps look like digit runs; strip them before scanning.
  const cleaned = markdown
    .replace(/\b(?:app|tbl|rec|fld)[A-Za-z0-9]{10,}\b/g, "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}[:\-]\d{2}[:\-]\d{2}(?:[.\-]\d+)?Z?/g, "")
    .replace(/\d{4}-\d{2}-\d{2}/g, "");
  return PII.filter(([, re]) => re.test(cleaned)).map(([name]) => name);
}

export type SignOff = {
  report: string;
  decision: "GO" | "NO-GO";
  signedBy: Array<{ role: string; name: string; date: string }>;
};

export function renderReport(args: {
  orgSlug: string;
  generatedAt: string;
  result: ReconcileResult;
  db: DbSnapshot;
  freezeAt?: string | null;
}): string {
  const { result, db } = args;
  const mark = (c: Check) => (c.ok ? "PASS" : c.severity === "warning" ? "WARN" : "**FAIL**");
  const lines = [
    `# Migration reconciliation — ${args.generatedAt}`,
    "",
    `- Workspace: \`${args.orgSlug}\``,
    `- Source freeze: ${args.freezeAt ?? "(not provided)"}`,
    `- Result: **${result.ok ? "READY FOR SIGN-OFF" : "NOT READY"}**`,
    "- Counts and ids only. No names, phone numbers or message text appear in this report.",
    "",
    "## Per-entity accounting",
    "",
    "| Source | Entity | Source total | Imported | Open reviews | Dismissed | Test skipped | Unidentifiable | Failed | Unaccounted |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...result.rows.map(
      (r) =>
        `| ${r.source} | ${r.label} (\`${r.entity}\`) | ${r.sourceTotal ?? "?"} | ${r.imported} | ${r.openReviews} | ${r.dismissedReviews} | ${r.testSkipped} | ${r.unidentifiable} | ${r.failed} | ${r.unaccounted ?? "?"} |`,
    ),
    "",
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...result.checks.map((c) => `| ${c.name} | ${mark(c)} | ${c.detail} |`),
    "",
    "## Database",
    "",
    `- Live contacts: ${db.contacts_live} (imported: ${db.contacts_imported})`,
    "",
    "## Sign-off",
    "",
    "Complete by editing `docs/audit/reconciliation-signoff.json` (see docs/06_PHASE_11_CUTOVER.md); `pnpm cutover:preflight` reads it.",
    "",
    "| Role | Name | Date | Decision (GO / NO-GO) |",
    "|---|---|---|---|",
    "| Operations lead | | | |",
    "| Clinical lead | | | |",
    "| Engineering | | | |",
    "",
  ];
  return lines.join("\n");
}

/** Validates the human sign-off file against a report. Returns blocking problems. */
export function checkSignOff(
  signoff: unknown,
  latestReport: string,
  requiredRoles: string[],
): string[] {
  const problems: string[] = [];
  const s = signoff as Partial<SignOff> | null;
  if (!s || typeof s !== "object") return ["sign-off file missing or not an object"];
  if (s.report !== latestReport)
    problems.push(`sign-off is for "${s.report ?? "?"}", not the latest report "${latestReport}"`);
  if (s.decision !== "GO") problems.push(`decision is "${s.decision ?? "none"}", not GO`);
  const have = new Set((s.signedBy ?? []).filter((x) => x?.name && x?.date).map((x) => x.role));
  for (const role of requiredRoles)
    if (!have.has(role)) problems.push(`missing signature: ${role}`);
  return problems;
}

export const REQUIRED_SIGNOFF_ROLES = ["Operations lead", "Clinical lead", "Engineering"] as const;
