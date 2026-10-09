/**
 * Template builder core: the editor's state, its conversion to and from Meta's
 * `components`, Meta's authoring limits as fail-closed validation, and the pure
 * text helpers behind the body editor (formatting, "@" variables).
 * No I/O. Unit-tested.
 */
import { isValidPhoneNumber } from "libphonenumber-js";

import type { MetaTemplateComponent, TemplateCreateRequest } from "@/lib/whatsapp/types";

export const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_TYPES = ["standard", "media_interactive", "carousel"] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const TEMPLATE_LANGUAGES = [
  { code: "en", label: "English", rtl: false },
  { code: "ar", label: "Arabic (العربية)", rtl: true },
] as const;

export function isRtlLanguage(code: string): boolean {
  return code.toLowerCase().startsWith("ar");
}

/** Host used by the starter gallery for links the clinic must replace before submitting. */
export const PLACEHOLDER_HOST = "placeholder.invalid";

export const LIMITS = {
  nameMax: 512,
  bodyMax: 1024,
  headerTextMax: 60,
  footerMax: 60,
  buttonTextMax: 25,
  urlMax: 2000,
  buttonsMax: 10,
  urlButtonsMax: 2,
  phoneButtonsMax: 1,
  copyCodeButtonsMax: 1,
  cardsMin: 2,
  cardsMax: 10,
  cardBodyMax: 160,
  cardButtonsMax: 2,
  exampleMax: 1024,
} as const;

export type MediaFormat = "IMAGE" | "VIDEO" | "DOCUMENT";

export type HeaderDef =
  | { format: "NONE" }
  | { format: "TEXT"; text: string; example: string }
  | { format: MediaFormat; handle: string; mediaPath?: string; fileName?: string };

export type ButtonDef =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string }
  | { type: "COPY_CODE"; example: string };

export type CardDef = {
  format: "IMAGE" | "VIDEO";
  handle: string;
  mediaPath?: string;
  body: string;
  examples: string[];
  buttons: Array<Exclude<ButtonDef, { type: "COPY_CODE" }>>;
};

export type AuthDef = {
  securityRecommendation: boolean;
  expiryMinutes: number | null;
  buttonText: string;
};

export type BuilderState = {
  name: string;
  language: string;
  category: TemplateCategory;
  type: TemplateType;
  header: HeaderDef;
  body: string;
  /** Example value per body variable, in variable order ({{1}}, {{2}} …). */
  examples: string[];
  footer: string;
  buttons: ButtonDef[];
  cards: CardDef[];
  auth: AuthDef;
};

