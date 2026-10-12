/**
 * Campaign Copilot, audience half. Turns a staff member's sentence into the platform's own filter AST and validates it with
 * the SAME code that runs filters everywhere else (lib/filters). PURE.
 *
 * The model never writes SQL and never sees a patient. It sees the list of fields it may use (never phone, e-mail, name,
 * notes, free text or custom fields), their allowed operators and the ids of the clinic's tags, locations and so on. Its
 * answer is parsed as JSON, checked against that closed catalogue, compiled once (which throws on an unknown field, a wrong
 * operator or a malformed value) and rejected if it would match everybody.
 */
import { z } from "zod";

import { extractJson } from "@/lib/ai/copilot/json";
import {
  countConditions,
  filterSchema,
  type Condition,
  type Filter,
  type FilterNode,
  type Group,
} from "@/lib/filters/ast";
import { OPERATORS_BY_TYPE, type FieldDef, type FieldRegistry } from "@/lib/filters/field-registry";
import { compileFilter, ParamBag } from "@/lib/filters/to-sql";

/** Fields the model may filter on. Everything else is invisible to it and refused if it asks anyway. */
export const AI_AUDIENCE_FIELDS = [
  "gender",
  "nationality",
  "country",
  "language",
  "label",
  "source",
  "tags",
  "segments",
  "dob",
  "birthday",
  "created_at",
  "last_interaction_at",
  "appointment_date",
  "appointment_status",
  "appointment_location",
  "appointment_specialist",
  "appointment_service",
  "appointment_department",
  "appointment_created_at",
  "enquiry_status",
  "enquiry_created_at",
  "enquiry_closed_at",
  "enquiry_location",
  "enquiry_specialist",
  "enquiry_service",
  "enquiry_count",
] as const;

/** Option lists the server can supply (ids and names of the clinic's own reference data). */
export const AI_OPTION_SOURCES = [
  "tags",
  "segments",
  "locations",
  "services",
  "specialists",
  "departments",
] as const;
export type AiOptionSource = (typeof AI_OPTION_SOURCES)[number];
export type OptionSets = Partial<Record<AiOptionSource, Array<{ id: string; name: string }>>>;

export const AUDIENCE_LIMITS = {
  maxConditions: 25,
  maxDepth: 3,
  maxListValues: 50,
  maxStringChars: 200,
} as const;

export type CatalogueField = {
  key: string;
  label: string;
  type: FieldDef["type"];
  operators: readonly string[];
  options?: Array<{ value: string; label: string }>;
  optionsFrom?: AiOptionSource;
};

export function buildAudienceCatalogue(
  registry: FieldRegistry,
  sets: OptionSets,
): CatalogueField[] {
  const out: CatalogueField[] = [];
  for (const key of AI_AUDIENCE_FIELDS) {
    const f = registry.get(key);
    if (!f || !f.available) continue;
    const source = f.optionsSource as string | undefined;
    if (source && !(AI_OPTION_SOURCES as readonly string[]).includes(source)) continue;
    const entry: CatalogueField = {
      key: f.key,
      label: f.label,
      type: f.type,
      operators: OPERATORS_BY_TYPE[f.type],
    };
    if (f.options) entry.options = f.options;
    if (source) {
      const list = sets[source as AiOptionSource] ?? [];
      if (list.length === 0) continue; // nothing to choose from: the field is not offered
      entry.optionsFrom = source as AiOptionSource;
      entry.options = list.slice(0, 100).map((o) => ({ value: o.id, label: o.name }));
    }
    out.push(entry);
  }
  return out;
}

const answerSchema = z.object({
  filter: z.unknown(),
  explanation: z.string().max(600).optional(),
});

export type AudienceValidation =
  | { ok: true; filter: Filter; explanation: string; warnings: string[] }
  /** `declined`: the model said it cannot build this (out of scope). Not repaired, shown as is. */
  | { ok: false; errors: string[]; declined?: boolean };

type Ctx = { registry: FieldRegistry; sets: OptionSets; timezone: string };

function depthOf(node: FilterNode): number {
  return node.type === "condition" ? 0 : 1 + Math.max(0, ...node.children.map(depthOf));
}

