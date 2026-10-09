import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearHandlers, registerHandler } from "@/lib/jobs/registry";
import { DEFAULTS, drainQueue, drainQueueUntilIdle, type DrainDeps } from "@/lib/jobs/runner";
import { PermanentJobError, type QueueMessage } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";

function msg(id: number, readCt = 1, message: unknown = { id }): QueueMessage {
  return {
    msg_id: id,
    read_ct: readCt,
    enqueued_at: new Date().toISOString(),
    vt: new Date().toISOString(),
    message: message as never,
  };
}

function deps(
  messages: QueueMessage[],
  over: Partial<DrainDeps> = {},
): DrainDeps & { runs: unknown[] } {
  const runs: unknown[] = [];
  return {
    runs,
    admin: {} as AdminClient,
    read: vi.fn(async () => messages),
    archive: vi.fn(async () => {}),
    deadLetter: vi.fn(async () => {}),
    startRun: vi.fn(async () => 42),
    finishRun: vi.fn(async (runId, r) => {
      runs.push({ runId, ...r });
    }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("drainQueue", () => {
  beforeEach(() => clearHandlers());

  it("returns an error result and never reads when no handler is registered", async () => {
    const d = deps([msg(1)]);
    const r = await drainQueue("outbound", d);
    expect(r.error).toBe("no handler registered");
    expect(d.read).not.toHaveBeenCalled();
  });

  it("does not log a job_run for an empty batch", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const d = deps([]);
    const r = await drainQueue("outbound", d);
    expect(r).toMatchObject({ read: 0, processed: 0, runId: null });
    expect(d.startRun).not.toHaveBeenCalled();
  });

  it("archives successful messages and logs the run", async () => {
    const handled: unknown[] = [];
    registerHandler({
      queue: "outbound",
      name: "t",
      handler: async (p) => {
        handled.push(p);
      },
    });
    const d = deps([msg(1), msg(2)]);
    const r = await drainQueue("outbound", d);
    expect(handled).toEqual([{ id: 1 }, { id: 2 }]);
    expect(d.read).toHaveBeenCalledWith("outbound", DEFAULTS.visibilityTimeout, DEFAULTS.batchSize);
    expect(d.archive).toHaveBeenCalledWith("outbound", [1, 2]);
    expect(r).toMatchObject({ runId: 42, read: 2, processed: 2, failed: 0, deadLettered: 0 });
    expect(d.runs[0]).toMatchObject({ runId: 42, processed: 2, failed: 0 });
  });

  it("uses the handler's batch size and visibility timeout", async () => {
    registerHandler({
      queue: "media_fetch",
      name: "t",
      handler: async () => {},
      batchSize: 5,
      visibilityTimeout: 120,
    });
    const d = deps([]);
    await drainQueue("media_fetch", d);
    expect(d.read).toHaveBeenCalledWith("media_fetch", 120, 5);
  });

  it("leaves a failed message for retry while under maxReads, dead-letters at maxReads", async () => {
    registerHandler({
      queue: "outbound",
      name: "t",
      maxReads: 3,
      handler: async (p) => {
        if ((p as { id: number }).id !== 2) throw new Error("boom");
      },
    });
    const d = deps([msg(1, 1), msg(2, 1), msg(3, 3)]);
    const r = await drainQueue("outbound", d);
    expect(d.archive).toHaveBeenCalledWith("outbound", [2]);
    expect(d.deadLetter).toHaveBeenCalledTimes(1);
    expect(d.deadLetter).toHaveBeenCalledWith(
      "outbound",
      expect.objectContaining({ msg_id: 3 }),
      "Error: boom",
    );
    expect(r).toMatchObject({ processed: 1, failed: 2, deadLettered: 1 });
    expect(d.runs[0]).toMatchObject({ failed: 2, error: "Error: boom" });
  });

  it("dead-letters PermanentJobError on first delivery", async () => {
    registerHandler({
      queue: "notifications",
      name: "t",
      handler: async () => {
        throw new PermanentJobError("bad payload");
      },
    });
    const d = deps([msg(9, 1)]);
    const r = await drainQueue("notifications", d);
    expect(d.deadLetter).toHaveBeenCalledWith(
      "notifications",
      expect.objectContaining({ msg_id: 9 }),
      "PermanentJobError: bad payload",
    );
    expect(r.deadLettered).toBe(1);
    expect(d.archive).not.toHaveBeenCalled();
  });

  it("records a failed run when reading the queue throws", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const d = deps([], {
      read: vi.fn(async () => {
        throw new Error("db offline");
      }),
    });
    const r = await drainQueue("outbound", d);
    expect(r.error).toBe("Error: db offline");
    expect(d.runs[0]).toMatchObject({ error: "Error: db offline", processed: 0 });
  });

  it("reports an archive failure in the run (messages will be redelivered)", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const d = deps([msg(1)], {
      archive: vi.fn(async () => {
        throw new Error("archive failed");
      }),
    });
    const r = await drainQueue("outbound", d);
    expect(r.processed).toBe(1);
    expect(r.error).toBe("Error: archive failed");
  });

  it("runs messages concurrently when the handler asks for it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    registerHandler({
      queue: "outbound",
      name: "t",
      concurrency: "parallel",
      handler: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    });
    await drainQueue("outbound", deps([msg(1), msg(2), msg(3)]));
    expect(maxInFlight).toBe(3);
  });
});