export function emptyBuilderState(over: Partial<BuilderState> = {}): BuilderState {
  return {
    name: "",
    language: "en",
    category: "UTILITY",
    type: "standard",
    header: { format: "NONE" },
    body: "",
    examples: [],
    footer: "",
    buttons: [],
    cards: [],
    auth: { securityRecommendation: true, expiryMinutes: 10, buttonText: "Copy code" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

const VAR = /\{\{\s*(\d+)\s*\}\}/g;
const ANY_VAR = /\{\{[^}]*\}\}/g;

/** Positional variable numbers in order of first appearance. */
export function variableIndexes(text: string): number[] {
  const seen: number[] = [];
  for (const m of text.matchAll(VAR)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

export function nextVariableIndex(text: string): number {
  return Math.max(0, ...variableIndexes(text)) + 1;
}

/** Inserts `{{n}}` (n = next free number) at `pos`. Returns the new text, the number and the caret. */
export function insertVariable(
  text: string,
  pos: number,
): { text: string; index: number; caret: number } {
  const at = Math.max(0, Math.min(pos, text.length));
  const index = nextVariableIndex(text);
  const token = `{{${index}}}`;
  return { text: text.slice(0, at) + token + text.slice(at), index, caret: at + token.length };
}

/**
 * Renumbers variables to 1..n in order of appearance (after a delete or reorder).
 * `mapping` says which old number each new number came from, so examples and
 * variable maps can follow.
 */
export function renumberVariables(text: string): {
  text: string;
  mapping: Array<{ from: number; to: number }>;
} {
  const order = variableIndexes(text);
  const to = new Map(order.map((from, i) => [from, i + 1]));
  return {
    text: text.replace(VAR, (_m, n: string) => `{{${to.get(Number(n))}}}`),
    mapping: order.map((from, i) => ({ from, to: i + 1 })),
  };
}

// ---------------------------------------------------------------------------
// WhatsApp formatting
// ---------------------------------------------------------------------------

export const FORMAT_MARKERS = {
  bold: "*",
  italic: "_",
  strike: "~",
  mono: "```",
} as const;
export type FormatKind = keyof typeof FORMAT_MARKERS;

/**
 * Wraps the selection in the marker (or unwraps it when already wrapped).
 * With an empty selection it inserts the marker pair and puts the caret inside.
 */
export function applyFormat(
  text: string,
  selStart: number,
  selEnd: number,
  kind: FormatKind,
): { text: string; selStart: number; selEnd: number } {
  const m = FORMAT_MARKERS[kind];
  const start = Math.max(0, Math.min(selStart, selEnd));
  const end = Math.min(text.length, Math.max(selStart, selEnd));
  const before = text.slice(0, start);
  const sel = text.slice(start, end);
  const after = text.slice(end);

  if (sel.length >= m.length * 2 && sel.startsWith(m) && sel.endsWith(m)) {
    const inner = sel.slice(m.length, sel.length - m.length);
    return { text: before + inner + after, selStart: start, selEnd: start + inner.length };
  }
  if (before.endsWith(m) && after.startsWith(m)) {
    return {
      text: before.slice(0, -m.length) + sel + after.slice(m.length),
      selStart: start - m.length,
      selEnd: end - m.length,
    };
  }
  return {
    text: before + m + sel + m + after,
    selStart: start + m.length,
    selEnd: end + m.length,
  };
}

// ---------------------------------------------------------------------------
// Validation (Meta's authoring rules; fail closed)
// ---------------------------------------------------------------------------

export type ValidationIssue = {
  path: string;
  message: string;
  /** 'draft' blocks saving a draft; 'submit' only blocks sending it to Meta. */
  level: "draft" | "submit";
};

function checkVariableText(
  text: string,
  path: string,
  label: string,
  examples: string[],
  issues: ValidationIssue[],
  opts: { maxVars?: number } = {},
) {
  const strays = [...text.matchAll(ANY_VAR)]
    .map((m) => m[0])
    .filter((t) => !/^\{\{\d+\}\}$/.test(t));
  if (strays.length)
    issues.push({
      path,
      level: "draft",
      message: `${label}: use numbered variables like {{1}} (found ${strays[0]}).`,
    });
  const idx = variableIndexes(text);
  idx.forEach((n, i) => {
    if (n !== i + 1)
      issues.push({
        path,
        level: "submit",
        message: `${label}: variables must be numbered {{1}}, {{2}}… in order without gaps.`,
      });
  });
  if (opts.maxVars !== undefined && idx.length > opts.maxVars)
    issues.push({
      path,
      level: "submit",
      message: `${label}: at most ${opts.maxVars} variable${opts.maxVars === 1 ? "" : "s"} allowed.`,
    });
  const trimmed = text.trim();
  if (idx.length && (/^\{\{\d+\}\}/.test(trimmed) || /\{\{\d+\}\}$/.test(trimmed)))
    issues.push({
      path,
      level: "submit",
      message: `${label}: cannot start or end with a variable.`,
    });
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text))
    issues.push({
      path,
      level: "submit",
      message: `${label}: variables cannot sit next to each other.`,
    });
  idx.forEach((n, i) => {
    const ex = examples[i];
    if (!ex || !ex.trim())
      issues.push({
        path: `${path}.example.${n}`,
        level: "submit",
        message: `${label}: add an example value for {{${n}}}.`,
      });
    else if (ex.length > LIMITS.exampleMax || /[\n\t]/.test(ex))
      issues.push({
        path: `${path}.example.${n}`,
        level: "submit",
        message: `${label}: example for {{${n}}} must be a single line.`,
      });
  });
}

function validateButtons(
  buttons: ButtonDef[],
  basePath: string,
  issues: ValidationIssue[],
  opts: { max: number; allowCopyCode: boolean },
) {
  if (buttons.length > opts.max)
    issues.push({
      path: basePath,
      level: "draft",
      message: `At most ${opts.max} buttons allowed.`,
    });
  const count = (t: ButtonDef["type"]) => buttons.filter((b) => b.type === t).length;
  if (count("URL") > LIMITS.urlButtonsMax)
    issues.push({ path: basePath, level: "draft", message: "At most 2 URL buttons." });
  if (count("PHONE_NUMBER") > LIMITS.phoneButtonsMax)
    issues.push({ path: basePath, level: "draft", message: "At most 1 phone button." });
  if (count("COPY_CODE") > LIMITS.copyCodeButtonsMax)
    issues.push({ path: basePath, level: "draft", message: "At most 1 copy-code button." });

  // Quick replies must be contiguous (all first or all last).
  const kinds = buttons.map((b) => (b.type === "QUICK_REPLY" ? "q" : "o")).join("");
  if (/q.*o.*q/.test(kinds))
    issues.push({
      path: basePath,
      level: "submit",
      message: "Keep quick-reply buttons together (before or after the other buttons).",
    });

  buttons.forEach((b, i) => {
    const p = `${basePath}.${i}`;
    if (b.type === "COPY_CODE") {
      if (!opts.allowCopyCode)
        issues.push({
          path: p,
          level: "draft",
          message: "Copy-code buttons are not allowed here.",
        });
      if (!b.example.trim() || b.example.length > 15)
        issues.push({
          path: `${p}.example`,
          level: "submit",
          message: "Copy-code buttons need an example code of up to 15 characters.",
        });
      return;
    }
    if (!b.text.trim())
      issues.push({ path: `${p}.text`, level: "submit", message: "Button text is required." });
    else if (b.text.length > LIMITS.buttonTextMax)
      issues.push({
        path: `${p}.text`,
        level: "draft",
        message: `Button text is limited to ${LIMITS.buttonTextMax} characters.`,
      });
    if (b.type === "URL") {
      if (!/^https:\/\/[^\s]+$/i.test(b.url))
        issues.push({
          path: `${p}.url`,
          level: "submit",
          message: "URL must start with https://.",
        });
      if (b.url.includes(PLACEHOLDER_HOST))
        issues.push({
          path: `${p}.url`,
          level: "submit",
          message: "Replace the placeholder link with your real address.",
        });
      if (b.url.length > LIMITS.urlMax)
        issues.push({ path: `${p}.url`, level: "draft", message: "URL is too long." });
      const vars = [...b.url.matchAll(ANY_VAR)].map((m) => m[0]);
      if (
        vars.length > 1 ||
        (vars.length === 1 && (vars[0] !== "{{1}}" || !b.url.endsWith("{{1}}")))
      )
        issues.push({
          path: `${p}.url`,
          level: "submit",
          message: "A URL can hold one variable, {{1}}, at the very end.",
        });
      if (vars.length === 1 && !/^https:\/\/[^\s]+$/i.test(b.example))
        issues.push({
          path: `${p}.example`,
          level: "submit",
          message: "Add a full example URL for the variable.",
        });
    }
    if (
      b.type === "PHONE_NUMBER" &&
      !(b.phone_number.startsWith("+") && isValidPhoneNumber(b.phone_number))
    )
      issues.push({
        path: `${p}.phone_number`,
        level: "submit",
        message: "Enter a valid phone number in international format (+971…).",
      });
  });
}

/** Validates a builder state against Meta's rules. An empty array means it can be submitted. */
export function validateBuilder(s: BuilderState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string, level: ValidationIssue["level"] = "submit") =>
    issues.push({ path, message, level });

  // Identity
  if (!/^[a-z0-9_]+$/.test(s.name))
    err("name", "Name: lowercase letters, numbers and underscores only.", "draft");
  else if (s.name.length > LIMITS.nameMax) err("name", "Name is too long.", "draft");
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(s.language)) err("language", "Choose a language.", "draft");
  if (!TEMPLATE_CATEGORIES.includes(s.category)) err("category", "Choose a category.", "draft");

  if (s.category === "AUTHENTICATION") {
    if (s.type !== "standard")
      err("type", "Authentication templates use the standard type.", "draft");
    if (!s.auth.buttonText.trim() || s.auth.buttonText.length > LIMITS.buttonTextMax)
      err("auth.buttonText", "Button text is required (25 characters max).");
    if (
      s.auth.expiryMinutes !== null &&
      (!Number.isInteger(s.auth.expiryMinutes) ||
        s.auth.expiryMinutes < 1 ||
        s.auth.expiryMinutes > 90)
    )
      err("auth.expiryMinutes", "Code expiry must be between 1 and 90 minutes.");
    return issues;
  }

  // Body
  if (!s.body.trim()) err("body", "Body text is required.");
  if (s.body.length > LIMITS.bodyMax)
    err("body", `Body is limited to ${LIMITS.bodyMax} characters.`, "draft");
  checkVariableText(s.body, "body", "Body", s.examples, issues);

  if (s.type === "carousel") {
    if (s.header.format !== "NONE") err("header", "Carousel templates have no top-level header.");
    if (s.footer.trim()) err("footer", "Carousel templates have no top-level footer.");
    if (s.buttons.length) err("buttons", "Carousel buttons belong on the cards.");
    validateCards(s, issues);
    return issues;
  }
  if (s.cards.length) err("cards", "Cards are only used by carousel templates.");

  // Header
  const h = s.header;
  if (h.format === "TEXT") {
    if (!h.text.trim()) err("header.text", "Header text is required.");
    if (h.text.length > LIMITS.headerTextMax)
      err("header.text", `Header is limited to ${LIMITS.headerTextMax} characters.`, "draft");
    checkVariableText(h.text, "header", "Header", [h.example], issues, { maxVars: 1 });
  } else if (h.format !== "NONE") {
    if (s.type === "standard")
      err("header", "Media headers need the Media & Interactive type.", "draft");
    if (!h.handle) err("header.media", "Upload a sample file for the header.");
  }

  // Footer
  if (s.footer.length > LIMITS.footerMax)
    err("footer", `Footer is limited to ${LIMITS.footerMax} characters.`, "draft");
  if ([...s.footer.matchAll(ANY_VAR)].length) err("footer", "Footer cannot contain variables.");

  // Buttons
  if (s.type === "standard" && s.buttons.length)
    err("buttons", "Buttons need the Media & Interactive type.", "draft");
  validateButtons(s.buttons, "buttons", issues, { max: LIMITS.buttonsMax, allowCopyCode: true });

  return issues;
}

