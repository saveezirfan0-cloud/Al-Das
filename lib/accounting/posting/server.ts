import "server-only";

import {
  missingMappings,
  type MissingMapping,
  type NeededKeys,
} from "@/lib/accounting/posting/rules";
import {
  DEFAULT_SETTINGS,
  isPostingSource,
  RULE_KIND_LIST,
  type PostingSettings,
  type PostingSource,
  type RuleKind,
  type RuleRow,
} from "@/lib/accounting/posting/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Loaders for the posting pages (Phase 22D): Posting rules, Waiting to post, Posting preview. Service role, called by
 * the page after its own permission check. Ids, codes and amounts only.
 */

export type RuleView = {
  id: string;
  kind: RuleKind;
  key: string;
  qualifier: string;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  tax_code_id: string | null;
  tax_code: string | null;
  note: string | null;
  origin: string;
  active: boolean;
};

export type PostingRulesView = {
  rules: RuleView[];
  accounts: Array<{ id: string; code: string; name: string }>;
  taxCodes: Array<{ id: string; code: string; name: string }>;
  settings: PostingSettings;
  missing: MissingMapping[];
  needed: NeededKeys;
};

const emptyNeeded: NeededKeys = {
  service_categories: [],
  payment_modes: [],
  expense_categories: [],
  provider_kinds: [],
  branches: [],
};

export async function loadPostingSettings(
  admin: AdminClient,
  orgId: string,
): Promise<PostingSettings> {
  const { data } = await admin
    .from("acc_posting_settings")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return {
    denialAllowanceEnabled: data.denial_allowance_enabled,
    packageInvoices: data.package_invoices === "post" ? "post" : "hold",
    roundingTolerance: Number(data.rounding_tolerance),
    vatTolerance: Number(data.vat_tolerance),
    pausedSources: (data.paused_sources ?? []).filter((s): s is PostingSource =>
      isPostingSource(s),
    ),
  };
}

export async function loadPostingRulesView(
  admin: AdminClient,
  orgId: string,
): Promise<PostingRulesView> {
  const [rulesRes, accountsRes, taxRes, settings, neededRes] = await Promise.all([
    admin
      .from("acc_posting_rules")
      .select("id, kind, key, qualifier, account_id, tax_code_id, note, origin, active")
      .eq("org_id", orgId)
      .order("kind")
      .order("key")
      .order("qualifier"),
    admin
      .from("acc_accounts")
      .select("id, code, name")
      .eq("org_id", orgId)
      .eq("is_group", false)
      .eq("is_active", true)
      .order("code"),
    admin
      .from("acc_tax_codes")
      .select("id, code, name")
      .eq("org_id", orgId)
      .eq("active", true)
      .order("code"),
    loadPostingSettings(admin, orgId),
    admin.rpc("acc_posting_needed_keys", { p_org_id: orgId }),
  ]);
  const accounts = accountsRes.data ?? [];
  const taxCodes = taxRes.data ?? [];
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const tax = new Map(taxCodes.map((t) => [t.id, t]));
  // an inactive account still shows on its rule
  const missingIds = (rulesRes.data ?? [])
    .map((r) => r.account_id)
    .filter((id): id is string => !!id && !acc.has(id));
  if (missingIds.length) {
    const { data } = await admin.from("acc_accounts").select("id, code, name").in("id", missingIds);
    for (const a of data ?? []) acc.set(a.id, { ...a, name: `${a.name} (inactive)` });
  }
  const rules: RuleView[] = (rulesRes.data ?? [])
    .filter((r) => (RULE_KIND_LIST as readonly string[]).includes(r.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind as RuleKind,
      key: r.key,
      qualifier: r.qualifier,
      account_id: r.account_id,
      account_code: r.account_id ? (acc.get(r.account_id)?.code ?? null) : null,
      account_name: r.account_id ? (acc.get(r.account_id)?.name ?? null) : null,
      tax_code_id: r.tax_code_id,
      tax_code: r.tax_code_id ? (tax.get(r.tax_code_id)?.code ?? null) : null,
      note: r.note,
      origin: r.origin,
      active: r.active,
    }));
  const needed = { ...emptyNeeded, ...((neededRes.data ?? {}) as Partial<NeededKeys>) };
  const active: RuleRow[] = rules
    .filter((r) => r.active)
    .map((r) => ({
      kind: r.kind,
      key: r.key,
      qualifier: r.qualifier,
      account: r.account_code,
      tax_code: r.tax_code,
    }));
  return {
    rules,
    accounts,
    taxCodes,
    settings,
    needed,
    missing: missingMappings(needed, active, { denialAllowance: settings.denialAllowanceEnabled }),
  };
}

