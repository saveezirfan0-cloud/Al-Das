import { createHash } from "node:crypto";

import { diffClaims, looksFiltered, type ClaimDiff } from "@/lib/finance/diff-claims";
import { normalizeInvoiceNumber } from "@/lib/finance/keys";
import {
  matchClaims,
  type ClaimToMatch,
  type InvoiceCandidate,
  type MatchResult,
} from "@/lib/finance/match-claims";
import {
  parseDiligenceTable,
  readXlsxTable,
  type ClaimRow,
  type HeaderReport,
  type ParseStats,
  type ValidationError,
} from "@/lib/finance/parse-diligence";

/**
 * Diligence import workflow: stage -> preview -> commit (+ matching). All persistence goes through
 * `DiligenceStore`, so the workflow is testable against any backend. The uploaded file's bytes are
 * never kept: only the sanitised, validated rows are staged.
 */

export type FileStatus = "validated" | "committed" | "rejected";
export type FileRow = {
  id: string;
  status: FileStatus;
  uploadedAt: string;
  rowCount: number | null;
};

export type DiligenceStore = {
  findFileBySha(orgId: string, sha: string): Promise<FileRow | null>;
  createFile(
    orgId: string,
    f: { storagePath: string; fileName: string; sha: string; userId: string },
  ): Promise<string>;
  /** Clears staged rows and errors of a previously rejected file so the same bytes can be retried. */
  resetFile(
    orgId: string,
    fileId: string,
    f: { storagePath: string; fileName: string; userId: string },
  ): Promise<void>;
  updateFile(
    fileId: string,
    patch: {
      status?: FileStatus;
      rowCount?: number;
      sumNet?: number;
      sumRemitted?: number;
      sumRejected?: number;
      headerCheck?: unknown;
      errors?: unknown;
    },
  ): Promise<void>;
  stageRows(
    orgId: string,
    fileId: string,
    rows: Array<{ row_no: number; claim_activity_number: string; data: ClaimRow }>,
  ): Promise<void>;
  loadFile(
    orgId: string,
    fileId: string,
  ): Promise<
    | (FileRow & {
        fileName: string | null;
        headerCheck: unknown;
        errors: unknown;
        sumNet: number | null;
        sumRemitted: number | null;
        sumRejected: number | null;
      })
    | null
  >;
  loadStaged(orgId: string, fileId: string): Promise<ClaimRow[]>;
  existingClaims(orgId: string, numbers: string[]): Promise<Map<string, Partial<ClaimRow>>>;
  lastCommittedFile(orgId: string, excludeFileId: string): Promise<{ id: string } | null>;
  claimNumbersSeenInFile(orgId: string, fileId: string): Promise<string[]>;
  openException(
    orgId: string,
    rule: string,
    entityType: string,
    key: string,
    detail: Record<string, unknown>,
  ): Promise<void>;
  commit(args: {
    orgId: string;
    fileId: string;
    userId: string;
    rows: ClaimRow[];
    events: Array<{ claim_activity_number: string; changed_fields: unknown }>;
    seen: string[];
    missing: string[];
    raiseMissing: boolean;
  }): Promise<Record<string, number>>;
  discard(orgId: string, fileId: string, reason: string): Promise<void>;
  /** One page of claims to (re)match, ordered by id, strictly after `afterId` (keyset paging). */
  claimsForMatching(
    orgId: string,
    scope: MatchScope,
    afterId: string | null,
    limit: number,
  ): Promise<ClaimToMatch[]>;
  invoicesByKeys(orgId: string, keys: string[]): Promise<InvoiceCandidate[]>;
  applyMatches(orgId: string, matches: MatchResult[]): Promise<number>;
};

export type MatchScope = { kind: "unresolved" } | { kind: "file"; fileId: string };

export type StageOutcome =
  | { status: "duplicate"; fileId: string; committedAt: string }
  | {
      status: "rejected";
      fileId: string;
      errors: ValidationError[];
      totalErrors: number;
      header: HeaderReport;
    }
  | { status: "staged"; fileId: string; header: HeaderReport; stats: ParseStats };

