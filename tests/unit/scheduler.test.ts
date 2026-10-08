import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearKinds,
  isClaimable,
  registerKind,
  retryDelaySeconds,
  routeKind,
  runScheduler,
  selectClaimable,
  toQueueMessage,
  type ScheduledJobRow,
  type SchedulerDeps,
} from "@/lib/jobs/scheduler";

const NOW = new Date("2026-10-08T12:00:00Z");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
const ahead = (sec: number) => new Date(NOW.getTime() + sec * 1000).toISOString();

function job(over: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    org_id: null,
    kind: "queue:outbound",
    payload: {},
    run_at: ago(10),
    attempts: 0,
    max_attempts: 5,
    locked_at: null,
    locked_by: null,
    last_error: null,
    done_at: null,
    ...over,
  };
}

describe("isClaimable (mirrors claim_scheduled_jobs SQL)", () => {
  it("claims due, unlocked, unfinished jobs with attempts left", () => {
    expect(isClaimable(job(), NOW)).toBe(true);
  });
  it("skips future jobs", () => {
    expect(isClaimable(job({ run_at: ahead(1) }), NOW)).toBe(false);
  });
  it("skips done jobs", () => {
    expect(isClaimable(job({ done_at: ago(1) }), NOW)).toBe(false);
  });
  it("skips jobs out of attempts", () => {
    expect(isClaimable(job({ attempts: 5, max_attempts: 5 }), NOW)).toBe(false);
    expect(isClaimable(job({ attempts: 4, max_attempts: 5 }), NOW)).toBe(true);
  });
  it("skips freshly locked jobs but reclaims stale locks after the TTL", () => {
    expect(isClaimable(job({ locked_at: ago(60) }), NOW)).toBe(false);
    expect(isClaimable(job({ locked_at: ago(5 * 60 + 1) }), NOW)).toBe(true);
    expect(isClaimable(job({ locked_at: ago(31) }), NOW, 30_000)).toBe(true);
    expect(isClaimable(job({ locked_at: ago(29) }), NOW, 30_000)).toBe(false);
  });
});

describe("selectClaimable", () => {
  it("orders by run_at and respects the limit", () => {
    const a = job({ id: "a", run_at: ago(30) });
    const b = job({ id: "b", run_at: ago(60) });
    const c = job({ id: "c", run_at: ago(10) });
    const d = job({ id: "d", run_at: ahead(10) });
    expect(selectClaimable([a, b, c, d], NOW, 2).map((j) => j.id)).toEqual(["b", "a"]);
    expect(selectClaimable([a, b, c, d], NOW, 10).map((j) => j.id)).toEqual(["b", "a", "c"]);
    expect(selectClaimable([a, b, c, d], NOW, 0)).toEqual([]);
  });
});

describe("retryDelaySeconds", () => {
  it("backs off exponentially from 1 minute, capped at 1 hour", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(3)).toBe(240);
    expect(retryDelaySeconds(10)).toBe(3600);
    expect(retryDelaySeconds(0)).toBe(60);
  });
});

describe("routeKind", () => {
  beforeEach(() => clearKinds());

  it("routes exact and prefix registrations, then the queue: convention", () => {
    registerKind("reminder.send", "outbound");
    registerKind("flow.*", "flow_steps");
    expect(routeKind("reminder.send")).toBe("outbound");
    expect(routeKind("flow.wait.timeout")).toBe("flow_steps");
    expect(routeKind("flow.resume")).toBe("flow_steps");
    expect(routeKind("queue:media_fetch")).toBe("media_fetch");
    expect(routeKind("queue:nope")).toBeNull();
    expect(routeKind("unknown.kind")).toBeNull();
  });

  it("prefers the most specific prefix", () => {
    registerKind("a.*", "outbound");
    registerKind("a.b.*", "flow_steps");
    expect(routeKind("a.b.c")).toBe("flow_steps");
    expect(routeKind("a.x")).toBe("outbound");
  });
});

describe("runScheduler", () => {
  beforeEach(() => clearKinds());

  function deps(jobs: ScheduledJobRow[], over: Partial<SchedulerDeps> = {}) {
    const d: SchedulerDeps = {
      claim: vi.fn(async () => jobs),
      enqueue: vi.fn(async () => 1),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      ...over,
    };
    return d;
  }

  it("enqueues routed jobs with a stable message shape and completes them", async () => {
    registerKind("reminder.send", "outbound");
    const j = job({
      id: "j1",
      kind: "reminder.send",
      org_id: "org",
      attempts: 1,
      payload: { appointment_id: "x" },
    });
    const d = deps([j]);
    const r = await runScheduler(d, { limit: 10, worker: "t" });
    expect(r).toEqual({ claimed: 1, enqueued: 1, failed: 0, errors: [] });
    expect(d.claim).toHaveBeenCalledWith(10, "t");
    expect(d.enqueue).toHaveBeenCalledWith("outbound", toQueueMessage(j));
    expect(toQueueMessage(j)).toEqual({
      kind: "reminder.send",
      org_id: "org",
      scheduled_job_id: "j1",
      attempt: 1,
      payload: { appointment_id: "x" },
    });
    expect(d.complete).toHaveBeenCalledWith("j1");
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("fails unroutable kinds immediately (retry in 0s so attempts exhaust)", async () => {
    const d = deps([job({ id: "j2", kind: "nothing.here" })]);
    const r = await runScheduler(d);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toContain("no route");
    expect(d.fail).toHaveBeenCalledWith("j2", expect.stringContaining("no queue route"), 0);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("retries with back-off when enqueue throws and keeps processing the batch", async () => {
    const j1 = job({ id: "j1", kind: "queue:outbound", attempts: 2 });
    const j2 = job({ id: "j2", kind: "queue:outbound", attempts: 1 });
    const enqueue = vi.fn(async (_q: string, msg: { scheduled_job_id: string }) => {
      if (msg.scheduled_job_id === "j1") throw new Error("pgmq down");
      return 7;
    });
    const d = deps([j1, j2], { enqueue: enqueue as unknown as SchedulerDeps["enqueue"] });
    const r = await runScheduler(d);
    expect(r).toMatchObject({ claimed: 2, enqueued: 1, failed: 1 });
    expect(d.fail).toHaveBeenCalledWith("j1", "pgmq down", retryDelaySeconds(2));
    expect(d.complete).toHaveBeenCalledWith("j2");
  });

  it("is a no-op when nothing is due", async () => {
    const d = deps([]);
    expect(await runScheduler(d)).toEqual({ claimed: 0, enqueued: 0, failed: 0, errors: [] });
  });
});
