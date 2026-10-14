import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GLOSSARY, glossaryEntry } from "@/lib/help/glossary";

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("glossary", () => {
  it("covers at least fifteen finance and accounting terms in plain, short words", () => {
    const entries = Object.entries(GLOSSARY);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    for (const [k, e] of entries) {
      expect(k, k).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(e.term.length, k).toBeGreaterThan(1);
      expect(e.meaning.length, k).toBeGreaterThan(20);
      expect(e.meaning.length, k).toBeLessThanOrEqual(160);
      expect(e.meaning.endsWith("."), k).toBe(true);
    }
  });

  it("looks terms up safely", () => {
    expect(glossaryEntry("accrual")?.term).toBe("Accrual");
    expect(glossaryEntry("toString")).toBeNull();
    expect(glossaryEntry("nope")).toBeNull();
  });

  it("every <Term k> in the app names a glossary entry, and accounting reports use it", () => {
    const used = new Set<string>();
    for (const f of files(join(process.cwd(), "app")))
      for (const m of readFileSync(f, "utf8").matchAll(/<Term k="([^"]+)"/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThanOrEqual(4);
    for (const k of used) expect(glossaryEntry(k), k).not.toBeNull();
  });
});
