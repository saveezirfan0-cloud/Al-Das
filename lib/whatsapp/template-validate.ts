/**
 * Meta's template rules as pure checks (Phase 4). Every limit is a named constant so it is easy to
 * adjust when Meta changes them; confirm against Meta's current "message templates" documentation
 * before go-live. The builder shows these inline, and `submit` refuses a draft with errors.
 */
import {
  variableNumbers,
  type DraftButton,
  type TemplateDraft,
  VARIABLE_SOURCES,
} from "@/lib/whatsapp/template-draft";

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
  carouselCardsMin: 2,
  carouselCardsMax: 10,
  carouselCardButtonsMax: 2,
  exampleMax: 1024,
  /** Variables per N characters of body: Meta rejects bodies that are mostly variables. */
  minCharsPerVariable: 8,
} as const;

export type Issue = { path: string; severity: "error" | "warning"; message: string };

const NAME = /^[a-z0-9_]+$/;
const LANGUAGE = /^[a-z]{2}(_[A-Z]{2})?$/;
const E164_LOOSE = /^\+[1-9]\d{6,14}$/;

const err = (path: string, message: string): Issue => ({ path, severity: "error", message });
const warn = (path: string, message: string): Issue => ({ path, severity: "warning", message });

/** Variables must run 1..n without gaps. */
function sequential(nums: number[]): boolean {
  return nums.every((n, i) => n === i + 1);
}

function checkText(path: string, text: string, issues: Issue[]) {
  if (/[\t]|\n{3,}| {5,}/.test(text) && path !== "body") {
    issues.push(err(path, "Remove tabs, repeated blank lines and long runs of spaces."));
  }
  if (/\{\{\s*[^0-9\s}][^}]*\}\}/.test(text) || /\{\{\s*\}\}/.test(text)) {
    issues.push(err(path, "Variables must be numbers like {{1}}."));
  }
  const open = (text.match(/\{\{/g) ?? []).length;
  const close = (text.match(/\}\}/g) ?? []).length;
  if (open !== close) issues.push(err(path, "Unbalanced {{ }} braces."));
}

function checkBodyLike(
  path: string,
  text: string,
  examples: string[],
  max: number,
  issues: Issue[],
) {
  if (!text.trim()) {
    issues.push(err(path, "Body text is required."));
    return;
  }
  if (text.length > max)
    issues.push(err(path, `Keep it to ${max} characters (now ${text.length}).`));
  checkText(path, text, issues);
  const nums = variableNumbers(text);
  if (nums.length && !sequential(nums)) {
    issues.push(err(path, "Variables must be numbered {{1}}, {{2}}, … with no gaps."));
  }
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(text))
    issues.push(err(path, "Text cannot start with a variable."));
  if (/\{\{\s*\d+\s*\}\}\s*[.!?…،؟]*\s*$/.test(text))
    issues.push(err(path, "Text cannot end with a variable."));
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(text))
    issues.push(err(path, "Two variables cannot sit next to each other."));
  for (const n of nums) {
    const ex = examples[n - 1];
    if (!ex || !ex.trim())
      issues.push(err(path, `Add an example for {{${n}}} (Meta requires one).`));
    else if (ex.length > LIMITS.exampleMax)
      issues.push(err(path, `Example for {{${n}}} is too long.`));
    else if (/\n/.test(ex))
      issues.push(err(path, `Example for {{${n}}} cannot contain line breaks.`));
  }
  if (
    nums.length &&
    text.replace(/\{\{\s*\d+\s*\}\}/g, "").trim().length < nums.length * LIMITS.minCharsPerVariable
  ) {
    issues.push(
      err(path, "Too many variables for the amount of text: add more fixed wording around them."),
    );
  }
}