function walk(node: FilterNode, visit: (c: Condition) => void) {
  if (node.type === "condition") visit(node);
  else node.children.forEach((c) => walk(c, visit));
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Validates an already-parsed filter (also used to re-check a filter a browser sends back before it is saved). */
export function validateAudienceFilter(
  raw: unknown,
  ctx: Ctx,
): { ok: true; filter: Filter; warnings: string[] } | { ok: false; errors: string[] } {
  const parsed = filterSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      errors: ["The audience is not in the filter format (include group with conditions)."],
    };
  const filter = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const total = countConditions(filter.include) + countConditions(filter.exclude ?? null);
  if (countConditions(filter.include) === 0)
    return {
      ok: false,
      errors: [
        "The audience has no conditions, which would match every patient. Say who it should include.",
      ],
    };
  if (total > AUDIENCE_LIMITS.maxConditions)
    errors.push(
      `The audience has ${total} conditions; the limit is ${AUDIENCE_LIMITS.maxConditions}.`,
    );
  if (
    depthOf(filter.include) > AUDIENCE_LIMITS.maxDepth ||
    (filter.exclude && depthOf(filter.exclude) > AUDIENCE_LIMITS.maxDepth)
  )
    errors.push(`Groups are nested more than ${AUDIENCE_LIMITS.maxDepth} levels deep.`);

  const allowed = new Set<string>(AI_AUDIENCE_FIELDS);
  const check = (c: Condition) => {
    if (!allowed.has(c.field)) {
      errors.push(`The field "${c.field.slice(0, 60)}" is not available for AI-built audiences.`);
      return;
    }
    const f = ctx.registry.get(c.field);
    if (!f || !f.available) {
      errors.push(`The field "${c.field}" is not available in this workspace.`);
      return;
    }
    const vals = strings(c.value);
    if (Array.isArray(c.value) && c.value.length > AUDIENCE_LIMITS.maxListValues)
      errors.push(`"${c.field}" lists too many values.`);
    if (vals.some((v) => v.length > AUDIENCE_LIMITS.maxStringChars))
      errors.push(`A value for "${c.field}" is too long.`);
    const source = f.optionsSource as AiOptionSource | undefined;
    if (source) {
      const known = new Set((ctx.sets[source] ?? []).map((o) => o.id));
      for (const v of vals)
        if (!known.has(v))
          errors.push(
            `"${v.slice(0, 40)}" is not one of this clinic's ${source} (use the ids provided).`,
          );
    } else if (f.options) {
      const known = new Set(f.options.map((o) => o.value));
      for (const v of vals)
        if (!known.has(v)) errors.push(`"${v.slice(0, 40)}" is not a valid value for ${c.field}.`);
    }
  };
  walk(filter.include, check);
  if (filter.exclude) walk(filter.exclude, check);
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 12) };

  // The real compiler is the last word: it throws for an unknown field, a wrong operator or a malformed value.
  try {
    compileFilter(filter, ctx.registry, { timezone: ctx.timezone }, new ParamBag());
  } catch (err) {
    return {
      ok: false,
      errors: [
        `The filter could not be compiled: ${err instanceof Error ? err.message.slice(0, 160) : "invalid"}.`,
      ],
    };
  }

  if (
    countConditions(filter.include) === 1 &&
    filter.include.children.length === 1 &&
    filter.include.children[0]!.type === "condition"
  ) {
    const only = (filter.include.children[0] as Condition).field;
    if (only === "created_at" || only === "language")
      warnings.push("This is a broad audience. Check the count before using it.");
  }
  return { ok: true, filter, warnings };
}

export function validateAudienceOutput(rawText: string, ctx: Ctx): AudienceValidation {
  const json = extractJson(rawText);
  if (!json.ok) return { ok: false, errors: [json.reason] };
  const shape = answerSchema.safeParse(json.value);
  if (!shape.success)
    return { ok: false, errors: ['The reply must be {"filter": {...}, "explanation": "..."}.'] };
  if (shape.data.filter === null)
    return {
      ok: false,
      declined: true,
      errors: [
        (shape.data.explanation ?? "").trim().slice(0, 300) ||
          "The assistant could not build an audience from that.",
      ],
    };
  const v = validateAudienceFilter(shape.data.filter, ctx);
  if (!v.ok) return v;
  return {
    ok: true,
    filter: v.filter,
    explanation: (shape.data.explanation ?? "").trim().slice(0, 600),
    warnings: v.warnings,
  };
}

/** The contacts a campaign could actually send MARKETING to: the audience AND opted in AND not stopped. Pure filter surgery. */
export function withMarketingEligibility(filter: Filter): Filter {
  const optIn: Group = {
    type: "group",
    logic: "and",
    children: [
      { type: "condition", field: "promotions_opt_in", op: "is_true" },
      { type: "condition", field: "stop_marketing", op: "is_false" },
    ],
  };
  return {
    include: { type: "group", logic: "and", children: [filter.include, optIn] },
    exclude: filter.exclude ?? null,
  };
}
