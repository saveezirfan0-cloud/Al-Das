import { aiEnv } from "@/lib/env";
import { AiNotConfiguredError } from "@/lib/ai/types";

/**
 * Text → 1024-d vectors for kb_chunks.embedding vector(1024). Anthropic has no embeddings endpoint,
 * so the default provider is Voyage AI (voyage-3, 1024 dimensions). The provider sits behind this
 * interface so it can be swapped without touching ingestion or retrieval.
 */

export const EMBEDDING_DIMENSIONS = 1024;

export type EmbedKind = "document" | "query";

export interface Embedder {
  readonly name: string;
  /**
   * Cosine similarity below which a passage is treated as unrelated. Scales differ by model, so the
   * cutoff belongs to the embedder: tune it per provider against real clinic content.
   */
  readonly minSimilarity: number;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export class EmbeddingsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingsError";
  }
}

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_BATCH = 64;

export function createVoyageEmbedder(opts: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Embedder {
  const model = opts.model ?? "voyage-3";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: `voyage:${model}`,
    minSimilarity: 0.3,
    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
        const batch = texts.slice(i, i + VOYAGE_BATCH);
        let res: Response;
        try {
          res = await doFetch(VOYAGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
            body: JSON.stringify({ input: batch, model, input_type: kind }),
          });
        } catch {
          throw new EmbeddingsError("Could not reach the embeddings service.", true);
        }
        if (!res.ok) {
          // status only: the body may echo document text
          throw new EmbeddingsError(
            `The embeddings service returned ${res.status}.`,
            res.status === 429 || res.status >= 500,
          );
        }
        const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
        const rows = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
        if (rows.length !== batch.length) throw new EmbeddingsError("The embeddings service returned an unexpected result.", false);
        for (const r of rows) {
          if (r.embedding.length !== EMBEDDING_DIMENSIONS) {
            throw new EmbeddingsError(
              `Expected ${EMBEDDING_DIMENSIONS}-dimension embeddings but the model returned ${r.embedding.length}. Check EMBEDDINGS_MODEL.`,
              false,
            );
          }
          out.push(r.embedding);
        }
      }
      return out;
    },
  };
}

/** FNV-1a, for the deterministic fake embedder. */
function fnv(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words vectors: texts that share words have high cosine similarity. For local
 * development and tests only, so the whole KB flow can be exercised without a provider key.
 */
export function createFakeEmbedder(): Embedder {
  return {
    name: "fake",
    // Bag-of-words cosine is low even for good matches (a short question vs a long paragraph).
    minSimilarity: 0.1,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[fnv(w) % EMBEDDING_DIMENSIONS] += 1;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

export function embedderFromEnv(): Embedder {
  const env = aiEnv();
  if (env.EMBEDDINGS_PROVIDER === "fake") {
    if (process.env.NODE_ENV === "production") {
      throw new AiNotConfiguredError("A real embeddings provider (EMBEDDINGS_PROVIDER=fake is for development only; it)");
    }
    return createFakeEmbedder();
  }
  if (!env.EMBEDDINGS_API_KEY) throw new AiNotConfiguredError("The embeddings provider (EMBEDDINGS_API_KEY)");
  return createVoyageEmbedder({ apiKey: env.EMBEDDINGS_API_KEY, model: env.EMBEDDINGS_MODEL });
}

/** pgvector text literal: '[0.1,0.2,...]' (supabase-js sends vectors as strings). */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
