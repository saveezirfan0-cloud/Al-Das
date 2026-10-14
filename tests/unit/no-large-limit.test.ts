import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PostgREST caps every response at `max_rows` (1,000; supabase/config.toml and the hosted default), so a
 * `.limit(n)` above 1,000 silently returns 1,000 rows and any sum, count, export or sweep built on it is wrong.
 * Read every row with `fetchAll` (lib/supabase/fetch-all.ts) instead, or keep a display list at <= 1,000.
 * No allow-list on purpose.
 */
const ROOT = path.resolve(__dirname, "../..");
const SCAN = ["app", "lib"];
const MAX_ROWS = 1000;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every `.limit(<numeric literal>)` above MAX_ROWS in `src`, as "line: text". */
function largeLimits(src: string): string[] {
  const hits: string[] = [];
  const re = /\.limit\(\s*([0-9][0-9_]*)\s*[,)]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const n = Number(m[1].replace(/_/g, ""));
    if (n > MAX_ROWS) {
      const line = src.slice(0, m.index).split("\n").length;
      hits.push(`${line}: .limit(${m[1]})`);
    }
  }
  return hits;
}

describe("no .limit() above PostgREST max_rows", () => {
  it("detects large literals, including numeric separators and line breaks", () => {
    expect(largeLimits(`q.limit(5000)`)).toEqual(["1: .limit(5000)"]);
    expect(largeLimits(`q\n  .limit(\n    20_000,\n  )`)).toEqual(["2: .limit(20_000)"]);
    expect(largeLimits(`q.limit(1000); q.limit(1_000); q.limit(50); q.limit(PAGE)`)).toEqual([]);
  });

  it("finds none in app/ and lib/", () => {
    const offenders: string[] = [];
    for (const dir of SCAN) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        for (const hit of largeLimits(readFileSync(file, "utf8")))
          offenders.push(`${path.relative(ROOT, file)}:${hit}`);
      }
    }
    expect(
      offenders,
      `PostgREST returns at most ${MAX_ROWS} rows per request; page with fetchAll (lib/supabase/fetch-all.ts) or keep the limit <= ${MAX_ROWS}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
