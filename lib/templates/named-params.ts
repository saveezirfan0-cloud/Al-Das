/**
 * Named template variables (Meta `parameter_format: "NAMED"`): `{{first_name}}` instead of `{{1}}`.
 * Pure; unit-tested. The builder (lib/templates/builder.ts) uses these rules for named drafts only; positional
 * drafts keep their own, unchanged rules.
 *
 * Rules (Meta's, plus one of ours): a name is lower-case letters, digits and underscores and starts with a letter;
 * each name appears once per component (body, header); every name has an example. Names are capped at
 * PARAM_NAME_MAX characters so a mapping key such as `body.<name>` stays within the 60-character limit of
 * `saveTemplateVariableMap`.
 */

export const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const PARAM_NAME_MAX = 40;

/** Any `{{…}}` token, whatever is inside (so invalid names can be reported, not silently ignored). */
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

export type NamedIssue = { path: string; message: string };

/** Every token's inner text in order of appearance, repeats included. */
export function variableTokens(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1]);
}

export function isValidParamName(name: string): boolean {
  return PARAM_NAME_RE.test(name) && name.length <= PARAM_NAME_MAX;
}

/** Valid names used in a text, unique, in order of first appearance. */
export function variableNames(text: string): string[] {
  const out: string[] = [];
  for (const t of variableTokens(text)) if (isValidParamName(t) && !out.includes(t)) out.push(t);
  return out;
}

/** Turns anything into a valid name (falls back to "value"). */
export function sanitizeParamName(input: string): string {
  let n = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) return "value";
  if (!/^[a-z]/.test(n)) n = `v_${n}`;
  return n.slice(0, PARAM_NAME_MAX).replace(/_+$/, "");
}

/**
 * A readable name for a variable filled from `source` ("contact.first_name" → "first_name",
 * "appointment.date" → "appointment_date", "custom.policy_no" → "policy_no"), made unique against `taken`.
 */
export function suggestParamName(source: string | undefined, taken: readonly string[]): string {
  let base = "value";
  if (source && !source.startsWith("text:") && !source.startsWith("media:")) {
    const s = source.replace(/^(contact|custom)\./, "");
    base = sanitizeParamName(s.replace(/\./g, "_"));
  }
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const name = `${base.slice(0, PARAM_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.includes(name)) return name;
  }
}

/** Inserts `{{name}}` at `at`, replacing `replace` characters (e.g. the typed "@"). */
export function insertNamedVariable(
  text: string,
  at: number,
  name: string,
  replace = 0,
): { text: string; caret: number } {
  const token = `{{${name}}}`;
  const pos = Math.max(0, Math.min(at, text.length));
  return {
    text: text.slice(0, pos) + token + text.slice(pos + replace),
    caret: pos + token.length,
  };
}

/**
 * Checks the variables of one named component. `examples` gives the sample per name (body), or `headerExample`
 * the one sample of a header. `maxVars` limits how many names the component may hold (a header: 1).
 */
export function checkNamedVariables(
  text: string,
  path: string,
  opts: {
    examples?: Record<string, string>;
    headerExample?: string;
    examplePath: (name: string) => string;
    maxVars?: number;
  },
): NamedIssue[] {
  const issues: NamedIssue[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const t of variableTokens(text)) {
    if (/^\d+$/.test(t)) {
      if (!reported.has(t))
        issues.push({
          path,
          message: `Named templates use names such as {{first_name}}, not numbers ({{${t}}}).`,
        });
      reported.add(t);
      continue;
    }
    if (!PARAM_NAME_RE.test(t)) {
      if (!reported.has(t))
        issues.push({
          path,
          message: `“{{${t}}}” is not a valid name: use lower-case letters, digits and underscores, starting with a letter.`,
        });
      reported.add(t);
      continue;
    }
    if (t.length > PARAM_NAME_MAX) {
      if (!reported.has(t))
        issues.push({
          path,
          message: `Variable names are limited to ${PARAM_NAME_MAX} characters.`,
        });
      reported.add(t);
      continue;
    }
    if (seen.has(t)) {
      if (!reported.has(t))
        issues.push({ path, message: `Use each name once here; {{${t}}} appears more than once.` });
      reported.add(t);
      continue;
    }
    seen.add(t);
  }
  const names = [...seen];
  if (opts.maxVars !== undefined && names.length > opts.maxVars)
    issues.push({
      path,
      message:
        opts.maxVars === 1
          ? "The header can contain one variable."
          : `At most ${opts.maxVars} variables here.`,
    });
  for (const name of names) {
    const ex = opts.headerExample ?? opts.examples?.[name];
    if (!ex?.trim())
      issues.push({ path: opts.examplePath(name), message: `Give an example for {{${name}}}.` });
  }
  return issues;
}

/** Meta's `*_named_params` example list for a text, in order of first appearance. */
export function namedParamExamples(
  text: string,
  examples: Record<string, string>,
): Array<{ param_name: string; example: string }> {
  return variableNames(text).map((name) => ({
    param_name: name,
    example: (examples[name] ?? "").trim(),
  }));
}

/** Rewrites `{{n}}` tokens to names: `names[n - 1]` replaces `{{n}}`. Unknown numbers stay as they are. */
export function numbersToNames(text: string, names: readonly string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => {
    const name = names[Number(n) - 1];
    return name ? `{{${name}}}` : m;
  });
}

/** Rewrites valid `{{name}}` tokens to numbers in order of first appearance. */
export function namesToNumbers(text: string): { text: string; names: string[] } {
  const names = variableNames(text);
  const out = text.replace(TOKEN, (m, inner: string) => {
    const i = names.indexOf(inner);
    return i >= 0 ? `{{${i + 1}}}` : m;
  });
  return { text: out, names };
}