export type WaitingItem = {
  source_kind: PostingSource;
  source_id: string;
  reason: string;
  detail: string | null;
  source_date: string | null;
  amount: number | null;
  attempts: number;
  first_seen_at: string;
  last_attempt_at: string;
  journal_id: string | null;
};

export const WAITING_LIMIT = 500;

/** acc_posting_status.state values (its CHECK constraint). */
const POSTING_STATES = ["posted", "waiting", "preview", "nothing", "withdrawn"] as const;

export async function loadWaiting(
  admin: AdminClient,
  orgId: string,
  filter: { reason?: string; kind?: string } = {},
): Promise<{
  items: WaitingItem[];
  byReason: Array<{ reason: string; count: number }>;
  byState: Record<string, number>;
}> {
  let query = admin
    .from("acc_posting_status")
    .select(
      "source_kind, source_id, reason, detail, source_date, amount, attempts, first_seen_at, last_attempt_at, journal_id",
    )
    .eq("org_id", orgId)
    .eq("state", "waiting")
    .order("source_date", { ascending: true, nullsFirst: true })
    .order("source_id")
    .limit(WAITING_LIMIT);
  if (filter.reason) query = query.eq("reason", filter.reason);
  if (filter.kind) query = query.eq("source_kind", filter.kind);
  // PostgREST returns at most 1,000 rows per request, so states are exact head counts (the CHECK constraint fixes the
  // list) and only the waiting rows' reasons are read, in pages.
  const [{ data }, stateCounts, { data: waiting }] = await Promise.all([
    query,
    Promise.all(
      POSTING_STATES.map(async (state) => {
        const { count } = await admin
          .from("acc_posting_status")
          .select("source_id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .eq("state", state);
        return [state, count ?? 0] as const;
      }),
    ),
    fetchAll((from, to) =>
      admin
        .from("acc_posting_status")
        .select("reason")
        .eq("org_id", orgId)
        .eq("state", "waiting")
        .order("source_kind")
        .order("source_id")
        .range(from, to),
    ),
  ]);
  const byReason = new Map<string, number>();
  const byState: Record<string, number> = {};
  for (const [state, count] of stateCounts) if (count) byState[state] = count;
  for (const s of waiting ?? []) {
    if (s.reason) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  }
  return {
    items: (data ?? [])
      .filter((d) => isPostingSource(d.source_kind))
      .map((d) => ({
        ...d,
        source_kind: d.source_kind as PostingSource,
        reason: d.reason ?? "error",
        amount: d.amount === null ? null : Number(d.amount),
      })),
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    byState,
  };
}

export type PreviewRow = {
  account_id: string;
  code: string;
  name: string;
  month: string;
  preview: number;
  ledger: number;
  difference: number;
};

export async function loadPreviewReport(
  admin: AdminClient,
  orgId: string,
  from: string,
  to: string,
): Promise<PreviewRow[]> {
  const { data, error } = await admin.rpc("acc_posting_preview_report", {
    p_org_id: orgId,
    p_entity_id: null as unknown as string,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`preview: ${error.code ?? "error"}`);
  return ((data ?? []) as PreviewRow[]).map((r) => ({
    ...r,
    preview: Number(r.preview),
    ledger: Number(r.ledger),
    difference: Number(r.difference),
  }));
}

/** The default entity's ledger start (null = not set). */
export async function loadLedgerStart(admin: AdminClient, orgId: string): Promise<string | null> {
  const { data } = await admin
    .from("acc_entities")
    .select("ledger_start_date")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  return data?.ledger_start_date ?? null;
}