describe("drainQueueUntilIdle", () => {
  beforeEach(() => clearHandlers());

  function batches(...sizes: number[]) {
    let id = 0;
    const queue = sizes.map((n) => Array.from({ length: n }, () => msg(++id)));
    return vi.fn(async () => queue.shift() ?? []);
  }

  it("keeps draining until the queue is empty (a tick is not capped at one batch)", async () => {
    const handled: number[] = [];
    registerHandler({
      queue: "outbound",
      name: "t",
      handler: async (p) => void handled.push((p as { id: number }).id),
    });
    const d = deps([], { read: batches(5, 5, 3) });
    const r = await drainQueueUntilIdle("outbound", d);
    expect(handled).toHaveLength(13);
    expect(r).toMatchObject({ read: 13, processed: 13, failed: 0, batches: 3 });
    expect(d.read).toHaveBeenCalledTimes(4); // the last call found it empty
  });

  it("stops at the time budget", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    let t = 0;
    const d = deps([], { read: batches(2, 2, 2, 2), now: () => (t += 20_000) });
    const r = await drainQueueUntilIdle("outbound", d, { budgetMs: 50_000 });
    expect(r.batches).toBeLessThan(4);
    expect(r.batches).toBeGreaterThanOrEqual(1);
  });

  it("stops at maxBatches", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const d = deps([], { read: batches(1, 1, 1, 1, 1) });
    expect((await drainQueueUntilIdle("outbound", d, { maxBatches: 2 })).batches).toBe(2);
  });

  it("does not hot-loop when a whole batch fails", async () => {
    registerHandler({
      queue: "outbound",
      name: "t",
      handler: async () => {
        throw new Error("boom");
      },
    });
    const d = deps([], { read: batches(3, 3, 3) });
    const r = await drainQueueUntilIdle("outbound", d);
    expect(r).toMatchObject({ batches: 1, read: 3, processed: 0, failed: 3 });
    expect(d.read).toHaveBeenCalledTimes(1);
  });

  it("keeps going after a partly failed batch and reports the error", async () => {
    let n = 0;
    registerHandler({
      queue: "outbound",
      name: "t",
      handler: async () => {
        if (++n === 1) throw new Error("one bad message");
      },
    });
    const d = deps([], { read: batches(3, 2) });
    const r = await drainQueueUntilIdle("outbound", d);
    expect(r).toMatchObject({ batches: 2, read: 5, processed: 4, failed: 1 });
    expect(r.error).toContain("one bad message");
  });

  it("returns the 'no handler' result without looping", async () => {
    const d = deps([msg(1)]);
    const r = await drainQueueUntilIdle("outbound", d);
    expect(r).toMatchObject({ batches: 1, read: 0, error: "no handler registered" });
    expect(d.read).not.toHaveBeenCalled();
  });

  it("reports a failing read once and stops", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const d = deps([], {
      read: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const r = await drainQueueUntilIdle("outbound", d);
    expect(r.error).toContain("db down");
    expect(r.batches).toBe(1);
  });
});

describe("drainQueueUntilIdle with delayed messages", () => {
  beforeEach(() => clearHandlers());

  it("waits for a delayed message that falls due inside the budget, then drains it", async () => {
    const handled: number[] = [];
    registerHandler({
      queue: "outbound",
      name: "t",
      handler: async (p) => void handled.push((p as { id: number }).id),
    });
    let t = 0;
    const slept: number[] = [];
    const reads = [[msg(1)], [], [msg(2)], []];
    const dues = [3, null]; // after the first empty read: 3 s to the next message; after the last: nothing
    const d = deps([], {
      read: vi.fn(async () => reads.shift() ?? []),
      nextDueSeconds: vi.fn(async () => dues.shift() ?? null),
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      now: () => t,
    });
    const r = await drainQueueUntilIdle("outbound", d, { budgetMs: 40_000 });
    expect(handled).toEqual([1, 2]);
    expect(slept).toEqual([3050]);
    expect(r).toMatchObject({ read: 2, processed: 2 });
  });

  it("does not wait for a message due beyond the time budget", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const sleep = vi.fn(async () => {});
    const d = deps([], {
      read: vi.fn(async () => []),
      nextDueSeconds: vi.fn(async () => 120),
      sleep,
    });
    const r = await drainQueueUntilIdle("outbound", d, { budgetMs: 40_000 });
    expect(sleep).not.toHaveBeenCalled();
    expect(r.batches).toBe(0);
  });

  it("treats a missing or failing due-check as 'nothing delayed'", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    const sleep = vi.fn(async () => {});
    const d = deps([], { read: vi.fn(async () => []), sleep });
    await drainQueueUntilIdle("outbound", d);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("is bounded by maxBatches even if messages keep arriving on a delay", async () => {
    registerHandler({ queue: "outbound", name: "t", handler: async () => {} });
    let n = 0;
    const d = deps([], {
      read: vi.fn(async () => (n++ % 2 === 0 ? [msg(n)] : [])),
      nextDueSeconds: vi.fn(async () => 1),
      sleep: async () => {},
    });
    const r = await drainQueueUntilIdle("outbound", d, { maxBatches: 3, budgetMs: 10 ** 9 });
    expect(r.batches).toBe(3);
  });
});