export async function stageDiligenceUpload(
  store: DiligenceStore,
  input: { orgId: string; userId: string; fileName: string; storagePath: string; buffer: Buffer },
): Promise<StageOutcome> {
  const sha = createHash("sha256").update(input.buffer).digest("hex");
  const existing = await store.findFileBySha(input.orgId, sha);
  if (existing?.status === "committed")
    return { status: "duplicate", fileId: existing.id, committedAt: existing.uploadedAt };
  if (existing?.status === "validated") {
    const stats = await previewStats(store, input.orgId, existing.id);
    return { status: "staged", fileId: existing.id, header: stats.header, stats: stats.stats };
  }

  let fileId: string;
  if (existing) {
    fileId = existing.id;
    await store.resetFile(input.orgId, fileId, {
      storagePath: input.storagePath,
      fileName: input.fileName,
      userId: input.userId,
    });
  } else {
    fileId = await store.createFile(input.orgId, {
      storagePath: input.storagePath,
      fileName: input.fileName,
      sha,
      userId: input.userId,
    });
  }

  let table: unknown[][];
  try {
    table = await readXlsxTable(input.buffer);
  } catch {
    return reject(
      store,
      input.orgId,
      fileId,
      [{ row: null, code: "unreadable_file" }],
      1,
      emptyHeader(),
    );
  }
  const parsed = parseDiligenceTable(table);
  if (!parsed.ok)
    return reject(store, input.orgId, fileId, parsed.errors, parsed.totalErrors, parsed.header);

  await store.stageRows(
    input.orgId,
    fileId,
    parsed.rows.map((data, i) => ({
      row_no: i + 2,
      claim_activity_number: data.claim_activity_number,
      data,
    })),
  );
  await store.updateFile(fileId, {
    status: "validated",
    rowCount: parsed.stats.rows,
    sumNet: parsed.stats.sumNet,
    sumRemitted: parsed.stats.sumRemitted,
    sumRejected: parsed.stats.sumRejected,
    headerCheck: parsed.header,
    errors: [],
  });
  return { status: "staged", fileId, header: parsed.header, stats: parsed.stats };
}

const emptyHeader = (): HeaderReport => ({
  recognised: 0,
  missingRequired: [],
  missingOptional: [],
  unrecognised: [],
  droppedSensitive: [],
  duplicateHeaders: [],
});

async function reject(
  store: DiligenceStore,
  orgId: string,
  fileId: string,
  errors: ValidationError[],
  totalErrors: number,
  header: HeaderReport,
): Promise<StageOutcome> {
  await store.updateFile(fileId, { status: "rejected", headerCheck: header, errors });
  await store.openException(orgId, "E10", "file", fileId, {
    error_count: totalErrors,
    codes: [...new Set(errors.map((e) => e.code))],
  });
  return { status: "rejected", fileId, errors, totalErrors, header };
}

export type Preview = {
  fileId: string;
  fileName: string | null;
  status: FileStatus;
  header: HeaderReport;
  stats: ParseStats;
  counts: { new: number; changed: number; unchanged: number; missing: number };
  changedFieldCounts: Record<string, number>;
  sampleChanges: Array<{ claim_activity_number: string; fields: string[] }>;
  previousFileId: string | null;
  looksFiltered: boolean;
};

function statsOf(rows: ClaimRow[]): ParseStats {
  const dates = rows
    .map((r) => r.transaction_date)
    .filter((d): d is string => !!d)
    .sort();
  const sum = (k: "net" | "remitted" | "rejected") =>
    Math.round(rows.reduce((a, r) => a + (r[k] ?? 0), 0) * 100) / 100;
  return {
    rows: rows.length,
    minTransactionDate: dates[0] ?? null,
    maxTransactionDate: dates.at(-1) ?? null,
    sumNet: sum("net"),
    sumRemitted: sum("remitted"),
    sumRejected: sum("rejected"),
  };
}

async function previewStats(store: DiligenceStore, orgId: string, fileId: string) {
  const file = await store.loadFile(orgId, fileId);
  const rows = await store.loadStaged(orgId, fileId);
  return { stats: statsOf(rows), header: (file?.headerCheck as HeaderReport) ?? emptyHeader() };
}

