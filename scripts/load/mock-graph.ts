/**
 * Local stand-in for the WhatsApp Cloud API, for load tests only.
 *
 *   pnpm tsx scripts/load/mock-graph.ts --port 4010 --latency-ms 80 --fail-rate 0.01
 *   # run the app with META_GRAPH_BASE_URL=http://127.0.0.1:4010 (loopback only is honoured)
 *
 * POST /<version>/<phone_number_id>/messages → { messages: [{ id }] }, or a Meta-style error
 *   for --fail-rate of requests (code 131026, undeliverable; permanent).
 * Template management (offline happy path for Phase 4, in-memory, nothing leaves the process):
 *   POST   /<v>/<waba>/message_templates        → { id, status: "PENDING", category }
 *   GET    /<v>/<waba>/message_templates        → { data: [...] }
 *   GET    /<v>/<template_id>                   → one template
 *   POST   /<v>/<template_id>                   → edit components / category → { success }
 *   DELETE /<v>/<waba>/message_templates?name=  → { success }
 *   POST   /<v>/<app_id>/uploads, /<v>/upload:<id> → resumable sample upload → { h: "4::MOCK…" }
 *   POST   /__templates/<id>/status?status=APPROVED|REJECTED → what a Meta review would do
 *     (then `pnpm wa:simulate template-status-update --template-id <id> --template-name <name>`
 *      to deliver the webhook the app actually reacts to).
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

type MockTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: unknown;
  parameter_format?: string;
};
const templates = new Map<string, MockTemplate>();
let tplSeq = 0;
let uploadSeq = 0;

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const metaError = (message: string, code: number, subcode?: number) => ({
  error: { message, type: "OAuthException", code, error_subcode: subcode, fbtrace_id: "MOCK" },
});

/** Returns true when the request was a template/upload route and has been answered. */
async function templateRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
): Promise<boolean> {
  const u = new URL(url, "http://mock");
  const path = u.pathname;
  const method = req.method ?? "GET";

  let m = /^\/__templates\/([^/]+)\/status$/.exec(path);
  if (m && method === "POST") {
    const t = templates.get(m[1]);
    if (!t) return (send(res, 404, metaError("Unknown template", 100)), true);
    t.status = (u.searchParams.get("status") ?? "APPROVED").toUpperCase();
    return (send(res, 200, { id: t.id, name: t.name, status: t.status }), true);
  }
  if (path === "/__templates" && method === "GET")
    return (send(res, 200, { data: [...templates.values()] }), true);

  m = /^\/[^/]+\/([^/]+)\/message_templates$/.exec(path);
  if (m) {
    if (method === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "");
      const language = String(body.language ?? "");
      if (!/^[a-z0-9_]{1,512}$/.test(name))
        return (send(res, 400, metaError("Invalid parameter: name", 100, 2388023)), true);
      for (const t of templates.values())
        if (t.name === name && t.language === language)
          return (
            send(res, 400, metaError("Content in this language already exists", 100, 2388024)),
            true
          );
      const id = String(300000000100000 + ++tplSeq);
      const category = String(body.category ?? "UTILITY");
      templates.set(id, {
        id,
        name,
        language,
        category,
        status: "PENDING",
        components: body.components ?? [],
        parameter_format: body.parameter_format as string | undefined,
      });
      return (send(res, 200, { id, status: "PENDING", category }), true);
    }
    if (method === "GET")
      return (send(res, 200, { data: [...templates.values()], paging: {} }), true);
    if (method === "DELETE") {
      const name = u.searchParams.get("name");
      let n = 0;
      for (const [id, t] of templates) {
        if (t.name !== name) continue;
        templates.delete(id);
        n++;
      }
      return (send(res, n ? 200 : 404, n ? { success: true } : metaError("Not found", 100)), true);
    }
  }

  m = /^\/[^/]+\/(\d+)\/uploads$/.exec(path);
  if (m && method === "POST") {
    req.resume();
    return (send(res, 200, { id: `upload:MOCK_${++uploadSeq}` }), true);
  }
  m = /^\/[^/]+\/(upload:[^/]+)$/.exec(path);
  if (m && method === "POST") {
    req.resume(); // sample bytes intentionally ignored
    return (req.on("end", () => send(res, 200, { h: `4::MOCK_HANDLE_${uploadSeq}` })), true);
  }

  m = /^\/[^/]+\/(\d{6,})$/.exec(path);
  if (m && templates.has(m[1])) {
    const t = templates.get(m[1])!;
    if (method === "GET") return (send(res, 200, t), true);
    if (method === "POST") {
      const body = await readJson(req);
      if (body.components) t.components = body.components;
      if (typeof body.category === "string") t.category = body.category;
      t.status = "PENDING";
      return (send(res, 200, { success: true }), true);
    }
  }
  return false;
}

let stamps: number[] = [];
let ok = 0;
let failed = 0;
let seq = 0;

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  if (await templateRoutes(req, res, url)) return;
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
