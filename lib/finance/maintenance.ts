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
  /** Runs the exception rules (idempotent). */
  runRules(): Promise<unknown>;
  /** Queues the daily digest e-mails when enabled. Returns how many were queued. */
  sendDigest(): Promise<number>;
};

export type MaintenanceResult = {
  stripped: number;
  rematched: number;
  purgedStaging: number;
  rules: unknown;
  digests: number;
};

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
  // matching first so the rules see fresh match reasons; digest last so it reflects the rules
  const rules = await deps.runRules();
  const digests = await deps.sendDigest();
  return { stripped, rematched, purgedStaging, rules, digests };
}
