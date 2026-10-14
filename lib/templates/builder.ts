/**
 * WhatsApp template builder core (pure, unit-tested): the editable draft, Meta's authoring
 * rules, conversion to Meta `components` and back. The UI, the server actions and the starter
 * gallery all go through these functions, so a template that validates here is one Meta
 * will accept structurally (content review is still Meta's call).
 */
import { z } from "zod";

import {
  checkNamedVariables,
  namedParamExamples,
  namesToNumbers,
  numbersToNames,
  suggestParamName,
  variableNames,
  variableTokens,
} from "@/lib/templates/named-params";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/** AUTHENTICATION (one-time code) templates use Meta's fixed wording; see `defaultAuth` and `authDisplayComponents`. */
export const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
export type BuilderCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_TYPES = ["standard", "media_interactive", "carousel"] as const;
export type BuilderType = (typeof TEMPLATE_TYPES)[number];

/** Positional `{{1}}` (the default) or named `{{first_name}}` variables (Meta `parameter_format`). */
export const PARAMETER_FORMATS = ["positional", "named"] as const;
export type ParameterFormat = (typeof PARAMETER_FORMATS)[number];

export const TEMPLATE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "ar", label: "Arabic" },
] as const;

export const LIMITS = {
  name: 512,
  body: 1024,
  headerText: 60,
  footer: 60,
  buttonText: 25,
  url: 2000,
  phone: 20,
  buttons: 10,
  urlButtons: 2,
  phoneButtons: 1,
  copyCodeButtons: 1,
  cardBody: 160,
  cardsMin: 2,
  cardsMax: 10,
  cardButtons: 2,
  copyCodeExample: 15,
  authExpiryMin: 1,
  authExpiryMax: 90,
} as const;

const button = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string() }),
  z.object({
    type: z.literal("URL"),
    text: z.string(),
    url: z.string(),
    /** Sample for the {{1}} suffix of a dynamic URL. */
    example: z.string().optional(),
  }),
  z.object({ type: z.literal("PHONE_NUMBER"), text: z.string(), phone_number: z.string() }),
  z.object({ type: z.literal("COPY_CODE"), example: z.string() }),
  /** Catalogue templates (marketing only): opens the product catalogue connected to the WhatsApp account. */
  z.object({ type: z.literal("CATALOG"), text: z.string() }),
]);
export type DraftButton = z.infer<typeof button>;

const header = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("text"), text: z.string(), example: z.string().optional() }),
  z.object({
    kind: z.literal("media"),
    format: z.enum(["IMAGE", "VIDEO", "DOCUMENT"]),
    /** Meta upload handle from the resumable upload API (the header sample). */
    handle: z.string().optional(),
    sampleName: z.string().optional(),
  }),
]);
export type DraftHeader = z.infer<typeof header>;

const card = z.object({
  format: z.enum(["IMAGE", "VIDEO"]),
  handle: z.string().optional(),
  sampleName: z.string().optional(),
  body: z.string(),
  buttons: z.array(button).max(LIMITS.cardButtons),
});
export type DraftCard = z.infer<typeof card>;

/** Authentication templates: Meta writes the text; the author only chooses these. */
const authSettings = z.object({
  /** Meta adds its fixed "keep this code private" sentence. */
  securityRecommendation: z.boolean(),
  /** Minutes until the code expires (1-90), shown by Meta in the footer; null for no footer. */
  codeExpiryMinutes: z.number().int().nullable(),
  /** Label of the copy-code button. */
  buttonText: z.string(),
});
export type AuthSettings = z.infer<typeof authSettings>;

export const draftSchema = z.object({
  name: z.string(),
  language: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES),
  type: z.enum(TEMPLATE_TYPES),
  header,
  body: z.string(),
  /** bodyExamples[i] is the sample for {{i+1}}. */
  bodyExamples: z.array(z.string()),
  footer: z.string(),
  buttons: z.array(button),
  cards: z.array(card),
  /** "body.1" → "contact.first_name" | "custom.x" | "text:…" — how campaigns/the inbox fill each variable. */
  variableMap: z.record(z.string(), z.string()),
  /** Absent means positional (every template before named variables existed). */
  parameterFormat: z.enum(PARAMETER_FORMATS).optional(),
  /** Named drafts: the example per body variable name (positional drafts use bodyExamples). */
  namedExamples: z.record(z.string(), z.string()).optional(),
  /** Set for AUTHENTICATION drafts. */
  auth: authSettings.optional(),
});
export type TemplateDraft = z.infer<typeof draftSchema>;

