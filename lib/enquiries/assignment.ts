import { z } from "zod";

/**
 * Assignment rules: the first enabled rule (lowest `sort`) whose conditions all
 * match decides the assignee of a new enquiry. Conditions are AND-ed across
 * keys and OR-ed within a list; an empty / missing condition always matches.
 * A condition on a fact the enquiry does not have fails (fail closed).
 */
const ids = z.array(z.string().uuid()).max(100).optional();

export const ruleConditionsSchema = z
  .object({
    pipeline_ids: ids,
    channel_ids: ids,
    location_ids: ids,
    department_ids: ids,
    sources: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .strict();
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), user_id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("team_round_robin"), team_id: z.string().uuid() }).strict(),
]);
export type RuleAction = z.infer<typeof ruleActionSchema>;

export type AssignmentRule = {
  id: string;
  name: string;
  sort: number;
  enabled: boolean;
  conditions: unknown;
  action: unknown;
};

export type EnquiryFacts = {
  pipeline_id: string;
  source?: string | null;
  channel_id?: string | null;
  location_id?: string | null;
  department_id?: string | null;
};

function listMatches(list: string[] | undefined, fact: string | null | undefined): boolean {
  if (!list || list.length === 0) return true;
  if (!fact) return false;
  return list.includes(fact);
}

export function conditionsMatch(conditions: RuleConditions, facts: EnquiryFacts): boolean {
  return (
    listMatches(conditions.pipeline_ids, facts.pipeline_id) &&
    listMatches(conditions.channel_ids, facts.channel_id) &&
    listMatches(conditions.location_ids, facts.location_id) &&
    listMatches(conditions.department_ids, facts.department_id) &&
    listMatches(
      conditions.sources?.map((s) => s.toLowerCase()),
      facts.source?.toLowerCase(),
    )
  );
}

export type MatchedRule = { id: string; name: string; action: RuleAction };

/** First matching enabled rule, or null. Rules that fail validation are skipped. */
export function firstMatchingRule(
  rules: readonly AssignmentRule[],
  facts: EnquiryFacts,
): MatchedRule | null {
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  for (const r of ordered) {
    const conditions = ruleConditionsSchema.safeParse(r.conditions ?? {});
    const action = ruleActionSchema.safeParse(r.action);
    if (!conditions.success || !action.success) continue;
    if (conditionsMatch(conditions.data, facts)) {
      return { id: r.id, name: r.name, action: action.data };
    }
  }
  return null;
}