function validateCards(s: BuilderState, issues: ValidationIssue[]) {
  const err = (path: string, message: string, level: ValidationIssue["level"] = "submit") =>
    issues.push({ path, message, level });
  if (s.cards.length < LIMITS.cardsMin || s.cards.length > LIMITS.cardsMax)
    err("cards", `A carousel needs ${LIMITS.cardsMin} to ${LIMITS.cardsMax} cards.`);
  const formats = new Set(s.cards.map((c) => c.format));
  if (formats.size > 1) err("cards", "All cards must use the same media type (image or video).");
  const signature = (c: CardDef) => c.buttons.map((b) => b.type).join(",");
  if (new Set(s.cards.map(signature)).size > 1)
    err("cards", "Every card must have the same kinds of buttons, in the same order.");
  s.cards.forEach((c, i) => {
    const p = `cards.${i}`;
    if (!c.handle) err(`${p}.media`, `Card ${i + 1}: upload a sample ${c.format.toLowerCase()}.`);
    if (!c.body.trim()) err(`${p}.body`, `Card ${i + 1}: body text is required.`);
    if (c.body.length > LIMITS.cardBodyMax)
      err(
        `${p}.body`,
        `Card ${i + 1}: body is limited to ${LIMITS.cardBodyMax} characters.`,
        "draft",
      );
    checkVariableText(c.body, `${p}.body`, `Card ${i + 1} body`, c.examples, issues);
    if (!c.buttons.length) err(`${p}.buttons`, `Card ${i + 1}: add at least one button.`);
    validateButtons(c.buttons, `${p}.buttons`, issues, {
      max: LIMITS.cardButtonsMax,
      allowCopyCode: false,
    });
  });
}

