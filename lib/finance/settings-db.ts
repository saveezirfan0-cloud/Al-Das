import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * The finance workflow thresholds (fin_ref_finance_settings): the one place every Phase 18 rule gets its numbers from.
 * Works with the member's own client (RLS decides who may read) or the service role.
 */

export type FinanceSettings = {
  preauthExpiryLeadDays: number;
  preauthTaskEnabled: boolean;
  readyGraceDays: number;
  readyStartDate: string | null;
  denialDefaultResubmitDays: number;
  denialWarnDays: number;
  denialTaskEnabled: boolean;
  denialCasesStartDate: string | null;
  shortPayToleranceAmount: number;
  shortPayTolerancePct: number;
  scorecardMinClaims: number;
  scorecardDenialRateWarn: number;
  scorecardDenialRateAlert: number;
  scorecardDaysToPayWarn: number;
  scorecardDaysToPayAlert: number;
  forecastHorizonWeeks: number;
  forecastDefaultLagDays: number;
  forecastDefaultCollectionRate: number;
  forecastMinHistory: number;
  forecastTailWeeks: number;
  cashupVarianceTolerance: number;
  recovery: {
    enabled: boolean;
    templateId: string | null;
    variableMap: Record<string, string>;
    toneApprovedBy: string | null;
    toneApprovedAt: string | null;
    toneApprovedHash: string | null;
    minBalance: number;
    minDaysOverdue: number;
    gapDays: number;
    maxReminders: number;
    batchSize: number;
  };
};

/** The defaults the table itself carries; used when an org has no row yet (a brand-new org before its seed ran). */
export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = {
  preauthExpiryLeadDays: 7,
  preauthTaskEnabled: true,
  readyGraceDays: 1,
  readyStartDate: null,
  denialDefaultResubmitDays: 30,
  denialWarnDays: 7,
  denialTaskEnabled: true,
  denialCasesStartDate: null,
  shortPayToleranceAmount: 1,
  shortPayTolerancePct: 0.01,
  scorecardMinClaims: 20,
  scorecardDenialRateWarn: 0.1,
  scorecardDenialRateAlert: 0.2,
  scorecardDaysToPayWarn: 60,
  scorecardDaysToPayAlert: 90,
  forecastHorizonWeeks: 13,
  forecastDefaultLagDays: 60,
  forecastDefaultCollectionRate: 0.9,
  forecastMinHistory: 30,
  forecastTailWeeks: 4,
  cashupVarianceTolerance: 5,
  recovery: {
    enabled: false,
    templateId: null,
    variableMap: {},
    toneApprovedBy: null,
    toneApprovedAt: null,
    toneApprovedHash: null,
    minBalance: 50,
    minDaysOverdue: 14,
    gapDays: 14,
    maxReminders: 3,
    batchSize: 50,
  },
};

const n = (v: unknown, fallback: number) =>
  v === null || v === undefined || v === "" ? fallback : Number(v);

export function settingsFromRow(r: Tables<"fin_ref_finance_settings"> | null): FinanceSettings {
  if (!r) return DEFAULT_FINANCE_SETTINGS;
  const d = DEFAULT_FINANCE_SETTINGS;
  const map =
    r.recovery_variable_map &&
    typeof r.recovery_variable_map === "object" &&
    !Array.isArray(r.recovery_variable_map)
      ? (Object.fromEntries(
          Object.entries(r.recovery_variable_map).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : {};
  return {
    preauthExpiryLeadDays: n(r.preauth_expiry_lead_days, d.preauthExpiryLeadDays),
    preauthTaskEnabled: r.preauth_task_enabled,
    readyGraceDays: n(r.ready_grace_days, d.readyGraceDays),
    readyStartDate: r.ready_start_date,
    denialDefaultResubmitDays: n(r.denial_default_resubmit_days, d.denialDefaultResubmitDays),
    denialWarnDays: n(r.denial_warn_days, d.denialWarnDays),
    denialTaskEnabled: r.denial_task_enabled,
    denialCasesStartDate: r.denial_cases_start_date,
    shortPayToleranceAmount: n(r.short_pay_tolerance_amount, d.shortPayToleranceAmount),
    shortPayTolerancePct: n(r.short_pay_tolerance_pct, d.shortPayTolerancePct),
    scorecardMinClaims: n(r.scorecard_min_claims, d.scorecardMinClaims),
    scorecardDenialRateWarn: n(r.scorecard_denial_rate_warn, d.scorecardDenialRateWarn),
    scorecardDenialRateAlert: n(r.scorecard_denial_rate_alert, d.scorecardDenialRateAlert),
    scorecardDaysToPayWarn: n(r.scorecard_days_to_pay_warn, d.scorecardDaysToPayWarn),
    scorecardDaysToPayAlert: n(r.scorecard_days_to_pay_alert, d.scorecardDaysToPayAlert),
    forecastHorizonWeeks: n(r.forecast_horizon_weeks, d.forecastHorizonWeeks),
    forecastDefaultLagDays: n(r.forecast_default_lag_days, d.forecastDefaultLagDays),
    forecastDefaultCollectionRate: n(
      r.forecast_default_collection_rate,
      d.forecastDefaultCollectionRate,
    ),
    forecastMinHistory: n(r.forecast_min_history, d.forecastMinHistory),
    forecastTailWeeks: n(r.forecast_tail_weeks, d.forecastTailWeeks),
    cashupVarianceTolerance: n(r.cashup_variance_tolerance, d.cashupVarianceTolerance),
    recovery: {
      enabled: r.recovery_enabled,
      templateId: r.recovery_template_id,
      variableMap: map,
      toneApprovedBy: r.recovery_tone_approved_by,
      toneApprovedAt: r.recovery_tone_approved_at,
      toneApprovedHash: r.recovery_tone_approved_hash,
      minBalance: n(r.recovery_min_balance, d.recovery.minBalance),
      minDaysOverdue: n(r.recovery_min_days_overdue, d.recovery.minDaysOverdue),
      gapDays: n(r.recovery_gap_days, d.recovery.gapDays),
      maxReminders: n(r.recovery_max_reminders, d.recovery.maxReminders),
      batchSize: n(r.recovery_batch_size, d.recovery.batchSize),
    },
  };
}

export async function loadFinanceSettings(
  client: AdminClient | SupabaseClient<Database>,
  orgId: string,
): Promise<FinanceSettings> {
  const { data } = await client
    .from("fin_ref_finance_settings")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  return settingsFromRow(data);
}
