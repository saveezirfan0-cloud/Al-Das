/**
 * Template helpers: find variables in a Meta template, render a preview, and
 * build the `template` send object from values. Pure; unit-tested.
 */
import type {
  MetaTemplateComponent,
  TemplateComponent,
  TemplateObject,
  TemplateParameter,
} from "@/lib/whatsapp/types";

export type TemplateVariable = {
  /** 'header.1', 'body.2', 'body.name', 'button.0' … */
  key: string;
  component: "header" | "body" | "button" | "card";
  /** 1-based index for positional params or the param name for named params. */
  name: string;
  index: number | null;
  example: string | null;
  /** For header media and URL buttons. */
  kind: "text" | "image" | "video" | "document" | "url_suffix" | "copy_code" | "otp";
  /** Carousel card the variable belongs to (component === "card"). */
  card?: number;
};

const POSITIONAL = /\{\{\s*(\d+)\s*\}\}/g;
const NAMED = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function findVars(text: string): Array<{ name: string; index: number | null }> {
  const out: Array<{ name: string; index: number | null }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(POSITIONAL)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], index: Number(m[1]) });
    }
  }
  for (const m of text.matchAll(NAMED)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], index: null });
    }
  }
  return out.sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
}

/** Lists every variable a template needs, with Meta's examples when available. */
export function templateVariables(components: MetaTemplateComponent[]): TemplateVariable[] {
  const vars: TemplateVariable[] = [];
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT" && h.text) {
        const exNamed = h.example?.header_text_named_params ?? [];
        findVars(h.text).forEach((v, i) => {
          vars.push({
            key: `header.${v.name}`,
            component: "header",
            name: v.name,
            index: v.index,
            example: v.index
              ? (h.example?.header_text?.[i] ?? null)
              : (exNamed.find((e) => e.param_name === v.name)?.example ?? null),
            kind: "text",
          });
        });
      } else if (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT") {
        vars.push({
          key: "header.media",
          component: "header",
          name: "media",
          index: null,
          example: h.example?.header_handle?.[0] ?? null,
          kind: h.format.toLowerCase() as "image" | "video" | "document",
        });
      }
    } else if (c.type === "BODY") {
      const b = c as Extract<MetaTemplateComponent, { type: "BODY" }>;
      const exPos = b.example?.body_text?.[0] ?? [];
      const exNamed = b.example?.body_text_named_params ?? [];
      findVars(b.text ?? "").forEach((v, i) => {
        vars.push({
          key: `body.${v.name}`,
          component: "body",
          name: v.name,
          index: v.index,
          example: v.index
            ? (exPos[i] ?? null)
            : (exNamed.find((e) => e.param_name === v.name)?.example ?? null),
          kind: "text",
        });
      });
    } else if (c.type === "BUTTONS") {
      const bt = c as Extract<MetaTemplateComponent, { type: "BUTTONS" }>;
      bt.buttons.forEach((btn, idx) => {
        if (btn.type === "URL" && /\{\{\s*1\s*\}\}/.test(btn.url)) {
          vars.push({
            key: `button.${idx}`,
            component: "button",
            name: String(idx),
            index: idx,
            example: btn.example?.[0] ?? null,
            kind: "url_suffix",
          });
        } else if (btn.type === "COPY_CODE") {
          vars.push({
            key: `button.${idx}`,
            component: "button",
            name: String(idx),
            index: idx,
            example: btn.example ?? null,
            kind: "copy_code",
          });
        } else if ((btn as { type: string }).type === "OTP") {
          vars.push({
            key: "auth.code",
            component: "button",
            name: "code",
            index: idx,
            example: "123456",
            kind: "otp",
          });
        }
      });
    } else if (c.type === "CAROUSEL") {
      const cards = (c as Extract<MetaTemplateComponent, { type: "CAROUSEL" }>).cards ?? [];
      cards.forEach((card, ci) => {
        for (const v of templateVariables(card.components)) {
          vars.push({
            ...v,
            key: `card.${ci}.${v.key}`,
            component: "card",
            card: ci,
          });
        }
      });
    }
  }
  return vars;
}

export type TemplateValues = Record<string, string>; // key → value (header.media = media id or link)

function substitute(
  text: string,
  values: TemplateValues,
  prefix: "header" | "body",
  fallbackToExample = true,
  vars?: TemplateVariable[],
): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    const key = `${prefix}.${name}`;
    const v = values[key];
    if (v !== undefined && v !== "") return v;
    if (fallbackToExample) {
      const ex = vars?.find((x) => x.key === key)?.example;
      if (ex) return ex;
    }
    return `{{${name}}}`;
  });
}

export type TemplatePreview = {
  headerText: string | null;
  headerMedia: "image" | "video" | "document" | "location" | null;
  body: string;
  footer: string | null;
  buttons: Array<{ type: string; text: string }>;
  /** Carousel cards (each rendered like a small template). */
  cards: TemplatePreview[];
  /** Authentication template: the body is Meta's fixed "code" message. */
  otp: boolean;
  missing: string[]; // variable keys without a value
};

type MetaCarousel = Extract<MetaTemplateComponent, { type: "CAROUSEL" }>;

