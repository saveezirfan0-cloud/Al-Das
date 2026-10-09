/**
 * Template builder model (Phase 4). Pure, no I/O.
 *
 * `TemplateDraft` is what the builder form edits; `draftToComponents()` produces the Meta
 * `components` array that `createTemplate` / `updateTemplate` accept, and `componentsToDraft()`
 * reads a mirrored template back into the form. Variables are positional ({{1}}, {{2}} …); every
 * variable carries an example (Meta rejects templates without) and an optional `variable_map`
 * source that Inbox, reminders and (later) campaigns use to fill it.
 */
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_LANGUAGES = [
  { code: "en", label: "English", rtl: false },
  { code: "en_US", label: "English (US)", rtl: false },
  { code: "en_GB", label: "English (UK)", rtl: false },
  { code: "ar", label: "Arabic", rtl: true },
] as const;

export type TemplateKind = "standard" | "media_interactive" | "carousel";

/** What a body variable may be filled from. Keep in step with `appointmentValueMap` and the Inbox picker. */
export const VARIABLE_SOURCES = [
  { key: "contact.first_name", label: "Contact first name", example: "Sara" },
  { key: "contact.last_name", label: "Contact last name", example: "Haddad" },
  { key: "contact.name", label: "Contact full name", example: "Sara Haddad" },
  { key: "contact.phone", label: "Contact phone", example: "+971500000000" },
  {
    key: "appointment.datetime",
    label: "Appointment date and time",
    example: "Monday 10 November, 10:00 AM",
  },
  { key: "appointment.date", label: "Appointment date", example: "Monday 10 November" },
  { key: "appointment.time", label: "Appointment time", example: "10:00 AM" },
  { key: "appointment.specialist", label: "Doctor", example: "Dr. Noor" },
  { key: "appointment.location", label: "Location", example: "Al Das Clinic" },
  { key: "appointment.service", label: "Service", example: "General consultation" },
] as const;

export type VariableSource = (typeof VARIABLE_SOURCES)[number]["key"];

export type DraftHeader =
  | { format: "NONE" }
  | { format: "TEXT"; text: string; example?: string }
  | { format: "IMAGE" | "VIDEO" | "DOCUMENT"; handle?: string; samplePath?: string }
  | { format: "LOCATION" };

export type DraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example?: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string }
  | { type: "COPY_CODE"; example: string };

export type DraftCard = {
  header: { format: "IMAGE" | "VIDEO"; handle?: string; samplePath?: string };
  body: string;
  bodyExamples: string[];
  buttons: DraftButton[];
};

export type TemplateDraft = {
  name: string;
  language: string;
  category: TemplateCategory;
  kind: TemplateKind;
  header: DraftHeader;
  body: string;
  /** Example values for {{1}}, {{2}} … in order (index 0 = {{1}}). */
  bodyExamples: string[];
  footer: string;
  buttons: DraftButton[];
  cards: DraftCard[];
  /** "body.1" → "contact.first_name" etc. */
  variableMap: Record<string, string>;
};

export function emptyDraft(over: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: "",
    language: "en",
    category: "UTILITY",
    kind: "standard",
    header: { format: "NONE" },
    body: "",
    bodyExamples: [],
    footer: "",
    buttons: [],
    cards: [],
    variableMap: {},
    ...over,
  };
}

const VAR = /\{\{\s*(\d+)\s*\}\}/g;

/** Distinct positional variable numbers in a text, ascending. */
export function variableNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(VAR)) seen.add(Number(m[1]));
  return [...seen].sort((a, b) => a - b);
}

/** Next free positional variable number (1 when none). */
export function nextVariableNumber(text: string): number {
  const nums = variableNumbers(text);
  return nums.length ? nums[nums.length - 1] + 1 : 1;
}

/** Inserts `{{n}}` at a cursor position and returns the new text plus the number used. */
export function insertVariable(text: string, position: number): { text: string; number: number } {
  const n = nextVariableNumber(text);
  const at = Math.max(0, Math.min(position, text.length));
  return { text: `${text.slice(0, at)}{{${n}}}${text.slice(at)}`, number: n };
}

