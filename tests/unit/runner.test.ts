import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearHandlers, registerHandler } from "@/lib/jobs/registry";
import { DEFAULTS, drainQueue, type DrainDeps } from "@/lib/jobs/runner";
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
