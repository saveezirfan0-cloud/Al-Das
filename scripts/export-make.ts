/**
 * Export Make.com scenarios + blueprints (secrets & sample data REDACTED), data-store structures,
 * and webhooks for the Al Das Clinic org. Output: docs/audit/make-raw/
 *
 * Setup:
 *   1. Make → Profile → API access → Add token
 *      Scopes: scenarios:read, datastores:read, hooks:read, teams:read, organizations:read
 *   2. echo "MAKE_API_TOKEN=..." >> .env.local
 *      (zone us2, team 1494412 — from the audit; override with MAKE_ZONE / MAKE_TEAM_ID)
 *   3. pnpm tsx scripts/export-make.ts            # active scenarios only
 *      pnpm tsx scripts/export-make.ts --all      # every scenario
 *
 * NEVER export data-store RECORDS (the Token store holds live Unite credentials).
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const TOKEN = process.env.MAKE_API_TOKEN;
if (!TOKEN) throw new Error("MAKE_API_TOKEN missing");
const ZONE = process.env.MAKE_ZONE ?? "us2";
const TEAM = process.env.MAKE_TEAM_ID ?? "1494412";
const BASE = `https://${ZONE}.make.com/api/v2`;
const OUT = path.join(process.cwd(), "docs/audit/make-raw");
fs.mkdirSync(OUT, { recursive: true });

async function api(p: string) {
  const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Token ${TOKEN}` } });
  if (!res.ok) throw new Error(`${res.status} ${p} ${await res.text()}`);
  return res.json();
}

const SECRET_KEY = /(token|authorization|api[_-]?key|apikey|password|secret|bearer|app_key|app_id|client_secret|access_key)/i;
function redact(o: any): any {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "samples") continue;                                   // sample bundles contain patient data
      if (typeof v === "string" && SECRET_KEY.test(k)) { out[k] = "[REDACTED]"; continue; }
      if ((k === "headers" || k === "qs") && Array.isArray(v)) {
        out[k] = v.map((h: any) => (h && SECRET_KEY.test(String(h.name)) ? { ...h, value: "[REDACTED]" } : redact(h)));
        continue;
      }
      out[k] = redact(v);
    }
    return out;
  }
  if (typeof o === "string") {
    return o
      .replace(/(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, "$1[REDACTED]")
      .replace(/("?(?:app_id|app_key|client_id|client_secret|api_key|password)"?\s*[:=]\s*\{?\{?(?:encodeURL\()?\\?"?)[^"&}\s]{6,}/gi, "$1[REDACTED]")
      .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-.]+/g, "[REDACTED_JWT]")
      .replace(/[A-Za-z0-9+/]{30,}={1,2}[A-Za-z0-9+/=]*/g, "[REDACTED_B64]");
  }
  return o;
}

function summarise(flow: any[], depth = 0, lines: string[] = []): string[] {
  for (const m of flow ?? []) {
    const p = m.mapper ?? {}, pa = m.parameters ?? {};
    const bits = [p.url && `url=${String(p.url).split("?")[0]}`, p.method && `method=${p.method}`,
      (pa.base ?? p.base) && `base=${pa.base ?? p.base}`, (pa.table ?? p.table) && `table=${pa.table ?? p.table}`,
      pa.datastore && `datastore=${pa.datastore}`].filter(Boolean);
    const name = m.metadata?.designer?.name;
    lines.push(`${"  ".repeat(depth)}- [${m.id}] ${m.module}${name ? ` «${name}»` : ""}${m.filter?.name ? ` (filter: ${m.filter.name})` : ""}${bits.length ? ": " + bits.join("; ") : ""}`);
    for (const r of m.routes ?? []) { lines.push(`${"  ".repeat(depth + 1)}↳ route`); summarise(r.flow, depth + 2, lines); }
  }
  return lines;
}

const all = process.argv.includes("--all");
const { scenarios } = await api(`/scenarios?teamId=${TEAM}&pg[limit]=500`);
fs.writeFileSync(path.join(OUT, "scenarios_list.json"), JSON.stringify(scenarios, null, 2));
const index: string[] = ["| id | name | active | trigger | ops |", "|---|---|---|---|---|"];

for (const s of scenarios) {
  const active = s.islinked && !s.isPaused;
  index.push(`| ${s.id} | ${s.name} | ${active ? "ON" : "off"} | ${s.hookId ? "webhook" : s.scheduling?.type} | ${s.operations ?? ""} |`);
  if (!active && !all) continue;
  const { response } = await api(`/scenarios/${s.id}/blueprint`);
  const bp = response?.blueprint ?? response;
  const safe = `${s.id}_${s.name}`.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 80);
  fs.writeFileSync(path.join(OUT, `${safe}.blueprint.redacted.json`), JSON.stringify(redact(bp), null, 2));
  fs.writeFileSync(path.join(OUT, `${safe}.summary.md`), `### ${s.name} (id ${s.id})\n${summarise(bp.flow).join("\n")}\n`);
  console.log(`✔ ${s.name}`);
}
fs.writeFileSync(path.join(OUT, "INDEX.md"), index.join("\n") + "\n");

// Data stores: structure only (never records)
const { dataStores } = await api(`/data-stores?teamId=${TEAM}`);
fs.writeFileSync(path.join(OUT, "data_stores.json"),
  JSON.stringify(dataStores.map((d: any) => ({ id: d.id, name: d.name, records: d.records, datastructureId: d.datastructureId })), null, 2));

// Webhooks: names + linked scenario (URLs are secrets-ish: keep out of git)
const { hooks } = await api(`/hooks?teamId=${TEAM}`);
fs.writeFileSync(path.join(OUT, "hooks.json"),
  JSON.stringify(hooks.map((h: any) => ({ id: h.id, name: h.name, typeName: h.typeName, scenarioId: h.scenarioId, enabled: h.enabled })), null, 2));

console.log(`Done → ${OUT}. Commit the redacted files only; add docs/audit/make-raw/hooks.json to .gitignore if unsure.`);
