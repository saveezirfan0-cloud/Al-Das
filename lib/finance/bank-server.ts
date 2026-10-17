import "server-only";

import {
  addDays,
  reconcileRun,
  type BankLine,
  type BankSettings,
  type Collection,
  type Decision,
  type RemittanceBatch,
  type RunResult,
  type SettlementLine,
  type SettlementRule,
} from "@/lib/finance/bank-recon";
import { refKey } from "@/lib/finance/match-keys";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads one reconciliation run's inputs with the service role (callers have run can() first) and computes it with the
 * pure rules in bank-recon.ts. Nothing here decides; it only moves data.
 */

const PAGE = 1000;
const LOOK_BACK_DAYS = 15; // bank lines before the period (window + slack)
const LOOK_AHEAD_DAYS = 45; // bank lines after the period: the longest lag plus the window

async function all<T>(
  fetch: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { code?: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetch(from, from + PAGE - 1);
    if (error) throw new Error(`bank load: ${error.code ?? "unknown"}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

/**
 * What the open-item matching (insurer payments, matching v2) already settled, so the monthly run never settles it twice:
 * bank lines with an active accepted allocation, and item refs (`ins|<ref key>` / `ins|batch:<id>`) that carry one or are
 * closed.
 */
async function loadV2Footprint(
  admin: AdminClient,
  orgId: string,
): Promise<{ lineIds: Set<string>; itemRefs: Set<string> }> {
  const [decisions, closures] = await Promise.all([
    all((a, b) =>
      admin
        .from("fin_match_decisions")
        .select("bank_line_id, item_ref")
        .eq("org_id", orgId)
        .eq("decision", "accepted")
        .is("undone_at", null)
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      admin
        .from("fin_item_closures")
        .select("item_ref")
        .eq("org_id", orgId)
        .is("undone_at", null)
        .order("id")
        .range(a, b),
    ),
  ]);
  return {
    lineIds: new Set(decisions.map((d) => d.bank_line_id)),
    itemRefs: new Set([...decisions.map((d) => d.item_ref), ...closures.map((c) => c.item_ref)]),
  };
}

/** The bank thresholds. A missing settings row is created with the table's own defaults (never defaults from code). */
export async function loadBankSettings(admin: AdminClient, orgId: string): Promise<BankSettings> {
  const read = () =>
    admin
      .from("fin_ref_finance_settings")
      .select(
        "bank_weekend_days, bank_date_window_days, bank_amount_tolerance, bank_amount_tolerance_pct, bank_auto_accept_score, bank_cutoff_day",
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
  if (!data) throw new Error("bank settings missing");
  return {
    weekendDays: (data.bank_weekend_days ?? []).map(Number),
    windowDays: Number(data.bank_date_window_days),
    toleranceAmount: Number(data.bank_amount_tolerance),
    tolerancePct: Number(data.bank_amount_tolerance_pct),
    autoAcceptScore: Number(data.bank_auto_accept_score),
    cutoffDay: Number(data.bank_cutoff_day),
  };
}

export async function loadSettlementRules(
  admin: AdminClient,
  orgId: string,
): Promise<Array<SettlementRule & { id: string }>> {
  const { data, error } = await admin
    .from("fin_ref_settlement_rules")
    .select("id, payment_mode, lag_days, fee_pct, account_id, settles_to_bank, source")
    .eq("org_id", orgId)
    .order("payment_mode");
  if (error) throw new Error(`rules: ${error.code ?? "unknown"}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    mode: r.payment_mode,
    lagDays: r.lag_days,
    feePct: r.fee_pct === null ? null : Number(r.fee_pct),
    accountId: r.account_id,
    settlesToBank: r.settles_to_bank,
    source: r.source === "settlement" ? "settlement" : "collections",
  }));
}

export type RecRow = {
  id: string;
  account_id: string;
  month: string;
  period_start: string;
  period_end: string;
  status: string;
  figures_sha256: string | null;
  prepared_by: string | null;
  prepared_at: string | null;
  signed_by: string | null;
  signed_at: string | null;
};

export type LoadedRun = {
  rec: RecRow;
  account: {
    id: string;
    name: string;
    bank_name: string;
    last4: string;
    currency: string;
    receives_insurance: boolean;
  };
  settings: BankSettings;
  result: RunResult;
  lines: Map<string, BankLine>; // the bank lines the run looked at, by id (for display)
};

const toLine = (l: {
  id: string;
  value_date: string;
  amount: number | string;
  reference: string | null;
  description: string | null;
}): BankLine => ({
  id: l.id,
  valueDate: l.value_date,
  amount: Number(l.amount),
  reference: l.reference,
  description: l.description,
});

