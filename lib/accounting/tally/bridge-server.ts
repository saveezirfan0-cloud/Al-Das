import "server-only";

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { formatInTimeZone } from "date-fns-tz";

import { buildJournalsForSources } from "@/lib/accounting/posting/runner";
import {
  isPostingSource,
  type BuildResult,
  type PostingSource,
} from "@/lib/accounting/posting/types";
import { buildBridgeVoucherXml } from "@/lib/finance/tally-xml";
import { isEnabled, loadAccount, readConfig } from "@/lib/integrations/accounts";
import type { JobLogger } from "@/lib/jobs/types";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { Json } from "@/lib/supabase/types";

import {
  CAPTURED_SOURCES,
  capturedJournal,
  connectorCode,
  DAY_KINDS,
  ENGINE_SOURCES,
  journalBranch,
  remoteIdBase,
  resolveVoucher,
  summariseDay,
  swapSides,
  tallyTypeFor,
  voucherNumberFor,
  withPulseVoucherTypes,
  type BridgeContent,
  type DayKind,
  type MappingContext,
  type PulseJournal,
  type PushKind,
  type ResultOutcome,
} from "./bridge";
import { loadPlanContext } from "./import-server";
import { parseTallyXml, type TallyParseResult } from "./parse";
import { mergeParsed, planTallyImport, type TallyPlan } from "./plan";
import { importVerdict, parseImportResponse, trialBalanceRows } from "./response";
import { chunk, stagedRows } from "./stage";

/**
 * The Tally bridge on the server (Phase 22J). Three parts:
 *
 *  - runTallyBridge(): the scheduler (/api/jobs/accounting_tally_bridge, every 15 minutes). Per organisation with the
 *    integration switched on: finishes a pull that ran out of time, queues the pulls (acc_tally_bridge_tick), and, while
 *    pushing is on and before the ledger start, builds what changed in the sources into Tally vouchers and hands them to
 *    acc_tally_bridge_push_apply (the database decides versions, reversals and jobs). Short, batched, idempotent; logs counts.
 *  - claimJobs() / applyResult(): what the connector's routes call after the device token and the switch were checked.
 *    Tally's answers are parsed only with lib/accounting/tally/ and applied through the 22I import path.
 *  - helpers for the Accounting, Setup, Tally bridge page.
 *
 * Nothing here calls Tally or any provider: the connector on the Tally PC calls Pulse.
 */

export const TALLY_BRIDGE_PROVIDER = "tally_bridge";
/** The largest result body the route reads (Vercel's request limit is 4.5 MB); parts are gzip-compressed by the connector. */
export const MAX_RESULT_BODY = 4_400_000;
/** The largest Tally answer after decompression, all parts together. */
export const MAX_RESULT_RAW = 96 * 1024 * 1024;
export const POLL_SECONDS = 30;
/** Plan refusals that clear up by themselves once the masters catch up: the vouchers cursor stays below them. */
const RETRYABLE = new Set(["ledger_unknown", "type_unknown", "cost_centre", "parent_unknown"]);
const VOUCHER_BATCH = 250;
const STEP_BUDGET_MS = 20_000;

type RpcError = { code?: string; hint?: string | null };
export class BridgeRpcError extends Error {
  constructor(
    readonly fn: string,
    readonly rpc: RpcError,
  ) {
    super(`${fn}: ${rpc.code ?? "error"}${rpc.hint ? ` (${rpc.hint})` : ""}`);
  }
}

async function rpc<T>(admin: AdminClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (
    admin.rpc as unknown as (
      f: string,
      a: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: RpcError | null }>
  )(fn, args);
  if (error) throw new BridgeRpcError(fn, error);
  return data as T;
}

const errText = (err: unknown) => (err instanceof Error ? err.message.slice(0, 120) : "error");

async function orgToday(admin: AdminClient, orgId: string, now: Date): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
  const tz = (data as { timezone?: string | null } | null)?.timezone || "Asia/Dubai";
  try {
    return formatInTimeZone(now, tz, "yyyy-MM-dd");
  } catch {
    return formatInTimeZone(now, "Asia/Dubai", "yyyy-MM-dd");
  }
}

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------------

export type BridgeSettings = {
  push_enabled: boolean;
  pull_enabled: boolean;
  push_from: string | null;
  revenue_mode: "daily" | "per_item";
  push_sources: string[];
  cost_category: string;
};