export const blockingDraftIssues = (issues: ValidationIssue[]) =>
  issues.filter((i) => i.level === "draft");

// ---------------------------------------------------------------------------
// State → Meta components
// ---------------------------------------------------------------------------

function buttonToMeta(b: ButtonDef): Record<string, unknown> {
  switch (b.type) {
    case "QUICK_REPLY":
      return { type: "QUICK_REPLY", text: b.text.trim() };
    case "URL": {
      const hasVar = /\{\{1\}\}$/.test(b.url);
      return {
        type: "URL",
        text: b.text.trim(),
        url: b.url.trim(),
        ...(hasVar ? { example: [b.example.trim()] } : {}),
      };
    }
    case "PHONE_NUMBER":
      return { type: "PHONE_NUMBER", text: b.text.trim(), phone_number: b.phone_number.trim() };
    case "COPY_CODE":
      return { type: "COPY_CODE", example: b.example.trim() };
  }
}

function bodyComponent(text: string, examples: string[]): MetaTemplateComponent {
  const n = variableIndexes(text).length;
  return {
    type: "BODY",
    text,
    ...(n ? { example: { body_text: [examples.slice(0, n).map((e) => e.trim())] } } : {}),
  };
}

/** Builds Meta's `components` array. Call after validateBuilder() returned no issues. */
export function toComponents(s: BuilderState): MetaTemplateComponent[] {
  if (s.category === "AUTHENTICATION") {
    return [
      { type: "BODY", add_security_recommendation: s.auth.securityRecommendation },
      ...(s.auth.expiryMinutes
        ? [{ type: "FOOTER", code_expiration_minutes: s.auth.expiryMinutes }]
        : []),
      {
        type: "BUTTONS",
        buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: s.auth.buttonText.trim() }],
      },
    ] as MetaTemplateComponent[];
  }

  const out: MetaTemplateComponent[] = [];
  if (s.type !== "carousel") {
    const h = s.header;
    if (h.format === "TEXT") {
      out.push({
        type: "HEADER",
        format: "TEXT",
        text: h.text,
        ...(variableIndexes(h.text).length ? { example: { header_text: [h.example.trim()] } } : {}),
      });
    } else if (h.format !== "NONE") {
      out.push({ type: "HEADER", format: h.format, example: { header_handle: [h.handle] } });
    }
  }
  out.push(bodyComponent(s.body, s.examples));
  if (s.type !== "carousel" && s.footer.trim()) out.push({ type: "FOOTER", text: s.footer.trim() });
  if (s.type !== "carousel" && s.buttons.length) {
    out.push({ type: "BUTTONS", buttons: s.buttons.map(buttonToMeta) } as MetaTemplateComponent);
  }
  if (s.type === "carousel") {
    out.push({
      type: "CAROUSEL",
      cards: s.cards.map((c) => ({
        components: [
          { type: "HEADER", format: c.format, example: { header_handle: [c.handle] } },
          bodyComponent(c.body, c.examples),
          { type: "BUTTONS", buttons: c.buttons.map(buttonToMeta) },
        ] as MetaTemplateComponent[],
      })),
    });
  }
  return out;
}

