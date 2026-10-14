/**
 * Monthly campaign message budget (Phase 20d, pure; unit-tested).
 *
 * An administrator (settings.manage) sets orgs.settings.campaign_budget.monthly_limit. Every campaign dispatch claims
 * room first (public.campaign_budget_claim, atomic per org and month in the org timezone); what is not granted stays
 * pending and the campaign pauses with BUDGET_PAUSE_REASON. Test sends, inbox messages, reminders and flows are not
 * campaign messages and are not counted. Null = no limit (the meter still counts).
 */
import { z } from "zod";

export const MAX_MONTHLY_BUDGET = 10_000_000;

export const campaignBudgetSchema = z.object({
  monthly_limit: z.number().int().min(0).max(MAX_MONTHLY_BUDGET).nullable().default(null),
});
export type CampaignBudget = z.infer<typeof campaignBudgetSchema>;

export const BUDGET_PAUSE_REASON =
  "The monthly campaign message budget is used up. An administrator can raise it, then resume the campaign.";

export function readCampaignBudget(orgSettings: unknown): CampaignBudget {
  const raw =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).campaign_budget
      : undefined;
  const parsed = campaignBudgetSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { monthly_limit: 0 }; // unreadable stored value: fail closed
}

export function writeCampaignBudget(
  orgSettings: unknown,
  next: CampaignBudget,
): Record<string, unknown> {
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  base.campaign_budget = { monthly_limit: next.monthly_limit };
  return base;
}

export type BudgetMeter = {
  used: number;
  limit: number | null;
  remaining: number | null;
  /** used / limit, capped at 1; null without a limit. */
  ratio: number | null;
  level: "none" | "ok" | "warn" | "reached";
};

export function budgetMeter(used: number, limit: number | null): BudgetMeter {
  const u = Math.max(0, Math.floor(used));
  if (limit === null) return { used: u, limit: null, remaining: null, ratio: null, level: "none" };
  const remaining = Math.max(0, limit - u);
  const ratio = limit > 0 ? Math.min(1, u / limit) : 1;
  const level = remaining === 0 ? "reached" : ratio >= 0.8 ? "warn" : "ok";
  return { used: u, limit, remaining, ratio, level };
}

/**
 * The dispatch batch after the budget claim: every skip item still goes through (it only marks a recipient skipped),
 * plus the first `granted` sendable items. The rest stay pending for later. Order is preserved.
 */
export function applyBudgetGrant<T extends object>(
  items: readonly T[],
  granted: number,
): { items: T[]; heldBack: number } {
  let left = Math.max(0, Math.floor(granted));
  let heldBack = 0;
  const out: T[] = [];
  for (const item of items) {
    if ("skip" in item) {
      out.push(item);
      continue;
    }
    if (left > 0) {
      out.push(item);
      left--;
    } else heldBack++;
  }
  return { items: out, heldBack };
}
