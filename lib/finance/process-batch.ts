import { mapBatch, MappingError, type NormalizedInvoice } from "@/lib/finance/map-invoice";
import { uniteFinanceResponseSchema } from "@/lib/finance/unite-payload";

/**
 * Raw batch -> fin_* tables. Reads ONLY from the stored raw payload, so any
 * batch can be (re)processed at any time: this is both the normal path and the
 * replay path. A failure marks the batch failed (E09) and leaves the raw
 * payload untouched.
 */

export type ApplyCounts = Record<string, number>;

export type ProcessDeps = {
  loadBatch(
    batchId: string,
  ): Promise<{ id: string; orgId: string; payload: unknown; recordCount: number | null } | null>;
  apply(orgId: string, batchId: string, invoices: NormalizedInvoice[]): Promise<ApplyCounts>;
  markFailed(batchId: string, error: string): Promise<void>;
};

export type ProcessResult = { ok: true; counts: ApplyCounts } | { ok: false; error: string };

function describe(err: unknown): string {
  if (err instanceof MappingError) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return "unknown error";
}

export async function processBatch(deps: ProcessDeps, batchId: string): Promise<ProcessResult> {
  const batch = await deps.loadBatch(batchId);
  if (!batch) return { ok: false, error: "batch not found" };

  try {
    if (batch.payload === null || batch.payload === undefined)
      throw new Error("raw payload is empty (stripped or never stored); cannot process");
    const parsed = uniteFinanceResponseSchema.safeParse(batch.payload);
    if (!parsed.success) throw new Error("payload does not match the Unite response envelope");
    // Map from the original payload, not the parsed copy, so nothing Unite sent is dropped.
    const data = (batch.payload as { Data?: unknown }).Data;
    const records = Array.isArray(data) ? data : [];
    const invoices = mapBatch(records);
    const counts = await deps.apply(batch.orgId, batch.id, invoices);
    return { ok: true, counts };
  } catch (err) {
    const error = describe(err);
    await deps.markFailed(batch.id, error);
    return { ok: false, error };
  }
}