export function toCreateRequest(s: BuilderState): TemplateCreateRequest {
  return {
    name: s.name,
    language: s.language,
    category: s.category,
    parameter_format: "POSITIONAL",
    components: toComponents(s),
  };
}

// ---------------------------------------------------------------------------
// Meta components → state (editing a synced / existing template)
// ---------------------------------------------------------------------------

type AnyComponent = Record<string, unknown> & { type: string };

function buttonFromMeta(b: Record<string, unknown>): ButtonDef | null {
  const text = typeof b.text === "string" ? b.text : "";
  switch (b.type) {
    case "QUICK_REPLY":
      return { type: "QUICK_REPLY", text };
    case "URL":
      return {
        type: "URL",
        text,
        url: String(b.url ?? ""),
        example: Array.isArray(b.example) ? String(b.example[0] ?? "") : "",
      };
    case "PHONE_NUMBER":
      return { type: "PHONE_NUMBER", text, phone_number: String(b.phone_number ?? "") };
    case "COPY_CODE":
      return { type: "COPY_CODE", example: typeof b.example === "string" ? b.example : "" };
    default:
      return null;
  }
}

function bodyExamples(c: AnyComponent | undefined): string[] {
  const ex = (c?.example as { body_text?: string[][] } | undefined)?.body_text?.[0];
  return Array.isArray(ex) ? ex.map(String) : [];
}

/**
 * Rebuilds editor state from stored components. `unsupported` lists things the
 * builder cannot round-trip (named parameters, Flow buttons, location headers…);
 * the UI then refuses to edit instead of silently dropping them.
 */
