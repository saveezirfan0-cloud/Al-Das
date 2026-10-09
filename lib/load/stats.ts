/** Pure helpers for the Phase 11 load-test harness (scripts/load/*). No I/O. */

/** Nearest-rank percentile of an unsorted list; NaN for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export type LatencySummary = {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

export function summarize(latencies: number[]): LatencySummary {
  if (latencies.length === 0)
    return { count: 0, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    count: latencies.length,
    min: Math.min(...latencies),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: Math.max(...latencies),
    mean: sum / latencies.length,
  };
}

/** Open-loop schedule: the i-th request is due at i * 60000 / perMinute ms after start. */
export function dueAtMs(index: number, perMinute: number): number {
  if (perMinute <= 0) throw new Error("perMinute must be positive");
  return (index * 60_000) / perMinute;
}

/** Highest average per-second rate over any `windowSeconds` consecutive one-second buckets. */
export function peakAverage(timestampsMs: number[], windowSeconds: number): number {
  const buckets = new Map<number, number>();
  for (const t of timestampsMs)
    buckets.set(Math.floor(t / 1000), (buckets.get(Math.floor(t / 1000)) ?? 0) + 1);
  const keys = [...buckets.keys()];
  if (keys.length === 0) return 0;
  const min = Math.min(...keys);
  const max = Math.max(...keys);
  let best = 0;
  for (let start = min; start <= max; start++) {
    let sum = 0;
    for (let k = start; k < start + windowSeconds; k++) sum += buckets.get(k) ?? 0;
    best = Math.max(best, sum / windowSeconds);
  }
  return best;
}

/** Highest count of events falling in any one-second bucket. */
export function maxPerSecond(timestampsMs: number[]): number {
  const buckets = new Map<number, number>();
  let max = 0;
  for (const t of timestampsMs) {
    const k = Math.floor(t / 1000);
    const n = (buckets.get(k) ?? 0) + 1;
    buckets.set(k, n);
    if (n > max) max = n;
  }
  return max;
}

export type Criterion = { name: string; ok: boolean; detail: string };

export type WebhookRun = {
  sent: number;
  replayed: number;
  non2xx: number;
  networkErrors: number;
  ingress: LatencySummary;
  messagesExpected: number;
  messagesFound: number;
  unprocessedRows: number;
  erroredRows: number;
  queueDepth: number | null;
  drainSeconds: number;
};

export const WEBHOOK_CRITERIA = { ingressP95Ms: 500, drainWithinSeconds: 120 } as const;

export function evaluateWebhookRun(r: WebhookRun, c = WEBHOOK_CRITERIA): Criterion[] {
  const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : "n/a");
  return [
    {
      name: "all requests accepted",
      ok: r.non2xx === 0 && r.networkErrors === 0,
      detail: `${r.non2xx} non-2xx, ${r.networkErrors} network errors of ${r.sent + r.replayed}`,
    },
    {
      name: `ingress p95 < ${c.ingressP95Ms} ms`,
      ok: r.ingress.p95 < c.ingressP95Ms,
      detail: `p50 ${fmt(r.ingress.p50)}, p95 ${fmt(r.ingress.p95)}, p99 ${fmt(r.ingress.p99)}`,
    },
    {
      name: "no events lost",
      ok: r.messagesFound >= r.messagesExpected,
      detail: `${r.messagesFound}/${r.messagesExpected} messages stored`,
    },
    {
      name: "no duplicates (replayed events did not create extra messages)",
      ok: r.messagesFound <= r.messagesExpected,
      detail: `${r.messagesFound} stored for ${r.messagesExpected} unique ids (${r.replayed} replays)`,
    },
    {
      name: "every webhook row processed",
      ok: r.unprocessedRows === 0 && r.erroredRows === 0,
      detail: `${r.unprocessedRows} unprocessed, ${r.erroredRows} with errors`,
    },
    {
      name: "queue drained",
      ok: r.queueDepth === 0 || r.queueDepth === null,
      detail: r.queueDepth === null ? "depth not available" : `${r.queueDepth} left`,
    },
    {
      name: `drained within ${c.drainWithinSeconds} s of the last event`,
      ok: r.drainSeconds <= c.drainWithinSeconds,
      detail: `${r.drainSeconds.toFixed(1)} s`,
    },
  ];
}

export type OutboundRun = {
  total: number;
  sent: number;
  failed: number;
  stillQueued: number;
  seconds: number;
  configuredRatePerSec: number;
  /** What the bulk lane may use (bulkSlotCap(limit)); the sustained rate should match this. */
  expectedRatePerSec: number;
  observedMaxPerSec: number | null;
  /** Rate averaged over the busiest 10 s, from the mock's per-second counts (null if unavailable). */
  observedPeak10sAvg: number | null;
  deadLetters: number;
  slowestTickMs: number;
  maxDurationMs: number;
};

export function evaluateOutboundRun(r: OutboundRun): Criterion[] {
  const achieved = r.seconds > 0 ? (r.sent + r.failed) / r.seconds : 0;
  return [
    {
      name: "every message reached a final state",
      ok: r.stillQueued === 0,
      detail: `${r.sent} sent, ${r.failed} failed, ${r.stillQueued} still queued of ${r.total}`,
    },
    {
      name: "nothing dead-lettered",
      ok: r.deadLetters === 0,
      detail: `${r.deadLetters} dead letters`,
    },
    {
      // claim_send_slot counts per wall-clock second, so two adjacent seconds can each fill up:
      // the true worst case in any 1 s window is 2x the limit. Keep the number's Meta throughput
      // (80 msg/s by default) above 2x send_rate_per_sec. A 10 s window can straddle 11 such
      // seconds (12 with clock skew between the app and the mock), hence the 1.2x allowance.
      name: "per-number limit holds (1 s peak <= 2x limit, busiest 10 s average <= 1.2x the bulk cap)",
      ok:
        (r.observedMaxPerSec === null || r.observedMaxPerSec <= r.configuredRatePerSec * 2) &&
        (r.observedPeak10sAvg === null || r.observedPeak10sAvg <= r.expectedRatePerSec * 1.2),
      detail: `1 s peak ${r.observedMaxPerSec ?? "n/a"} (limit ${r.configuredRatePerSec}/s), 10 s avg ${r.observedPeak10sAvg?.toFixed(1) ?? "n/a"} (bulk cap ${r.expectedRatePerSec}/s)`,
    },
    {
      name: "throughput within 25% of the bulk cap",
      ok: r.stillQueued > 0 ? false : achieved >= r.expectedRatePerSec * 0.75,
      detail: `${achieved.toFixed(1)} msg/s achieved vs bulk cap ${r.expectedRatePerSec}`,
    },
    {
      name: `no job tick exceeded the ${Math.round(r.maxDurationMs / 1000)} s function limit`,
      ok: r.slowestTickMs < r.maxDurationMs,
      detail: `slowest tick ${Math.round(r.slowestTickMs)} ms`,
    },
  ];
}

export function renderCriteria(title: string, criteria: Criterion[]): string {
  return [
    `### ${title}`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...criteria.map((c) => `| ${c.name} | ${c.ok ? "PASS" : "**FAIL**"} | ${c.detail} |`),
    "",
  ].join("\n");
}
