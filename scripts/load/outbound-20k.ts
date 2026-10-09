/**
 * 20,000-recipient send, standing in for a campaign until Phase 7 exists: creates synthetic
 * contacts + conversations, queues one template message each on `outbound` (the lane campaigns
 * will use), then drives /api/jobs/outbound on a pg_cron-like cadence against the mock Graph API
 * and checks that every message ends in a final state without ever exceeding the per-number limit.
 *
 *   # terminal 1
 *   pnpm tsx scripts/load/mock-graph.ts --port 4010 --latency-ms 80 --fail-rate 0.01
 *   # terminal 2: the app, started with META_GRAPH_BASE_URL=http://127.0.0.1:4010 META_SYSTEM_USER_TOKEN=mock ENCRYPTION_KEY=...
 *   # terminal 3
 *   pnpm load:outbound --yes-staging --count 20000 --rate 20 --phone-number-id 100000000000001
 *
 * Options: --org <slug>  --count N (≤ 49,999)  --rate msgs/sec for the run (the channel's
 * send_rate_per_sec is set for the run and restored)  --template <name>  --tick-seconds 10
 * --timeout-minutes 45  --mock http://127.0.0.1:4010  --cleanup  --report <file>.
 * Writes synthetic data; refuses to run without --yes-staging.
 */
import "dotenv/config";

import fs from "node:fs";

import { evaluateOutboundRun, renderCriteria, type OutboundRun } from "../../lib/load/stats";
import { bulkSlotCap } from "../../lib/jobs/pacing";
import {
  MAX_SYNTHETIC_PER_DIRECTION,
  OUTBOUND_OFFSET,
  syntheticE164,
} from "../../lib/load/synthetic";
import { adminFromEnv, resolveOrg } from "../import/common";
import { parseCli } from "./args";

const { flags, opts } = parseCli(process.argv.slice(2));
const CHUNK = 500;

