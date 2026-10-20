import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { SANOFLOW_PHONE_PREFIX } from "./config";

/**
 * Setting up Sanoflow sending (pure): the checks behind "Add a Sanoflow number" and "Add a Sanoflow template" under Settings,
 * Integrations, Sanoflow (OQ-182). A Sanoflow template is a copy, in Pulse, of a template already approved in Sanoflow: its
 * Sanoflow number, name, language, category and body text with {{1}}, {{2}}, … so Pulse can show it, check consent by its
 * category and fill its values. Pulse never submits it anywhere.
 */

export const SANOFLOW_CATEGORIES = ["UTILITY", "MARKETING"] as const;
export type SanoflowCategory = (typeof SANOFLOW_CATEGORIES)[number];

export type SanoflowTemplateInput = {
  name: string;
  language: string;
  category: string;
  body: string;
  sanoflowTemplateId: number;
};

export type SanoflowTemplateDraft = {
  name: string;
  language: string;
  category: SanoflowCategory;
  components: MetaTemplateComponent[];
  sanoflowTemplateId: number;
};

const NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** A Sanoflow template number: a positive whole number Sanoflow uses (11885, 13159, …). */
export function sanoflowTemplateNumberProblem(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || n > 999_999_999)
    return "The Sanoflow template number must be a whole number (for example 11885).";
  return null;
}

export function sanoflowTemplateDraft(
  input: SanoflowTemplateInput,
): { ok: true; draft: SanoflowTemplateDraft } | { ok: false; error: string } {
  const name = input.name.trim().toLowerCase();
  if (!NAME.test(name))
    return {
      ok: false,
      error: "Use the template's name as in Sanoflow: lower-case letters, digits and _ only.",
    };
  const language = input.language.trim();
  if (!LANGUAGE.test(language))
    return { ok: false, error: "The language must be a code such as en, en_US or ar." };
  const category = input.category.trim().toUpperCase();
  if (!(SANOFLOW_CATEGORIES as readonly string[]).includes(category))
    return {
      ok: false,
      error: "Choose Utility or Marketing (one-time code templates are not sent through Sanoflow).",
    };
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!body || body.length > 1024)
    return { ok: false, error: "Paste the template's body text (at most 1,024 characters)." };
  const numbers = [...body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]!);
  if (numbers.some((n) => !/^\d+$/.test(n)))
    return { ok: false, error: "Variables must be numbered: {{1}}, {{2}}, …" };
  const distinct = [...new Set(numbers.map(Number))].sort((a, b) => a - b);
  if (distinct.some((n, i) => n !== i + 1))
    return { ok: false, error: "Number the variables {{1}}, {{2}}, … without gaps." };
  const problem = sanoflowTemplateNumberProblem(input.sanoflowTemplateId);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    draft: {
      name,
      language,
      category: category as SanoflowCategory,
      components: [{ type: "BODY", text: body } as MetaTemplateComponent],
      sanoflowTemplateId: input.sanoflowTemplateId,
    },
  };
}

/** The phone_number_id of a new Sanoflow number: a fixed prefix and a random id (never the clinic's number). */
export function sanoflowChannelRef(uuid: string): string {
  return `${SANOFLOW_PHONE_PREFIX}${uuid}`;
}
