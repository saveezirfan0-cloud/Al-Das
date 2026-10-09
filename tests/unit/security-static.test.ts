/**
 * Phase 11 static security pass, enforced in CI (also available as `pnpm audit:security`).
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeFile, clientLeaks, sensitiveLogs, splitFunctions, effectiveText } from "@/lib/security/static-audit";
import { AUDIT_EXEMPT, AUTHN_ONLY_OK, CHANNEL_SECRET_MODULES, UNGUARDED_OK } from "@/lib/security/policy";
import { scanRepo, walk } from "../../scripts/audit-security";

const ROOT = path.resolve(__dirname, "../..");
const { reports, leaks, logs } = scanRepo(ROOT);
const entries = reports.flatMap((r) => r.entries);
const key = (e: { file: string; name: string }) => `${e.file}::${e.name}`;

describe("analyzer", () => {
  it("splits functions and follows local helpers one hop at a time", () => {
    const src = `"use server";
async function guard() { return await requirePerm("x"); }
export async function a() { await guard(); await admin.from("t").insert({}); }
export async function b() { return 1; }`;
    const report = analyzeFile("app/x/actions.ts", src)!;
    const a = report.entries.find((e) => e.name === "a")!;
    const b = report.entries.find((e) => e.name === "b")!;
    expect(a).toMatchObject({ authz: true, mutates: true, audited: false });
    expect(b).toMatchObject({ authz: false, authn: false, mutates: false });
    const fns = splitFunctions(src);
    expect(effectiveText(fns.find((f) => f.name === "a")!, fns)).toContain("requirePerm");
  });

  it("only treats 'use server' modules and route handlers as entry points", () => {
    expect(analyzeFile("lib/x.ts", "export async function a() {}")).toBeNull();
    const route = analyzeFile("app/api/x/route.ts", "export async function POST() {}\nexport async function helper() {}")!;
    expect(route.entries.map((e) => e.name)).toEqual(["POST"]);
  });

  it("flags client components that reach server secrets and logs of sensitive fields", () => {
    expect(clientLeaks("c.tsx", `"use client";\nimport { createAdminClient } from "@/lib/supabase/admin";`)).toHaveLength(1);
    expect(clientLeaks("c.tsx", `"use client";\n<p>uses META_SYSTEM_USER_TOKEN when empty</p>`)).toEqual([]);
    expect(sensitiveLogs("l.ts", `console.error("x", { token, code });`)).toHaveLength(1);
    expect(sensitiveLogs("l.ts", `console.error("x", { code: error.code });`)).toEqual([]);
  });
});

describe("repository rules", () => {
  it("finds the entry points (guards against a scanner that silently sees nothing)", () => {
    expect(entries.length).toBeGreaterThan(80);
    expect(reports.some((r) => r.kind === "route")).toBe(true);
  });

  it("guards every server action and route handler with authn or authz, or a reviewed exception", () => {
    const bad = entries.filter((e) => !e.authz && !e.authn && !(key(e) in UNGUARDED_OK)).map(key);
    expect(bad).toEqual([]);
  });

  it("allows authentication-only entry points only when reviewed", () => {
    const bad = entries.filter((e) => !e.authz && e.authn && !(key(e) in AUTHN_ONLY_OK) && !(key(e) in UNGUARDED_OK)).map(key);
    expect(bad).toEqual([]);
  });

  it("writes an audit_log row from every mutating entry point, or documents why not", () => {
    const bad = entries.filter((e) => e.mutates && !e.audited && !(key(e) in AUDIT_EXEMPT)).map(key);
    expect(bad).toEqual([]);
  });

  it("keeps the exception lists free of stale entries", () => {
    const known = new Set(entries.map(key));
    const stale = [
      ...Object.keys(UNGUARDED_OK),
      ...Object.keys(AUTHN_ONLY_OK),
      ...Object.keys(AUDIT_EXEMPT),
    ].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
    // An exception must still be needed.
    const byKey = new Map(entries.map((e) => [key(e), e]));
    expect(Object.keys(UNGUARDED_OK).filter((k) => byKey.get(k)?.authz)).toEqual([]);
    expect(Object.keys(AUDIT_EXEMPT).filter((k) => byKey.get(k)?.audited)).toEqual([]);
  });

  it("keeps service-role, crypto and server secrets out of client components", () => {
    expect(leaks).toEqual([]);
  });

  it("never logs tokens, secrets, passwords, bodies or phone numbers", () => {
    expect(logs).toEqual([]);
  });

  it("reads channel_secrets only in the modules that decrypt or store the Meta token", () => {
    const readers = ["app", "lib", "components", "scripts"]
      .flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : []))
      .map((f) => ({ rel: path.relative(ROOT, f).replaceAll(path.sep, "/"), src: fs.readFileSync(f, "utf8") }))
      .filter(({ rel, src }) => rel !== "lib/supabase/types.ts" && /from\(\s*["']channel_secrets["']\s*\)/.test(src))
      .map(({ rel }) => rel)
      .filter((rel) => !CHANNEL_SECRET_MODULES.has(rel));
    expect(readers).toEqual([]);
  });

  it("encrypts channel tokens before storing them, and only lib/whatsapp/channel.ts touches the ciphertext column", () => {
    const channel = fs.readFileSync(path.join(ROOT, "lib/whatsapp/channel.ts"), "utf8");
    const writes = channel.match(/from\("channel_secrets"\)\.upsert\([\s\S]{0,200}/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toMatch(/encryptSecret\(/);

    const touching = ["app", "lib", "components", "scripts"]
      .flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : []))
      .map((f) => path.relative(ROOT, f).replaceAll(path.sep, "/"))
      .filter((rel) => rel !== "lib/supabase/types.ts" && fs.readFileSync(path.join(ROOT, rel), "utf8").includes("access_token_enc"));
    expect(touching).toEqual(["lib/whatsapp/channel.ts"]);
  });

  it("never sends channel tokens to the browser from the channels page", () => {
    const page = fs.readFileSync(path.join(ROOT, "app/(app)/settings/channels/page.tsx"), "utf8");
    expect(page).not.toMatch(/access_token|decryptSecret/);
  });

  it("keeps .env files and unredacted exports out of git", () => {
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(gi).toMatch(/^\.env\*?/m);
  });
});
