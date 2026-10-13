#!/usr/bin/env node
/**
 * Run REA (Reverse Engineer Anything) against Sanoflow from YOUR machine.
 *
 * Why local: REA attaches over the Chrome DevTools Protocol to a browser that
 * you start and log into yourself. Nothing here types a password or reads cookies.
 *
 *   node tools/rea-sanoflow.mjs                 # clone+build REA if needed, open Chrome, wait for login, capture
 *   node tools/rea-sanoflow.mjs --rea ~/code/rea --out ~/rea-sanoflow-evidence
 *   node tools/rea-sanoflow.mjs --routes /flow,/campaigns --observe-ms 20000
 *
 * Output (outside any git repo by default):
 *   <out>/raw/<route>.inspect.json   full REA Evidence (may contain live data in URLs, keep private)
 *   <out>/raw/<route>.bundle.json    REA static bundle analysis
 *   <out>/sanoflow-rea-shapes.json   PHI-free summary: request paths (no query), JSON response
 *                                    SHAPES (paths + types, never values), WebSocket shapes,
 *                                    bundle endpoints/routes. This is the file to commit to
 *                                    docs/audit/ in the Al-Das repo.
 *
 * Requires Node 22+, git, and Google Chrome / Chromium / Edge installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);
const BASE = (args.base || "https://app.sanoflow.io").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const PORT = Number(args.port || 9222);
const CDP = `http://127.0.0.1:${PORT}`;
const REA_DIR = resolve((args.rea || join(homedir(), "rea")).replace(/^~/, homedir()));
const REA_GIT = args["rea-git"] || "https://github.com/saveezirfan0-cloud/rea.git";
const OUT = resolve((args.out || join(homedir(), "rea-sanoflow-evidence")).replace(/^~/, homedir()));
const OBSERVE_MS = Number(args["observe-ms"] || 12000);
const ROUTES = (args.routes ||
  [
    "/dashboard", "/appointments", "/contacts", "/enquiries", "/tasks", "/chat-inbox",
    "/chat-inbox/failed-messages", "/campaigns", "/campaigns/new-campaigns", "/templates", "/flow",
    "/reports", "/settings/account/notification", "/settings/company/users",
    "/settings/company/integrations", "/settings/company/knowledgebase",
    "/settings/platform/enquiries", "/settings/platform/inbox", "/settings/platform/appointments",
  ].join(",")).split(",").map((r) => r.trim()).filter(Boolean);

const sh = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { stdio: "inherit", shell: platform() === "win32", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(" ")} failed (${r.status})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log("[rea-sanoflow]", ...m);

// 1. REA: clone + build from your GitHub fork if not present
function ensureRea() {
  const cli = join(REA_DIR, "scripts", "rea.mjs");
  if (!existsSync(cli)) {
    log(`cloning REA into ${REA_DIR}`);
    sh("git", ["clone", "--depth", "1", REA_GIT, REA_DIR]);
  }
  if (!existsSync(join(REA_DIR, "node_modules"))) sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: REA_DIR });
  if (!existsSync(join(REA_DIR, "dist"))) sh("npm", ["run", "build:cached"], { cwd: REA_DIR });
  return cli;
}
function rea(cli, a) {
  const r = spawnSync(process.execPath, [cli, ...a, "--format", "json"], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`rea ${a[0]} failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return JSON.parse(r.stdout);
}
const reaAsync = (cli, a) =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, [cli, ...a, "--format", "json"]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`rea ${a[0]}: ${(err || out).slice(0, 600)}`))));
  });

// 2. Chrome with a debugging port on loopback and a separate profile
function findChrome() {
  if (args.chrome) return args.chrome;
  const c = {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    win32: [`${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  }[platform()] || [];
  const f = c.find((p) => p && existsSync(p));
  if (!f) throw new Error("Chrome not found; pass --chrome <path>");
  return f;
}
async function cdpUp() {
  try { return (await fetch(`${CDP}/json/version`)).ok; } catch { return false; }
}
async function ensureChrome() {
  if (await cdpUp()) return log(`using the Chrome already listening on ${CDP}`);
  const profile = join(OUT, "chrome-profile");
  mkdirSync(profile, { recursive: true });
  const extra = platform() === "linux" ? ["--password-store=basic"] : [];
  if (args.headless) extra.push("--headless=new", "--no-sandbox");
  spawn(findChrome(), [`--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, ...extra, `${BASE}/login`], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40 && !(await cdpUp()); i++) await sleep(250);
  if (!(await cdpUp())) throw new Error("Chrome did not open its debugging port");
}

// Minimal CDP client (Node 22 has a global WebSocket) – only Page.navigate is sent
async function navigate(target, url) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
  await new Promise((r) => { ws.onmessage = (m) => { if (JSON.parse(m.data).id === 1) r(); }; });
  ws.close();
}
async function sanoflowTab() {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  return tabs.find((t) => t.type === "page" && t.url.startsWith(ORIGIN));
}

// 3. PHI-free projection of REA Evidence
const noQuery = (u) => { try { const x = new URL(u); return x.origin === ORIGIN ? x.pathname : x.origin + x.pathname; } catch { return String(u).split("?")[0]; } };
function walk(o, fn, path = []) {
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, fn, [...path, i]));
  else if (o && typeof o === "object") { fn(o, path); for (const [k, v] of Object.entries(o)) walk(v, fn, [...path, k]); }
}
function summarise(route, inspect, bundle) {
  const n = inspect?.normalized_result ?? {};
  const requests = new Map();
  for (const r of n.network?.requests ?? []) {
    const key = `${r.method ?? r.request?.method ?? "GET"} ${noQuery(r.url ?? r.request?.url ?? "")}`;
    const e = requests.get(key) ?? { count: 0, status: new Set(), mime: new Set() };
    e.count++; if (r.status ?? r.response?.status) e.status.add(r.status ?? r.response?.status);
    if (r.mime_type ?? r.response?.mime_type) e.mime.add(r.mime_type ?? r.response?.mime_type);
    requests.set(key, e);
  }
  // Collect every JSON / WebSocket shape REA produced (paths + types only, never values)
  const shapes = [];
  walk(n, (o, p) => {
    const k = p.join(".");
    if (/shape/i.test(String(p.at(-1) ?? "")) && (Array.isArray(o) || typeof o === "object")) {
      const owner = p.slice(0, -1).reduce((a, s) => a?.[s], n);
      const flat = (side) => (side?.properties ?? []).map((pr) =>
        pr.path.map((s) => (s.kind === "array-element" ? "[]" : `.${s.name}`)).join("").replace(/^\./, "") + ":" + pr.types.join("|"));
      const req = flat(o.request), res = flat(o.response);
      if (req.length || res.length || !o.response) shapes.push({ at: k, url: owner?.url ? noQuery(owner.url) : undefined, request: req, response: res, status: o.status });
    }
  });
  const b = bundle?.normalized_result?.observations ?? {};
  return {
    route,
    captured_url: noQuery(n.target?.url ?? ""),
    completeness: n.completeness?.status ?? n.completeness,
    requests: [...requests].map(([k, v]) => ({ request: k, count: v.count, status: [...v.status], mime: [...v.mime] })),
    json_and_ws_shapes: [...new Map(shapes.map((s) => [`${s.url}|${s.request.join()}|${s.response.join()}`, s])).values()],
    bundle_endpoints: [...new Set((b.endpoints ?? []).map((e) => `${e.mechanism} ${noQuery(e.value)}`))],
    bundle_routes: [...new Set((b.routes ?? []).map((r) => r.value ?? r.path ?? JSON.stringify(r)))],
    scripts: (b.chunks?.nodes ?? []).map((s) => ({ url: noQuery(s.url), bytes: s.bytes })),
  };
}

async function main() {
  mkdirSync(join(OUT, "raw"), { recursive: true });
  const cli = ensureRea();
  // `rea doctor` reports unhealthy without Hopper/Ghidra; web capture needs neither, so only check the CLI starts.
  rea(cli, ["capabilities"]);
  log("REA CLI ready");
  await ensureChrome();
  if (!args["no-wait"]) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(`\nLog into Sanoflow in the Chrome window that opened (profile: ${OUT}/chrome-profile).\nPress Enter here when the dashboard is showing... `);
    rl.close();
  }
  const summary = { captured_at: new Date().toISOString(), base: ORIGIN, rea_dir: REA_DIR, routes: [] };
  for (const route of ROUTES) {
    const tab = await sanoflowTab();
    if (!tab) throw new Error(`no ${ORIGIN} tab is open in the debug Chrome`);
    log(`capturing ${route} (${OBSERVE_MS} ms)`);
    // Start REA's observation window, then navigate inside it so page-load requests are seen
    const inspectP = reaAsync(cli, ["inspect-web-page", CDP, tab.id, "--allowed-origins", ORIGIN, "--observation-ms", String(OBSERVE_MS),
      "--include-json-body-shapes", "--include-websocket-shapes", "--include-storage-keys"]);
    await sleep(1500);
    await navigate(tab, BASE + route);
    let inspect, bundle;
    try { inspect = await inspectP; } catch (e) { log("inspect failed:", e.message); }
    const tab2 = await sanoflowTab();
    try { bundle = await reaAsync(cli, ["analyze-web-bundle", CDP, tab2.id, "--allowed-origins", ORIGIN]); } catch (e) { log("bundle failed:", e.message); }
    const slug = route.replace(/\W+/g, "_").replace(/^_|_$/g, "") || "root";
    if (inspect) writeFileSync(join(OUT, "raw", `${slug}.inspect.json`), JSON.stringify(inspect));
    if (bundle) writeFileSync(join(OUT, "raw", `${slug}.bundle.json`), JSON.stringify(bundle));
    summary.routes.push(summarise(route, inspect, bundle));
    writeFileSync(join(OUT, "sanoflow-rea-shapes.json"), JSON.stringify(summary, null, 1));
  }
  log(`done. Commit ONLY ${join(OUT, "sanoflow-rea-shapes.json")} (to docs/audit/). Keep ${join(OUT, "raw")} private and delete it when finished.`);
  log("Close the debug Chrome yourself when you are done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