function checkButtons(path: string, buttons: DraftButton[], max: number, issues: Issue[]) {
  if (buttons.length > max)
    issues.push(err(path, `At most ${max} buttons here (now ${buttons.length}).`));
  const count = (t: DraftButton["type"]) => buttons.filter((b) => b.type === t).length;
  if (count("URL") > LIMITS.urlButtonsMax)
    issues.push(err(path, `At most ${LIMITS.urlButtonsMax} URL buttons.`));
  if (count("PHONE_NUMBER") > LIMITS.phoneButtonsMax)
    issues.push(err(path, `At most ${LIMITS.phoneButtonsMax} call button.`));
  if (count("COPY_CODE") > LIMITS.copyCodeButtonsMax)
    issues.push(err(path, `At most ${LIMITS.copyCodeButtonsMax} copy-code button.`));

  // Quick replies must be grouped together, not interleaved with call-to-action buttons.
  const kinds = buttons.map((b) => (b.type === "QUICK_REPLY" ? "Q" : "C")).join("");
  if (/Q.*C.*Q/.test(kinds))
    issues.push(err(path, "Keep quick-reply buttons together, before or after the others."));

  const seen = new Set<string>();
  buttons.forEach((b, i) => {
    const p = `${path}[${i}]`;
    if (b.type !== "COPY_CODE") {
      if (!b.text.trim()) issues.push(err(p, "Button text is required."));
      else if (b.text.length > LIMITS.buttonTextMax)
        issues.push(err(p, `Button text is at most ${LIMITS.buttonTextMax} characters.`));
      if (/\{\{/.test(b.text)) issues.push(err(p, "Button text cannot contain variables."));
      const k = b.text.trim().toLowerCase();
      if (k && seen.has(k)) issues.push(err(p, "Two buttons have the same text."));
      seen.add(k);
    }
    if (b.type === "URL") {
      if (!/^https:\/\//i.test(b.url)) issues.push(err(p, "Use an https:// address."));
      if (b.url.length > LIMITS.urlMax) issues.push(err(p, "The address is too long."));
      const nums = variableNumbers(b.url);
      if (nums.length > 1 || (nums.length === 1 && !/\{\{1\}\}$/.test(b.url)))
        issues.push(err(p, "A URL may have one variable, {{1}}, at the very end."));
      if (nums.length === 1 && !b.example?.trim())
        issues.push(err(p, "Add an example address for the variable."));
    }
    if (b.type === "PHONE_NUMBER" && !E164_LOOSE.test(b.phone_number.replace(/[\s()-]/g, "")))
      issues.push(err(p, "Use an international number like +97140000000."));
    if (b.type === "COPY_CODE") {
      if (!b.example.trim()) issues.push(err(p, "Add an example code."));
      else if (b.example.length > 15)
        issues.push(err(p, "The example code is at most 15 characters."));
    }
  });
}

/** Validates a draft. `errors` block submission; `warnings` are advice. */
export function validateDraft(d: TemplateDraft): {
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
  ok: boolean;
} {
  const issues: Issue[] = [];

  // identity
  if (!d.name) issues.push(err("name", "Give the template a name."));
  else if (!NAME.test(d.name))
    issues.push(err("name", "Use lowercase letters, numbers and underscores only."));
  else if (d.name.length > LIMITS.nameMax)
    issues.push(err("name", `At most ${LIMITS.nameMax} characters.`));
  if (!LANGUAGE.test(d.language)) issues.push(err("language", "Pick a language."));

  if (d.kind === "carousel") {
    checkBodyLike("body", d.body, d.bodyExamples, LIMITS.bodyMax, issues);
    if (d.category === "AUTHENTICATION")
      issues.push(err("category", "Carousels cannot be authentication templates."));
    if (d.cards.length < LIMITS.carouselCardsMin || d.cards.length > LIMITS.carouselCardsMax)
      issues.push(
        err(
          "cards",
          `A carousel needs ${LIMITS.carouselCardsMin}–${LIMITS.carouselCardsMax} cards.`,
        ),
      );
    const shape = (c: TemplateDraft["cards"][number]) =>
      `${c.header.format}|${c.buttons.map((b) => b.type).join(",")}`;
    const first = d.cards[0] ? shape(d.cards[0]) : "";
    d.cards.forEach((c, i) => {
      const p = `cards[${i}]`;
      if (shape(c) !== first)
        issues.push(err(p, "Every card must use the same media type and the same buttons."));
      if (!c.header.handle && !c.header.samplePath)
        issues.push(err(`${p}.header`, "Upload a sample image or video."));
      checkBodyLike(`${p}.body`, c.body, c.bodyExamples, 160, issues);
      if (c.buttons.length === 0)
        issues.push(err(`${p}.buttons`, "Each card needs at least one button."));
      checkButtons(`${p}.buttons`, c.buttons, LIMITS.carouselCardButtonsMax, issues);
    });
  } else {
    // header
    const h = d.header;
    if (h.format === "TEXT") {
      if (!h.text.trim()) issues.push(err("header", "Header text is required."));
      if (h.text.length > LIMITS.headerTextMax)
        issues.push(err("header", `Header is at most ${LIMITS.headerTextMax} characters.`));
      checkText("header", h.text, issues);
      const nums = variableNumbers(h.text);
      if (nums.length > 1) issues.push(err("header", "A header can have at most one variable."));
      if (nums.length === 1 && !h.example?.trim())
        issues.push(err("header", "Add an example for the header variable."));
      if (/[*_~`]/.test(h.text))
        issues.push(err("header", "Headers cannot use formatting characters (* _ ~ `)."));
    } else if (
      (h.format === "IMAGE" || h.format === "VIDEO" || h.format === "DOCUMENT") &&
      !h.handle &&
      !h.samplePath
    ) {
      issues.push(err("header", "Upload a sample file for the header."));
    }

    checkBodyLike("body", d.body, d.bodyExamples, LIMITS.bodyMax, issues);

    if (d.footer) {
      if (d.footer.length > LIMITS.footerMax)
        issues.push(err("footer", `Footer is at most ${LIMITS.footerMax} characters.`));
      if (/\{\{/.test(d.footer)) issues.push(err("footer", "Footers cannot contain variables."));
    }
    checkButtons("buttons", d.buttons, LIMITS.buttonsMax, issues);

    if (d.category === "AUTHENTICATION")
      issues.push(
        warn(
          "category",
          "Authentication templates follow Meta's fixed one-time-code layout; build those only if you need OTP messages.",
        ),
      );
  }

  // advice
  if (
    d.category === "MARKETING" &&
    !/stop|opt.?out|unsubscribe|إيقاف|إلغاء/i.test(`${d.body} ${d.footer}`)
  )
    issues.push(
      warn(
        "footer",
        "Marketing messages should tell people how to opt out (for example “Reply STOP to opt out”).",
      ),
    );
  if (d.category === "UTILITY" && /\b(offer|discount|% ?off|sale|promo|free)\b/i.test(d.body))
    issues.push(
      warn(
        "category",
        "Promotional wording in a utility template can make Meta reclassify it as marketing.",
      ),
    );
  if (d.language.startsWith("ar") && /[A-Za-z]{4,}/.test(d.body.replace(/\{\{\d+\}\}/g, "")))
    issues.push(
      warn(
        "body",
        "This Arabic template contains long Latin-letter words; check the wording reads correctly right-to-left.",
      ),
    );

  // variable map
  const allowed = new Set<string>(VARIABLE_SOURCES.map((s) => s.key));
  for (const [k, v] of Object.entries(d.variableMap))
    if (!allowed.has(v)) issues.push(warn(`variableMap.${k}`, `Unknown source “${v}”.`));

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { issues, errors, warnings, ok: errors.length === 0 };
}
