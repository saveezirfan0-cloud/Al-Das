/**
 * Meta-policy lint for WhatsApp template copy. PURE and deterministic: no model involved.
 *
 * It layers the clinic's own rules and a reading of Meta's published template guidelines ON TOP of the builder's structural
 * validation (lib/templates/builder.ts validateDraft, which stays the authority on what Meta's API accepts). It cannot
 * predict Meta's review: it exists to catch the mistakes that are cheap to catch before a template is submitted, namely
 * a promotional message filed as Utility, a marketing message with no way to opt out, variables that fill from the wrong
 * place, health claims and health details in a message that goes to many people.
 */
import { clinicalContentFlags } from "@/lib/ai/guardrails";
import { parseSource } from "@/lib/campaigns/variables";
import { validateDraft, variableNumbers, type TemplateDraft } from "@/lib/templates/builder";

export type LintSeverity = "error" | "warning";
export type LintIssue = { severity: LintSeverity; code: string; message: string; path?: string };
export type LintResult = {
  /** No errors. Warnings do not block a draft but should be read. */
  ok: boolean;
  issues: LintIssue[];
  /** What the wording looks like, whatever the draft says. Meta makes the final call. */
  looksLike: "MARKETING" | "UTILITY";
};

/** Where a suggested template's variables may come from. Names only: nothing clinical, nothing free-form. */
export const AI_VARIABLE_SOURCES = [
  "contact.first_name",
  "contact.last_name",
  "contact.full_name",
] as const;

const PROMO_EN =
  /(?<!feel )\bfree\b|\b(offer|offers|discount|discounts|promo|promotion|sale|special price|limited time|book now|don'?t miss|save \d+|deal|deals|package|voucher|coupon|exclusive|bonus|gift|\d+ ?% ?(?:off|discount))\b/i;
const PROMO_AR = /(عرض|عروض|خصم|مجان|تخفيض|باقة|حصري|لفترة محدودة|احجز الآن|احجزي|هدية|قسيمة)/;
const TRANSACTIONAL =
  /\b(appointment|reminder|confirm\w*|your visit|invoice|receipt|booking|reschedul\w+|check-?in)\b|(موعد|تذكير|تأكيد|فاتورة|إيصال|حجز)/i;
const OPT_OUT = /\bstop\b|unsubscribe|opt[ -]?out|إيقاف|ايقاف|إلغاء الاشتراك|الغاء الاشتراك/i;
const HEALTH_CLAIM =
  /\b(cure[sd]?|guarantee[ds]?|100 ?%|miracle|risk-?free|painless|no side effects)\b|(ضمان|مضمون|شفاء|علاج نهائي|بدون آثار جانبية|معجز)/i;
const HEALTH_DETAIL =
  /\b(diabet\w*|cancer|hiv|aids|pregnan\w*|depress\w*|hypertension|medication|prescription|lab results?|test results?|blood results?|diagnos\w*)\b|(سكري|السكري|سرطان|حمل|اكتئاب|وصفة|نتيجة التحليل|نتائج التحليل|تشخيص)/i;
const SHORTENER = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rb\.gy)\b/i;
const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/;
const ARABIC = /[؀-ۿ]/g;
const LATIN_LETTER = /[A-Za-z]/g;

function corpus(d: TemplateDraft): string {
  return [
    d.header.kind === "text" ? d.header.text : "",
    d.body,
    d.footer,
    ...d.buttons.map((b) => ("text" in b ? b.text : "")),
  ]
    .filter(Boolean)
    .join("\n");
}

export function looksPromotional(text: string): boolean {
  return PROMO_EN.test(text) || PROMO_AR.test(text);
}

