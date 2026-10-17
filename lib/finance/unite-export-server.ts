import type { ProcessResult } from "@/lib/finance/process-batch";
import {
  parseUniteExport,
  UniteExportError,
  validPulledOn,
  type ExportChunk,
} from "@/lib/finance/unite-export";

/**
 * Stores a saved Unite pull as raw batches (source 'file'), THEN processes them with the unchanged processBatch.
 * Effects are injected so this is testable without a database. Never touches the Unite client (rule 7).
 *
 * Order (never reordered): parse -> look up each chunk by hash -> insert every missing chunk -> process in order,
 * stopping at the first failure (later chunks stay 'received' for `pnpm finance:replay`).
 */

export type StoredChunk = { id: string; processStatus: string };

export type RawFileBatchInsert = {
  requested_at: string;
  from_date: string;
  to_date: string;
  count_requested: number;
  http_status: number;
  message_status: string | null;
  detail_message: string | null;
  balance_in_range: null;
  balance_overall: null;
  record_count: number;
  payload: unknown;
  payload_sha256: string;
  source: "file";
  file_name: string | null;
  uploaded_by: string | null;
};

export type ExportDeps = {
  findBySha(sha256: string): Promise<StoredChunk | null>;
  insertRaw(row: RawFileBatchInsert): Promise<string>;
  processBatch(batchId: string): Promise<ProcessResult>;
};

export type ExportResult = {
  records: number;
  chunks: number;
  storedNow: number;
  alreadyStored: number;
  processedNow: number;
  alreadyProcessed: number;
  /** Chunks left unprocessed because an earlier one failed. */
  notProcessed: number;
  failed: { chunk: number; error: string } | null;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.slice(0, 500) : null);

export async function storeAndProcessUniteExport(
  deps: ExportDeps,
  input: {
    text: string;
    pulledOn: string;
    today: string;
    nowIso: string;
    fileName: string | null;
    userId: string | null;
  },
): Promise<ExportResult> {
  const pulledOn = validPulledOn(input.pulledOn, input.today);
  if (!pulledOn)
    throw new UniteExportError(
      "Enter the date this export was pulled from Unite (not in the future).",
    );
  const { chunks, totalRecords } = parseUniteExport(input.text);
  // older than any later API data, so those win (staleness rule); never in the future (the org's today can be
  // tomorrow in UTC)
  const startOfDay = `${pulledOn}T00:00:00Z`;
  const requestedAt = startOfDay < input.nowIso ? startOfDay : input.nowIso;

  // identical chunks inside one file would clash on the unique hash: keep the first
  const seen = new Set<string>();
  const unique: ExportChunk[] = chunks.filter((c) => !seen.has(c.sha256) && seen.add(c.sha256));

  const res: ExportResult = {
    records: totalRecords,
    chunks: unique.length,
    storedNow: 0,
    alreadyStored: 0,
    processedNow: 0,
    alreadyProcessed: 0,
    notProcessed: 0,
    failed: null,
  };

  // 1. store everything first
  const stored: StoredChunk[] = [];
  for (const chunk of unique) {
    const existing = await deps.findBySha(chunk.sha256);
    if (existing) {
      res.alreadyStored++;
      stored.push(existing);
      continue;
    }
    const id = await deps.insertRaw({
      requested_at: requestedAt,
      from_date: pulledOn,
      to_date: pulledOn,
      count_requested: chunk.recordCount,
      http_status: 200,
      message_status: str(chunk.payload.MessageStatus),
      detail_message: str(chunk.payload.DetailMessage),
      balance_in_range: null,
      balance_overall: null,
      record_count: chunk.recordCount,
      payload: chunk.payload,
      payload_sha256: chunk.sha256,
      source: "file",
      file_name: input.fileName ? input.fileName.slice(0, 200) : null,
      uploaded_by: input.userId,
    });
    res.storedNow++;
    stored.push({ id, processStatus: "received" });
  }

  // 2. then process, in order, stopping at the first failure
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    if (s.processStatus === "processed") {
      res.alreadyProcessed++;
      continue;
    }
    if (res.failed) {
      res.notProcessed++;
      continue;
    }
    const out = await deps.processBatch(s.id);
    if (out.ok) res.processedNow++;
    else {
      res.failed = { chunk: i + 1, error: out.error };
      res.notProcessed++;
    }
  }
  return res;
}
