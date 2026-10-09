import type { Embedder } from "@/lib/ai/embeddings";
import { toVectorLiteral } from "@/lib/ai/embeddings";
import type { Passage } from "@/lib/ai/types";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Knowledge-base retrieval for Suggested Reply. Org-scoped by the kb_match RPC; groups narrow it
 * further. Weak matches are dropped: an ungrounded passage is worse than none, because the model
 * is told to say "the team will confirm" when the knowledge has no answer.
 */

/** Fallback when a caller has no embedder at hand; retrieveKnowledge uses the embedder's own cutoff. */
export const DEFAULT_MIN_SIMILARITY = 0.3;

export function selectPassages(
  rows: Array<{ chunk_id: string; source_id: string; source_name: string; content: string; similarity: number }>,
  minSimilarity = DEFAULT_MIN_SIMILARITY,
): Passage[] {
  return rows
    .filter((r) => r.similarity >= minSimilarity)
    .map((r) => ({
      chunkId: r.chunk_id,
      sourceId: r.source_id,
      sourceName: r.source_name,
      content: r.content,
      similarity: r.similarity,
    }));
}

export async function retrieveKnowledge(
  admin: AdminClient,
  embedder: Embedder,
  input: { orgId: string; query: string; groupIds?: string[]; limit?: number; minSimilarity?: number },
): Promise<Passage[]> {
  const query = input.query.trim();
  if (!query) return [];
  const [vector] = await embedder.embed([query.slice(0, 2_000)], "query");
  const { data, error } = await admin.rpc("kb_match", {
    p_org_id: input.orgId,
    p_embedding: toVectorLiteral(vector),
    p_group_ids: input.groupIds && input.groupIds.length ? input.groupIds : undefined,
    p_limit: input.limit ?? 5,
  });
  if (error) throw new Error(`kb_match failed (${error.code ?? "unknown"})`);
  return selectPassages(data ?? [], input.minSimilarity ?? embedder.minSimilarity);
}