async function computeDiff(store: DiligenceStore, orgId: string, fileId: string, rows: ClaimRow[]) {
  const existing = await store.existingClaims(
    orgId,
    rows.map((r) => r.claim_activity_number),
  );
  const previous = await store.lastCommittedFile(orgId, fileId);
  const previousNumbers = previous ? await store.claimNumbersSeenInFile(orgId, previous.id) : [];
  return {
    diff: diffClaims(existing, rows, previousNumbers),
    previous,
    previousCount: previousNumbers.length,
  };
}

export async function buildPreview(
  store: DiligenceStore,
  orgId: string,
  fileId: string,
): Promise<Preview | null> {
  const file = await store.loadFile(orgId, fileId);
  if (!file) return null;
  const rows = await store.loadStaged(orgId, fileId);
  const { diff, previous, previousCount } = await computeDiff(store, orgId, fileId, rows);
  return {
    fileId,
    fileName: file.fileName,
    status: file.status,
    header: (file.headerCheck as HeaderReport) ?? emptyHeader(),
    stats: statsOf(rows),
    counts: {
      new: diff.newRows.length,
      changed: diff.changed.length,
      unchanged: diff.unchanged.length,
      missing: diff.missing.length,
    },
    changedFieldCounts: diff.changedFieldCounts,
    sampleChanges: diff.changed.slice(0, 20).map((c) => ({
      claim_activity_number: c.row.claim_activity_number,
      fields: Object.keys(c.changes),
    })),
    previousFileId: previous?.id ?? null,
    looksFiltered: looksFiltered(diff.missing.length, previousCount),
  };
}

export type CommitOutcome = {
  summary: Record<string, number>;
  diff: Pick<ClaimDiff, "changedFieldCounts">;
  matched: { examined: number; changed: number };
};

export async function commitImport(
  store: DiligenceStore,
  input: { orgId: string; userId: string; fileId: string; raiseMissing: boolean },
): Promise<CommitOutcome> {
  const file = await store.loadFile(input.orgId, input.fileId);
  if (!file) throw new Error("file not found");
  if (file.status !== "validated")
    throw new Error(`file is ${file.status} and cannot be committed`);
  const rows = await store.loadStaged(input.orgId, input.fileId);
  if (rows.length === 0)
    throw new Error("no staged rows (the preview expired); upload the file again");
  const { diff } = await computeDiff(store, input.orgId, input.fileId, rows);

  const summary = await store.commit({
    orgId: input.orgId,
    fileId: input.fileId,
    userId: input.userId,
    rows: [...diff.newRows, ...diff.changed.map((c) => c.row)],
    events: diff.changed.map((c) => ({
      claim_activity_number: c.row.claim_activity_number,
      changed_fields: c.changes,
    })),
    seen: rows.map((r) => r.claim_activity_number),
    missing: diff.missing,
    raiseMissing: input.raiseMissing,
  });

  const matched = await matchClaimsForOrg(store, input.orgId, {
    kind: "file",
    fileId: input.fileId,
  });
  return { summary, diff: { changedFieldCounts: diff.changedFieldCounts }, matched };
}

export async function discardImport(store: DiligenceStore, orgId: string, fileId: string) {
  await store.discard(orgId, fileId, "discarded");
}

const MATCH_PAGE = 500;

/** Match (or re-match) claims against current invoices and lines. Idempotent. */
export async function matchClaimsForOrg(
  store: DiligenceStore,
  orgId: string,
  scope: MatchScope,
): Promise<{ examined: number; changed: number }> {
  let examined = 0;
  let changed = 0;
  let afterId: string | null = null;
  for (;;) {
    const claims = await store.claimsForMatching(orgId, scope, afterId, MATCH_PAGE);
    if (claims.length === 0) break;
    const keys = [
      ...new Set(claims.map((c) => normalizeInvoiceNumber(c.invoice_no)).filter(Boolean)),
    ];
    const invoices = await store.invoicesByKeys(orgId, keys);
    changed += await store.applyMatches(orgId, matchClaims(claims, invoices));
    examined += claims.length;
    afterId = claims[claims.length - 1].id;
    if (claims.length < MATCH_PAGE) break;
  }
  return { examined, changed };
}
