import { describe, expect, it } from "vitest";

import {
  dueAtMs,
  evaluateOutboundRun,
  evaluateWebhookRun,
  maxPerSecond,
  peakAverage,
  percentile,
  renderCriteria,
  summarize,
  type OutboundRun,
  type WebhookRun,
} from "@/lib/load/stats";
import {
  chunkIndexes,
  isSyntheticPhone,
  messageEvent,
  messageId,
  syntheticWaId,
} from "@/lib/load/synthetic";
import { parseWebhookBody } from "@/lib/whatsapp/parse";

describe("stats", () => {
  it("computes nearest-rank percentiles", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });
  it("summarises latencies", () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s).toMatchObject({ count: 4, min: 10, max: 40, mean: 25 });
    expect(summarize([]).count).toBe(0);
  });
  it("paces an open-loop schedule", () => {
    expect(dueAtMs(0, 1000)).toBe(0);
    expect(dueAtMs(1000, 1000)).toBe(60_000);
    expect(dueAtMs(10, 600)).toBe(1000);
    expect(() => dueAtMs(1, 0)).toThrow();
  });
  it("averages the busiest window", () => {
    const ts = [
      ...Array.from({ length: 30 }, (_, i) => 5000 + i * 30),
      ...Array.from({ length: 10 }, (_, i) => 20_000 + i * 90),
    ];
    expect(peakAverage(ts, 10)).toBe(3); // 30 events in one second, 10 more later: busiest 10 s window averages 3/s
    expect(peakAverage([], 10)).toBe(0);
  });
  it("finds the busiest second", () => {
    expect(maxPerSecond([0, 100, 999, 1000, 1500, 2000])).toBe(3);
    expect(maxPerSecond([])).toBe(0);
  });
});

const goodWebhook: WebhookRun = {
  sent: 1000,
  replayed: 50,
  non2xx: 0,
  networkErrors: 0,
  ingress: { count: 1050, min: 5, p50: 20, p95: 80, p99: 150, max: 300, mean: 30 },
  messagesExpected: 1000,
  messagesFound: 1000,
  unprocessedRows: 0,
  erroredRows: 0,
  queueDepth: 0,
  drainSeconds: 20,
};

describe("evaluateWebhookRun", () => {
  it("passes a clean run", () => {
    expect(evaluateWebhookRun(goodWebhook).every((c) => c.ok)).toBe(true);
  });
  it.each([
    ["loss", { messagesFound: 990 }],
    ["duplicates", { messagesFound: 1001 }],
    ["rejections", { non2xx: 3 }],
    ["slow ingress", { ingress: { ...goodWebhook.ingress, p95: 900 } }],
    ["backlog", { queueDepth: 12 }],
    ["unprocessed rows", { unprocessedRows: 4 }],
    ["slow drain", { drainSeconds: 600 }],
  ])("fails on %s", (_n, patch) => {
    expect(evaluateWebhookRun({ ...goodWebhook, ...patch }).some((c) => !c.ok)).toBe(true);
  });
});

const goodOutbound: OutboundRun = {
  total: 20000,
  sent: 20000,
  failed: 0,
  stillQueued: 0,
  seconds: 1300,
  configuredRatePerSec: 20,
  expectedRatePerSec: 16,
  observedMaxPerSec: 20,
  observedPeak10sAvg: 16.2,
  deadLetters: 0,
  slowestTickMs: 30_000,
  maxDurationMs: 60_000,
};

describe("evaluateOutboundRun", () => {
  it("passes a clean 20k run at the configured rate", () => {
    expect(evaluateOutboundRun(goodOutbound).every((c) => c.ok)).toBe(true);
  });
  it.each([
    ["rate exceeded (1 s peak over 2x)", { observedMaxPerSec: 45 }],
    ["rate exceeded (sustained)", { observedPeak10sAvg: 20 }],
    ["stuck messages", { stillQueued: 500 }],
    ["dead letters", { deadLetters: 2 }],
    ["slow tick", { slowestTickMs: 61_000 }],
    ["throughput collapse", { seconds: 5000 }],
    ["messages stuck in the queue", { stillQueued: 1, sent: 19999 }],
  ])("fails on %s", (_n, patch) => {
    expect(evaluateOutboundRun({ ...goodOutbound, ...patch }).some((c) => !c.ok)).toBe(true);
  });
  it("renders a markdown table", () => {
    expect(renderCriteria("T", evaluateOutboundRun(goodOutbound))).toContain("| PASS |");
  });
});

describe("synthetic events", () => {
  it("uses only the reserved fake number block", () => {
    expect(syntheticWaId(42)).toBe("971500900042");
    expect(isSyntheticPhone("+971500900042")).toBe(true);
    expect(isSyntheticPhone("971501234567")).toBe(false);
    expect(() => syntheticWaId(100_000)).toThrow();
  });
  it("builds payloads the real parser accepts, one message per index, with unique ids", () => {
    const body = messageEvent({
      runId: "r1",
      phoneNumberId: "100000000000001",
      wabaId: "200000000000001",
      indexes: [0, 1, 2],
      senders: 2,
      nowSeconds: 1760000000,
    });
    const parsed = parseWebhookBody(body);
    if (!parsed.ok) throw new Error(parsed.error);
    const events = parsed.events.flatMap((e) => (e.kind === "message" ? [e] : []));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.waMessageId)).size).toBe(3);
    expect(
      events.every((e) => e.type === "text" && e.identity.phoneE164?.startsWith("+9715009")),
    ).toBe(true);
    expect(JSON.stringify(body)).toContain(messageId("r1", 2));
  });
  it("chunks indexes", () => {
    expect(chunkIndexes(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
    expect(chunkIndexes(0, 3)).toEqual([]);
  });
});
