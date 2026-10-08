#!/usr/bin/env node
/**
 * Maps supabase-js's `/rest/v1/*` prefix onto a plain PostgREST so the
 * supabase-js code paths can be tested without the full Supabase stack.
 *
 *   node supabase/test/rest-proxy.mjs [listenPort=3998] [postgrestUrl=http://127.0.0.1:3999]
 *   export TEST_POSTGREST_URL=http://127.0.0.1:3998
 */
import http from "node:http";

const listenPort = Number(process.argv[2] ?? 3998);
const target = new URL(process.argv[3] ?? "http://127.0.0.1:3999");

http
  .createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/";
    const headers = { ...req.headers, host: target.host };
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `rest-proxy: ${err.message}` }));
    });
    req.pipe(upstream);
  })
  .listen(listenPort, "127.0.0.1", () => {
    console.log(`rest-proxy: http://127.0.0.1:${listenPort}/rest/v1 → ${target.origin}`);
  });
