import { describe, expect, it } from "vitest";

import { BACKLOG_THRESHOLD, classifyQueue, OLDEST_AGE_THRESHOLD_SEC } from "@/lib/jobs/health";

const base = {
  queue: "outbound",
  depth: 0,
  oldestAgeSec: 0,
  total: 0,
  handler: "h",
  lastRun: null,
};

describe("classifyQueue", () => {
  it("flags queues without a handler", () => {
    expect(classifyQueue({ ...base, handler: null })).toBe("no_handler");
  });
  it("is unknown without metrics", () => {
    expect(classifyQueue({ ...base, depth: null })).toBe("unknown");
  });
  it("is idle with nothing queued and no runs, ok once it has run", () => {
    expect(classifyQueue(base)).toBe("idle");
    expect(
      classifyQueue({
        ...base,
        lastRun: { started_at: "x", finished_at: "x", processed: 3, failed: 0, error: null },
      }),
    ).toBe("ok");
  });
  it("flags backlog by depth or age", () => {
    expect(classifyQueue({ ...base, depth: BACKLOG_THRESHOLD })).toBe("backlog");
    expect(classifyQueue({ ...base, depth: 1, oldestAgeSec: OLDEST_AGE_THRESHOLD_SEC })).toBe(
      "backlog",
    );
  });
  it("flags failing when the last drain processed nothing and errored", () => {
    expect(
      classifyQueue({
        ...base,
        depth: 1,
        lastRun: { started_at: "x", finished_at: "x", processed: 0, failed: 2, error: "boom" },
      }),
    ).toBe("failing");
    expect(
      classifyQueue({
        ...base,
        depth: 1,
        lastRun: { started_at: "x", finished_at: "x", processed: 5, failed: 1, error: "boom" },
      }),
    ).toBe("ok");
  });
});