/** Renumbers variables to 1..n in order of first appearance and returns the old→new mapping. */
export function renumberVariables(text: string): { text: string; mapping: Record<number, number> } {
  const mapping: Record<number, number> = {};
  let next = 0;
  const out = text.replace(VAR, (_m, d: string) => {
    const old = Number(d);
    if (!(old in mapping)) mapping[old] = ++next;
    return `{{${mapping[old]}}}`;
  });
  return { text: out, mapping };
}

function buttonToMeta(
  b: DraftButton,
): Extract<MetaTemplateComponent, { type: "BUTTONS" }>["buttons"][number] {
  switch (b.type) {
    case "QUICK_REPLY":
      return { type: "QUICK_REPLY", text: b.text };
    case "URL":
      return {
        type: "URL",
        text: b.text,
        url: b.url,
        ...(variableNumbers(b.url).length ? { example: [b.example ?? ""] } : {}),
      };
    case "PHONE_NUMBER":
      return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone_number };
    case "COPY_CODE":
      return { type: "COPY_CODE", example: b.example };
  }
}

function bodyComponent(text: string, examples: string[]): MetaTemplateComponent {
  const nums = variableNumbers(text);
  return {
    type: "BODY",
    text,
    ...(nums.length ? { example: { body_text: [nums.map((n) => examples[n - 1] ?? "")] } } : {}),
  };
}

/** Form model → Meta `components`. Empty optional parts are omitted. */
export function draftToComponents(d: TemplateDraft): MetaTemplateComponent[] {
  const out: MetaTemplateComponent[] = [];

  if (d.kind === "carousel") {
    out.push(bodyComponent(d.body, d.bodyExamples));
    out.push({
      type: "CAROUSEL",
      cards: d.cards.map((c) => ({
        components: [
          {
            type: "HEADER",
            format: c.header.format,
            example: { header_handle: c.header.handle ? [c.header.handle] : [] },
          },
          bodyComponent(c.body, c.bodyExamples),
          ...(c.buttons.length
            ? [{ type: "BUTTONS", buttons: c.buttons.map(buttonToMeta) } as MetaTemplateComponent]
            : []),
        ],
      })),
    });
    return out;
  }

  const h = d.header;
  if (h.format === "TEXT") {
    const has = variableNumbers(h.text).length > 0;
    out.push({
      type: "HEADER",
      format: "TEXT",
      text: h.text,
      ...(has ? { example: { header_text: [h.example ?? ""] } } : {}),
    });
  } else if (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT") {
    out.push({
      type: "HEADER",
      format: h.format,
      example: { header_handle: h.handle ? [h.handle] : [] },
    });
  } else if (h.format === "LOCATION") {
    out.push({ type: "HEADER", format: "LOCATION" });
  }

  out.push(bodyComponent(d.body, d.bodyExamples));
  if (d.footer.trim()) out.push({ type: "FOOTER", text: d.footer });
  if (d.buttons.length) out.push({ type: "BUTTONS", buttons: d.buttons.map(buttonToMeta) });
  return out;
}

function metaToButton(
  b: Extract<MetaTemplateComponent, { type: "BUTTONS" }>["buttons"][number],
): DraftButton | null {
  switch (b.type) {
    case "QUICK_REPLY":
      return { type: "QUICK_REPLY", text: b.text };
    case "URL":
      return { type: "URL", text: b.text, url: b.url, example: b.example?.[0] };
    case "PHONE_NUMBER":
      return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone_number };
    case "COPY_CODE":
      return { type: "COPY_CODE", example: b.example ?? "" };
    default:
      return null; // FLOW buttons are not editable in the builder
  }
}

function bodyExamplesOf(c: Extract<MetaTemplateComponent, { type: "BODY" }>): string[] {
  const row = c.example?.body_text?.[0] ?? [];
  const nums = variableNumbers(c.text);
  const out: string[] = [];
  nums.forEach((n, i) => (out[n - 1] = row[i] ?? ""));
  return Array.from(out, (v) => v ?? "");
}

