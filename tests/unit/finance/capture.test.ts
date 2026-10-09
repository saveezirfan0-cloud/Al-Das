import { describe, expect, it } from "vitest";

import {
  MIN_TIME_PER_BATCH_MS,
  runCapture,
  type CaptureDeps,
  type CaptureSettings,
  type RawBatchInsert,
} from "@/lib/finance/capture";
import type { ProcessResult } from "@/lib/finance/process-batch";
import { UniteCallError, type FinanceCall } from "@/lib/unite/client";

const SETTINGS: CaptureSettings = {
  enabled: true,
  batchSize: 50,
  windowFrom: "2026-01-01",
  maxBatchesPerRun: 10,
};

type Opts = {
  settings?: CaptureSettings | null;
  lease?: boolean;
  pending?: string[];
  calls?: Array<FinanceCall | Error>;
  insertFailures?: number;
  process?: (id: string) => ProcessResult;
  budgetMs?: number;
  step?: number; // clock advance per call
};

function harness(o: Opts = {}) {
  const events: string[] = [];
  let clock = 0;
  const calls = [...(o.calls ?? [])];
  let insertFailures = o.insertFailures ?? 0;
  let seq = 0;
  const inserted: RawBatchInsert[] = [];
  const critical: string[] = [];
  const failed: string[] = [];
  const requests: unknown[] = [];

  const deps: CaptureDeps = {
    budgetMs: o.budgetMs ?? 45_000,
    now: () => clock,
    sleep: async () => {},
    loadSettings: async () => (o.settings === undefined ? SETTINGS : o.settings),
    tryLease: async () => {
      events.push("lease");
      return o.lease ?? true;
    },
    releaseLease: async () => {
      events.push("release");
    },
    today: () => "2026-10-09",
    financeDetails: async (req) => {
      events.push("call");
      requests.push(req);
      clock += o.step ?? 0;
      const next = calls.shift();
      if (!next) throw new Error("test ran out of scripted Unite responses");
      if (next instanceof Error) throw next;
      return next;
    },
    insertRaw: async (row) => {
      events.push("insert");
      if (insertFailures > 0) {
        insertFailures--;
        throw new Error("db down");
      }
      inserted.push(row);
      return `batch-${++seq}`;
    },
    pendingBatchIds: async () => o.pending ?? [],
    processBatch: async (id) => {
      events.push(`process:${id}`);
      return o.process ? o.process(id) : { ok: true, counts: { invoices: 1 } };
    },
    raiseCritical: async (reason) => {
      critical.push(reason);
    },
    markBatchFailed: async (id) => {
      failed.push(id);
    },
  };
  return { deps, events, inserted, critical, failed, requests };
}

const page = (
  records: number,
  balance: number | null,
  extra: Record<string, unknown> = {},
): FinanceCall => ({
  httpStatus: 200,
  body: {
    MessageStatus: "Success",
    DetailMessage: "ok",
    DataBalancetoSync: balance,
    OverallDataBalancetoSync: balance,
    Data: Array.from({ length: records }, (_, i) => ({ InvDisplayNumber: `ADMC/${i}` })),
    ...extra,
  },
});