export function fromComponents(
  meta: {
    name: string;
    language: string;
    category: string;
    parameter_format?: string | null;
  },
  components: MetaTemplateComponent[],
): { state: BuilderState; unsupported: string[] } {
  const unsupported: string[] = [];
  const state = emptyBuilderState({
    name: meta.name,
    language: meta.language,
    category: (TEMPLATE_CATEGORIES as readonly string[]).includes(meta.category)
      ? (meta.category as TemplateCategory)
      : "UTILITY",
  });
  if (meta.parameter_format && meta.parameter_format.toLowerCase() === "named")
    unsupported.push("Named parameters");

  const list = components as AnyComponent[];
  const find = (t: string) => list.find((c) => c.type === t);

  if (state.category === "AUTHENTICATION") {
    const body = find("BODY");
    const footer = find("FOOTER");
    const btn = (find("BUTTONS")?.buttons as Array<Record<string, unknown>> | undefined)?.[0];
    state.auth = {
      securityRecommendation: body?.add_security_recommendation === true,
      expiryMinutes:
        typeof footer?.code_expiration_minutes === "number" ? footer.code_expiration_minutes : null,
      buttonText: typeof btn?.text === "string" ? btn.text : "Copy code",
    };
    return { state, unsupported };
  }

  const header = find("HEADER");
  if (header) {
    const fmt = String(header.format);
    if (fmt === "TEXT") {
      const text = String(header.text ?? "");
      if (/\{\{\s*[a-zA-Z_]/.test(text)) unsupported.push("Named header parameters");
      state.header = {
        format: "TEXT",
        text,
        example: String(
          (header.example as { header_text?: string[] } | undefined)?.header_text?.[0] ?? "",
        ),
      };
    } else if (fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT") {
      state.header = {
        format: fmt,
        handle: String(
          (header.example as { header_handle?: string[] } | undefined)?.header_handle?.[0] ?? "",
        ),
      };
    } else {
      unsupported.push(`${fmt} header`);
    }
  }

  const body = find("BODY");
  state.body = String(body?.text ?? "");
  if (/\{\{\s*[a-zA-Z_]/.test(state.body)) unsupported.push("Named body parameters");
  state.examples = bodyExamples(body);

  const footer = find("FOOTER");
  if (footer && typeof footer.text === "string") state.footer = footer.text;

  const buttons = find("BUTTONS")?.buttons as Array<Record<string, unknown>> | undefined;
  for (const b of buttons ?? []) {
    const def = buttonFromMeta(b);
    if (def) state.buttons.push(def);
    else unsupported.push(`${String(b.type)} button`);
  }

  const carousel = find("CAROUSEL");
  if (carousel) {
    state.type = "carousel";
    const cards = (carousel.cards as Array<{ components: AnyComponent[] }>) ?? [];
    state.cards = cards.map((card) => {
      const h = card.components.find((c) => c.type === "HEADER");
      const b = card.components.find((c) => c.type === "BODY");
      const btns = card.components.find((c) => c.type === "BUTTONS")?.buttons as
        Array<Record<string, unknown>> | undefined;
      return {
        format: h?.format === "VIDEO" ? "VIDEO" : "IMAGE",
        handle: String(
          (h?.example as { header_handle?: string[] } | undefined)?.header_handle?.[0] ?? "",
        ),
        body: String(b?.text ?? ""),
        examples: bodyExamples(b),
        buttons: (btns ?? [])
          .map(buttonFromMeta)
          .filter(
            (x): x is Exclude<ButtonDef, { type: "COPY_CODE" }> => !!x && x.type !== "COPY_CODE",
          ),
      };
    });
  } else {
    state.type =
      state.header.format !== "NONE" && state.header.format !== "TEXT"
        ? "media_interactive"
        : state.buttons.length
          ? "media_interactive"
          : "standard";
  }
  return { state, unsupported };
}

/** Keeps `examples` the same length as the number of variables in `text`. */
export function syncExamples(text: string, examples: string[]): string[] {
  const n = variableIndexes(text).length;
  return Array.from({ length: n }, (_v, i) => examples[i] ?? "");
}

/**
 * Applies an edit to a body: keeps each variable's example and field mapping with
 * the variable it belongs to when variables are deleted or reordered, then renumbers
 * to {{1}}…{{n}}. `varMap` is keyed "<prefix>.<n>" (e.g. "body.2").
 */
export function reconcileVariables(
  prevText: string,
  nextText: string,
  examples: string[],
  varMap: Record<string, string>,
  prefix = "body",
): { text: string; examples: string[]; varMap: Record<string, string> } {
  const prev = variableIndexes(prevText);
  const nextOrder = variableIndexes(nextText);
  const byNumber = new Map(prev.map((n, i) => [n, examples[i] ?? ""]));
  const kept = nextOrder.map((n) => byNumber.get(n) ?? "");
  const renum = renumberVariables(nextText);
  const nextMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(varMap)) {
    if (!k.startsWith(`${prefix}.`)) nextMap[k] = v;
  }
  for (const { from, to } of renum.mapping) {
    const v = varMap[`${prefix}.${from}`];
    if (v) nextMap[`${prefix}.${to}`] = v;
  }
  return { text: renum.text, examples: kept, varMap: nextMap };
}
