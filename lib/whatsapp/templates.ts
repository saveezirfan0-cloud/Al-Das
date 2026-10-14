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
  /**
   * 'header.1', 'body.2', 'body.name', 'button.0' … Carousel cards (Phase 20d) prefix their own:
   * 'card.0.header.media', 'card.1.body.1', 'card.0.button.1'.
   */
  key: string;
  component: "header" | "body" | "button";
  /** 1-based index for positional params or the param name for named params. */
  name: string;
  index: number | null;
  example: string | null;
  /** For header media and URL buttons. */
  kind: "text" | "image" | "video" | "document" | "url_suffix" | "copy_code" | "catalog_thumbnail";
  /** Set for a variable on a carousel card (0-based card index); absent for the message itself. */
  card?: number;
  /**
   * True when the message can go without a value (only the catalogue button's thumbnail item: Meta then shows the
   * first catalogue item). Optional variables are never reported as missing.
   */
  optional?: boolean;
};

type MetaButtonDef = Extract<MetaTemplateComponent, { type: "BUTTONS" }>["buttons"][number];

/**
 * An authentication template's copy-code button: the create shape (`OTP`) or the shape Meta lists it back in
 * (a URL button to whatsapp.com/otp). Its one parameter is always the code in the body, so it is not a variable.
 */
export function isOtpButton(b: MetaButtonDef): boolean {
  if (b.type === "OTP") return true;
  return b.type === "URL" && /^https:\/\/(www\.)?whatsapp\.com\/otp\//i.test(b.url ?? "");
}

/** The key prefix of a carousel card's variables. */
export function cardKeyPrefix(card: number): string {
  return `card.${card}.`;
}

/** True for any header-media key: 'header.media' or a carousel card's 'card.N.header.media'. */
export function isHeaderMediaKey(key: string): boolean {
  return key === "header.media" || /^card\.\d{1,2}\.header\.media$/.test(key);
}

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

type CarouselComponent = Extract<MetaTemplateComponent, { type: "CAROUSEL" }>;

/** Variables of one component list: the message itself (no prefix) or one carousel card. */
function componentVariables(
  components: MetaTemplateComponent[],
  prefix: string,
  card: number | undefined,
): TemplateVariable[] {
  const vars: TemplateVariable[] = [];
  const extra = card === undefined ? {} : { card };
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT" && h.text) {
        const exNamed = h.example?.header_text_named_params ?? [];
        findVars(h.text).forEach((v, i) => {
          vars.push({
            key: `${prefix}header.${v.name}`,
            component: "header",
            name: v.name,
            index: v.index,
            example: v.index
              ? (h.example?.header_text?.[i] ?? null)
              : (exNamed.find((e) => e.param_name === v.name)?.example ?? null),
            kind: "text",
            ...extra,
          });
        });
      } else if (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT") {
        vars.push({
          key: `${prefix}header.media`,
          component: "header",
          name: "media",
          index: null,
          example: h.example?.header_handle?.[0] ?? null,
          kind: h.format.toLowerCase() as "image" | "video" | "document",
          ...extra,
        });
      }
    } else if (c.type === "BODY") {
      const b = c as Extract<MetaTemplateComponent, { type: "BODY" }>;
      const exPos = b.example?.body_text?.[0] ?? [];
      const exNamed = b.example?.body_text_named_params ?? [];
      findVars(b.text ?? "").forEach((v, i) => {
        vars.push({
          key: `${prefix}body.${v.name}`,
          component: "body",
          name: v.name,
          index: v.index,
          example: v.index
            ? (exPos[i] ?? null)
            : (exNamed.find((e) => e.param_name === v.name)?.example ?? null),
          kind: "text",
          ...extra,
        });
      });
    } else if (c.type === "BUTTONS") {
      const bt = c as Extract<MetaTemplateComponent, { type: "BUTTONS" }>;
      bt.buttons.forEach((btn, idx) => {
        if (isOtpButton(btn)) return; // filled from the body's code at send time
        if (btn.type === "CATALOG") {
          vars.push({
            key: `${prefix}button.${idx}`,
            component: "button",
            name: String(idx),
            index: idx,
            example: null,
            kind: "catalog_thumbnail",
            optional: true,
            ...extra,
          });
        } else if (btn.type === "URL" && /\{\{\s*1\s*\}\}/.test(btn.url)) {
          vars.push({
            key: `${prefix}button.${idx}`,
            component: "button",
            name: String(idx),
            index: idx,
            example: btn.example?.[0] ?? null,
            kind: "url_suffix",
            ...extra,
          });
        } else if (btn.type === "COPY_CODE") {
          vars.push({
            key: `${prefix}button.${idx}`,
            component: "button",
            name: String(idx),
            index: idx,
            example: btn.example ?? null,
            kind: "copy_code",
            ...extra,
          });
        }
      });
    } else if (c.type === "CAROUSEL" && card === undefined) {
      ((c as CarouselComponent).cards ?? []).forEach((cd, ci) => {
        vars.push(...componentVariables(cd.components ?? [], cardKeyPrefix(ci), ci));
      });
    }
  }
  return vars;
}

