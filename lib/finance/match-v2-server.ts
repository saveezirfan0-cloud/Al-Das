import "server-only";

import { ageBucket, AGE_BUCKETS, daysBetween, type AgeBucket } from "@/lib/finance/bank-recon";
import { refKey } from "@/lib/finance/match-keys";
import {
  ruleHistory,
  ruleMayAuto,
  type DecisionRow,
  type GateSettings,
} from "@/lib/finance/match-rule-gate";
import { buildInsurerItems, isOpen, matchV2, type InsurerItem } from "@/lib/finance/match-v2";
import {
  AUTO_CAPABLE_RULES,
  type ApprovedAlias,
  type AutoRule,
  type MatchRule,
  type MatchSettings,
  type OpenLine,
  type Suggestion,
  type SuggestionOption,
} from "@/lib/finance/match-v2-types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

/**
 * Matching engine v2, insurer money (docs/46 section 3): loads everything with the service role (callers have run
 * can() first), builds the open items and the open bank credits, and asks the pure engine for suggestions. Nothing here
 * decides; the rules are in match-v2.ts and the invariants in the database (fin_match_decision_guard).
 */

const PAGE = 1000;

async function all<T>(
  fetch: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { code?: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetch(from, from + PAGE - 1);
    if (error) throw new Error(`matching load: ${error.code ?? "unknown"}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

const money = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

export type LoadedMatchSettings = MatchSettings & GateSettings;

/** The matching thresholds. A missing settings row is created with the table's own defaults (never defaults in code). */
export async function loadMatchSettings(
  admin: AdminClient,
  orgId: string,
): Promise<LoadedMatchSettings> {
  const read = () =>
    admin
      .from("fin_ref_finance_settings")
      .select(
        "bank_amount_tolerance, bank_amount_tolerance_pct, bank_date_window_days, match_ref_min_length, match_set_max_items, match_item_look_back_days, match_auto_min_precision, match_auto_min_months, match_auto_min_decisions",
      )
      .eq("org_id", orgId)
      .maybeSingle();
  let { data } = await read();
  if (!data) {
    await admin
      .from("fin_ref_finance_settings")
      .upsert({ org_id: orgId }, { onConflict: "org_id", ignoreDuplicates: true });
    data = (await read()).data;
  }
  if (!data) throw new Error("matching settings missing");
  return {
    toleranceAmount: Number(data.bank_amount_tolerance),
    tolerancePct: Number(data.bank_amount_tolerance_pct),
    windowDays: Number(data.bank_date_window_days),
    refMinLength: Number(data.match_ref_min_length),
    setMaxItems: Number(data.match_set_max_items),
    itemLookBackDays: Number(data.match_item_look_back_days),
    minPrecision: Number(data.match_auto_min_precision),
    minMonths: Number(data.match_auto_min_months),
    minDecisions: Number(data.match_auto_min_decisions),
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type AllocationRow = {
  id: string;
  lineId: string;
  itemRef: string;
  amount: number;
  rule: MatchRule | "manual";
  auto: boolean;
  decidedAt: string;
  lineDate: string | null;
  lineAmount: number | null;
};

export type AliasRow = {
  id: string;
  payerKey: string;
  alias: string;
  status: "proposed" | "approved" | "retired";
  proposedAt: string;
  decidedAt: string | null;
  made: number; // accepted decisions this name recognised
  undone: number; // of those, taken back
};

export type ClosureRow = {
  id: string;
  itemRef: string;
  label: string;
  kind: "write_off" | "cancelled";
  amount: number;
  itemTotal: number;
  reasonCode: string;
  note: string | null;
  decidedAt: string;
};

export type RuleGate = {
  rule: AutoRule;
  on: boolean;
  setAt: string | null;
  ok: boolean;
  reason: string;
  months: Array<{ month: string; decisions: number; precision: number; qualifies: boolean }>;
};

export type MatchingView = {
  today: string;
  settings: LoadedMatchSettings;
  account: { id: string; name: string; bank_name: string; last4: string; currency: string } | null;
  items: InsurerItem[]; // every item, any status
  openItems: InsurerItem[];
  ageOf: Record<string, AgeBucket>; // open item ref -> bucket
  lines: OpenLine[]; // credits with something left to explain
  suggestions: Suggestion[];
  allocations: AllocationRow[]; // active accepted
  rejections: Array<{ id: string; lineId: string; itemRef: string; decidedAt: string }>;
  closures: ClosureRow[]; // active
  aliases: AliasRow[];
  gates: RuleGate[];
  decisionRows: DecisionRow[];
  totals: {
    openItems: number;
    openAmount: number;
    unexplainedCredits: number;
    unexplainedAmount: number;
    suggestions: number;
    autoReady: number;
  };
  ageBuckets: Record<AgeBucket, { count: number; amount: number }>;
};

type DecisionDbRow = Pick<
  Database["public"]["Tables"]["fin_match_decisions"]["Row"],
  | "id"
  | "bank_line_id"
  | "item_ref"
  | "amount"
  | "rule"
  | "decision"
  | "auto"
  | "alias_id"
  | "decided_at"
  | "undone_at"
> & { fin_bank_lines: { value_date: string; amount: number } | null };

export async function loadMatching(
  admin: AdminClient,
  orgId: string,
  today: string,
): Promise<MatchingView> {
  const settings = await loadMatchSettings(admin, orgId);

  const { data: account } = await admin
    .from("fin_bank_accounts")
    .select("id, name, bank_name, last4, currency")
    .eq("org_id", orgId)
    .eq("receives_insurance", true)
    .eq("active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();

  const [receipts, batches, decisions, closureRows, v1, aliasRows, ruleRows] = await Promise.all([
    all((a, b) =>
      admin
        .from("fin_receipts")
        .select("ref_key, payment_ref, payer_key, amount, receipt_date")
        .eq("org_id", orgId)
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      admin
        .from("ins_remittance_batches")
        .select("id, remittance_ref, payer_id, paid_on, created_at, sum_paid")
        .eq("org_id", orgId)
        .order("id")
        .range(a, b),
    ),
    all<DecisionDbRow>((a, b) =>
      admin
        .from("fin_match_decisions")
        .select(
          "id, bank_line_id, item_ref, amount, rule, decision, auto, alias_id, decided_at, undone_at, fin_bank_lines(value_date, amount)",
        )
        .eq("org_id", orgId)
        .order("id")
        .range(a, b) as unknown as PromiseLike<{
        data: DecisionDbRow[] | null;
        error: { code?: string } | null;
      }>,
    ),
    all((a, b) =>
      admin
        .from("fin_item_closures")
        .select("id, item_ref, item_total, kind, amount, reason_code, note, decided_at")
        .eq("org_id", orgId)
        .is("undone_at", null)
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      admin
        .from("fin_bank_matches")
        .select("expected_key")
        .eq("org_id", orgId)
        .eq("status", "matched")
        .eq("expected_kind", "insurance")
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      admin
        .from("fin_payer_aliases")
        .select("id, payer_key, alias, status, proposed_at, decided_at")
        .eq("org_id", orgId)
        .order("id")
        .range(a, b),
    ),
    admin
      .from("fin_match_rule_status")
      .select("rule, auto_enabled, set_at")
      .eq("org_id", orgId)
      .then(({ data, error }) => {
        if (error) throw new Error(`matching load: ${error.code ?? "unknown"}`);
        return data ?? [];
      }),
  ]);

  // ---- allocations --------------------------------------------------------
  const active = decisions.filter((d) => d.undone_at === null);
  const accepted = active.filter((d) => d.decision === "accepted");
  const allocatedByItem = new Map<string, number>();
  const allocatedByLine = new Map<string, number>();
  for (const d of accepted) {
    allocatedByItem.set(d.item_ref, (allocatedByItem.get(d.item_ref) ?? 0) + cents(money(d.amount)));
    allocatedByLine.set(d.bank_line_id, (allocatedByLine.get(d.bank_line_id) ?? 0) + cents(money(d.amount)));
  }
  const allocated = new Map([...allocatedByItem].map(([k, v]) => [k, v / 100]));

  // ---- items ----------------------------------------------------------------
  const v1MatchedBatchIds = new Set(
    v1
      .map((m) => m.expected_key)
      .filter((k) => k.startsWith("ins|"))
      .map((k) => k.slice(4)),
  );
  const closed = new Set(closureRows.map((c) => c.item_ref));
  const items = buildInsurerItems({
    receipts: receipts.map((r) => ({
      refKey: r.ref_key,
      paymentRef: r.payment_ref,
      payerKey: r.payer_key,
      amount: money(r.amount),
      date: r.receipt_date,
    })),
    batches: batches.map((b) => ({
      id: b.id,
      refKey: refKey(b.remittance_ref),
      payerKey: b.payer_id,
      date: b.paid_on ?? b.created_at.slice(0, 10),
      sumPaid: money(b.sum_paid),
    })),
    allocated,
    closed,
    v1MatchedBatchIds,
    today,
    settings,
  });
  const openItems = items.filter(isOpen);
  const labelOf = new Map(items.map((i) => [i.ref, i.label]));

  // ---- bank credits (the insurance account; a line the monthly run matched is not ours) ---------------
  let lines: OpenLine[] = [];
  if (account) {
    const credits = await all((a, b) =>
      admin
        .from("fin_bank_lines")
        .select("id, value_date, amount, reference, description")
        .eq("org_id", orgId)
        .eq("account_id", account.id)
        .gt("amount", 0)
        .neq("match_status", "matched")
        .order("value_date")
        .order("id")
        .range(a, b),
    );
    lines = credits
      .map((l): OpenLine => {
        const amount = money(l.amount);
        const used = (allocatedByLine.get(l.id) ?? 0) / 100;
        return {
          id: l.id,
          valueDate: l.value_date,
          amount,
          allocated: used,
          open: money(amount - used),
          text: [l.reference, l.description].filter(Boolean).join(" "),
        };
      })
      .filter((l) => l.open > 0);
  }

  // ---- aliases -------------------------------------------------------------------
  const made = new Map<string, number>();
  const undone = new Map<string, number>();
  for (const d of decisions) {
    if (d.decision !== "accepted" || !d.alias_id) continue;
    made.set(d.alias_id, (made.get(d.alias_id) ?? 0) + 1);
    if (d.undone_at !== null) undone.set(d.alias_id, (undone.get(d.alias_id) ?? 0) + 1);
  }
  const aliases: AliasRow[] = aliasRows
    .map((a) => ({
      id: a.id,
      payerKey: a.payer_key,
      alias: a.alias,
      status: a.status as AliasRow["status"],
      proposedAt: a.proposed_at,
      decidedAt: a.decided_at,
      made: made.get(a.id) ?? 0,
      undone: undone.get(a.id) ?? 0,
    }))
    .sort((a, b) => a.payerKey.localeCompare(b.payerKey) || a.alias.localeCompare(b.alias));
  const approved: ApprovedAlias[] = aliases
    .filter((a) => a.status === "approved")
    .map((a) => ({ id: a.id, payerKey: a.payerKey, alias: a.alias }));

  // ---- rules ------------------------------------------------------------------------
  const decisionRows: DecisionRow[] = decisions.map((d) => ({
    rule: d.rule as DecisionRow["rule"],
    decidedAt: d.decided_at,
    decision: d.decision as DecisionRow["decision"],
    auto: d.auto,
    undone: d.undone_at !== null,
  }));
  const history = ruleHistory(decisionRows);
  const statusOf = new Map(ruleRows.map((r) => [r.rule, r]));
  const gates: RuleGate[] = AUTO_CAPABLE_RULES.map((rule) => {
    const verdict = ruleMayAuto(history, rule, settings);
    const st = statusOf.get(rule);
    return {
      rule,
      on: st?.auto_enabled === true,
      setAt: st?.set_at ?? null,
      ok: verdict.ok,
      reason: verdict.reason,
      months: verdict.months,
    };
  });
  const autoRules = new Set<AutoRule>(gates.filter((g) => g.on).map((g) => g.rule));

  const rejected = new Set(
    active.filter((d) => d.decision === "rejected").map((d) => `${d.item_ref}|${d.bank_line_id}`),
  );
  const suggestions = matchV2({
    lines,
    items: openItems,
    aliases: approved,
    rejected,
    autoRules,
    settings,
  });

  // ---- display figures ---------------------------------------------------------------------
  const ageOf: Record<string, AgeBucket> = {};
  const ageBuckets = Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, amount: 0 }])) as Record<
    AgeBucket,
    { count: number; amount: number }
  >;
  for (const i of openItems) {
    const bucket = ageBucket(daysBetween(i.date, today), settings.windowDays);
    ageOf[i.ref] = bucket;
    ageBuckets[bucket].count += 1;
    ageBuckets[bucket].amount = money(ageBuckets[bucket].amount + i.open);
  }

  return {
    today,
    settings,
    account: account ?? null,
    items,
    openItems,
    ageOf,
    lines,
    suggestions,
    allocations: accepted
      .map((d) => ({
        id: d.id,
        lineId: d.bank_line_id,
        itemRef: d.item_ref,
        amount: money(d.amount),
        rule: d.rule as AllocationRow["rule"],
        auto: d.auto,
        decidedAt: d.decided_at,
        lineDate: d.fin_bank_lines?.value_date ?? null,
        lineAmount: d.fin_bank_lines ? money(d.fin_bank_lines.amount) : null,
      }))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
    rejections: active
      .filter((d) => d.decision === "rejected")
      .map((d) => ({ id: d.id, lineId: d.bank_line_id, itemRef: d.item_ref, decidedAt: d.decided_at })),
    closures: closureRows
      .map((c) => ({
        id: c.id,
        itemRef: c.item_ref,
        label: labelOf.get(c.item_ref) ?? c.item_ref.slice(4),
        kind: c.kind as ClosureRow["kind"],
        amount: money(c.amount),
        itemTotal: money(c.item_total),
        reasonCode: c.reason_code,
        note: c.note,
        decidedAt: c.decided_at,
      }))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
    aliases,
    gates,
    decisionRows,
    totals: {
      openItems: openItems.length,
      openAmount: money(openItems.reduce((t, i) => t + i.open, 0)),
      unexplainedCredits: lines.length,
      unexplainedAmount: money(lines.reduce((t, l) => t + l.open, 0)),
      suggestions: suggestions.length,
      autoReady: suggestions.filter((s) => s.auto).length,
    },
    ageBuckets,
  };
}

// ---------------------------------------------------------------------------
// Turning a suggestion into decisions
// ---------------------------------------------------------------------------

/** A stable fingerprint of what an option would do, so a click applies exactly what the person saw. */
export function optionFingerprint(option: SuggestionOption): string {
  return [...option.allocations]
    .sort((a, b) => a.itemRef.localeCompare(b.itemRef))
    .map((a) => `${a.itemRef}=${a.amount.toFixed(2)}`)
    .join(";");
}

export type DecisionInsert = Database["public"]["Tables"]["fin_match_decisions"]["Insert"];

/**
 * The accepted-decision rows for one option, sorted by bank line then item so two concurrent callers take their locks in
 * the same order. They go to the database in ONE insert, so a set is applied whole or not at all.
 */
export function acceptedRows(
  orgId: string,
  userId: string,
  suggestion: Pick<Suggestion, "rule">,
  option: SuggestionOption,
  auto: boolean,
): DecisionInsert[] {
  return [...option.allocations]
    .sort((a, b) => a.lineId.localeCompare(b.lineId) || a.itemRef.localeCompare(b.itemRef))
    .map((a) => ({
      org_id: orgId,
      bank_line_id: a.lineId,
      item_ref: a.itemRef,
      item_total: a.itemTotal,
      amount: a.amount,
      rule: suggestion.rule,
      score: Math.max(0, Math.min(100, Math.round(option.score))),
      reasons: option.reasons,
      decision: "accepted",
      auto,
      alias_id: option.aliasId,
      decided_by: userId,
    }));
}
