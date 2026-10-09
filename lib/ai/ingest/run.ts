import { chunkText } from "@/lib/ai/ingest/chunk";
import { contentHash, extractText, UnsupportedContentError } from "@/lib/ai/ingest/extract";
import { EmbeddingsError, toVectorLiteral, type Embedder } from "@/lib/ai/embeddings";
import { safeRequest } from "@/lib/net/safe-request";
import { UnsafeUrlError } from "@/lib/net/url-guard";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Ingest one knowledge source: fetch → extract → (skip if unchanged) → chunk → embed → atomically
 * swap chunks via kb_replace_chunks. Returns an outcome; throws only for failures worth retrying.
 */

export const KB_BUCKET = "kb-files";
export const MAX_CHUNKS = 400;
export const MAX_FETCH_BYTES = 10 * 1024 * 1024;

export type SourceRow = {
  id: string;
  org_id: string;
  kind: string;
  name: string;
  url: string | null;
  storage_path: string | null;
  mime_type: string | null;
  status: string;
  content_hash: string | null;
  chunk_count: number;
};

export type IngestOutcome =
  | { state: "ready"; chunks: number; skipped: boolean }
  | { state: "failed"; reason: string };

/** Thrown for a transient failure (network, provider 429/5xx). The queue retries it. */
export class RetryableIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableIngestError";
  }
}

async function load(
  admin: AdminClient,
  source: SourceRow,
): Promise<{ bytes: Uint8Array; mime: string; filename: string | null }> {
  if (source.kind === "url") {
    if (!source.url) throw new UnsupportedContentError("This source has no URL.");
    let res;
    try {
      res = await safeRequest(source.url, {
        headers: { "User-Agent": "PulseKnowledgeBot/1.0", Accept: "text/html,text/plain,application/pdf;q=0.9" },
        maxBytes: MAX_FETCH_BYTES,
        maxRedirects: 3,
        timeoutMs: 15_000,
      });
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new UnsupportedContentError(err.message);
      throw new RetryableIngestError("Could not fetch the page.");
    }
    if (res.status >= 500 || res.status === 429) throw new RetryableIngestError(`The page returned ${res.status}.`);
    if (res.status < 200 || res.status >= 300) throw new UnsupportedContentError(`The page returned ${res.status}.`);
    return { bytes: res.body, mime: res.headers["content-type"] ?? "text/html", filename: null };
  }
  if (!source.storage_path) throw new UnsupportedContentError("This source has no file.");
  const { data, error } = await admin.storage.from(KB_BUCKET).download(source.storage_path);
  if (error || !data) throw new RetryableIngestError("Could not read the uploaded file.");
  return {
    bytes: new Uint8Array(await data.arrayBuffer()),
    mime: source.mime_type ?? data.type ?? "application/octet-stream",
    filename: source.storage_path.split("/").pop() ?? null,
  };
}

export async function ingestSource(
  admin: AdminClient,
  embedder: Embedder,
  source: SourceRow,
): Promise<IngestOutcome> {
  try {
    const loaded = await load(admin, source);
    const { text } = await extractText(loaded);
    if (!text) return { state: "failed", reason: "No readable text was found." };

    const hash = contentHash(text);
    if (source.status === "ready" && source.content_hash === hash && source.chunk_count > 0) {
      return { state: "ready", chunks: source.chunk_count, skipped: true };
    }

    const chunks = chunkText(text);
    if (chunks.length > MAX_CHUNKS) {
      return { state: "failed", reason: `Too large: ${chunks.length} sections (the limit is ${MAX_CHUNKS}). Split it into smaller sources.` };
    }

    const vectors = await embedder.embed(chunks, "document");
    const payload = chunks.map((content, ord) => ({ ord, content, embedding: vectors[ord] }));
    const { error } = await admin.rpc("kb_replace_chunks", {
      p_org_id: source.org_id,
      p_source_id: source.id,
      p_chunks: payload as never,
      p_content_hash: hash,
    });
    if (error) throw new RetryableIngestError(`Saving failed (${error.code ?? "unknown"}).`);
    return { state: "ready", chunks: chunks.length, skipped: false };
  } catch (err) {
    if (err instanceof UnsupportedContentError) return { state: "failed", reason: err.message };
    if (err instanceof EmbeddingsError) {
      if (err.retryable) throw new RetryableIngestError(err.message);
      return { state: "failed", reason: err.message };
    }
    throw err;
  }
}

export { toVectorLiteral };