function cardValues(values: TemplateValues, index: number): TemplateValues {
  const prefix = `card.${index}.`;
  const out: TemplateValues = {};
  for (const [k, v] of Object.entries(values))
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

/** Renders the template as the patient will see it, with examples for unfilled variables. */
export function renderTemplatePreview(
  components: MetaTemplateComponent[],
  values: TemplateValues = {},
): TemplatePreview {
  const vars = templateVariables(components);
  const preview: TemplatePreview = {
    headerText: null,
    headerMedia: null,
    body: "",
    footer: null,
    buttons: [],
    cards: [],
    otp: false,
    missing: [],
  };
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT")
        preview.headerText = substitute(h.text ?? "", values, "header", true, vars);
      else preview.headerMedia = h.format.toLowerCase() as TemplatePreview["headerMedia"];
    } else if (c.type === "BODY") {
      const b = c as Extract<MetaTemplateComponent, { type: "BODY" }>;
      if (typeof b.text === "string") preview.body = substitute(b.text, values, "body", true, vars);
    } else if (c.type === "FOOTER") {
      const f = c as Extract<MetaTemplateComponent, { type: "FOOTER" }>;
      if (typeof f.text === "string") preview.footer = f.text;
    } else if (c.type === "BUTTONS") {
      for (const b of (c as Extract<MetaTemplateComponent, { type: "BUTTONS" }>).buttons) {
        if ((b as { type: string }).type === "OTP") {
          preview.otp = true;
          const code = values["auth.code"] || "123456";
          preview.body = `*${code}* is your verification code.`;
          preview.buttons.push({
            type: "COPY_CODE",
            text: (b as { text?: string }).text || "Copy code",
          });
          continue;
        }
        preview.buttons.push({
          type: b.type,
          text: "text" in b && b.text ? b.text : b.type === "COPY_CODE" ? "Copy code" : "Button",
        });
      }
    } else if (c.type === "CAROUSEL") {
      (c as MetaCarousel).cards?.forEach((card, ci) => {
        preview.cards.push(renderTemplatePreview(card.components, cardValues(values, ci)));
      });
    }
  }
  preview.missing = vars.filter((v) => !values[v.key]).map((v) => v.key);
  return preview;
}

function mediaParam(kind: "image" | "video" | "document", value: string): TemplateParameter {
  const ref = mediaRef(value);
  return kind === "image"
    ? { type: "image", image: ref }
    : kind === "video"
      ? { type: "video", video: ref }
      : { type: "document", document: ref };
}

/** Send components for one flat list of variables (a template, or one carousel card). */
function componentsFor(
  vars: TemplateVariable[],
  values: TemplateValues,
  named: boolean,
): TemplateComponent[] {
  const components: TemplateComponent[] = [];

  const headerVars = vars.filter((v) => v.component === "header");
  if (headerVars.length) {
    const params: TemplateParameter[] = headerVars.map((v) => {
      const value = values[v.key];
      switch (v.kind) {
        case "image":
        case "video":
        case "document":
          return mediaParam(v.kind, value);
        default:
          return named
            ? { type: "text", text: value, parameter_name: v.name }
            : { type: "text", text: value };
      }
    });
    components.push({ type: "header", parameters: params });
  }

  const bodyVars = vars.filter((v) => v.component === "body");
  const otp = vars.find((v) => v.kind === "otp");
  if (bodyVars.length) {
    components.push({
      type: "body",
      parameters: bodyVars.map((v) =>
        named
          ? { type: "text", text: values[v.key], parameter_name: v.name }
          : { type: "text", text: values[v.key] },
      ),
    });
  } else if (otp) {
    components.push({ type: "body", parameters: [{ type: "text", text: values[otp.key] }] });
  }

  for (const v of vars.filter((x) => x.component === "button")) {
    if (v.kind === "url_suffix") {
      components.push({
        type: "button",
        sub_type: "url",
        index: v.index ?? 0,
        parameters: [{ type: "text", text: values[v.key] }],
      });
    } else if (v.kind === "otp") {
      components.push({
        type: "button",
        sub_type: "url",
        index: v.index ?? 0,
        parameters: [{ type: "text", text: values[v.key] }],
      });
    } else if (v.kind === "copy_code") {
      components.push({
        type: "button",
        sub_type: "copy_code",
        index: v.index ?? 0,
        parameters: [{ type: "coupon_code", coupon_code: values[v.key] }],
      });
    }
  }
  return components;
}

/** Builds the Cloud API `template` object. Throws when a required variable is missing. */
export function buildTemplateSend(
  tpl: {
    name: string;
    language: string;
    components: MetaTemplateComponent[];
    parameterFormat?: "positional" | "named";
  },
  values: TemplateValues,
): TemplateObject {
  const vars = templateVariables(tpl.components);
  const named = tpl.parameterFormat === "named";
  const missing = vars.filter((v) => !values[v.key]);
  if (missing.length)
    throw new Error(`Missing template values: ${missing.map((m) => m.key).join(", ")}`);

  const components = componentsFor(
    vars.filter((v) => v.component !== "card"),
    values,
    named,
  );

  const carousel = tpl.components.find((c) => c.type === "CAROUSEL") as MetaCarousel | undefined;
  if (carousel) {
    const cards: Array<{ card_index: number; components: TemplateComponent[] }> = [];
    carousel.cards.forEach((card, ci) => {
      const cv = cardValues(values, ci);
      const parts = componentsFor(templateVariables(card.components), cv, named);
      if (parts.length) cards.push({ card_index: ci, components: parts });
    });
    if (cards.length) components.push({ type: "carousel", cards });
  }

  return {
    name: tpl.name,
    language: { code: tpl.language, policy: "deterministic" },
    ...(components.length ? { components } : {}),
  };
}

function mediaRef(value: string): { id: string } | { link: string } {
  return /^https?:\/\//i.test(value) ? { link: value } : { id: value };
}

/** The plain-text body of a template send, for the message row / preview column. */
export function templateBodyText(
  components: MetaTemplateComponent[],
  values: TemplateValues,
): string {
  return renderTemplatePreview(components, values).body;
}

/** Meta template status → whether it can be sent. */
export function isTemplateSendable(status: string | null | undefined): boolean {
  return status === "APPROVED";
}