export function emptyDraft(overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: "",
    language: "en",
    category: "UTILITY",
    type: "standard",
    header: { kind: "none" },
    body: "",
    bodyExamples: [],
    footer: "",
    buttons: [],
    cards: [],
    variableMap: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

const VAR = /\{\{\s*(\d+)\s*\}\}/g;

/** Variable numbers used in a text, in order of first appearance. */
export function variableNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(VAR)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Next free number for an inserted variable. */
export function nextVariable(text: string): number {
  return variableNumbers(text).reduce((a, b) => Math.max(a, b), 0) + 1;
}

/** Inserts `{{n}}` at `at` (replacing `replace` characters, e.g. the typed "@"). */
export function insertVariable(
  text: string,
  at: number,
  replace = 0,
): { text: string; number: number; caret: number } {
  const n = nextVariable(text);
  const token = `{{${n}}}`;
  const pos = Math.max(0, Math.min(at, text.length));
  return {
    text: text.slice(0, pos) + token + text.slice(pos + replace),
    number: n,
    caret: pos + token.length,
  };
}

/** Wraps the selection in WhatsApp formatting markers (*bold*, _italic_, ~strike~, ```mono```). */
export function applyFormat(
  text: string,
  start: number,
  end: number,
  mark: "*" | "_" | "~" | "```",
): { text: string; start: number; end: number } {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.max(s, Math.max(start, end));
  const selected = text.slice(s, e);
  const out = text.slice(0, s) + mark + selected + mark + text.slice(e);
  return { text: out, start: s + mark.length, end: e + mark.length };
}

/** Drops examples for variables that no longer exist; keeps indexes aligned with {{n}}. */
export function alignExamples(body: string, examples: string[], fallback = "Sample"): string[] {
  const max = variableNumbers(body).reduce((a, b) => Math.max(a, b), 0);
  return Array.from({ length: max }, (_, i) => examples[i]?.trim() || fallback);
}

// ---------------------------------------------------------------------------
// Named variables and authentication templates
// ---------------------------------------------------------------------------

/** True when the draft's body and header use `{{name}}` variables. Authentication templates never do. */
export function usesNamedParams(d: TemplateDraft): boolean {
  return d.parameterFormat === "named" && d.category !== "AUTHENTICATION";
}

/** Meta's `parameter_format` for a create request (omitted for authentication templates). */
export function metaParameterFormat(d: TemplateDraft): "POSITIONAL" | "NAMED" | undefined {
  if (d.category === "AUTHENTICATION") return undefined;
  return usesNamedParams(d) ? "NAMED" : "POSITIONAL";
}

/** wa_templates.parameter_format for a draft. */
export function storedParameterFormat(d: TemplateDraft): ParameterFormat {
  return usesNamedParams(d) ? "named" : "positional";
}

/** Body variable keys of a draft ("body.1" or "body.first_name"), for the variable map. */
export function bodyVariableKeys(d: TemplateDraft): string[] {
  return usesNamedParams(d)
    ? variableNames(d.body).map((n) => `body.${n}`)
    : variableNumbers(d.body).map((n) => `body.${n}`);
}

/**
 * Switches a draft between numbered and named variables, keeping examples and the variable map. Names are
 * suggested from what fills each variable ("contact.first_name" becomes {{first_name}}).
 */
export function convertParameterFormat(d: TemplateDraft, to: ParameterFormat): TemplateDraft {
  const from: ParameterFormat = d.parameterFormat === "named" ? "named" : "positional";
  if (from === to) return d;
  const map = { ...d.variableMap };
  const move = (fromKey: string, toKey: string) => {
    if (fromKey in map) {
      map[toKey] = map[fromKey];
      delete map[fromKey];
    }
  };
  if (to === "named") {
    const max = variableNumbers(d.body).reduce((a, b) => Math.max(a, b), 0);
    const names: string[] = [];
    const namedExamples: Record<string, string> = {};
    for (let n = 1; n <= max; n++) {
      const name = suggestParamName(map[`body.${n}`], names);
      names.push(name);
      namedExamples[name] = d.bodyExamples[n - 1] ?? "";
      move(`body.${n}`, `body.${name}`);
    }
    let header = d.header;
    if (header.kind === "text" && variableNumbers(header.text).includes(1)) {
      const name = suggestParamName(map["header.1"], []);
      header = { ...header, text: numbersToNames(header.text, [name]) };
      move("header.1", `header.${name}`);
    }
    return {
      ...d,
      parameterFormat: "named",
      body: numbersToNames(d.body, names),
      bodyExamples: [],
      namedExamples,
      header,
      variableMap: map,
    };
  }
  const { text: body, names } = namesToNumbers(d.body);
  names.forEach((name, i) => move(`body.${name}`, `body.${i + 1}`));
  let header = d.header;
  if (header.kind === "text") {
    const h = namesToNumbers(header.text);
    if (h.names[0]) move(`header.${h.names[0]}`, "header.1");
    header = { ...header, text: h.text };
  }
  return {
    ...d,
    parameterFormat: "positional",
    body,
    bodyExamples: names.map((n) => d.namedExamples?.[n] ?? ""),
    namedExamples: undefined,
    header,
    variableMap: map,
  };
}

/**
 * Drops examples and mappings of variables that are no longer in the text (the media header mapping stays while
 * the header is media). Positional drafts come out exactly as before named variables existed.
 */
export function pruneDraft(d: TemplateDraft): TemplateDraft {
  const named = usesNamedParams(d);
  const keep = new Set(bodyVariableKeys(d));
  return {
    ...d,
    bodyExamples: alignExamples(d.body, d.bodyExamples, ""),
    ...(named
      ? {
          namedExamples: Object.fromEntries(
            variableNames(d.body).map((n) => [n, d.namedExamples?.[n] ?? ""]),
          ),
        }
      : {}),
    variableMap: Object.fromEntries(
      Object.entries(d.variableMap).filter(
        ([k]) => keep.has(k) || (k === "header.media" && d.header.kind === "media"),
      ),
    ),
  };
}

export const AUTH_DEFAULT_BUTTON = "Copy code";
/** Synthetic sample code Meta reviews (never a real one). */
export const AUTH_EXAMPLE_CODE = "482913";

export function defaultAuth(): AuthSettings {
  return { securityRecommendation: true, codeExpiryMinutes: 10, buttonText: AUTH_DEFAULT_BUTTON };
}

/**
 * Pulse's stand-in wording for the preview and the message log until a sync brings Meta's own text (Meta writes
 * the real message, in the template's language).
 */
export const AUTH_PREVIEW_TEXT = {
  body: "Your verification code is {{1}}.",
  security: "Keep it to yourself and never share it.",
  footer: (minutes: number) =>
    `This code stops working after ${minutes} minute${minutes === 1 ? "" : "s"}.`,
} as const;

/** What Meta's create call takes for an authentication template: no text, only the settings. */
function authCreateComponents(a: AuthSettings): MetaTemplateComponent[] {
  const out: MetaTemplateComponent[] = [
    { type: "BODY", add_security_recommendation: a.securityRecommendation },
  ];
  if (a.codeExpiryMinutes)
    out.push({ type: "FOOTER", code_expiration_minutes: a.codeExpiryMinutes });
  out.push({
    type: "BUTTONS",
    buttons: [
      { type: "OTP", otp_type: "COPY_CODE", text: a.buttonText.trim() || AUTH_DEFAULT_BUTTON },
    ],
  });
  return out;
}

/**
 * What Pulse stores for an authentication template (and previews): the same settings plus readable text with the
 * one `{{1}}` code variable, the shape a sync returns. The copy-code button is filled from that code at send time.
 */
export function authDisplayComponents(a: AuthSettings): MetaTemplateComponent[] {
  const body = a.securityRecommendation
    ? `${AUTH_PREVIEW_TEXT.body} ${AUTH_PREVIEW_TEXT.security}`
    : AUTH_PREVIEW_TEXT.body;
  const out: MetaTemplateComponent[] = [
    {
      type: "BODY",
      text: body,
      add_security_recommendation: a.securityRecommendation,
      example: { body_text: [[AUTH_EXAMPLE_CODE]] },
    },
  ];
  if (a.codeExpiryMinutes)
    out.push({
      type: "FOOTER",
      text: AUTH_PREVIEW_TEXT.footer(a.codeExpiryMinutes),
      code_expiration_minutes: a.codeExpiryMinutes,
    });
  out.push({
    type: "BUTTONS",
    buttons: [
      { type: "OTP", otp_type: "COPY_CODE", text: a.buttonText.trim() || AUTH_DEFAULT_BUTTON },
    ],
  });
  return out;
}

/** Reads the settings back from stored, created or synced authentication components. */
export function authFromComponents(components: MetaTemplateComponent[]): AuthSettings {
  const body = components.find((c) => c.type === "BODY") as
    { add_security_recommendation?: unknown } | undefined;
  const footer = components.find((c) => c.type === "FOOTER") as
    { text?: unknown; code_expiration_minutes?: unknown } | undefined;
  const buttons =
    (
      components.find((c) => c.type === "BUTTONS") as
        { buttons?: Array<{ type?: string; text?: string; url?: string }> } | undefined
    )?.buttons ?? [];
  let minutes: number | null = null;
  if (typeof footer?.code_expiration_minutes === "number") minutes = footer.code_expiration_minutes;
  else if (typeof footer?.text === "string") {
    const m = /\b(\d{1,2})\b/.exec(footer.text);
    if (m) minutes = Number(m[1]);
  }
  if (minutes !== null && (minutes < LIMITS.authExpiryMin || minutes > LIMITS.authExpiryMax))
    minutes = null;
  const otp = buttons.find(
    (b) => b.type === "OTP" || (b.type === "URL" && /whatsapp\.com\/otp\//i.test(b.url ?? "")),
  );
  return {
    securityRecommendation: body?.add_security_recommendation === true,
    codeExpiryMinutes: minutes,
    buttonText: otp?.text?.trim() || AUTH_DEFAULT_BUTTON,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Issue = { path: string; message: string };
export type ValidationResult = { errors: Issue[]; warnings: Issue[] };

const NAME_RE = /^[a-z0-9_]+$/;
const LANG_RE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;

function wordCount(text: string): number {
  return text.replace(VAR, " ").split(/\s+/).filter(Boolean).length;
}

function checkSequential(text: string, path: string, errors: Issue[]) {
  const nums = variableNumbers(text).sort((a, b) => a - b);
  nums.forEach((n, i) => {
    if (n !== i + 1)
      errors.push({
        path,
        message: `Variables must be numbered {{1}}, {{2}}, … without gaps (found {{${n}}}).`,
      });
  });
}

function checkButtons(
  buttons: DraftButton[],
  path: string,
  errors: Issue[],
  limits: { total: number; url: number; phone: number; copy: number },
) {
  if (buttons.length > limits.total)
    errors.push({ path, message: `At most ${limits.total} buttons.` });
  const count = (t: DraftButton["type"]) => buttons.filter((b) => b.type === t).length;
  if (count("URL") > limits.url)
    errors.push({ path, message: `At most ${limits.url} URL buttons.` });
  if (count("PHONE_NUMBER") > limits.phone)
    errors.push({ path, message: `At most ${limits.phone} call button.` });
  if (count("COPY_CODE") > limits.copy)
    errors.push({ path, message: `At most ${limits.copy} copy-code button.` });
  buttons.forEach((b, i) => {
    const p = `${path}.${i}`;
    if (b.type !== "COPY_CODE") {
      const t = b.text.trim();
      if (!t) errors.push({ path: `${p}.text`, message: "Button text is required." });
      else if (t.length > LIMITS.buttonText)
        errors.push({
          path: `${p}.text`,
          message: `Button text is limited to ${LIMITS.buttonText} characters.`,
        });
    }
    if (b.type === "URL") {
      if (!/^https:\/\//i.test(b.url.trim()))
        errors.push({ path: `${p}.url`, message: "URL must start with https://." });
      if (b.url.length > LIMITS.url) errors.push({ path: `${p}.url`, message: "URL is too long." });
      const vars = variableNumbers(b.url);
      if (vars.length > 1 || (vars.length === 1 && vars[0] !== 1))
        errors.push({ path: `${p}.url`, message: "A URL can only contain one variable, {{1}}." });
      if (vars.length === 1 && !b.url.trim().endsWith("{{1}}"))
        errors.push({ path: `${p}.url`, message: "The variable must be at the end of the URL." });
      if (vars.length === 1 && !b.example?.trim())
        errors.push({
          path: `${p}.example`,
          message: "Give an example value for the URL variable.",
        });
    }
    if (b.type === "PHONE_NUMBER" && !PHONE_RE.test(b.phone_number.trim()))
      errors.push({
        path: `${p}.phone_number`,
        message: "Use international format, e.g. +97143000000.",
      });
    if (b.type === "COPY_CODE") {
      if (!b.example.trim())
        errors.push({ path: `${p}.example`, message: "Give an example code." });
      else if (b.example.length > LIMITS.copyCodeExample)
        errors.push({
          path: `${p}.example`,
          message: `Example code is limited to ${LIMITS.copyCodeExample} characters.`,
        });
    }
  });
}

/** Authentication templates: Meta writes the text, so only the settings are checked. */
function validateAuth(d: TemplateDraft, errors: Issue[]) {
  const a = d.auth ?? defaultAuth();
  if (d.type === "carousel")
    errors.push({ path: "type", message: "Authentication templates can't be carousels." });
  const m = a.codeExpiryMinutes;
  if (m !== null && (!Number.isInteger(m) || m < LIMITS.authExpiryMin || m > LIMITS.authExpiryMax))
    errors.push({
      path: "auth.codeExpiryMinutes",
      message: `The code can expire after ${LIMITS.authExpiryMin} to ${LIMITS.authExpiryMax} minutes.`,
    });
  const t = a.buttonText.trim();
  if (!t) errors.push({ path: "auth.buttonText", message: "Button text is required." });
  else if (t.length > LIMITS.buttonText)
    errors.push({
      path: "auth.buttonText",
      message: `Button text is limited to ${LIMITS.buttonText} characters.`,
    });
}

/** Named body variables: names, uniqueness and examples, plus Meta's placement rules. */
function validateNamedBody(d: TemplateDraft, errors: Issue[], warnings: Issue[]) {
  const body = d.body;
  errors.push(
    ...checkNamedVariables(body, "body", {
      examples: d.namedExamples ?? {},
      examplePath: (name) => `namedExamples.${name}`,
    }),
  );
  const count = variableTokens(body).length;
  if (!count) return;
  if (/^\s*\{\{[^{}]*\}\}/.test(body))
    errors.push({ path: "body", message: "The body can't start with a variable." });
  if (/\{\{[^{}]*\}\}[\s.!?,:;。]*$/.test(body))
    errors.push({ path: "body", message: "The body can't end with a variable." });
  if (/\{\{[^{}]*\}\}\s*\{\{[^{}]*\}\}/.test(body))
    errors.push({ path: "body", message: "Variables can't sit next to each other." });
  const words = body
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  if (words < count * 3)
    warnings.push({
      path: "body",
      message: "Meta rejects templates with too many variables for their length. Add more text.",
    });
}

/** Meta's authoring rules. `errors` block submission; `warnings` are advice. */
export function validateDraft(d: TemplateDraft): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (!d.name) errors.push({ path: "name", message: "Name is required." });
  else if (!NAME_RE.test(d.name))
    errors.push({ path: "name", message: "Use lowercase letters, numbers and underscores only." });
  else if (d.name.length > LIMITS.name) errors.push({ path: "name", message: "Name is too long." });
  if (!LANG_RE.test(d.language)) errors.push({ path: "language", message: "Choose a language." });

  if (d.category === "AUTHENTICATION") {
    validateAuth(d, errors);
    return { errors, warnings };
  }
  const named = usesNamedParams(d);

  const body = d.body;
  if (!body.trim()) errors.push({ path: "body", message: "Body text is required." });
  if (body.length > LIMITS.body)
    errors.push({ path: "body", message: `Body is limited to ${LIMITS.body} characters.` });
  if (named) {
    validateNamedBody(d, errors, warnings);
  } else {
    checkSequential(body, "body", errors);
  }
  const bodyVars = named ? [] : variableNumbers(body);
  if (bodyVars.length) {
    if (/^\s*\{\{\s*\d+\s*\}\}/.test(body))
      errors.push({ path: "body", message: "The body can't start with a variable." });
    if (/\{\{\s*\d+\s*\}\}[\s.!?,:;。]*$/.test(body))
      errors.push({ path: "body", message: "The body can't end with a variable." });
    if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(body))
      errors.push({ path: "body", message: "Variables can't sit next to each other." });
    if (wordCount(body) < bodyVars.length * 3)
      warnings.push({
        path: "body",
        message: "Meta rejects templates with too many variables for their length. Add more text.",
      });
    bodyVars.forEach((n) => {
      if (!d.bodyExamples[n - 1]?.trim())
        errors.push({ path: `bodyExamples.${n - 1}`, message: `Give an example for {{${n}}}.` });
    });
  }
  if (/\n{3,}/.test(body) || /[ \t]{4,}/.test(body))
    warnings.push({ path: "body", message: "Avoid long runs of blank lines or spaces." });

  if (d.footer) {
    if (d.footer.length > LIMITS.footer)
      errors.push({ path: "footer", message: `Footer is limited to ${LIMITS.footer} characters.` });
    if (VAR.test(d.footer))
      errors.push({ path: "footer", message: "The footer can't contain variables." });
    else if (named && variableTokens(d.footer).length)
      errors.push({ path: "footer", message: "The footer can't contain variables." });
    VAR.lastIndex = 0;
  }

  if (d.type === "carousel") {
    if (named)
      errors.push({
        path: "parameterFormat",
        message: "Carousel templates use numbered variables ({{1}}).",
      });
    if (d.header.kind !== "none")
      errors.push({
        path: "header",
        message: "Carousel templates have no header; each card has its own media.",
      });
    if (d.buttons.length)
      errors.push({ path: "buttons", message: "Buttons belong on the cards of a carousel." });
    if (d.cards.length < LIMITS.cardsMin || d.cards.length > LIMITS.cardsMax)
      errors.push({
        path: "cards",
        message: `A carousel needs ${LIMITS.cardsMin}–${LIMITS.cardsMax} cards.`,
      });
    const first = d.cards[0];
    d.cards.forEach((c, i) => {
      const p = `cards.${i}`;
      if (!c.handle)
        errors.push({ path: `${p}.handle`, message: "Upload a sample image or video." });
      if (first && c.format !== first.format)
        errors.push({ path: `${p}.format`, message: "Every card must use the same media type." });
      if (!c.body.trim()) errors.push({ path: `${p}.body`, message: "Card text is required." });
      if (c.body.length > LIMITS.cardBody)
        errors.push({
          path: `${p}.body`,
          message: `Card text is limited to ${LIMITS.cardBody} characters.`,
        });
      if (variableNumbers(c.body).length)
        errors.push({ path: `${p}.body`, message: "Variables in card text aren't supported yet." });
      if (c.buttons.length === 0)
        errors.push({ path: `${p}.buttons`, message: "Add at least one button." });
      checkButtons(c.buttons, `${p}.buttons`, errors, {
        total: LIMITS.cardButtons,
        url: 2,
        phone: 1,
        copy: 0,
      });
      if (c.buttons.some((b) => b.type === "COPY_CODE"))
        errors.push({
          path: `${p}.buttons`,
          message: "Copy-code buttons aren't allowed on carousel cards.",
        });
      if (c.buttons.some((b) => b.type === "CATALOG"))
        errors.push({
          path: `${p}.buttons`,
          message: "Catalogue buttons aren't allowed on carousel cards.",
        });
      if (first && c.buttons.map((b) => b.type).join() !== first.buttons.map((b) => b.type).join())
        errors.push({
          path: `${p}.buttons`,
          message: "Every card needs the same button types in the same order.",
        });
    });
  } else {
    if (d.cards.length)
      errors.push({ path: "cards", message: "Cards are only for carousel templates." });
    if (d.header.kind === "text") {
      const t = d.header.text;
      if (!t.trim()) errors.push({ path: "header.text", message: "Header text is required." });
      if (t.length > LIMITS.headerText)
        errors.push({
          path: "header.text",
          message: `Header is limited to ${LIMITS.headerText} characters.`,
        });
      if (named) {
        errors.push(
          ...checkNamedVariables(t, "header.text", {
            headerExample: d.header.example ?? "",
            examplePath: () => "header.example",
            maxVars: 1,
          }),
        );
      } else {
        const hv = variableNumbers(t);
        if (hv.length > 1 || (hv.length === 1 && hv[0] !== 1))
          errors.push({
            path: "header.text",
            message: "The header can contain one variable, {{1}}.",
          });
        if (hv.length === 1 && !d.header.example?.trim())
          errors.push({
            path: "header.example",
            message: "Give an example for the header variable.",
          });
      }
    }
    if (d.header.kind === "media" && !d.header.handle)
      errors.push({ path: "header.handle", message: "Upload a sample file for the header." });
    if (d.type === "standard" && (d.header.kind === "media" || d.buttons.length))
      errors.push({
        path: "type",
        message: "Media headers and buttons need the “Media & interactive” type.",
      });
    checkButtons(d.buttons, "buttons", errors, {
      total: LIMITS.buttons,
      url: LIMITS.urlButtons,
      phone: LIMITS.phoneButtons,
      copy: LIMITS.copyCodeButtons,
    });
    if (d.buttons.some((b) => b.type === "CATALOG")) {
      if (d.category !== "MARKETING")
        errors.push({
          path: "buttons",
          message: "A catalogue button is only for marketing templates.",
        });
      if (d.buttons.length > 1)
        errors.push({
          path: "buttons",
          message: "A catalogue template has one button: the catalogue button.",
        });
      if (d.header.kind !== "none")
        errors.push({
          path: "header",
          message: "Catalogue templates have no header; WhatsApp shows a catalogue picture there.",
        });
    }
  }

  const allButtons = [...d.buttons, ...d.cards.flatMap((c) => c.buttons)];
  if (
    allButtons.some(
      (b) => b.type === "URL" && /^https:\/\/(www\.)?example\.(com|org)\b/i.test(b.url.trim()),
    )
  )
    warnings.push({
      path: "buttons",
      message: "A button still links to the placeholder example.com. Replace it before submitting.",
    });

  if (d.category === "MARKETING") {
    const optOut = /\bstop\b|unsubscribe|opt[ -]?out|إيقاف|ايقاف|إلغاء الاشتراك/i.test(
      `${d.footer} ${d.buttons.map((b) => ("text" in b ? b.text : "")).join(" ")}`,
    );
    if (!optOut)
      warnings.push({
        path: "footer",
        message:
          "Marketing messages should tell people how to opt out, e.g. footer “Reply STOP to unsubscribe”.",
      });
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Draft → Meta components
// ---------------------------------------------------------------------------

type MetaButton = Extract<MetaTemplateComponent, { type: "BUTTONS" }>["buttons"][number];

function toMetaButtons(buttons: DraftButton[]): MetaButton[] {
  // Meta wants like buttons grouped: call-to-action buttons first, then quick replies.
  const cta = buttons.filter((b) => b.type !== "QUICK_REPLY");
  const qr = buttons.filter((b) => b.type === "QUICK_REPLY");
  return [...cta, ...qr].map((b): MetaButton => {
    switch (b.type) {
      case "QUICK_REPLY":
        return { type: "QUICK_REPLY", text: b.text.trim() };
      case "URL":
        return variableNumbers(b.url).length
          ? { type: "URL", text: b.text.trim(), url: b.url.trim(), example: [exampleUrl(b)] }
          : { type: "URL", text: b.text.trim(), url: b.url.trim() };
      case "PHONE_NUMBER":
        return { type: "PHONE_NUMBER", text: b.text.trim(), phone_number: b.phone_number.trim() };
      case "COPY_CODE":
        return { type: "COPY_CODE", example: b.example.trim() };
      case "CATALOG":
        return { type: "CATALOG", text: b.text.trim() };
    }
  });
}

function exampleUrl(b: Extract<DraftButton, { type: "URL" }>): string {
  return b.url.trim().replace(/\{\{\s*1\s*\}\}/, (b.example ?? "").trim());
}

/** Builds Meta's `components` array. Call validateDraft first; this does not re-check. */
export function buildComponents(d: TemplateDraft): MetaTemplateComponent[] {
  if (d.category === "AUTHENTICATION") return authCreateComponents(d.auth ?? defaultAuth());
  const out: MetaTemplateComponent[] = [];
  const named = usesNamedParams(d);

  if (d.type !== "carousel") {
    if (d.header.kind === "text" && named) {
      const name = variableNames(d.header.text)[0];
      out.push({
        type: "HEADER",
        format: "TEXT",
        text: d.header.text.trim(),
        ...(name
          ? {
              example: {
                header_text_named_params: [
                  { param_name: name, example: d.header.example?.trim() ?? "" },
                ],
              },
            }
          : {}),
      });
    } else if (d.header.kind === "text") {
      const hv = variableNumbers(d.header.text);
      out.push({
        type: "HEADER",
        format: "TEXT",
        text: d.header.text.trim(),
        ...(hv.length ? { example: { header_text: [d.header.example?.trim() ?? ""] } } : {}),
      });
    } else if (d.header.kind === "media") {
      out.push({
        type: "HEADER",
        format: d.header.format,
        example: { header_handle: d.header.handle ? [d.header.handle] : [] },
      });
    }
  }

  if (named) {
    const params = namedParamExamples(d.body, d.namedExamples ?? {});
    out.push({
      type: "BODY",
      text: d.body,
      ...(params.length ? { example: { body_text_named_params: params } } : {}),
    });
  } else {
    const bodyVars = variableNumbers(d.body);
    out.push({
      type: "BODY",
      text: d.body,
      ...(bodyVars.length
        ? { example: { body_text: [alignExamples(d.body, d.bodyExamples)] } }
        : {}),
    });
  }

  if (d.type === "carousel") {
    out.push({
      type: "CAROUSEL",
      cards: d.cards.map((c) => ({
        components: [
          {
            type: "HEADER",
            format: c.format,
            example: { header_handle: c.handle ? [c.handle] : [] },
          },
          { type: "BODY", text: c.body },
          { type: "BUTTONS", buttons: toMetaButtons(c.buttons) },
        ] as MetaTemplateComponent[],
      })),
    });
    return out;
  }

  if (d.footer.trim()) out.push({ type: "FOOTER", text: d.footer.trim() });
  if (d.buttons.length) out.push({ type: "BUTTONS", buttons: toMetaButtons(d.buttons) });
  return out;
}

// ---------------------------------------------------------------------------
// Meta components → draft (editing a synced or submitted template)
// ---------------------------------------------------------------------------

function fromMetaButtons(buttons: MetaButton[]): DraftButton[] {
  const out: DraftButton[] = [];
  for (const b of buttons) {
    if (b.type === "QUICK_REPLY") out.push({ type: "QUICK_REPLY", text: b.text });
    else if (b.type === "URL") {
      const ex = b.example?.[0];
      out.push({
        type: "URL",
        text: b.text,
        url: b.url,
        example:
          ex && /\{\{\s*1\s*\}\}/.test(b.url)
            ? ex.slice(b.url.replace(/\{\{\s*1\s*\}\}.*/, "").length)
            : undefined,
      });
    } else if (b.type === "PHONE_NUMBER")
      out.push({ type: "PHONE_NUMBER", text: b.text, phone_number: b.phone_number });
    else if (b.type === "COPY_CODE") out.push({ type: "COPY_CODE", example: b.example ?? "" });
    else if (b.type === "CATALOG") out.push({ type: "CATALOG", text: b.text ?? "" });
  }
  return out;
}

export function draftFromComponents(
  base: {
    name: string;
    language: string;
    category: string;
    variableMap?: Record<string, string>;
    /** wa_templates.parameter_format; when absent it is inferred from the examples. */
    parameterFormat?: string | null;
  },
  components: MetaTemplateComponent[],
): TemplateDraft {
  if (base.category === "AUTHENTICATION")
    return emptyDraft({
      name: base.name,
      language: base.language,
      category: "AUTHENTICATION",
      type: "media_interactive",
      variableMap: base.variableMap ?? {},
      auth: authFromComponents(components),
    });
  const namedExamples = components.some(
    (c) =>
      (c.type === "BODY" || c.type === "HEADER") &&
      !!(c as { example?: Record<string, unknown> }).example &&
      ("body_text_named_params" in (c as { example: object }).example ||
        "header_text_named_params" in (c as { example: object }).example),
  );
  const named = base.parameterFormat === "named" || (base.parameterFormat == null && namedExamples);
  const d = emptyDraft({
    name: base.name,
    language: base.language,
    category: base.category === "MARKETING" ? "MARKETING" : "UTILITY",
    variableMap: base.variableMap ?? {},
    ...(named ? { parameterFormat: "named" as const, namedExamples: {} } : {}),
  });
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT")
        d.header = {
          kind: "text",
          text: h.text ?? "",
          example: h.example?.header_text?.[0] ?? h.example?.header_text_named_params?.[0]?.example,
        };
      else if (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT")
        d.header = { kind: "media", format: h.format, handle: h.example?.header_handle?.[0] };
    } else if (c.type === "BODY") {
      const b = c as Extract<MetaTemplateComponent, { type: "BODY" }>;
      d.body = b.text ?? "";
      if (named) {
        d.namedExamples = Object.fromEntries(
          (b.example?.body_text_named_params ?? []).map((p) => [p.param_name, p.example]),
        );
      } else d.bodyExamples = alignExamples(d.body, b.example?.body_text?.[0] ?? []);
    } else if (c.type === "FOOTER") {
      d.footer = (c as Extract<MetaTemplateComponent, { type: "FOOTER" }>).text ?? "";
    } else if (c.type === "BUTTONS") {
      d.buttons = fromMetaButtons(
        (c as Extract<MetaTemplateComponent, { type: "BUTTONS" }>).buttons,
      );
    } else if (c.type === "CAROUSEL") {
      d.type = "carousel";
      d.cards = (c as Extract<MetaTemplateComponent, { type: "CAROUSEL" }>).cards.map((card) => {
        const header = card.components.find((x) => x.type === "HEADER") as
          Extract<MetaTemplateComponent, { type: "HEADER" }> | undefined;
        const body = card.components.find((x) => x.type === "BODY") as
          Extract<MetaTemplateComponent, { type: "BODY" }> | undefined;
        const btns = card.components.find((x) => x.type === "BUTTONS") as
          Extract<MetaTemplateComponent, { type: "BUTTONS" }> | undefined;
        return {
          format: header?.format === "VIDEO" ? "VIDEO" : "IMAGE",
          handle: header?.example?.header_handle?.[0],
          body: body?.text ?? "",
          buttons: btns ? fromMetaButtons(btns.buttons) : [],
        } as DraftCard;
      });
    }
  }
  if (d.type !== "carousel")
    d.type = d.header.kind === "media" || d.buttons.length ? "media_interactive" : "standard";
  return d;
}

/** The builder type to store in wa_templates.type (matches lib/whatsapp/sync.ts). */
export function storedType(d: TemplateDraft): BuilderType {
  // An authentication template always has its copy-code button, which sync classes as media & interactive.
  if (d.category === "AUTHENTICATION") return "media_interactive";
  return d.type;
}

/**
 * The components kept in wa_templates.components: what Meta is sent, except for an authentication template, where
 * the readable shape (`authDisplayComponents`) is stored so previews and sends work before the next sync.
 */
export function storedComponents(d: TemplateDraft): MetaTemplateComponent[] {
  return d.category === "AUTHENTICATION"
    ? authDisplayComponents(d.auth ?? defaultAuth())
    : buildComponents(d);
}

/** Turns "Appointment reminder!" into a valid template name. */
export function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}
