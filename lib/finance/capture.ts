import { createHash } from "node:crypto";

import { UniteCallError, type FinanceCall, type FinanceRequest } from "@/lib/unite/client";
import type { ProcessResult } from "@/lib/finance/process-batch";

/**
 * One capture run for one org. Every effect is injected so the whole flow is
 * testable without the network or a database.
 *
 * Order of operations per batch (never reordered):
 *   1. call Unite                (records are now dequeued on Unite's side)
 *   2. INSERT the raw payload    (3 attempts; the only copy until it is stored)
 *   3. process from raw          (idempotent; failure keeps the raw row)
 * Capture stops, rather than pulling more records, whenever step 2 or 3 fails.
 */

export type CaptureSettings = {
  enabled: boolean;
  batchSize: number;
  windowFrom: string; // yyyy-mm-dd
  maxBatchesPerRun: number;
};

export type RawBatchInsert = {
  from_date: string;
  to_date: string;
  count_requested: number;
  http_status: number;
  message_status: string | null;
  detail_message: string | null;
  balance_in_range: number | null;
  balance_overall: number | null;
  record_count: number | null;
  payload: unknown;
  payload_sha256: string;
};

export type CaptureDeps = {
  loadSettings(): Promise<CaptureSettings | null>;
  tryLease(holder: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(holder: string): Promise<void>;
  /** yyyy-mm-dd in the org timezone. */
  today(): string;
  financeDetails(req: FinanceRequest): Promise<FinanceCall>;
  insertRaw(row: RawBatchInsert): Promise<string>;
  /** Raw batches not yet processed (received or failed), oldest first. */
  pendingBatchIds(): Promise<string[]>;
  processBatch(batchId: string): Promise<ProcessResult>;
  /** Opens an E09 exception keyed on the reason; must be idempotent and never include patient data. */
  raiseCritical(reason: CriticalReason, detail: Record<string, unknown>): Promise<void>;
  markBatchFailed(batchId: string, error: string): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Total time this run may take. */
  budgetMs: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type CriticalReason =
  "lost_response" | "raw_insert_failed" | "stalled_balance" | "process_failed" | "bad_response";

export type CaptureResult = {
  status: "disabled" | "lease_held" | "ran";
  stop?:
    | "blocked"
    | "drained"
    | "max_batches"
    | "budget"
    | "process_failed"
    | "raw_insert_failed"
    | "lost_response"
    | "stalled_balance"
    | "bad_response";
  batches: number;
  records: number;
  lastBalance: number | null;
};

/** Time reserved for one more Unite call + raw insert + processing. */
export const MIN_TIME_PER_BATCH_MS = 20_000;
const RAW_INSERT_ATTEMPTS = 3;
const STALL_LIMIT = 2;

const ddMMyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

function numberOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
const strOrNull = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.slice(0, 500) : null;

export async function runCapture(deps: CaptureDeps): Promise<CaptureResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const result: CaptureResult = { status: "disabled", batches: 0, records: 0, lastBalance: null };

  const settings = await deps.loadSettings();
  if (!settings || !settings.enabled) return result;

  const holder = `capture:${now()}:${Math.random().toString(36).slice(2, 8)}`;
  if (!(await deps.tryLease(holder, Math.ceil(deps.budgetMs / 1000) + 60))) {
    return { ...result, status: "lease_held" };
  }
  result.status = "ran";

  const started = now();
  let stalls = 0;
  let prevBalance: number | null = null;

  try {
    // Never pull more records while earlier raw batches are unprocessed: retry them first
    // (this is how a fixed mapping recovers on its own), and stop if any still fails.
    for (const pendingId of await deps.pendingBatchIds()) {
      const retried = await deps.processBatch(pendingId);
      if (!retried.ok) {
        log("unprocessed batch still failing; not pulling new records", { batchId: pendingId });
        result.stop = "blocked";
        return result;
      }
    }

    for (let i = 0; i < settings.maxBatchesPerRun; i++) {
      if (now() - started + MIN_TIME_PER_BATCH_MS > deps.budgetMs) {
        result.stop = "budget";
        return result;
      }

      const req: FinanceRequest = {
        fromDate: ddMMyyyy(settings.windowFrom),
        toDate: ddMMyyyy(deps.today()),
        count: settings.batchSize,
      };

      let call: FinanceCall;
      try {
        call = await deps.financeDetails(req);
      } catch (err) {
        if (err instanceof UniteCallError) {
          await deps.raiseCritical("lost_response", {
            note: "request may have been consumed by Unite; ask Unite to re-queue",
          });
          result.stop = "lost_response";
          return result;
        }
        throw err; // auth / configuration problems: nothing was consumed, the job fails and retries next tick
      }

      const body = (call.body && typeof call.body === "object" ? call.body : {}) as Record<
        string,
        unknown
      >;
      const data = Array.isArray(body.Data) ? (body.Data as unknown[]) : null;
      const row: RawBatchInsert = {
        from_date: settings.windowFrom,
        to_date: deps.today(),
        count_requested: settings.batchSize,
        http_status: call.httpStatus,
        message_status: strOrNull(body.MessageStatus ?? body.Status),
        detail_message: strOrNull(body.DetailMessage ?? body.Message),
        balance_in_range: numberOrNull(body.DataBalancetoSync),
        balance_overall: numberOrNull(body.OverallDataBalancetoSync),
        record_count: data ? data.length : null,
        payload: call.body,
        payload_sha256: createHash("sha256")
          .update(JSON.stringify(call.body) ?? "")
          .digest("hex"),
      };

      let batchId: string | null = null;
      for (let attempt = 1; attempt <= RAW_INSERT_ATTEMPTS && !batchId; attempt++) {
        try {
          batchId = await deps.insertRaw(row);
        } catch (err) {
          log("raw insert failed", { attempt, error: (err as Error).name });
          if (attempt < RAW_INSERT_ATTEMPTS) await sleep(500 * attempt);
        }
      }
      if (!batchId) {
        await deps.raiseCritical("raw_insert_failed", {
          note: "raw payload could not be stored; process nothing and ask Unite to re-queue",
          records: row.record_count,
        });
        result.stop = "raw_insert_failed";
        return result;
      }

      result.batches++;
      result.records += row.record_count ?? 0;
      result.lastBalance = row.balance_in_range;

      if (!data || call.httpStatus < 200 || call.httpStatus >= 300) {
        await deps.markBatchFailed(batchId, "response was not a successful Unite finance payload");
        result.stop = "bad_response";
        return result;
      }

      const processed = await deps.processBatch(batchId);
      if (!processed.ok) {
        log("processing failed; stopping capture", { batchId });
        result.stop = "process_failed";
        return result;
      }

      if (data.length === 0 || row.balance_in_range === null || row.balance_in_range <= 0) {
        result.stop = "drained";
        return result;
      }

      // Pulling N records must lower the remaining balance. Edits can re-queue records, so only
      // repeated non-decreasing balances count as a stall.
      if (prevBalance !== null && row.balance_in_range >= prevBalance) stalls++;
      else stalls = 0;
      prevBalance = row.balance_in_range;
      if (stalls >= STALL_LIMIT) {
        await deps.raiseCritical("stalled_balance", { balance: row.balance_in_range });
        result.stop = "stalled_balance";
        return result;
      }
    }
    result.stop = "max_batches";
    return result;
  } finally {
    await deps.releaseLease(holder);
  }
}
