import { stripPayload, RAW_PAYLOAD_RETENTION_DAYS } from "@/lib/finance/strip-payload";

/** Daily per-org maintenance. Every effect is injected so the logic is unit-testable. */

export type MaintenanceDeps = {
  now(): Date;
  /** Processed batches older than the cutoff whose payload has not been stripped yet. */
  eligibleBatches(
    cutoffIso: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown }>>;
  saveStripped(id: string, payload: unknown): Promise<void>;
  /** Re-run claim matching for claims that are not matched yet. Returns how many changed. */
  rematchUnresolved(): Promise<number>;
  purgeStaleStaging(): Promise<number>;
};

export type MaintenanceResult = { stripped: number; rematched: number; purgedStaging: number };

const STRIP_PER_RUN = 25;

export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const cutoff = new Date(
    deps.now().getTime() - RAW_PAYLOAD_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  let stripped = 0;
  for (const b of await deps.eligibleBatches(cutoff, STRIP_PER_RUN)) {
    await deps.saveStripped(b.id, stripPayload(b.payload));
    stripped++;
  }
  const rematched = await deps.rematchUnresolved();
  const purgedStaging = await deps.purgeStaleStaging();
  return { stripped, rematched, purgedStaging };
}