export async function loadRun(
  admin: AdminClient,
  orgId: string,
  recId: string,
  today: string,
): Promise<LoadedRun | null> {
  const { data: rec } = await admin
    .from("fin_bank_recs")
    .select(
      "id, account_id, month, period_start, period_end, status, figures_sha256, prepared_by, prepared_at, signed_by, signed_at",
    )
    .eq("org_id", orgId)
    .eq("id", recId)
    .maybeSingle();
  if (!rec) return null;
  const { data: account } = await admin
    .from("fin_bank_accounts")
    .select("id, name, bank_name, last4, currency, receives_insurance")
    .eq("org_id", orgId)
    .eq("id", rec.account_id)
    .single();
  if (!account) return null;

  const period = { start: rec.period_start, end: rec.period_end };
  const from = addDays(period.start, -LOOK_BACK_DAYS);
  const to = addDays(period.end, LOOK_AHEAD_DAYS);
  const [settings, rules] = await Promise.all([
    loadBankSettings(admin, orgId),
    loadSettlementRules(admin, orgId),
  ]);
  const settlementModes = rules
    .filter((r) => r.source === "settlement" && r.accountId === account.id)
    .map((r) => r.mode);

  const [collections, settlements, remittanceBatches, lines, decisions, notes, lastLine, v2] =
    await Promise.all([
      admin
        .rpc("fin_bank_collections", { p_org_id: orgId, p_from: period.start, p_to: period.end })
        .then(({ data, error }) => {
          if (error) throw new Error(`collections: ${error.code ?? "unknown"}`);
          return (
            (data ?? []) as unknown as Array<{
              mode: string;
              date: string;
              paid: number;
              refunds: number;
              payments: number;
            }>
          ).map((c): Collection => ({
            mode: c.mode,
            date: c.date,
            paid: Number(c.paid),
            refunds: Number(c.refunds),
            payments: Number(c.payments),
          }));
        }),
      settlementModes.length === 0
        ? Promise.resolve([] as SettlementLine[])
        : all((a, b) =>
            admin
              .from("fin_settlement_lines")
              .select("id, payment_mode, txn_date, settlement_date, gross, fee, net, reference")
              .eq("org_id", orgId)
              .in("payment_mode", settlementModes)
              .or(
                `and(settlement_date.gte.${period.start},settlement_date.lte.${period.end}),and(txn_date.gte.${period.start},txn_date.lte.${period.end})`,
              )
              .order("id")
              .range(a, b),
          ).then((rows) =>
            rows.map((s): SettlementLine => ({
              mode: s.payment_mode,
              txnDate: s.txn_date,
              settlementDate: s.settlement_date,
              gross: Number(s.gross),
              fee: Number(s.fee),
              net: Number(s.net),
              reference: s.reference,
            })),
          ),
      account.receives_insurance
        ? all((a, b) =>
            admin
              .from("ins_remittance_batches")
              .select("id, remittance_ref, payer_id, paid_on, created_at, sum_paid")
              .eq("org_id", orgId)
              .gte("created_at", `${addDays(period.start, -120)}T00:00:00Z`) // advices are uploaded after the payment date
              .order("id")
              .range(a, b),
          ).then((rows) =>
            rows.map((r): RemittanceBatch => ({
              id: r.id,
              ref: r.remittance_ref,
              payerId: r.payer_id,
              date: r.paid_on ?? r.created_at.slice(0, 10),
              amount: Number(r.sum_paid),
            })),
          )
        : Promise.resolve([] as RemittanceBatch[]),
      all((a, b) =>
        admin
          .from("fin_bank_lines")
          .select("id, value_date, amount, reference, description, match_status")
          .eq("org_id", orgId)
          .eq("account_id", account.id)
          .gte("value_date", from)
          .lte("value_date", to)
          .order("id")
          .range(a, b),
      ),
      all((a, b) =>
        admin
          .from("fin_bank_matches")
          .select("expected_key, bank_line_id, status, auto, score")
          .eq("org_id", orgId)
          .eq("rec_id", rec.id)
          .order("id")
          .range(a, b),
      ),
      all((a, b) =>
        admin
          .from("fin_bank_rec_notes")
          .select("item_key, reason_code, note")
          .eq("org_id", orgId)
          .eq("rec_id", rec.id)
          .order("id")
          .range(a, b),
      ),
      admin
        .from("fin_bank_lines")
        .select("value_date")
        .eq("org_id", orgId)
        .eq("account_id", account.id)
        .order("value_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      loadV2Footprint(admin, orgId),
    ]);
  // an insurer payment the open-item matching has allocated or closed is not expected again by the monthly run
  const remittances = remittanceBatches.filter(
    (r) => !v2.itemRefs.has(`ins|${refKey(r.ref) ?? `batch:${r.id}`}`),
  );

  const mine = new Set(decisions.filter((d) => d.status === "matched").map((d) => d.bank_line_id));
  // lines matched in this run but outside the loaded window
  const missing = [...mine].filter((id) => !lines.some((l) => l.id === id));
  const extra = missing.length
    ? ((
        await admin
          .from("fin_bank_lines")
          .select("id, value_date, amount, reference, description, match_status")
          .eq("org_id", orgId)
          .in("id", missing)
      ).data ?? [])
    : [];
  const allLines = [...lines, ...extra];
  const matchedElsewhere = new Set(
    allLines
      .filter((l) => !mine.has(l.id) && (l.match_status === "matched" || v2.lineIds.has(l.id)))
      .map((l) => l.id),
  );

  const bankLines = allLines.map(toLine);
  const result = reconcileRun({
    accountId: account.id,
    receivesInsurance: account.receives_insurance,
    period,
    rules,
    settings,
    collections,
    settlements,
    remittances,
    lines: bankLines,
    matchedElsewhere,
    decisions: decisions.map((d): Decision => ({
      expectedKey: d.expected_key,
      lineId: d.bank_line_id,
      status: d.status === "matched" ? "matched" : "rejected",
      auto: d.auto,
      score: d.score,
    })),
    notes: notes.map((n) => ({ itemKey: n.item_key, code: n.reason_code, note: n.note })),
    today,
    statementEnd: lastLine.data?.value_date ?? null,
  });
  return { rec, account, settings, result, lines: new Map(bankLines.map((l) => [l.id, l])) };
}