describe("runCapture", () => {
  it("does nothing, and never calls Unite, when capture is disabled or unconfigured", async () => {
    for (const settings of [null, { ...SETTINGS, enabled: false }]) {
      const h = harness({ settings });
      expect((await runCapture(h.deps)).status).toBe("disabled");
      expect(h.events).toEqual([]);
    }
  });

  it("does not call Unite when another run holds the lease", async () => {
    const h = harness({ lease: false });
    expect((await runCapture(h.deps)).status).toBe("lease_held");
    expect(h.events).toEqual(["lease"]);
  });

  it("stores the raw payload BEFORE processing, for every batch", async () => {
    const h = harness({ calls: [page(2, 1), page(1, 0)] });
    const res = await runCapture(h.deps);
    expect(h.events).toEqual([
      "lease",
      "call",
      "insert",
      "process:batch-1",
      "call",
      "insert",
      "process:batch-2",
      "release",
    ]);
    expect(res).toMatchObject({
      status: "ran",
      stop: "drained",
      batches: 2,
      records: 3,
      lastBalance: 0,
    });
  });

  it("requests the wide window (window start -> today) in Unite's date format", async () => {
    const h = harness({ calls: [page(1, 0)] });
    await runCapture(h.deps);
    expect(h.requests[0]).toEqual({ fromDate: "01-01-2026", toDate: "09-10-2026", count: 50 });
  });

  it("stores the full response untouched with its balances and a hash", async () => {
    const h = harness({ settings: { ...SETTINGS, maxBatchesPerRun: 1 }, calls: [page(2, 7)] });
    await runCapture(h.deps);
    expect(h.inserted[0]).toMatchObject({
      from_date: "2026-01-01",
      to_date: "2026-10-09",
      count_requested: 50,
      http_status: 200,
      message_status: "Success",
      balance_in_range: 7,
      balance_overall: 7,
      record_count: 2,
    });
    expect(h.inserted[0].payload).toEqual(expect.objectContaining({ Data: expect.any(Array) }));
    expect(h.inserted[0].payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops at an empty page", async () => {
    const h = harness({ calls: [page(0, 0)] });
    expect((await runCapture(h.deps)).stop).toBe("drained");
  });

  it("stops after max_batches_per_run", async () => {
    const h = harness({
      settings: { ...SETTINGS, maxBatchesPerRun: 2 },
      calls: [page(5, 100), page(5, 90), page(5, 80)],
    });
    const res = await runCapture(h.deps);
    expect(res).toMatchObject({ stop: "max_batches", batches: 2 });
    expect(h.events.filter((e) => e === "call")).toHaveLength(2);
  });

  it("stops before a call that could not finish inside the time budget", async () => {
    const h = harness({
      budgetMs: 1.5 * MIN_TIME_PER_BATCH_MS,
      step: MIN_TIME_PER_BATCH_MS,
      calls: [page(5, 100), page(5, 90), page(5, 80)],
    });
    const res = await runCapture(h.deps);
    expect(res.stop).toBe("budget");
    expect(res.batches).toBe(1);
  });

  it("raises a critical exception and stops when the balance stops dropping", async () => {
    const h = harness({ calls: [page(5, 100), page(5, 100), page(5, 100), page(5, 100)] });
    const res = await runCapture(h.deps);
    expect(res.stop).toBe("stalled_balance");
    expect(h.critical).toEqual(["stalled_balance"]);
  });

  it("does not call a rising balance a stall unless it repeats (edits can re-queue records)", async () => {
    const h = harness({ calls: [page(5, 100), page(5, 105), page(5, 50), page(5, 0)] });
    expect((await runCapture(h.deps)).stop).toBe("drained");
    expect(h.critical).toEqual([]);
  });

  describe("failure handling (the data may already be gone from Unite)", () => {
    it("retries the raw insert, then succeeds", async () => {
      const h = harness({ insertFailures: 2, calls: [page(1, 0)] });
      const res = await runCapture(h.deps);
      expect(res.stop).toBe("drained");
      expect(h.events.filter((e) => e === "insert")).toHaveLength(3);
      expect(h.events).toContain("process:batch-1");
    });

    it("processes nothing and raises a critical exception when the raw insert never works", async () => {
      const h = harness({ insertFailures: 99, calls: [page(3, 10), page(3, 5)] });
      const res = await runCapture(h.deps);
      expect(res.stop).toBe("raw_insert_failed");
      expect(h.critical).toEqual(["raw_insert_failed"]);
      expect(h.events.some((e) => e.startsWith("process"))).toBe(false);
      expect(h.events.filter((e) => e === "call")).toHaveLength(1); // no further pulls
      expect(h.events.at(-1)).toBe("release");
    });

    it("keeps the raw row, does not pull more, and flags it when processing fails", async () => {
      const h = harness({
        calls: [page(3, 10), page(3, 5)],
        process: () => ({ ok: false, error: "invoice X: net is missing" }),
      });
      const res = await runCapture(h.deps);
      expect(res.stop).toBe("process_failed");
      expect(res.batches).toBe(1);
      expect(h.events.filter((e) => e === "call")).toHaveLength(1);
    });

    it("alerts and stops without retrying when the outcome of a call is unknown", async () => {
      const h = harness({ calls: [new UniteCallError("unknown_outcome", "timeout"), page(1, 0)] });
      const res = await runCapture(h.deps);
      expect(res.stop).toBe("lost_response");
      expect(h.critical).toEqual(["lost_response"]);
      expect(h.events.filter((e) => e === "call")).toHaveLength(1);
      expect(h.events.at(-1)).toBe("release");
    });

    it("stores a response without a Data list, marks it failed and stops", async () => {
      const h = harness({
        calls: [{ httpStatus: 200, body: { Status: "Exception", Message: "boom" } }, page(1, 0)],
      });
      const res = await runCapture(h.deps);
      expect(res.stop).toBe("bad_response");
      expect(h.inserted).toHaveLength(1);
      expect(h.failed).toEqual(["batch-1"]);
      expect(h.events.some((e) => e.startsWith("process"))).toBe(false);
    });

    it("lets configuration errors (no credentials) fail the run after releasing the lease", async () => {
      const h = harness({ calls: [new Error("no Unite credentials are configured")] });
      await expect(runCapture(h.deps)).rejects.toThrow(/no Unite credentials/);
      expect(h.events.at(-1)).toBe("release");
      expect(h.inserted).toHaveLength(0);
    });
  });

  describe("unprocessed batches", () => {
    it("reprocesses earlier raw batches first, then continues", async () => {
      const h = harness({ pending: ["old-1", "old-2"], calls: [page(1, 0)] });
      const res = await runCapture(h.deps);
      expect(h.events.slice(0, 4)).toEqual(["lease", "process:old-1", "process:old-2", "call"]);
      expect(res.stop).toBe("drained");
    });

    it("does not pull any new records while an earlier batch still fails", async () => {
      const h = harness({
        pending: ["old-1"],
        calls: [page(1, 0)],
        process: () => ({ ok: false, error: "still broken" }),
      });
      const res = await runCapture(h.deps);
      expect(res.stop).toBe("blocked");
      expect(h.events).not.toContain("call");
      expect(h.events.at(-1)).toBe("release");
    });
  });
});