async function inChunks<T>(items: T[], size: number, fn: (chunk: T[], i: number) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size), i / size);
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function main() {
  if (!flags.has("yes-staging"))
    throw new Error(
      "Refusing to run: this writes synthetic data. Re-run with --yes-staging against staging/local only.",
    );
  const jobSecret = process.env.JOB_SECRET;
  if (!jobSecret) throw new Error("JOB_SECRET is required");
  const base = (opts.url ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const mock = (opts.mock ?? "http://127.0.0.1:4010").replace(/\/$/, "");
  const count = Number(opts.count ?? 20000);
  if (count < 1 || count > MAX_SYNTHETIC_PER_DIRECTION)
    throw new Error(`--count must be 1..${MAX_SYNTHETIC_PER_DIRECTION}`);
  const rate = Number(opts.rate ?? 20);
  const tickSeconds = Number(opts["tick-seconds"] ?? 10);
  const timeoutMs = Number(opts["timeout-minutes"] ?? 45) * 60_000;
  const phoneNumberId = opts["phone-number-id"] ?? "100000000000001";
  const runId = Date.now().toString(36);
  const marker = `LOADTEST ${runId}`;

  const admin = adminFromEnv();
  const org = await resolveOrg(admin, opts.org);
  const { data: channel } = await admin
    .from("channels")
    .select("id, send_rate_per_sec")
    .eq("org_id", org.id)
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  if (!channel) throw new Error(`channel ${phoneNumberId} not found in org ${org.slug}`);
  const tplQuery = admin
    .from("wa_templates")
    .select("id, name")
    .eq("org_id", org.id)
    .eq("status", "APPROVED")
    .limit(1);
  const { data: tpls } = await (opts.template ? tplQuery.eq("name", opts.template) : tplQuery);
  const template = tpls?.[0];
  if (!template) throw new Error("no APPROVED template found (pass --template <name>)");
  const mockOk = await fetch(`${mock}/__stats`).then(
    (r) => r.ok,
    () => false,
  );
  if (!mockOk)
    throw new Error(
      `mock Graph API not reachable at ${mock}; start scripts/load/mock-graph.ts first`,
    );
  await fetch(`${mock}/__reset`, { method: "POST" });

  console.log(
    `run ${runId}: ${count} recipients, template "${template.name}", ${rate} msg/s on channel ${phoneNumberId}`,
  );
  const originalRate = channel.send_rate_per_sec;
  await admin.from("channels").update({ send_rate_per_sec: rate }).eq("id", channel.id);
  const startedAt = new Date().toISOString();

  try {
    // ---- setup: contacts → conversations → messages → queue
    const indexes = Array.from({ length: count }, (_, i) => i);
    const contactIds: string[] = [];
    await inChunks(indexes, CHUNK, async (chunk) => {
      const { data, error } = await admin
        .from("contacts")
        .insert(
          chunk.map((i) => ({
            org_id: org.id,
            first_name: "Load",
            last_name: `Recipient ${i}`,
            phone_e164: syntheticE164(OUTBOUND_OFFSET + i),
            source: "load-test",
            label: marker,
            promotions_opt_in: true,
          })),
        )
        .select("id");
      if (error) throw new Error(`contacts insert: ${error.message}`);
      contactIds.push(...(data ?? []).map((r) => r.id));
    });
    const conversationIds: string[] = [];
    await inChunks(contactIds, CHUNK, async (chunk) => {
      const { data, error } = await admin
        .from("conversations")
        .insert(chunk.map((contact_id) => ({ org_id: org.id, channel_id: channel.id, contact_id })))
        .select("id");
      if (error) throw new Error(`conversations insert: ${error.message}`);
      conversationIds.push(...(data ?? []).map((r) => r.id));
    });
    const messageIds: string[] = [];
    const spec = { send: { type: "template", template_id: template.id, values: {} } };
    await inChunks(conversationIds, CHUNK, async (chunk) => {
      const { data, error } = await admin
        .from("messages")
        .insert(
          chunk.map((conversation_id) => ({
            org_id: org.id,
            conversation_id,
            direction: "out" as const,
            kind: "template" as const,
            body: marker,
            payload: spec,
            status: "queued" as const,
            at: new Date().toISOString(),
          })),
        )
        .select("id");
      if (error) throw new Error(`messages insert: ${error.message}`);
      messageIds.push(...(data ?? []).map((r) => r.id));
    });
    console.log(
      `created ${contactIds.length} contacts, ${conversationIds.length} conversations, ${messageIds.length} messages; queueing…`,
    );
    await pool(messageIds, 32, async (message_id) => {
      const { error } = await admin.rpc("job_enqueue", {
        p_queue: "outbound",
        p_payload: { message_id },
        p_delay: 0,
      });
      if (error) throw new Error(`enqueue: ${error.message}`);
    });

    // ---- drive: pg_cron-like ticks, fired on schedule even if the previous one is still running
    const tickDurations: number[] = [];
    const inflight = new Set<Promise<void>>();
    const fireTick = () => {
      const t = performance.now();
      const p = fetch(`${base}/api/jobs/outbound`, {
        method: "POST",
        headers: { "X-Job-Secret": jobSecret, "Content-Type": "application/json" },
        body: "{}",
      })
        .then((r) => r.arrayBuffer())
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          tickDurations.push(performance.now() - t);
          inflight.delete(p);
        });
      inflight.add(p);
    };
    const countStatus = async (status: string) => {
      const { count: c } = await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("body", marker)
        .eq("status", status);
      return c ?? 0;
    };

    const t0 = performance.now();
    let lastTick = -Infinity;
    let lastLog = 0;
    for (;;) {
      if (performance.now() - lastTick >= tickSeconds * 1000) {
        fireTick();
        lastTick = performance.now();
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (performance.now() - lastLog > 15_000) {
        lastLog = performance.now();
        const [q, s, snt, f] = await Promise.all(
          ["queued", "sending", "sent", "failed"].map(countStatus),
        );
        console.log(
          `${Math.round((performance.now() - t0) / 1000)}s: queued ${q} sending ${s} sent ${snt} failed ${f}`,
        );
        if (q + s === 0) break;
      }
      if (performance.now() - t0 > timeoutMs) break;
    }
    await Promise.all([...inflight]);
    const seconds = (performance.now() - t0) / 1000;

    // ---- verify
    const [queued, sending, sent, failed] = await Promise.all(
      ["queued", "sending", "sent", "failed"].map(countStatus),
    );
    const { count: dead } = await admin
      .from("dead_letters")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startedAt);
    const stats = (await fetch(`${mock}/__stats`)
      .then((r) => r.json())
      .catch(() => null)) as { maxPerSecond: number; peak10sAvg: number } | null;
    const run: OutboundRun = {
      total: count,
      sent,
      failed,
      stillQueued: queued + sending,
      seconds,
      configuredRatePerSec: rate,
      expectedRatePerSec: bulkSlotCap(rate),
      observedMaxPerSec: stats?.maxPerSecond ?? null,
      observedPeak10sAvg: stats?.peak10sAvg ?? null,
      deadLetters: dead ?? 0,
      slowestTickMs: Math.max(0, ...tickDurations),
      maxDurationMs: 60_000,
    };
    const criteria = evaluateOutboundRun(run);
    const md = [
      `## 20k outbound — run ${runId}`,
      "",
      `- ${count} template messages on \`outbound\`, ${rate} msg/s per number, ${tickSeconds} s tick cadence, ${tickDurations.length} ticks, mock Graph latency/failure per its flags`,
      "",
      renderCriteria("Result", criteria),
    ].join("\n");
    console.log("\n" + md);
    if (opts.report) fs.writeFileSync(opts.report, md + "\n");
    if (criteria.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    await admin.from("channels").update({ send_rate_per_sec: originalRate }).eq("id", channel.id);
    if (flags.has("cleanup")) {
      const { error } = await admin
        .from("contacts")
        .delete()
        .eq("org_id", org.id)
        .eq("source", "load-test")
        .like("label", "LOADTEST %");
      console.log(
        error
          ? `cleanup failed: ${error.message}`
          : "cleanup: synthetic contacts (and their conversations/messages) deleted",
      );
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
