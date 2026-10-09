/**
 * Local stand-in for the WhatsApp Cloud API, for load tests only.
 *
 *   pnpm tsx scripts/load/mock-graph.ts --port 4010 --latency-ms 80 --fail-rate 0.01
 *   # run the app with META_GRAPH_BASE_URL=http://127.0.0.1:4010 (loopback only is honoured)
 *
 * POST /<version>/<phone_number_id>/messages → { messages: [{ id }] }, or a Meta-style error
 *   for --fail-rate of requests (code 131026, undeliverable; permanent).
 * GET  /__stats → totals and the busiest second (to prove the per-number limit held).
 * POST /__reset → clear counters.
 * Never forwards anything anywhere and never logs bodies or phone numbers.
 */
import http from "node:http";

import { maxPerSecond, peakAverage } from "../../lib/load/stats";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", "4010"));
const latencyMs = Number(arg("latency-ms", "80"));
const failRate = Number(arg("fail-rate", "0"));

let stamps: number[] = [];
let ok = 0;
let failed = 0;
let seq = 0;

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/__stats") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        total: ok + failed,
        ok,
        failed,
        maxPerSecond: maxPerSecond(stamps),
        peak10sAvg: peakAverage(stamps, 10),
      }),
    );
    return;
  }
  if (req.method === "POST" && url === "/__reset") {
    stamps = [];
    ok = failed = 0;
    res.end("{}");
    return;
  }
  if (req.method === "POST" && /\/messages$/.test(url)) {
    stamps.push(Date.now());
    req.resume(); // body intentionally ignored
    req.on("end", () => {
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        if (Math.random() < failRate) {
          failed++;
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error: {
                message: "(#131026) Message undeliverable",
                type: "OAuthException",
                code: 131026,
                fbtrace_id: "MOCK",
              },
            }),
          );
          return;
        }
        ok++;
        res.end(
          JSON.stringify({
            messaging_product: "whatsapp",
            contacts: [{ input: "x", wa_id: "x" }],
            messages: [{ id: `wamid.MOCK_${Date.now()}_${++seq}` }],
          }),
        );
      }, latencyMs);
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

server.listen(port, "127.0.0.1", () =>
  console.log(
    `mock graph on http://127.0.0.1:${port} (latency ${latencyMs} ms, fail rate ${failRate})`,
  ),
);
