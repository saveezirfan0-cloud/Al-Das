/**
 * Webhook burst: POST signed synthetic Meta events to the ingress at a fixed rate, replay a
 * slice to prove idempotency, drain meta_events the way pg_cron does, then verify nothing was
 * lost or duplicated.
 *
 *   pnpm load:webhook --yes-staging --rate 1000 --minutes 1 [--phone-number-id 100000000000001]
 *       [--per-post 1] [--senders 200] [--replay-pct 5] [--concurrency 64] [--tick-seconds 10]
 *       [--url http://localhost:3000] [--report docs/audit/load-webhook.md]
 *
 * Needs APP_URL, META_APP_SECRET, JOB_SECRET and Supabase service-role env (the same as the app).
 * Writes synthetic contacts/conversations/messages into the target org, so it refuses to run
 * without --yes-staging: point it at a staging project or local stack, never at production.
 */
import "dotenv/config";

import { createHmac } from "node:crypto";
import fs from "node:fs";

import {
  dueAtMs,
  evaluateWebhookRun,
  renderCriteria,
  summarize,
  type WebhookRun,
} from "../../lib/load/stats";
import { chunkIndexes, MAX_SYNTHETIC_PER_DIRECTION, messageEvent } from "../../lib/load/synthetic";
import { adminFromEnv } from "../import/common";
import { parseCli } from "./args";

const { flags, opts } = parseCli(process.argv.slice(2));