/**
 * Lists every variable a template needs, with Meta's examples when available. A carousel's cards add their own
 * variables after the message's ('card.0.header.media', 'card.0.body.1', 'card.0.button.1', …).
 */
export function templateVariables(components: MetaTemplateComponent[]): TemplateVariable[] {
  return componentVariables(components, "", undefined);
}

export type TemplateValues = Record<string, string>; // key → value (header.media = media id or link)

function substitute(
  text: string,
  values: TemplateValues,
  prefix: string,
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
  /** Carousel cards (media kind, text and button labels). */
  cards: Array<{ media: "image" | "video" | null; body: string; buttons: string[] }>;
  missing: string[]; // variable keys without a value
};

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
    missing: [],
  };
  for (const c of components) {
    if (c.type === "HEADER") {
      const h = c as Extract<MetaTemplateComponent, { type: "HEADER" }>;
      if (h.format === "TEXT")
        preview.headerText = substitute(h.text ?? "", values, "header", true, vars);
      else preview.headerMedia = h.format.toLowerCase() as TemplatePreview["headerMedia"];
    } else if (c.type === "BODY") {
      preview.body = substitute(
        (c as Extract<MetaTemplateComponent, { type: "BODY" }>).text ?? "",
        values,
        "body",
        true,
        vars,
      );
    } else if (c.type === "FOOTER") {
      preview.footer = (c as Extract<MetaTemplateComponent, { type: "FOOTER" }>).text ?? null;
    } else if (c.type === "CAROUSEL") {
      for (const [ci, card] of ((c as CarouselComponent).cards ?? []).entries()) {
        const head = card.components.find((x) => x.type === "HEADER") as
          Extract<MetaTemplateComponent, { type: "HEADER" }> | undefined;
        const body = card.components.find((x) => x.type === "BODY") as
          Extract<MetaTemplateComponent, { type: "BODY" }> | undefined;
        const btns = card.components.find((x) => x.type === "BUTTONS") as
          Extract<MetaTemplateComponent, { type: "BUTTONS" }> | undefined;
        preview.cards.push({
          media: head?.format === "VIDEO" ? "video" : head ? "image" : null,
          body: body ? substitute(body.text, values, `${cardKeyPrefix(ci)}body`, true, vars) : "",
          buttons: (btns?.buttons ?? []).map((b) => ("text" in b && b.text ? b.text : b.type)),
        });
      }
    } else if (c.type === "BUTTONS") {
      for (const b of (c as Extract<MetaTemplateComponent, { type: "BUTTONS" }>).buttons) {
        preview.buttons.push({
          type: b.type,
          text:
            "text" in b && b.text
              ? b.text
              : b.type === "COPY_CODE" || b.type === "OTP"
                ? "Copy code"
                : b.type,
        });
      }
    }
  }
  preview.missing = vars.filter((v) => !v.optional && !values[v.key]).map((v) => v.key);
  return preview;
}

