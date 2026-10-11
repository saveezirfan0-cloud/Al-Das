import { z } from "zod";

import { embedderFromEnv } from "@/lib/ai/embeddings";
import { ingestSource, RetryableIngestError, type SourceRow } from "@/lib/ai/ingest/run";
import { AiNotConfiguredError } from "@/lib/ai/types";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `kb_ingest` queue: { source_id } → fetch / read the source, embed it, swap its chunks.
 * One source per message. Idempotent: unchanged content is detected by hash and not re-embedded,
 * and the chunk swap is a single transaction. Document text is never logged.
 */
const job = z.object({ source_id: z.string().uuid() });

const MAX_READS = 5;

registerHandler({
  queue: "kb_ingest",
  name: "kb_ingest.source",
  batchSize: 5,
  visibilityTimeout: 120,
  maxReads: MAX_READS,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid kb_ingest job payload");
    const { admin, log } = ctx;

    const { data: source } = await admin
      .from("kb_sources")
      .select("id, org_id, kind, name, url, storage_path, mime_type, status, content_hash, chunk_count")
      .eq("id", parsed.data.source_id)
      .maybeSingle();
    if (!source) return; // deleted while queued

    const fail = async (reason: string) => {
      await admin.from("kb_sources").update({ status: "failed", error: reason.slice(0, 300) }).eq("id", source.id);
    };

    await admin.from("kb_sources").update({ status: "processing", error: null }).eq("id", source.id);

    let embedder;
    try {
      embedder = embedderFromEnv();
    } catch (err) {
      await fail(err instanceof AiNotConfiguredError ? err.message : "Embeddings are not configured.");
      return;
    }

    try {
      const outcome = await ingestSource(admin, embedder, source as SourceRow);
      if (outcome.state === "failed") {
        await fail(outcome.reason);
        log.warn("kb source failed", { sourceId: source.id, orgId: source.org_id });
        return;
      }
      if (outcome.skipped) {
        await admin
          .from("kb_sources")
          .update({ status: "ready", error: null, last_ingested_at: new Date().toISOString() })
          .eq("id", source.id);
      }
      log.info("kb source ingested", { sourceId: source.id, chunks: outcome.chunks, skipped: outcome.skipped });
    } catch (err) {
      if (err instanceof RetryableIngestError) {
        if (ctx.readCt < MAX_READS) throw err; // the queue retries after the visibility timeout
        await fail(err.message); // out of attempts: surface it on the source instead of leaving it "processing"
        return;
      }
      await fail("Unexpected error while processing.");
      throw err;
    }
  },
});