async function main() {
  if (!flags.has("yes-staging")) {
    throw new Error(
      "Refusing to run: this writes synthetic data. Re-run with --yes-staging against staging/local only.",
    );
  }
  const secret = process.env.META_APP_SECRET;
  const jobSecret = process.env.JOB_SECRET;
  if (!secret || !jobSecret) throw new Error("META_APP_SECRET and JOB_SECRET are required");
  const base = (opts.url ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const perMinute = Number(opts.rate ?? 1000);
  const minutes = Number(opts.minutes ?? 1);
  const perPost = Math.max(1, Number(opts["per-post"] ?? 1));
  const senders = Math.min(MAX_SYNTHETIC_PER_DIRECTION, Number(opts.senders ?? 200));
  const replayPct = Number(opts["replay-pct"] ?? 5);
  const concurrency = Number(opts.concurrency ?? 64);
  const tickSeconds = Number(opts["tick-seconds"] ?? 10);
  const phoneNumberId = opts["phone-number-id"] ?? "100000000000001";
  const wabaId = opts.waba ?? "200000000000001";
  const runId = Date.now().toString(36);
  const totalMessages = Math.round(perMinute * minutes);
  const posts = chunkIndexes(totalMessages, perPost);
  const postsPerMinute = perMinute / perPost;

  const admin = adminFromEnv();
  const startedAt = new Date().toISOString();
  console.log(
    `run ${runId}: ${totalMessages} messages in ${posts.length} POSTs at ${postsPerMinute.toFixed(0)} POST/min against ${base}`,
  );

  const signedFetch = async (body: string) => {
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}/api/webhooks/meta`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
        body,
      });
      await res.arrayBuffer();
      return { ms: performance.now() - t0, status: res.status, net: false };
    } catch {
      return { ms: performance.now() - t0, status: 0, net: true };
    }
  };

  // pg_cron fires a drain tick every N seconds for the whole run, whether or not the last one finished.
  let ticks = 0;
  const inflightTicks = new Set<Promise<void>>();
  const fireTick = () => {
    ticks++;
    const p = fetch(`${base}/api/jobs/meta_events`, {
      method: "POST",
      headers: { "X-Job-Secret": jobSecret, "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.arrayBuffer())
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => inflightTicks.delete(p));
    inflightTicks.add(p);
  };
  fireTick();
  const timer = setInterval(fireTick, tickSeconds * 1000);

  // ---- phase 1: open-loop send (late requests are not delayed further, which keeps the offered load honest)
  const latencies: number[] = [];
  let non2xx = 0;
  let networkErrors = 0;
  let inFlight = 0;
  const bodies = posts.map((idx) =>
    JSON.stringify(messageEvent({ runId, phoneNumberId, wabaId, indexes: idx, senders })),
  );
  const t0 = performance.now();
  const pending: Promise<void>[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const wait = dueAtMs(i, postsPerMinute) - (performance.now() - t0);
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    while (inFlight >= concurrency) await new Promise((r) => setTimeout(r, 2));
    inFlight++;
    pending.push(
      signedFetch(bodies[i]).then((r) => {
        inFlight--;
        latencies.push(r.ms);
        if (r.net) networkErrors++;
        else if (r.status < 200 || r.status >= 300) non2xx++;
      }),
    );
  }
  await Promise.all(pending);
  const sendSeconds = (performance.now() - t0) / 1000;
  console.log(`sent ${posts.length} POSTs in ${sendSeconds.toFixed(1)} s`);

  // ---- phase 2: replay a slice (Meta retries). Must not create extra messages.
  const replayCount = Math.floor((posts.length * replayPct) / 100);
  const replayLatencies: number[] = [];
  for (let i = 0; i < replayCount; i += concurrency) {
    const batch = bodies.slice(i, Math.min(i + concurrency, replayCount));
    const rs = await Promise.all(batch.map(signedFetch));
    for (const r of rs) {
      replayLatencies.push(r.ms);
      if (r.net) networkErrors++;
      else if (r.status < 200 || r.status >= 300) non2xx++;
    }
  }

  // ---- phase 3: keep ticking until every webhook row is processed; drain time is measured from the last event
  const drainStart = performance.now();
  const pendingRows = async () => {
    const { count } = await admin
      .from("webhook_events_in")
      .select("id", { count: "exact", head: true })
      .gte("received_at", startedAt)
      .is("processed_at", null);
    return count ?? 0;
  };
  const backlogAtEnd = await pendingRows();
  console.log(`backlog when the last event arrived: ${backlogAtEnd} unprocessed webhook rows`);
  const maxDrainMs = Number(opts["max-drain-seconds"] ?? 600) * 1000;
  while (performance.now() - drainStart < maxDrainMs) {
    if ((await pendingRows()) === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  clearInterval(timer);
  await Promise.all([...inflightTicks]);
  const drainSeconds = (performance.now() - drainStart) / 1000;

  // ---- phase 4: verify
  const { count: found } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .like("wa_message_id", `wamid.LOAD_${runId}_%`);
  const { count: unprocessed } = await admin
    .from("webhook_events_in")
    .select("id", { count: "exact", head: true })
    .gte("received_at", startedAt)
    .is("processed_at", null);
  const { count: errored } = await admin
    .from("webhook_events_in")
    .select("id", { count: "exact", head: true })
    .gte("received_at", startedAt)
    .not("error", "is", null);
  const { data: metrics } = await admin.rpc("job_queue_metrics");
  const depth =
    (metrics as Array<{ queue_name: string; queue_length: number }> | null)?.find(
      (m) => m.queue_name === "meta_events",
    )?.queue_length ?? null;

  const run: WebhookRun = {
    sent: posts.length,
    replayed: replayCount,
    non2xx,
    networkErrors,
    ingress: summarize(latencies),
    messagesExpected: totalMessages,
    messagesFound: found ?? 0,
    unprocessedRows: unprocessed ?? 0,
    erroredRows: errored ?? 0,
    queueDepth: depth,
    drainSeconds,
  };
  const criteria = evaluateWebhookRun(run);
  const md = [
    `## Webhook burst — run ${runId}`,
    "",
    `- Offered load: ${perMinute}/min for ${minutes} min (${perPost} message(s) per POST), ${replayCount} replayed POSTs, ${senders} synthetic senders`,
    `- Target: ${base}; ${ticks} job ticks fired every ${tickSeconds} s; backlog when the last event arrived: ${backlogAtEnd} rows`,
    `- Replay latency p95: ${summarize(replayLatencies).p95?.toFixed?.(0) ?? "n/a"} ms`,
    "",
    renderCriteria("Result", criteria),
  ].join("\n");
  console.log("\n" + md);
  if (opts.report) fs.writeFileSync(opts.report, md + "\n");
  if (flags.has("cleanup"))
    console.log(
      "cleanup: synthetic contacts use source 'whatsapp' and the +971500 9xxxxx block; remove them with the staging reset (see docs/load-test.md).",
    );
  if (criteria.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
