import { createHash } from "node:crypto";

import type { RawBatchInsert } from "@/lib/finance/capture";
import { mapBatch } from "@/lib/finance/map-invoice";
import { invalidInvoiceCount, uniteFinanceResponseSchema } from "@/lib/finance/unite-payload";

/**
 * Loading an export of the Unite Finance API that the clinic saved earlier (W1, docs/47_W1_LOAD_EXPORT_NOTES.md).
 *
 * The API is deliver-once, so that file is the only copy of those records: they can never reach Pulse's own capture.
 * They go in as raw batches (`fin_raw_unite_batches`, stored first, untouched) and are then processed by the same
 * `processBatch` as everything else. This module is pure and never talks to Unite; it only reads a file's text.
 */

export class LoadExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadExportError";
  }
}

/** The API's own largest page; also keeps one `fin_apply_invoices` call small. */
export const LOAD_CHUNK_SIZE = 500;
export const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

export type ExportChunk = {
  /** Envelope holding this chunk's records exactly as received, plus the envelope's own status fields. */
  payload: Record<string, unknown>;
  records: number;
  sha256: string;
};

export type ParsedExport = { fileSha256: string; records: number; chunks: ExportChunk[] };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Accepts the response envelope (`{ Data: [...] }`) or a bare array of invoices. Errors never echo file content. */
export function readSavedExport(bytes: Buffer): ParsedExport {
  if (bytes.length === 0) throw new LoadExportError("The file is empty.");
  if (bytes.length > MAX_EXPORT_BYTES) throw new LoadExportError("The file is larger than 200 MB.");

  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new LoadExportError(
      "The file is not valid JSON. Load the file exactly as Unite delivered it, not a copy re-typed in Excel.",
    );
  }

  const envelope = (
    Array.isArray(json) ? { Data: json } : json && typeof json === "object" ? json : null
  ) as Record<string, unknown> | null;
  const data = envelope?.Data;
  if (!envelope || !Array.isArray(data))
    throw new LoadExportError("No invoice list (Data) was found in the file.");
  if (!uniteFinanceResponseSchema.safeParse(envelope).success)
    throw new LoadExportError(
      `${invalidInvoiceCount(envelope)} invoice(s) have no invoice number; nothing was loaded.`,
    );

  const status = { ...envelope };
  delete status.Data;
  const chunks: ExportChunk[] = [];
  for (let p = 0; p < Math.max(1, Math.ceil(data.length / LOAD_CHUNK_SIZE)); p++) {
    const part = data.slice(p * LOAD_CHUNK_SIZE, (p + 1) * LOAD_CHUNK_SIZE);
    const payload = { ...status, Data: part };
    chunks.push({ payload, records: part.length, sha256: sha256(JSON.stringify(payload)) });
  }
  return { fileSha256: sha256(bytes), records: data.length, chunks };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The date range the person says the file covers (the API reports none back). */
export function checkRange(from: string, to: string): void {
  if (
    !DAY.test(from) ||
    !DAY.test(to) ||
    Number.isNaN(Date.parse(from)) ||
    Number.isNaN(Date.parse(to))
  )
    throw new LoadExportError("Give the date range as --from=YYYY-MM-DD --to=YYYY-MM-DD.");
  if (to < from) throw new LoadExportError("--to is before --from.");
}

/**
 * The `fin_raw_unite_batches` row for one chunk. The queue balances Unite reported when the file was pulled stay inside
 * the stored payload; the balance columns describe a live pull, so they stay empty here.
 */
export function rawRowFor(
  chunk: ExportChunk,
  fileSha256: string,
  part: number,
  parts: number,
  range: { from: string; to: string },
): RawBatchInsert {
  return {
    from_date: range.from,
    to_date: range.to,
    count_requested: Math.max(chunk.records, 1),
    http_status: 200,
    message_status: "Loaded from a saved export",
    detail_message: `saved export ${fileSha256.slice(0, 12)} part ${part}/${parts}`,
    balance_in_range: null,
    balance_overall: null,
    record_count: chunk.records,
    payload: chunk.payload,
    payload_sha256: chunk.sha256,
  };
}

export type MonthTotal = { month: string; invoices: number; totalCents: number };

/**
 * Invoices and their `total` per month, for the person to compare with the collection report. Uses the same mapper as
 * processing, so a mapping problem shows here exactly as it would there. A re-sent invoice counts once (the last one).
 */
export function monthTotals(chunks: readonly ExportChunk[]): MonthTotal[] {
  const latest = new Map<string, { date: string; cents: number }>();
  for (const c of chunks) {
    for (const inv of mapBatch(c.payload.Data as unknown[]).invoices)
      latest.set(inv.inv_display_number, {
        date: inv.transaction_date,
        cents: inv.is_deleted ? 0 : Math.round(inv.total * 100),
      });
  }
  const months = new Map<string, MonthTotal>();
  for (const { date, cents } of latest.values()) {
    const m = months.get(date.slice(0, 7)) ?? {
      month: date.slice(0, 7),
      invoices: 0,
      totalCents: 0,
    };
    m.invoices += 1;
    m.totalCents += cents;
    months.set(m.month, m);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}
