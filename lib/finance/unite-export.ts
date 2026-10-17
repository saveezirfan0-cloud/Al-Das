import { createHash } from "node:crypto";

import { invalidInvoiceCount, uniteFinanceResponseSchema } from "@/lib/finance/unite-payload";

/**
 * The saved Unite pull (a file) as raw batches. Pure: text in, chunks out. Nothing here calls Unite or a database
 * (CLAUDE.md rule 7). A file is accepted as one response envelope `{ "Data": [...] }` or a bare array of invoice records;
 * it is split into chunks of at most CHUNK_SIZE records so one fin_apply_invoices call never gets thousands of invoices.
 */

export const MAX_EXPORT_BYTES = 25 * 1024 * 1024;
export const CHUNK_SIZE = 200;

/** Safe to show a user: never carries record content. */
export class UniteExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniteExportError";
  }
}

export type ExportChunk = {
  payload: Record<string, unknown>;
  recordCount: number;
  sha256: string;
};

export type ParsedExport = { chunks: ExportChunk[]; totalRecords: number };

export const payloadSha256 = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

export function parseUniteExport(text: string): ParsedExport {
  if (Buffer.byteLength(text) > MAX_EXPORT_BYTES)
    throw new UniteExportError("The file is larger than 25 MB.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UniteExportError("The file is not valid JSON.");
  }

  let envelope: Record<string, unknown>;
  if (Array.isArray(json)) envelope = { MessageStatus: "file", Data: json };
  else if (json && typeof json === "object" && Array.isArray((json as { Data?: unknown }).Data))
    envelope = json as Record<string, unknown>;
  else
    throw new UniteExportError(
      "Expected a Unite response with a Data list, or a plain list of invoice records.",
    );

  const data = envelope.Data as unknown[];
  if (data.length === 0) throw new UniteExportError("The file holds no invoice records.");
  // same shape check as an API answer (envelope + every record has an invoice number)
  const bad = invalidInvoiceCount(envelope);
  if (bad > 0 || !uniteFinanceResponseSchema.safeParse(envelope).success)
    throw new UniteExportError(
      bad > 0
        ? `${bad} record(s) have no invoice number or are not objects. Nothing was stored.`
        : "The file does not match the Unite response shape. Nothing was stored.",
    );

  const chunks: ExportChunk[] = [];
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const part = data.slice(i, i + CHUNK_SIZE);
    const payload = { ...envelope, Data: part };
    chunks.push({ payload, recordCount: part.length, sha256: payloadSha256(payload) });
  }
  return { chunks, totalRecords: data.length };
}

/** yyyy-mm-dd that is a real calendar date and not after `today`; null otherwise. */
export function validPulledOn(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return value <= today ? value : null;
}
