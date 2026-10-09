/**
 * Static security audit (Phase 11). Pure functions over source text so they can be
 * unit-tested and reused by scripts/audit-security.ts and tests/unit/security-static.test.ts.
 *
 * It answers three questions for every server action module and route handler:
 *   1. Does each exported entry point authenticate/authorise before it can reach the service role?
 *   2. Does each mutating entry point write an audit_log row?
 *   3. Can anything sensitive leak through client bundles or logs?
 */

export const AUTHZ_PATTERN = /\b(requirePerm|assertCan|canAll|canAny|can)\s*\(/;
export const AUTHN_PATTERN =
  /\b(requireMember|getCurrentMember|getCurrentUser|secretMatches|verifyMetaSignature)\s*\(|auth\.getUser\s*\(/;
export const MUTATION_PATTERN =
  /\.(insert|update|delete|upsert)\s*\(|\.rpc\s*\(\s*["'`](?!contacts_|contact_duplicate|job_queue|job_cron|rate_limit_hit)/;
export const AUDIT_PATTERN = /\brecordAudit\s*\(/;
export const ADMIN_IMPORT_PATTERN = /from\s+["']@\/lib\/supabase\/admin["']/;

export type FnInfo = {
  name: string;
  exported: boolean;
  text: string;
};

export type EntryReport = {
  file: string;
  name: string;
  authz: boolean;
  authn: boolean;
  mutates: boolean;
  audited: boolean;
};

export type FileReport = {
  file: string;
  kind: "action" | "route";
  usesAdmin: boolean;
  entries: EntryReport[];
};

/** Splits a module into top-level function declarations (function / async function / export …). */
export function splitFunctions(src: string): FnInfo[] {
  const re = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm;
  const marks: Array<{ index: number; name: string; exported: boolean }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    marks.push({ index: m.index, name: m[2], exported: !!m[1] });
  }
  return marks.map((mk, i) => ({
    name: mk.name,
    exported: mk.exported,
    text: src.slice(mk.index, i + 1 < marks.length ? marks[i + 1].index : src.length),
  }));
}

/** The function's own text plus every local function it calls, transitively. */
export function effectiveText(fn: FnInfo, all: FnInfo[]): string {
  const byName = new Map(all.map((f) => [f.name, f]));
  const seen = new Set<string>([fn.name]);
  const queue = [fn];
  let text = "";
  while (queue.length) {
    const cur = queue.pop()!;
    text += "\n" + cur.text;
    for (const other of byName.values()) {
      if (seen.has(other.name)) continue;
      if (new RegExp(`\\b${other.name}\\s*[(<]`).test(cur.text)) {
        seen.add(other.name);
        queue.push(other);
      }
    }
  }
  return text;
}

export function analyzeFile(file: string, src: string): FileReport | null {
  const isAction = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*["']use server["']/.test(src);
  const isRoute = /(^|\/)app\/api\/.+\/route\.ts$/.test(file);
  if (!isAction && !isRoute) return null;

  const fns = splitFunctions(src);
  const entries = fns
    .filter((f) => f.exported)
    .filter((f) => isAction || /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(f.name))
    .map((f): EntryReport => {
      const text = effectiveText(f, fns);
      return {
        file,
        name: f.name,
        authz: AUTHZ_PATTERN.test(text),
        authn: AUTHN_PATTERN.test(text),
        mutates: MUTATION_PATTERN.test(text),
        audited: AUDIT_PATTERN.test(text),
      };
    });
  return { file, kind: isAction ? "action" : "route", usesAdmin: ADMIN_IMPORT_PATTERN.test(src), entries };
}

/** Client components must never reach the service role, crypto or secret-bearing modules. */
export function clientLeaks(file: string, src: string): string[] {
  if (!/^\s*["']use client["']/m.test(src.slice(0, 200))) return [];
  const bad: Array<[RegExp, string]> = [
    [/@\/lib\/supabase\/admin/, "imports the service-role client"],
    [/@\/lib\/crypto/, "imports lib/crypto"],
    [/channel_secrets/, "references channel_secrets"],
    [/process\.env\.(META_SYSTEM_USER_TOKEN|META_APP_SECRET|SUPABASE_SERVICE_ROLE_KEY|JOB_SECRET|ENCRYPTION_KEY|ANTHROPIC_API_KEY|RESEND_API_KEY)/, "reads a server secret from process.env"],
    [/@\/lib\/env["']/, "imports lib/env (server env)"],
  ];
  return bad.filter(([re]) => re.test(src)).map(([, why]) => `${file}: ${why}`);
}

/** console.* calls whose arguments mention token/secret/password/body/phone-like identifiers. */
export function sensitiveLogs(file: string, src: string): string[] {
  const out: string[] = [];
  const re = /console\.(?:log|info|warn|error|debug)\s*\(([\s\S]*?)\);/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const args = m[1];
    if (/\b(token|secret|password|authorization|message_body|body|text_body|phone_e164|e164|payload)\b\s*[:,}]/i.test(args) || /\b(token|secret|password)\b\s*\)/i.test(args)) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push(`${file}:${line}: logs a sensitive-looking field`);
    }
  }
  return out;
}