export async function loadBridgeSettings(
  admin: AdminClient,
  orgId: string,
): Promise<BridgeSettings | null> {
  const { data } = await admin
    .from("acc_tally_bridge_settings")
    .select("push_enabled, pull_enabled, push_from, revenue_mode, push_sources, cost_category")
    .eq("org_id", orgId)
    .maybeSingle();
  return (data as BridgeSettings | null) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------------------------------

export type BridgeTotals = {
  orgs: number;
  queued: number;
  held: number;
  reversed: number;
  unchanged: number;
  pulls_resumed: number;
  errors: number;
};

export async function runTallyBridge(
  admin: AdminClient,
  log: JobLogger,
  opts: { now?: Date; budgetMs?: number } = {},
): Promise<BridgeTotals> {
  const totals: BridgeTotals = {
    orgs: 0,
    queued: 0,
    held: 0,
    reversed: 0,
    unchanged: 0,
    pulls_resumed: 0,
    errors: 0,
  };
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const { data: rows, error } = await admin
    .from("integration_accounts")
    .select("org_id")
    .eq("kind", "tally_bridge")
    .eq("enabled", true);
  if (error) throw new Error(`integration_accounts: ${error.code ?? "error"}`);
  for (const orgId of [...new Set((rows ?? []).map((r) => r.org_id))].sort()) {
    if (Date.now() - started > budget) break;
    try {
      const today = await orgToday(admin, orgId, now);
      totals.pulls_resumed += await resumePulls(admin, orgId);
      await rpc(admin, "acc_tally_bridge_tick", { p_org_id: orgId, p_today: today });
      const settings = await loadBridgeSettings(admin, orgId);
      if (settings?.push_enabled) {
        const c = await pushSources(admin, orgId, settings, today);
        totals.queued += (c.queued ?? 0) + (c.new_version ?? 0);
        totals.held += c.held ?? 0;
        totals.reversed += c.reversed ?? 0;
        totals.unchanged += c.unchanged ?? 0;
      }
      totals.orgs++;
    } catch (err) {
      totals.errors++;
      log.warn("accounting.tally_bridge org failed", { error: errText(err) });
    }
  }
  log.info("accounting.tally_bridge done", { ...totals });
  return totals;
}

/** Accounts, cost centres and branch cost centres: what a Pulse journal needs to become a Tally voucher. */
export async function loadMappingContext(
  admin: AdminClient,
  orgId: string,
): Promise<MappingContext> {
  const [acc, cc, br] = await Promise.all([
    // Every account and cost centre, read in pages (PostgREST returns at most 1,000 rows per request).
    fetchAll((from, to) =>
      admin
        .from("acc_accounts")
        .select("id, code, name, tally_guid, tally_name, is_group")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    fetchAll((from, to) =>
      admin
        .from("acc_cost_centres")
        .select("id, name")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    admin
      .from("fin_ref_tally_ledgers")
      .select("key, ledger_name")
      .eq("org_id", orgId)
      .eq("kind", "cost_centre"),
  ]);
  return {
    accounts: (acc.data ?? []) as MappingContext["accounts"],
    costCentres: new Map((cc.data ?? []).map((c) => [c.id, c.name])),
    branchCostCentres: new Map(
      (br.data ?? []).map((b) => [b.key.toUpperCase(), b.ledger_name.trim()]),
    ),
  };
}

type PushItem = Record<string, unknown>;

function itemFor(
  orgId: string,
  kind: PushKind,
  id: string,
  journal: PulseJournal | null,
  ctx: MappingContext,
  fallback?: { reason: string; detail: string; date: string | null },
): PushItem {
  const remote_base = remoteIdBase(orgId, kind, id);
  if (!journal) {
    if (!fallback) return { kind, id, remote_base, action: "withdraw" };
    return {
      kind,
      id,
      remote_base,
      action: "hold",
      date: fallback.date,
      voucher_type: "journal",
      amount: 0,
      journal_sha256: createHash("sha256")
        .update(`${fallback.reason}|${fallback.detail}`)
        .digest("hex"),
      reason: fallback.reason,
      detail: fallback.detail.slice(0, 300),
    };
  }
  const r = resolveVoucher(journal, ctx);
  if (r.action === "nothing") return { kind, id, remote_base, action: "withdraw" };
  const common = {
    kind,
    id,
    remote_base,
    date: journal.date,
    voucher_type: r.voucherType,
    amount: r.amount,
    journal_sha256: r.journalSha256,
  };
  return r.action === "push"
    ? { ...common, action: "push", content: r.content }
    : { ...common, action: "hold", reason: r.reason, detail: r.detail };
}

function fromBuild(b: BuildResult | undefined): {
  journal: PulseJournal | null;
  fallback?: { reason: string; detail: string; date: string | null };
} {
  if (!b || b.action === "withdraw" || b.action === "nothing") return { journal: null };
  if (b.action === "reasons")
    return {
      journal: null,
      fallback: {
        reason: "not_buildable",
        detail: b.reasons.map((r) => r.detail || r.code).join("; "),
        date: b.date,
      },
    };
  return { journal: b.journal as PulseJournal };
}

/** One push run for an organisation: what changed since the scan position, the held items again, and recent days. */
export async function pushSources(
  admin: AdminClient,
  orgId: string,
  settings: BridgeSettings,
  today: string,
): Promise<Record<string, number>> {
  const { data: cur } = await admin
    .from("acc_tally_cursors")
    .select("stamp, stamp_key")
    .eq("org_id", orgId)
    .eq("cursor", "sources")
    .maybeSingle();
  const cands = await rpc<
    Array<{
      kind: string;
      id: string;
      state: "ready" | "gone";
      date: string | null;
      stamp: string;
      key: string;
    }>
  >(admin, "acc_tally_bridge_candidates", {
    p_org_id: orgId,
    p_after: cur?.stamp ?? null,
    p_after_key: cur?.stamp_key ?? null,
    p_limit: 200,
  });
  const { data: held } = await admin
    .from("acc_tally_push")
    .select("source_kind, source_id")
    .eq("org_id", orgId)
    .eq("role", "voucher")
    .eq("status", "held")
    .order("updated_at")
    .limit(100);

  const daily = settings.revenue_mode === "daily";
  const sources = new Set(settings.push_sources);
  const ctx = await loadMappingContext(admin, orgId);
  const items: PushItem[] = [];
  const dayDates = new Map<DayKind, Set<string>>();
  const addDay = (k: DayKind, d: string | null) => {
    if (!d) return;
    const set = dayDates.get(k) ?? new Set<string>();
    set.add(d.slice(0, 10));
    dayDates.set(k, set);
  };
  const engine = new Map<PostingSource, { ready: Set<string>; gone: Set<string> }>();
  const captured = new Map<string, { kind: string; id: string; gone: boolean }>();
  const want = (kind: string, id: string, gone: boolean) => {
    if (daily && (kind === "unite_invoice" || kind === "unite_payment")) return;
    if (isPostingSource(kind) && (ENGINE_SOURCES as readonly string[]).includes(kind)) {
      const e = engine.get(kind) ?? { ready: new Set<string>(), gone: new Set<string>() };
      (gone ? e.gone : e.ready).add(id);
      engine.set(kind, e);
    } else if ((CAPTURED_SOURCES as readonly string[]).includes(kind)) {
      captured.set(`${kind}|${id}`, { kind, id, gone });
    }
  };
  for (const c of cands ?? []) {
    if (daily && (c.kind === "unite_invoice" || c.kind === "unite_payment"))
      addDay(DAY_KINDS[c.kind], c.date);
    else want(c.kind, c.id, c.state === "gone");
  }
  for (const h of held ?? []) {
    const base =
      h.source_kind === "unite_invoice_day"
        ? "unite_invoice"
        : h.source_kind === "unite_payment_day"
          ? "unite_payment"
          : h.source_kind;
    if (!sources.has(base)) continue; // no longer chosen: it stays held
    if (h.source_kind === "unite_invoice_day" || h.source_kind === "unite_payment_day")
      addDay(h.source_kind, h.source_id.slice(0, 10));
    else if (h.source_kind === "fixed_asset" && h.source_id.endsWith(":reverse"))
      want("fixed_asset", h.source_id.slice(0, -":reverse".length), false);
    else want(h.source_kind, h.source_id, false);
  }
  // the last three closed days are rebuilt every run: a late invoice or payment changes its day's summary
  if (daily && settings.push_from)
    for (const [k, dk] of Object.entries(DAY_KINDS) as Array<[keyof typeof DAY_KINDS, DayKind]>)
      if (sources.has(k))
        for (let i = 1; i <= 3; i++) {
          const d = addDays(today, -i);
          if (d >= settings.push_from) addDay(dk, d);
        }

  // 22D sources: the posting engine's own builders, without posting
  for (const [kind, e] of engine) {
    for (const id of e.gone) if (!e.ready.has(id)) items.push(itemFor(orgId, kind, id, null, ctx));
    const built = await buildJournalsForSources(admin, orgId, kind, [...e.ready]);
    for (const id of e.ready) {
      const b = fromBuild(built.get(id));
      items.push(itemFor(orgId, kind, id, b.journal, ctx, b.fallback));
    }
  }
  // 22E / 22F / 22H: what the slice would post, read by the database
  for (const c of captured.values()) {
    const kind = c.kind as PushKind;
    if (c.gone) {
      items.push(itemFor(orgId, kind, c.id, null, ctx));
      if (kind === "fixed_asset") items.push(itemFor(orgId, kind, `${c.id}:reverse`, null, ctx));
      continue;
    }
    const raw = await rpc<Json>(admin, "acc_tally_bridge_capture", {
      p_org_id: orgId,
      p_kind: kind,
      p_id: c.id,
    });
    const error =
      raw && typeof raw === "object" && !Array.isArray(raw) && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : null;
    const journal = error ? null : capturedJournal(raw);
    items.push(
      itemFor(
        orgId,
        kind,
        c.id,
        journal,
        ctx,
        error
          ? { reason: "capture_failed", detail: `Could not read it (${error}).`, date: null }
          : undefined,
      ),
    );
    if (kind === "fixed_asset") {
      // a reversing-accruals run is undone on the 1st of the next month (Pulse's automatic reversal)
      const o = (raw ?? {}) as Record<string, unknown>;
      const reverseOn = typeof o.reverse_on === "string" ? o.reverse_on : null;
      items.push(
        itemFor(
          orgId,
          kind,
          `${c.id}:reverse`,
          journal && reverseOn
            ? swapSides(
                journal,
                reverseOn,
                `Reversal of the accruals of ${journal.date.slice(0, 7)}`,
              )
            : null,
          ctx,
        ),
      );
    }
  }
  // Unite revenue and payments: one voucher per day and branch
  for (const [dayKind, dates] of dayDates) {
    const kind: PostingSource = dayKind === "unite_invoice_day" ? "unite_invoice" : "unite_payment";
    if (!sources.has(kind)) continue;
    for (const date of [...dates].sort()) {
      if (date >= today || (settings.push_from && date < settings.push_from)) continue;
      items.push(...(await daySummaryItems(admin, orgId, kind, dayKind, date, ctx)));
    }
  }

  const last = cands?.length ? cands[cands.length - 1] : null;
  const counts: Record<string, number> = {};
  const batches = chunk(items, 500);
  if (batches.length === 0) batches.push([]);
  for (let i = 0; i < batches.length; i++) {
    const res = await rpc<Record<string, unknown>>(admin, "acc_tally_bridge_push_apply", {
      p_org_id: orgId,
      p_items: batches[i],
      p_today: today,
      p_cursor: i === batches.length - 1 && last ? { stamp: last.stamp, key: last.key } : null,
    });
    if (res && typeof res.stopped === "string") break;
    for (const [k, v] of Object.entries(res ?? {}))
      if (typeof v === "number") counts[k] = (counts[k] ?? 0) + v;
  }
  return counts;
}

async function daySummaryItems(
  admin: AdminClient,
  orgId: string,
  kind: PostingSource,
  dayKind: DayKind,
  date: string,
  ctx: MappingContext,
): Promise<PushItem[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("acc_posting_status")
      .select("source_id")
      .eq("org_id", orgId)
      .eq("source_kind", kind)
      .eq("state", "preview")
      .eq("source_date", date)
      .order("source_id")
      .range(from, from + 999);
    ids.push(...(data ?? []).map((r) => r.source_id));
    if (!data || data.length < 1000) break;
  }
  const built = await buildJournalsForSources(admin, orgId, kind, ids);
  const byBranch = new Map<string, PulseJournal[]>();
  const waiting: string[] = [];
  for (const id of ids) {
    const b = built.get(id);
    if (b?.action === "post") {
      const j = b.journal as PulseJournal;
      if (j.date !== date) continue;
      const br = journalBranch(j);
      byBranch.set(br, [...(byBranch.get(br) ?? []), j]);
    } else if (b?.action === "reasons") waiting.push(id);
  }
  const items: PushItem[] = [];
  for (const [branch, journals] of [...byBranch].sort(([a], [b]) => (a < b ? -1 : 1)))
    items.push(
      itemFor(
        orgId,
        dayKind,
        `${date}|${branch}`,
        summariseDay(journals, { date, branch, kind: dayKind }),
        ctx,
      ),
    );
  // a branch whose day no longer has anything to send is withdrawn
  const { data: existing } = await admin
    .from("acc_tally_push")
    .select("source_id")
    .eq("org_id", orgId)
    .eq("source_kind", dayKind)
    .eq("role", "voucher")
    .like("source_id", `${date}|%`);
  for (const id of new Set((existing ?? []).map((e) => e.source_id)))
    if (!byBranch.has(id.slice(11))) items.push(itemFor(orgId, dayKind, id, null, ctx));
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// The connector's routes
// ---------------------------------------------------------------------------------------------------------------------

/** One integration_calls row per connector request: provider, operation, outcome, status, latency. Nothing else. */
export async function recordBridgeCall(
  admin: AdminClient,
  orgId: string,
  operation: "pair" | "poll" | "result",
  outcome: "ok" | "client_error" | "auth_error" | "rate_limited" | "server_error" | "blocked",
  httpStatus: number,
  startedAt: number,
): Promise<void> {
  try {
    await admin.from("integration_calls").insert({
      org_id: orgId,
      provider: TALLY_BRIDGE_PROVIDER,
      operation,
      outcome,
      http_status: httpStatus,
      duration_ms: Math.max(0, Math.round(Date.now() - startedAt)),
      attempt: 1,
    });
  } catch {
    // a counter must never break the request it counts
  }
}

export type DeviceAuth = { deviceId: string; orgId: string };

export async function deviceForToken(
  admin: AdminClient,
  tokenSha256: string,
  version: string | null,
  tallyState: string | null,
): Promise<DeviceAuth | null> {
  const r = await rpc<{ device_id: string; org_id: string } | null>(
    admin,
    "acc_tally_bridge_device",
    {
      p_token_sha256: tokenSha256,
      p_version: version,
      p_tally_state: tallyState,
    },
  );
  return r ? { deviceId: r.device_id, orgId: r.org_id } : null;
}

export async function bridgeEnabled(admin: AdminClient, orgId: string): Promise<boolean> {
  return isEnabled(admin, orgId, "tally_bridge");
}

/** A job as the connector receives it. Only these fields, and an import's XML is complete (the connector checks it). */
export type ConnectorJob =
  | { id: string; type: "export_masters_since"; company: string; since_alter_id: number }
  | {
      id: string;
      type: "export_vouchers_since";
      company: string;
      since_alter_id: number;
      from: string;
      to: string;
    }
  | { id: string; type: "export_trial_balance"; company: string; as_at: string }
  | {
      id: string;
      type: "import_voucher";
      company: string;
      remote_id: string;
      voucher_date: string;
      check_first: boolean;
      lookup_only: boolean;
      xml: string;
    };

type ClaimRow = {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  check_first: boolean;
  lookup_only: boolean;
  push: {
    id: string;
    remote_id: string;
    date: string;
    voucher_type: string;
    role: string;
    content: BridgeContent;
  } | null;
};

const num = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Hands queued jobs to the connector. Import XML is built here from the stored content (lib/finance/tally-xml.ts). */
export async function claimJobs(
  admin: AdminClient,
  auth: DeviceAuth,
  now: Date = new Date(),
): Promise<ConnectorJob[]> {
  const company = String(
    readConfig(await loadAccount(admin, auth.orgId, "tally_bridge")).company ?? "",
  ).trim();
  const today = await orgToday(admin, auth.orgId, now);
  const res = await rpc<{ jobs: ClaimRow[]; cost_category: string }>(
    admin,
    "acc_tally_bridge_claim",
    {
      p_org_id: auth.orgId,
      p_device_id: auth.deviceId,
      p_limit: 5,
      p_today: today,
    },
  );
  const out: ConnectorJob[] = [];
  for (const j of res?.jobs ?? []) {
    const p = j.params ?? {};
    if (j.kind === "export_masters_since")
      out.push({ id: j.id, type: j.kind, company, since_alter_id: num(p.since_alter_id) });
    else if (j.kind === "export_vouchers_since" && day(p.from) && day(p.to))
      out.push({
        id: j.id,
        type: j.kind,
        company,
        since_alter_id: num(p.since_alter_id),
        from: day(p.from)!,
        to: day(p.to)!,
      });
    else if (j.kind === "export_trial_balance" && day(p.as_at))
      out.push({ id: j.id, type: j.kind, company, as_at: day(p.as_at)! });
    else if (j.kind === "import_voucher" && j.push) {
      const type = tallyTypeFor(j.push.voucher_type);
      let xml: string | null = null;
      try {
        if (type && j.push.content)
          xml = buildBridgeVoucherXml({
            company,
            costCategory: res.cost_category || "Primary Cost Category",
            remoteId: j.push.remote_id,
            number: voucherNumberFor(j.push.remote_id),
            date: j.push.date,
            tallyType: type,
            narration: j.push.content.narration,
            entries: j.push.content.entries,
          });
      } catch {
        xml = null;
      }
      if (!xml) {
        await rpc(admin, "acc_tally_bridge_import_result", {
          p_org_id: auth.orgId,
          p_device_id: auth.deviceId,
          p_job_id: j.id,
          p_outcome: "failed",
          p_master_id: null,
          p_code: "bad_content",
          p_message: "The voucher could not be written for Tally.",
        });
        continue;
      }
      out.push({
        id: j.id,
        type: "import_voucher",
        company,
        remote_id: j.push.remote_id,
        voucher_date: j.push.date,
        check_first: j.check_first === true,
        lookup_only: j.lookup_only === true,
        xml,
      });
    } else {
      await rpc(admin, "acc_tally_bridge_export_result", {
        p_org_id: auth.orgId,
        p_device_id: auth.deviceId,
        p_job_id: j.id,
        p_ok: false,
        p_code: "bad_job",
        p_counts: null,
      });
    }
  }
  return out;
}

/** The connector's answer: gzip-compressed Tally bytes, base64. */
export type ResultBody = {
  job_id: string;
  outcome: ResultOutcome;
  code?: string;
  parts?: string[];
};

export class ResultError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The parts decompressed (each at most MAX_RESULT_RAW together); throws ResultError(400) when they cannot be read. */
export function decodeParts(parts: unknown): Uint8Array[] {
  if (parts === undefined) return [];
  if (!Array.isArray(parts) || parts.length > 8) throw new ResultError(400, "bad_parts");
  let total = 0;
  return parts.map((p) => {
    if (typeof p !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(p))
      throw new ResultError(400, "bad_parts");
    let raw: Buffer;
    try {
      raw = gunzipSync(Buffer.from(p, "base64"), { maxOutputLength: MAX_RESULT_RAW });
    } catch {
      throw new ResultError(400, "bad_parts");
    }
    total += raw.length;
    if (total > MAX_RESULT_RAW) throw new ResultError(413, "too_large");
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
  });
}

type JobRow = {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  push_id: string | null;
  check_first: boolean;
  remote_id: string | null;
  attempts: number;
};

/** Applies one connector answer. Returns what happened, in a word (for the route's response; no data). */
export async function applyResult(
  admin: AdminClient,
  auth: DeviceAuth,
  body: ResultBody,
): Promise<string> {
  const job = await rpc<JobRow | null>(admin, "acc_tally_bridge_job", {
    p_org_id: auth.orgId,
    p_device_id: auth.deviceId,
    p_job_id: body.job_id,
  });
  if (!job) throw new ResultError(409, "not_expected");
  const code = connectorCode(body.code);

  if (job.kind === "import_voucher") {
    const result = async (
      outcome: string,
      extra: { master?: number | null; code?: string; message?: string } = {},
    ) => {
      await rpc(admin, "acc_tally_bridge_import_result", {
        p_org_id: auth.orgId,
        p_device_id: auth.deviceId,
        p_job_id: job.id,
        p_outcome: outcome,
        p_master_id: extra.master ?? null,
        p_code: extra.code ?? null,
        p_message: extra.message ? redactText(extra.message, 300) : null,
      });
      return outcome;
    };
    if (body.outcome === "unreachable") return result("retry", { code: "tally_unreachable" });
    if (body.outcome === "absent") return result("absent");
    if (body.outcome === "error" && (code === "refused_job" || code === "bad_job"))
      return result("failed", {
        code: "connector_refused",
        message: "The connector refused this voucher.",
      });
    if (body.outcome === "error" || body.outcome === "timeout")
      return result("ambiguous", { code: code === "error" ? "no_answer" : code });
    let parts: Uint8Array[];
    try {
      parts = decodeParts(body.parts);
    } catch {
      return result("ambiguous", { code: "unreadable_answer" });
    }
    if (body.outcome === "exists") {
      // the look-up found it: confirm from Tally's own answer, by REMOTEID or GUID
      for (const p of parts) {
        try {
          const v = parseTallyXml(p).vouchers.find(
            (x) => x.remoteId === job.remote_id || x.guid === job.remote_id,
          );
          if (v) return result("exists", { master: v.masterId });
        } catch {
          // unreadable: treated as no answer below
        }
      }
      return result("ambiguous", { code: "unreadable_answer" });
    }
    if (body.outcome !== "ok" || parts.length !== 1)
      return result("ambiguous", { code: "unreadable_answer" });
    const verdict = importVerdict(parseImportResponse(parts[0]));
    if (verdict.outcome === "ambiguous") return result("ambiguous", { code: verdict.code });
    if (verdict.outcome === "failed")
      return result("failed", { code: verdict.code, message: verdict.message });
    return result(verdict.outcome, { master: verdict.masterId });
  }

  const finish = async (ok: boolean, c: string | null, counts: Record<string, unknown> | null) => {
    await rpc(admin, "acc_tally_bridge_export_result", {
      p_org_id: auth.orgId,
      p_device_id: auth.deviceId,
      p_job_id: job.id,
      p_ok: ok,
      p_code: c,
      p_counts: counts,
    });
    return ok ? "done" : "failed";
  };
  if (body.outcome !== "ok") return finish(false, code, null);
  let parts: Uint8Array[];
  try {
    parts = decodeParts(body.parts);
  } catch (err) {
    return finish(
      false,
      err instanceof ResultError && err.status === 413 ? "too_large" : "unreadable",
      null,
    );
  }
  let parsed: TallyParseResult[];
  try {
    parsed = parts.map((p) => parseTallyXml(p));
  } catch {
    return finish(false, "unreadable", null);
  }
  const sha = createHash("sha256");
  for (const p of parts) sha.update(p);
  const src: PullSource = {
    sha256: sha.digest("hex"),
    bytes: parts.reduce((a, p) => a + p.length, 0),
  };
  try {
    if (job.kind === "export_trial_balance") {
      const merged = mergeParsed(parsed);
      if (merged.ledgers.length === 0) return finish(false, "empty_answer", null);
      const asAt = day(job.params.as_at);
      if (!asAt) return finish(false, "bad_job", null);
      const tb = await rpc<Record<string, unknown>>(admin, "acc_tally_bridge_record_tb", {
        p_org_id: auth.orgId,
        p_job_id: job.id,
        p_as_at: asAt,
        p_sha256: src.sha256,
        p_rows: trialBalanceRows(merged),
      });
      return finish(true, null, {
        compared: tb?.compared ?? null,
        differences: tb?.differences ?? null,
      });
    }
    if (job.kind === "export_masters_since") {
      const counts = await applyMastersPull(admin, auth.orgId, job.id, parsed, src);
      return finish(true, null, counts);
    }
    if (job.kind === "export_vouchers_since") {
      const counts = await applyVouchersPull(admin, auth.orgId, job.id, parsed, src);
      return finish(true, null, counts);
    }
    return finish(false, "bad_job", null);
  } catch {
    return finish(false, "process_error", null);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pulls, through the 22I import path
// ---------------------------------------------------------------------------------------------------------------------

type PullSource = { sha256: string; bytes: number };

type BridgeReport = {
  bridge: {
    cursor: "masters" | "vouchers";
    alter_id: number | null;
    job_id: string;
    refusals: Array<{
      guid: string | null;
      date: string | null;
      number: string | null;
      code: string;
    }>;
    names: Array<{ guid: string; name: string }>;
  };
};

async function stageBridgeImport(
  admin: AdminClient,
  orgId: string,
  plan: TallyPlan,
  src: PullSource,
  report: BridgeReport,
): Promise<string> {
  const { data: entity } = await admin
    .from("acc_entities")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (!entity) throw new Error("no default entity");
  const { data: imp, error } = await admin
    .from("acc_tally_imports")
    .insert({
      org_id: orgId,
      entity_id: entity.id,
      file_sha256: [src.sha256],
      file_bytes: src.bytes,
      source: "bridge",
      company: plan.report.company?.slice(0, 120) ?? null,
      report: report as unknown as NonNullable<Json>,
      first_date: plan.report.firstDate,
      last_date: plan.report.lastDate,
    })
    .select("id")
    .single();
  if (error || !imp) throw new Error("the pull could not be staged");
  for (const batch of chunk(stagedRows(orgId, imp.id, plan), 1000)) {
    const { error: e } = await admin
      .from("acc_tally_staged")
      .insert(batch.map((r) => ({ ...r, payload: r.payload as NonNullable<Json> })));
    if (e) {
      await admin.from("acc_tally_imports").delete().eq("id", imp.id);
      throw new Error("the pull could not be staged");
    }
  }
  return imp.id;
}

/** Commit steps of a bridge import (no person: the database allows it for source 'bridge'), then the finish. */
async function commitBridgeImport(
  admin: AdminClient,
  orgId: string,
  importId: string,
  status: string,
  report: BridgeReport,
): Promise<{ finished: boolean; counts: Record<string, unknown> | null }> {
  if (status === "staged")
    await rpc(admin, "acc_tally_apply_masters", {
      p_org_id: orgId,
      p_import_id: importId,
      p_user_id: null,
    });
  const started = Date.now();
  let remaining = 0;
  for (;;) {
    const b = await rpc<{ remaining: number }>(admin, "acc_tally_post_vouchers", {
      p_org_id: orgId,
      p_import_id: importId,
      p_user_id: null,
      p_limit: VOUCHER_BATCH,
    });
    remaining = Number(b?.remaining ?? 0);
    if (remaining === 0 || Date.now() - started > STEP_BUDGET_MS) break;
  }
  if (remaining > 0) return { finished: false, counts: null };
  let alterId = report.bridge.alter_id;
  if (report.bridge.cursor === "vouchers") {
    // a voucher refused for a ledger or cost centre Tally created after the masters pull comes back next time
    const { data: retry } = await admin
      .from("acc_tally_staged")
      .select("alter_id, result_code")
      .eq("import_id", importId)
      .eq("status", "refused");
    const low = (retry ?? [])
      .filter((r) => r.result_code && RETRYABLE.has(r.result_code) && r.alter_id !== null)
      .map((r) => Number(r.alter_id));
    if (low.length && alterId !== null) alterId = Math.min(alterId, Math.min(...low) - 1);
  }
  const counts = await rpc<Record<string, unknown>>(admin, "acc_tally_bridge_pull_finish", {
    p_org_id: orgId,
    p_job_id: report.bridge.job_id,
    p_import_id: importId,
    p_cursor: report.bridge.cursor,
    p_alter_id: alterId,
    p_refusals: report.bridge.refusals,
    p_names: report.bridge.names,
  });
  return { finished: true, counts };
}

/** Bridge imports that ran out of time are continued by the next scheduler run. */
async function resumePulls(admin: AdminClient, orgId: string): Promise<number> {
  const { data } = await admin
    .from("acc_tally_imports")
    .select("id, status, report")
    .eq("org_id", orgId)
    .eq("source", "bridge")
    .in("status", ["staged", "committing"])
    .order("created_at")
    .limit(3);
  let n = 0;
  for (const imp of data ?? []) {
    const report = imp.report as unknown as BridgeReport;
    if (!report?.bridge) continue;
    await commitBridgeImport(admin, orgId, imp.id, imp.status, report);
    n++;
  }
  return n;
}

const maxAlter = (rows: ReadonlyArray<{ alterId: number | null }>): number | null => {
  let m: number | null = null;
  for (const r of rows) if (r.alterId !== null && (m === null || r.alterId > m)) m = r.alterId;
  return m;
};

async function applyMastersPull(
  admin: AdminClient,
  orgId: string,
  jobId: string,
  parsed: TallyParseResult[],
  src: PullSource,
): Promise<Record<string, unknown>> {
  const merged = mergeParsed(parsed);
  const alterId = maxAlter([...merged.groups, ...merged.ledgers]);
  const names = merged.ledgers.filter((l) => l.guid).map((l) => ({ guid: l.guid!, name: l.name }));
  const finishEmpty = () =>
    rpc<Record<string, unknown>>(admin, "acc_tally_bridge_pull_finish", {
      p_org_id: orgId,
      p_job_id: jobId,
      p_import_id: null,
      p_cursor: "masters",
      p_alter_id: alterId,
      p_refusals: [],
      p_names: names,
    });
  if (merged.groups.length + merged.ledgers.length + merged.costCentres.length === 0)
    return { ...(await finishEmpty()), masters: 0 };
  const plan = planTallyImport({ ...merged, vouchers: [] }, await loadPlanContext(admin, orgId), {
    openingDate: null,
  });
  const guidOf = new Map(
    [...merged.groups, ...merged.ledgers].map((m) => [m.name.trim().toLowerCase(), m.guid]),
  );
  const refusals = [...plan.report.groups.refused, ...plan.report.ledgers.refused].map((r) => ({
    guid: guidOf.get(r.name.trim().toLowerCase()) ?? null,
    date: null,
    number: null,
    code: r.code,
  }));
  if (plan.masters.length === 0) {
    const r = await rpc<Record<string, unknown>>(admin, "acc_tally_bridge_pull_finish", {
      p_org_id: orgId,
      p_job_id: jobId,
      p_import_id: null,
      p_cursor: "masters",
      p_alter_id: alterId,
      p_refusals: refusals,
      p_names: names,
    });
    return { ...r, masters: 0 };
  }
  const report: BridgeReport = {
    bridge: { cursor: "masters", alter_id: alterId, job_id: jobId, refusals, names },
  };
  const importId = await stageBridgeImport(admin, orgId, plan, src, report);
  const done = await commitBridgeImport(admin, orgId, importId, "staged", report);
  return {
    masters: plan.masters.length,
    // a new Tally ledger with the name of an existing Pulse account is linked to it (as the 22I voucher path does)
    linked_by_name: plan.report.ledgers.linkByName.length,
    finished: done.finished,
    ...(done.counts ?? {}),
  };
}

async function applyVouchersPull(
  admin: AdminClient,
  orgId: string,
  jobId: string,
  parsed: TallyParseResult[],
  src: PullSource,
): Promise<Record<string, unknown>> {
  // the voucher types come with the vouchers (the plan resolves custom types through their parent); Pulse's own are always known
  const merged = withPulseVoucherTypes(mergeParsed(parsed));
  const alterId = maxAlter(merged.vouchers);
  const { data: entity } = await admin
    .from("acc_entities")
    .select("ledger_start_date")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  const start = (entity as { ledger_start_date?: string | null } | null)?.ledger_start_date ?? null;
  // cancelled, optional or deleted in Tally since it was mirrored: the mirror journal is reversed
  const gone = merged.vouchers
    .filter((v) => v.guid && v.alterId !== null && (v.cancelled || v.optional || v.deleted))
    .map((v) => ({ guid: v.guid, alter_id: v.alterId }));
  const reversed = gone.length
    ? await rpc<Record<string, number>>(admin, "acc_tally_bridge_pull_cancelled", {
        p_org_id: orgId,
        p_job_id: jobId,
        p_items: gone,
      })
    : null;
  // from the ledger start Pulse is the book of record: a Tally voucher dated then is never imported
  const late = start ? merged.vouchers.filter((v) => v.date && v.date >= start) : [];
  const kept = start
    ? merged.vouchers.filter((v) => !(v.date && v.date >= start))
    : merged.vouchers;
  const refusals: BridgeReport["bridge"]["refusals"] = late.map((v) => ({
    guid: v.guid,
    date: v.date,
    number: v.number,
    code: "after_ledger_start",
  }));
  const plan = planTallyImport({ ...merged, vouchers: kept }, await loadPlanContext(admin, orgId), {
    openingDate: null,
  });
  refusals.push(
    ...plan.report.refusals.map((r) => ({
      guid: r.guid,
      date: r.date,
      number: r.number,
      code: r.code,
    })),
  );
  // the cursor stays below a voucher that may post once the masters catch up
  const alterOf = new Map(kept.filter((v) => v.guid).map((v) => [v.guid!, v.alterId]));
  const retryLow = plan.report.refusals
    .filter((r) => RETRYABLE.has(r.code) && r.guid)
    .map((r) => alterOf.get(r.guid!) ?? null)
    .filter((a): a is number => a !== null);
  const cursor =
    alterId === null
      ? null
      : retryLow.length
        ? Math.min(alterId, Math.min(...retryLow) - 1)
        : alterId;
  if (plan.vouchers.length + plan.masters.length === 0) {
    const r = await rpc<Record<string, unknown>>(admin, "acc_tally_bridge_pull_finish", {
      p_org_id: orgId,
      p_job_id: jobId,
      p_import_id: null,
      p_cursor: "vouchers",
      p_alter_id: cursor,
      p_refusals: refusals,
      p_names: [],
    });
    return { ...r, vouchers: 0, reversed: reversed?.reversed ?? 0 };
  }
  const report: BridgeReport = {
    bridge: { cursor: "vouchers", alter_id: cursor, job_id: jobId, refusals, names: [] },
  };
  const importId = await stageBridgeImport(admin, orgId, plan, src, report);
  const done = await commitBridgeImport(admin, orgId, importId, "staged", report);
  return {
    vouchers: plan.vouchers.length,
    reversed: reversed?.reversed ?? 0,
    finished: done.finished,
    ...(done.counts ?? {}),
  };
}