export function lintTemplatePolicy(
  draft: TemplateDraft,
  opts: { allowedSources?: readonly string[] } = {},
): LintResult {
  const allowedSources = opts.allowedSources ?? AI_VARIABLE_SOURCES;
  const issues: LintIssue[] = [];
  const add = (severity: LintSeverity, code: string, message: string, path?: string) =>
    issues.push({ severity, code, message, path });

  // 1. Structural rules (the builder's own validator).
  const structural = validateDraft(draft);
  for (const e of structural.errors) add("error", "builder", e.message, e.path);
  // The builder only warns about a missing opt-out; this lint turns it into an error below, so do not say it twice.
  for (const w of structural.warnings)
    if (!/how to opt out/.test(w.message)) add("warning", "builder", w.message, w.path);

  const text = corpus(draft);
  const promo = looksPromotional(text);
  const transactional = TRANSACTIONAL.test(text);
  const looksLike: LintResult["looksLike"] = promo ? "MARKETING" : "UTILITY";

  // 2. Category.
  if (draft.category === "UTILITY" && promo)
    add(
      "error",
      "category_promo_as_utility",
      "This wording is promotional (an offer, discount or call to buy) but the category is Utility. Meta re-files it as Marketing or rejects it. Use Marketing.",
      "category",
    );
  if (draft.category === "MARKETING" && !promo && transactional)
    add(
      "warning",
      "category_maybe_utility",
      "This reads like a service message about an existing booking. If it only concerns an existing booking it may qualify as Utility, which needs no marketing opt-in. Meta decides.",
      "category",
    );

  // 3. Opt-out line (the clinic honours stop_marketing; the patient needs a way to say it).
  if (
    draft.category === "MARKETING" &&
    !OPT_OUT.test(
      `${draft.footer}\n${draft.body}\n${draft.buttons.map((b) => ("text" in b ? b.text : "")).join("\n")}`,
    )
  )
    add(
      "error",
      "no_opt_out",
      "A marketing message must tell people how to stop receiving it, e.g. the footer “Reply STOP to unsubscribe” (Arabic: “أرسل STOP لإلغاء الاشتراك”).",
      "footer",
    );

  // 4. Variables: every one must be filled from an allowed, non-clinical source.
  const bodyVars = variableNumbers(draft.body);
  const headerVars = draft.header.kind === "text" ? variableNumbers(draft.header.text) : [];
  for (const n of bodyVars) {
    const source = draft.variableMap[`body.${n}`];
    if (!source)
      add(
        "error",
        "variable_source_missing",
        `{{${n}}} has no source. Map it to the patient's first name.`,
        `variableMap.body.${n}`,
      );
    else {
      const parsed = parseSource(source);
      if (!parsed || !allowedSources.includes(source))
        add(
          "error",
          "variable_source_not_allowed",
          `{{${n}}} is filled from "${source.slice(0, 40)}", which is not allowed for suggested copy. Use the patient's name only.`,
          `variableMap.body.${n}`,
        );
    }
  }
  if (headerVars.length)
    add(
      "error",
      "variable_in_header",
      "Suggested copy keeps variables out of the header.",
      "header",
    );
  if (bodyVars.length > 3)
    add(
      "warning",
      "many_variables",
      "More than three variables makes a template more likely to be rejected.",
      "body",
    );

  // 5. Clinical content and health claims.
  for (const f of clinicalContentFlags(text))
    add(
      "error",
      "clinical_content",
      `${f} A template goes to many people and must not give medical advice.`,
      "body",
    );
  if (HEALTH_CLAIM.test(text))
    add(
      "error",
      "health_claim",
      "Do not promise outcomes or guarantee results (words like cure, guaranteed, 100%, painless). Health advertising rules and Meta both reject them.",
      "body",
    );
  if (HEALTH_DETAIL.test(text))
    add(
      "warning",
      "health_detail",
      "This mentions a condition, medication or result. A template reaches many patients: keep health details out of it.",
      "body",
    );

  // 6. Links, numbers, tone.
  if (SHORTENER.test(text))
    add(
      "error",
      "url_shortener",
      "Link shorteners are not allowed in templates. Use the full address.",
      "body",
    );
  if (PHONE_LIKE.test(draft.body))
    add(
      "warning",
      "phone_in_body",
      "A phone number in the text is easy to miss. Use a call button in the template builder instead.",
      "body",
    );
  const letters = text.match(LATIN_LETTER) ?? [];
  if (letters.length >= 20 && (text.match(/[A-Z]/g) ?? []).length / letters.length > 0.4)
    add(
      "warning",
      "shouting",
      "Too much capital lettering reads as shouting and is flagged as spam.",
      "body",
    );
  if ((text.match(/!/g) ?? []).length > 3)
    add("warning", "exclamations", "More than three exclamation marks looks like spam.", "body");
  if ((text.match(/\p{Extended_Pictographic}/gu) ?? []).length > 3)
    add("warning", "emoji", "Use three emoji at most.", "body");
  if (draft.category === "MARKETING" && draft.body.length > 600)
    add(
      "warning",
      "long_marketing",
      "Long marketing messages are read less and flagged more. Aim for under 600 characters.",
      "body",
    );

  // 7. Language matches the declared language.
  const arabic = (draft.body.match(ARABIC) ?? []).length;
  const latin = (draft.body.match(LATIN_LETTER) ?? []).length;
  if (draft.language === "ar" && arabic === 0)
    add(
      "error",
      "language_mismatch",
      "The language is Arabic but the text has no Arabic letters.",
      "language",
    );
  if (draft.language.startsWith("en") && arabic > latin)
    add(
      "error",
      "language_mismatch",
      "The language is English but the text is mostly Arabic.",
      "language",
    );

  // 8. Things the copilot cannot supply.
  if (draft.header.kind === "media")
    add(
      "warning",
      "media_needed",
      "Upload a sample file in the template builder before submitting.",
      "header",
    );

  const ok = !issues.some((i) => i.severity === "error");
  return { ok, issues, looksLike };
}