/** Meta `components` (+ identity fields) → form model. Unknown component types are ignored. */
export function componentsToDraft(
  components: MetaTemplateComponent[],
  meta: {
    name: string;
    language: string;
    category: string;
    kind?: TemplateKind;
    variableMap?: Record<string, string> | null;
  },
): TemplateDraft {
  const d = emptyDraft({
    name: meta.name,
    language: meta.language,
    category: (TEMPLATE_CATEGORIES as readonly string[]).includes(meta.category)
      ? (meta.category as TemplateCategory)
      : "UTILITY",
    variableMap: { ...(meta.variableMap ?? {}) },
  });
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT")
        d.header = { format: "TEXT", text: h.text ?? "", example: h.example?.header_text?.[0] };
      else if (h.format === "LOCATION") d.header = { format: "LOCATION" };
      else d.header = { format: h.format, handle: h.example?.header_handle?.[0] };
    } else if (c.type === "BODY") {
      const b = c as Extract<MetaTemplateComponent, { type: "BODY" }>;
      d.body = b.text;
      d.bodyExamples = bodyExamplesOf(b);
    } else if (c.type === "FOOTER") {
      d.footer = (c as Extract<MetaTemplateComponent, { type: "FOOTER" }>).text;
    } else if (c.type === "BUTTONS") {
      d.buttons = (c as Extract<MetaTemplateComponent, { type: "BUTTONS" }>).buttons
        .map(metaToButton)
        .filter((x): x is DraftButton => x !== null);
    } else if (c.type === "CAROUSEL") {
      const cards = (c as Extract<MetaTemplateComponent, { type: "CAROUSEL" }>).cards;
      d.kind = "carousel";
      d.cards = cards.map((card) => {
        const hdr = card.components.find((x) => x.type === "HEADER") as
          Extract<MetaTemplateComponent, { type: "HEADER" }> | undefined;
        const body = card.components.find((x) => x.type === "BODY") as
          Extract<MetaTemplateComponent, { type: "BODY" }> | undefined;
        const btns = card.components.find((x) => x.type === "BUTTONS") as
          Extract<MetaTemplateComponent, { type: "BUTTONS" }> | undefined;
        return {
          header: {
            format: hdr?.format === "VIDEO" ? "VIDEO" : "IMAGE",
            handle: hdr?.example?.header_handle?.[0],
          },
          body: body?.text ?? "",
          bodyExamples: body ? bodyExamplesOf(body) : [],
          buttons: (btns?.buttons ?? [])
            .map(metaToButton)
            .filter((x): x is DraftButton => x !== null),
        };
      });
    }
  }
  if (d.kind !== "carousel") {
    const hasMedia = d.header.format !== "NONE" && d.header.format !== "TEXT";
    d.kind = meta.kind ?? (hasMedia || d.buttons.length > 0 ? "media_interactive" : "standard");
  }
  return d;
}

/** Keys of `variableMap` that no longer correspond to a variable in the body. */
export function staleVariableMapKeys(d: TemplateDraft): string[] {
  const live = new Set(variableNumbers(d.body).map((n) => `body.${n}`));
  if (d.header.format === "TEXT")
    for (const n of variableNumbers(d.header.text)) live.add(`header.${n}`);
  return Object.keys(d.variableMap).filter((k) => !live.has(k));
}

/** The Meta `type` column value for a draft (matches `templateType()` in lib/whatsapp/sync.ts). */
export function draftKind(d: TemplateDraft): TemplateKind {
  if (d.cards.length > 0 || d.kind === "carousel") return "carousel";
  const hasMedia = d.header.format !== "NONE" && d.header.format !== "TEXT";
  return hasMedia || d.buttons.length > 0 ? "media_interactive" : "standard";
}

/** Header sample constraints by format (Meta's documented limits; confirm before go-live). */
export const SAMPLE_LIMITS = {
  IMAGE: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024 },
  VIDEO: { mimes: ["video/mp4"], maxBytes: 16 * 1024 * 1024 },
  DOCUMENT: { mimes: ["application/pdf"], maxBytes: 100 * 1024 * 1024 },
} as const;

/** Returns an error message when a file cannot be used as a header sample, otherwise null. */
export function checkSampleFile(
  format: keyof typeof SAMPLE_LIMITS,
  file: { mimeType: string; size: number },
): string | null {
  const lim = SAMPLE_LIMITS[format];
  if (!(lim.mimes as readonly string[]).includes(file.mimeType))
    return `Use ${lim.mimes.map((m) => m.split("/")[1].toUpperCase()).join(" or ")} for a ${format.toLowerCase()} header.`;
  if (file.size > lim.maxBytes)
    return `That file is over ${Math.round(lim.maxBytes / 1024 / 1024)} MB.`;
  if (file.size === 0) return "That file is empty.";
  return null;
}
