/**
 * WhatsApp template builder core (pure, unit-tested): the editable draft, Meta's authoring
 * rules, conversion to Meta `components` and back. The UI, the server actions and the starter
 * gallery all go through these functions, so a template that validates here is one Meta
 * will accept structurally (content review is still Meta's call).
 */
import { z } from "zod";

import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY"] as const;
export type BuilderCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_TYPES = ["standard", "media_interactive", "carousel"] as const;
export type BuilderType = (typeof TEMPLATE_TYPES)[number];

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

/** Meta's authoring rules. `errors` block submission; `warnings` are advice. */
export function validateDraft(d: TemplateDraft): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (!d.name) errors.push({ path: "name", message: "Name is required." });
  else if (!NAME_RE.test(d.name))
    errors.push({ path: "name", message: "Use lowercase letters, numbers and underscores only." });
  else if (d.name.length > LIMITS.name) errors.push({ path: "name", message: "Name is too long." });
  if (!LANG_RE.test(d.language)) errors.push({ path: "language", message: "Choose a language." });

  const body = d.body;
  if (!body.trim()) errors.push({ path: "body", message: "Body text is required." });
  if (body.length > LIMITS.body)
    errors.push({ path: "body", message: `Body is limited to ${LIMITS.body} characters.` });
  checkSequential(body, "body", errors);
  const bodyVars = variableNumbers(body);
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
    VAR.lastIndex = 0;
  }

  if (d.type === "carousel") {
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
    }
  });
}

function exampleUrl(b: Extract<DraftButton, { type: "URL" }>): string {
  return b.url.trim().replace(/\{\{\s*1\s*\}\}/, (b.example ?? "").trim());
}

/** Builds Meta's `components` array. Call validateDraft first; this does not re-check. */
export function buildComponents(d: TemplateDraft): MetaTemplateComponent[] {
  const out: MetaTemplateComponent[] = [];

  if (d.type !== "carousel") {
    if (d.header.kind === "text") {
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

  const bodyVars = variableNumbers(d.body);
  out.push({
    type: "BODY",
    text: d.body,
    ...(bodyVars.length ? { example: { body_text: [alignExamples(d.body, d.bodyExamples)] } } : {}),
  });

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
  }
  return out;
}

export function draftFromComponents(
  base: { name: string; language: string; category: string; variableMap?: Record<string, string> },
  components: MetaTemplateComponent[],
): TemplateDraft {
  const d = emptyDraft({
    name: base.name,
    language: base.language,
    category: base.category === "MARKETING" ? "MARKETING" : "UTILITY",
    variableMap: base.variableMap ?? {},
  });
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT")
        d.header = { kind: "text", text: h.text ?? "", example: h.example?.header_text?.[0] };
      else if (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT")
        d.header = { kind: "media", format: h.format, handle: h.example?.header_handle?.[0] };
    } else if (c.type === "BODY") {
      const b = c as Extract<MetaTemplateComponent, { type: "BODY" }>;
      d.body = b.text;
      d.bodyExamples = alignExamples(b.text, b.example?.body_text?.[0] ?? []);
    } else if (c.type === "FOOTER") {
      d.footer = (c as Extract<MetaTemplateComponent, { type: "FOOTER" }>).text;
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
  return d.type;
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
