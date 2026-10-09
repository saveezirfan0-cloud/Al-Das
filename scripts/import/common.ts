/**
 * Shared plumbing for the one-shot importers (scripts/import-*.ts):
 * env, a service-role client, org lookup, CLI args and the markdown report.
 * Reports never contain names, phones or message bodies (CLAUDE.md rule 10).
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import type { ImportSummary } from "@/lib/migration/reconcile";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

export function parseArgs(argv: string[]): { flags: Set<string>; opts: Record<string, string> } {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.slice(2).split("=");
    if (rest.length) opts[k] = rest.join("=");
    else flags.add(k);
  }
  return { flags, opts };
}

export function adminFromEnv(): AdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local)",
    );
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Resolves --org=<slug|uuid>; with exactly one org in the database it is picked automatically. */
export async function resolveOrg(
  admin: AdminClient,
  ref: string | undefined,
): Promise<{ id: string; slug: string; timezone: string }> {
  if (ref) {
    const q = admin.from("orgs").select("id, slug, timezone");
    const { data } = /^[0-9a-f-]{36}$/i.test(ref)
      ? await q.eq("id", ref).maybeSingle()
      : await q.eq("slug", ref).maybeSingle();
    if (!data) throw new Error(`org not found: ${ref}`);
    return data;
  }
  const { data } = await admin.from("orgs").select("id, slug, timezone").limit(2);
  if (!data || data.length !== 1) throw new Error("pass --org=<slug> (several workspaces exist)");
  return data[0];
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function writeReport(name: string, markdown: string): string {
  const dir = path.join(process.cwd(), "docs/audit");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `import-report-${name}-${nowStamp()}.md`);
  fs.writeFileSync(file, markdown);
  return file;
}

export function mdTable(headers: string[], rows: Array<Array<string | number>>): string {
  const line = (cells: Array<string | number>) => `| ${cells.map(String).join(" | ")} |`;
  return [line(headers), `|${headers.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Counters = {
  read: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  duplicates: number;
  review: number;
  failed: number;
};

export function counters(): Counters {
  return {
    read: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    invalid: 0,
    duplicates: 0,
    review: 0,
    failed: 0,
  };
}

/**
 * Machine-readable twin of the markdown report (counts only), read by `pnpm reconcile`.
 * One file per run: docs/audit/import-summary-<source>-<timestamp>.json
 */
export function writeSummary(source: string, summaries: ImportSummary[]): string {
  const dir = path.join(process.cwd(), "docs/audit");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `import-summary-${source}-${nowStamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, source, summaries }, null, 2) + "\n");
  return file;
}
