/**
 * Export Airtable schema (bases → tables → fields → views) for the Al Das bases.
 * SCHEMA ONLY — no records. Output: docs/audit/airtable-raw/<baseId>.json
 *
 * Setup:
 *   1. Airtable → Developer hub → Personal access tokens → create token
 *      Scopes: schema.bases:read   (add data.records:read ONLY for the import step later)
 *      Access: the Al Das bases listed below
 *   2. echo "AIRTABLE_PAT=pat..." >> .env.local
 *   3. pnpm tsx scripts/export-airtable-schema.ts
 */
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const PAT = process.env.AIRTABLE_PAT;
if (!PAT) throw new Error("AIRTABLE_PAT missing");

// Al Das bases identified in the audit (docs/audit/airtable-schema.md)
const BASES: Record<string, string> = {
  app7QJ2pvhADHQeBP: "Unite",
  appkOnjPr1SMD83CP: "Campaigns - Message Log",
  appH2jHpsNR1nqEQ2: "Acute Clinical Follow-Up Automation",
  appVsJVw5jjj5YiMp: "Clinical Follow-Up & Care Automation",
  appZbwlQvkuaUsF2l: "Patient Treatment & Follow-Up System",
};

const OUT = path.join(process.cwd(), "docs/audit/airtable-raw");
fs.mkdirSync(OUT, { recursive: true });

async function api(url: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${PAT}` } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 30_000)); continue; } // Airtable: 5 req/s per base
    if (!res.ok) throw new Error(`${res.status} ${url} ${await res.text()}`);
    return res.json();
  }
  throw new Error(`rate limited: ${url}`);
}

for (const [baseId, name] of Object.entries(BASES)) {
  // Meta API: tables incl. fields (with options, links, descriptions) and views
  const schema = await api(`https://api.airtable.com/v0/meta/bases/${baseId}/tables?include=visibleFieldIds`);
  const file = path.join(OUT, `${baseId}.json`);
  fs.writeFileSync(file, JSON.stringify({ baseId, name, exportedAt: new Date().toISOString(), ...schema }, null, 2));
  const tables = schema.tables as any[];
  console.log(`✔ ${name}: ${tables.length} tables, ${tables.reduce((n, t) => n + t.fields.length, 0)} fields → ${file}`);
  await new Promise(r => setTimeout(r, 300));
}

// Optional: record COUNTS only (needs data.records:read) — useful for migration sizing, still no PHI written
if (process.argv.includes("--counts")) {
  for (const [baseId] of Object.entries(BASES)) {
    const { tables } = JSON.parse(fs.readFileSync(path.join(OUT, `${baseId}.json`), "utf8"));
    for (const t of tables) {
      let count = 0, offset: string | undefined;
      do {
        const u = new URL(`https://api.airtable.com/v0/${baseId}/${t.id}`);
        u.searchParams.set("pageSize", "100");
        u.searchParams.append("fields[]", t.primaryFieldId);
        if (offset) u.searchParams.set("offset", offset);
        const page = await api(u.toString());
        count += page.records.length; offset = page.offset;
        await new Promise(r => setTimeout(r, 220));
      } while (offset);
      console.log(`  ${baseId} / ${t.name}: ${count} records`);
    }
  }
}