/** Header / body / button parameters for one component list (the message, or one carousel card). */
function sendComponents(
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
          return { type: "image", image: mediaRef(value) };
        case "video":
          return { type: "video", video: mediaRef(value) };
        case "document":
          return { type: "document", document: mediaRef(value) };
        default:
          return named
            ? { type: "text", text: value, parameter_name: v.name }
            : { type: "text", text: value };
      }
    });
    components.push({ type: "header", parameters: params });
  }

  const bodyVars = vars.filter((v) => v.component === "body");
  if (bodyVars.length) {
    components.push({
      type: "body",
      parameters: bodyVars.map((v) =>
        named
          ? { type: "text", text: values[v.key], parameter_name: v.name }
          : { type: "text", text: values[v.key] },
      ),
    });
  }

  for (const v of vars.filter((x) => x.component === "button")) {
    if (v.kind === "url_suffix") {
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
    } else if (v.kind === "catalog_thumbnail" && values[v.key]) {
      // Without a value the button needs no parameter: Meta shows the first catalogue item.
      components.push({
        type: "button",
        sub_type: "CATALOG",
        index: v.index ?? 0,
        parameters: [{ type: "action", action: { thumbnail_product_retailer_id: values[v.key] } }],
      });
    }
  }
  return components;
}

/**
 * Authentication templates: the copy-code button carries the same code as the body's one variable. Returns the
 * button components for the message's own buttons (never a carousel card's).
 */
function otpButtonComponents(
  components: MetaTemplateComponent[],
  vars: TemplateVariable[],
  values: TemplateValues,
): TemplateComponent[] {
  const buttons = components.find((c) => c.type === "BUTTONS") as
    Extract<MetaTemplateComponent, { type: "BUTTONS" }> | undefined;
  const out: TemplateComponent[] = [];
  (buttons?.buttons ?? []).forEach((b, index) => {
    if (!isOtpButton(b)) return;
    const codeVar = vars.find((v) => v.component === "body" && v.card === undefined);
    const code = codeVar ? values[codeVar.key] : undefined;
    if (!code) throw new Error("Missing template values: the code for the copy-code button");
    out.push({ type: "button", sub_type: "url", index, parameters: [{ type: "text", text: code }] });
  });
  return out;
}

/**
 * Quick-reply buttons on carousel cards get a fixed payload ('card<i>_btn<j>') so a tap can be told apart from
 * another card's button with the same label. No patient data goes into it.
 */
function cardQuickReplies(card: { components: MetaTemplateComponent[] }, ci: number): TemplateComponent[] {
  const btns = card.components.find((x) => x.type === "BUTTONS") as
    Extract<MetaTemplateComponent, { type: "BUTTONS" }> | undefined;
  const out: TemplateComponent[] = [];
  (btns?.buttons ?? []).forEach((b, bi) => {
    if (b.type === "QUICK_REPLY")
      out.push({
        type: "button",
        sub_type: "quick_reply",
        index: bi,
        parameters: [{ type: "payload", payload: `card${ci}_btn${bi}` }],
      });
  });
  return out;
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
  const missing = vars.filter((v) => !v.optional && !values[v.key]);
  if (missing.length)
    throw new Error(`Missing template values: ${missing.map((m) => m.key).join(", ")}`);

  const components = sendComponents(
    vars.filter((v) => v.card === undefined),
    values,
    named,
  );
  components.push(...otpButtonComponents(tpl.components, vars, values));

  // Carousel (Phase 20d): one entry per card, in card order, with that card's media, text and button params.
  const carousel = tpl.components.find((c) => c.type === "CAROUSEL") as CarouselComponent | undefined;
  if (carousel) {
    components.push({
      type: "carousel",
      cards: (carousel.cards ?? []).map((card, ci) => {
        const cardVars = vars.filter((v) => v.card === ci);
        const own = sendComponents(cardVars, values, named);
        const buttons = [
          ...own.filter((x) => x.type === "button"),
          ...cardQuickReplies(card, ci),
        ].sort((a, b) => Number((a as { index: number }).index) - Number((b as { index: number }).index));
        return {
          card_index: ci,
          components: [...own.filter((x) => x.type !== "button"), ...buttons],
        };
      }),
    });
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

/**
 * CLAUDE.md rule 11: a MARKETING template never goes to a contact who opted out. One rule, used when a
 * send is requested (inbox, public API) AND again when it is actually sent, because an opt-out can
 * arrive in between. Utility templates (appointment reminders etc.) are unaffected.
 */
export function isMarketingBlocked(category: string | null | undefined, stopMarketing: boolean | null | undefined): boolean {
  return category === "MARKETING" && stopMarketing === true;
}
