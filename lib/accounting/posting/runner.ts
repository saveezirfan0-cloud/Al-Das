import "server-only";

import { formatInTimeZone } from "date-fns-tz";

import { applyItem, buildFor } from "@/lib/accounting/posting/builders";
import {
  parseContext,
  POSTING_SOURCES,
  type BuildResult,
  type PostingContext,
  type PostingSource,
} from "@/lib/accounting/posting/types";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * The posting runner (Phase 22D): /api/jobs/accounting_post, every 15 minutes. Per organisation with a ledger and per
 * source kind it reads what changed since its cursor (acc_posting_candidates), loads the sanitised records, builds each
 * journal with the pure builders and hands them to acc_posting_apply, which posts (from the ledger start on), stores a
 * preview (before it), records why an item waits, or reverses the journal of a withdrawn item. Then it retries items
 * that are waiting (a rule added since, a period reopened) and runs the automatic reversals of 22A.
 *
 * Short and batched: at most BATCH items per kind per run, a time budget, and the cursor moves only past items that were
 * applied. Idempotent: an unchanged item is left as it is; a changed one posts its next version (the old one reversed).
 * Never writes a sub-ledger table and never calls Unite. Logs counts only.
 */

export const BATCH = 100;
export const RETRY_BATCH = 100;
const APPLY_CHUNK = 200;

export type RunOptions = {
  now?: Date;
  orgIds?: string[];
  batch?: number;
  /** Items changed in the last N seconds wait for the next run (late commits keep their earlier timestamp). */
  settleSeconds?: number;
  /** Waiting items are retried once their last attempt is this old. */
  retryAfterMinutes?: number;
  budgetMs?: number;
};

export type RunTotals = {
  orgs: number;
  posted: number;
  unchanged: number;
  preview: number;
  waiting: number;
  withdrawn: number;
  nothing: number;
  retried: number;
  auto_reversed: number;
  errors: number;
};

const emptyTotals = (): RunTotals => ({
  orgs: 0,
  posted: 0,
  unchanged: 0,
  preview: 0,
  waiting: 0,
  withdrawn: 0,
  nothing: 0,
  retried: 0,
  auto_reversed: 0,
  errors: 0,
});

type Counts = Partial<Record<keyof RunTotals, number>>;
const add = (t: RunTotals, c: Counts) => {
  for (const [k, v] of Object.entries(c)) t[k as keyof RunTotals] += Number(v) || 0;
};

/**
 * What the runner needs from the database, as a narrow port: the server passes the service-role client (adminPort);
 * the database tests pass a port over a plain Postgres connection.
 */
export type PostingPort = {
  /** Calls a SQL function; throws on an error (its code and HINT, never the database's text). */
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
  cursors(
    orgId: string,
  ): Promise<Array<{ source_kind: string; cursor_at: string | null; cursor_id: string | null }>>;
  waiting(
    orgId: string,
    beforeIso: string,
    limit: number,
  ): Promise<Array<{ source_kind: string; source_id: string }>>;
  orgTimezone(orgId: string): Promise<string | null>;
  orgsWithLedger(): Promise<string[]>;
};

export function adminPort(admin: AdminClient): PostingPort {
  return {
    async rpc(fn, args) {
      const { data, error } = await (
        admin.rpc as unknown as (
          f: string,
          a: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { code?: string; hint?: string | null } | null }>
      )(fn, args);
      if (error)
        throw new Error(`${fn}: ${error.code ?? "error"}${error.hint ? ` (${error.hint})` : ""}`);
      return data;
    },
    async cursors(orgId) {
      const { data } = await admin
        .from("acc_posting_cursors")
        .select("source_kind, cursor_at, cursor_id")
        .eq("org_id", orgId);
      return data ?? [];
    },
    async waiting(orgId, beforeIso, limit) {
      const { data } = await admin
        .from("acc_posting_status")
        .select("source_kind, source_id")
        .eq("org_id", orgId)
        .eq("state", "waiting")
        .lte("last_attempt_at", beforeIso)
        .order("last_attempt_at")
        .limit(limit);
      return data ?? [];
    },
    async orgTimezone(orgId) {
      const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
      return (data as { timezone?: string | null } | null)?.timezone ?? null;
    },
    async orgsWithLedger() {
      const { data, error } = await admin
        .from("acc_entities")
        .select("org_id")
        .eq("is_default", true);
      if (error) throw new Error(`acc_entities: ${error.code ?? "error"}`);
      return [...new Set((data ?? []).map((d) => d.org_id))].sort();
    },
  };
}

const toPort = (a: AdminClient | PostingPort): PostingPort =>
  "orgsWithLedger" in a ? a : adminPort(a);

const call = async <T>(port: PostingPort, fn: string, args: Record<string, unknown>) =>
  (await port.rpc(fn, args)) as T;

export async function loadPostingContext(
  port: PostingPort,
  orgId: string,
): Promise<PostingContext> {
  return parseContext(await call<Json>(port, "acc_posting_context", { p_org_id: orgId }));
}

async function loadRecords(
  port: PostingPort,
  orgId: string,
  kind: PostingSource,
  ids: string[],
): Promise<Map<string, unknown>> {
  const rows = await call<Array<{ id: string }>>(port, "acc_posting_load", {
    p_org_id: orgId,
    p_kind: kind,
    p_ids: ids,
  });
  return new Map((rows ?? []).map((r) => [String(r.id), r as unknown]));
}

/** Builds one item without posting: the journal lines, or why it cannot post. A missing record is withdrawn. */
export function buildItem(
  kind: PostingSource,
  record: unknown | undefined,
  ctx: PostingContext,
): BuildResult {
  if (record === undefined) return { action: "withdraw" };
  return buildFor(kind, record, ctx);
}

/** Builds and applies a set of items of one kind. Returns the counts per outcome. */
export async function processItems(
  port: PostingPort,
  orgId: string,
  kind: PostingSource,
  ids: string[],
  ctx: PostingContext,
  today: string,
): Promise<Counts> {
  const counts: Counts = {};
  for (let i = 0; i < ids.length; i += APPLY_CHUNK) {
    const chunk = ids.slice(i, i + APPLY_CHUNK);
    const records = await loadRecords(port, orgId, kind, chunk);
    const items = chunk.map((id) => applyItem(id, buildItem(kind, records.get(id), ctx)));
    const res = await call<{ counts: Record<string, number> }>(port, "acc_posting_apply", {
      p_org_id: orgId,
      p_kind: kind,
      p_items: items,
      p_today: today,
    });
    for (const [k, v] of Object.entries(res?.counts ?? {}))
      if (k in emptyTotals())
        counts[k as keyof RunTotals] = (counts[k as keyof RunTotals] ?? 0) + Number(v);
  }
  return counts;
}

async function orgToday(port: PostingPort, orgId: string, now: Date): Promise<string> {
  const tz = (await port.orgTimezone(orgId)) || "Asia/Dubai";
  try {
    return formatInTimeZone(now, tz, "yyyy-MM-dd");
  } catch {
    return formatInTimeZone(now, "Asia/Dubai", "yyyy-MM-dd");
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message.slice(0, 120) : "error");

/** One organisation: every source kind since its cursor, then the waiting items, then the automatic reversals. */
export async function runPostingForOrg(
  port: PostingPort,
  orgId: string,
  opts: RunOptions = {},
  log?: JobLogger,
): Promise<RunTotals> {
  const totals = emptyTotals();
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 40_000;
  const ctx = await loadPostingContext(port, orgId);
  const today = await orgToday(port, orgId, now);
  const cursors = new Map((await port.cursors(orgId)).map((c) => [c.source_kind, c]));
  const seen = new Set<string>(); // items handled in this run are not retried in it

  for (const kind of POSTING_SOURCES) {
    if (ctx.settings.pausedSources.includes(kind)) continue;
    if (Date.now() - started > budget) break;
    try {
      const cur = cursors.get(kind);
      const cands = await call<Array<{ id: string; stamp: string }>>(
        port,
        "acc_posting_candidates",
        {
          p_org_id: orgId,
          p_kind: kind,
          p_after: cur?.cursor_at ?? null,
          p_after_id: cur?.cursor_id ?? null,
          p_limit: opts.batch ?? BATCH,
          p_settle_seconds: opts.settleSeconds ?? 120,
        },
      );
      if (!cands?.length) continue;
      for (const c of cands) seen.add(`${kind}|${c.id}`);
      add(
        totals,
        await processItems(
          port,
          orgId,
          kind,
          cands.map((c) => c.id),
          ctx,
          today,
        ),
      );
      const last = cands[cands.length - 1];
      await call(port, "acc_posting_set_cursor", {
        p_org_id: orgId,
        p_kind: kind,
        p_at: last.stamp,
        p_id: last.id,
      });
    } catch (err) {
      totals.errors++;
      log?.warn("accounting.post kind failed", { kind, error: errText(err) });
    }
  }

  // items waiting for a rule, a tax code or an open period are tried again (oldest attempt first)
  if (Date.now() - started <= budget) {
    try {
      const before = new Date(
        now.getTime() - (opts.retryAfterMinutes ?? 30) * 60_000,
      ).toISOString();
      const byKind = new Map<PostingSource, string[]>();
      for (const w of await port.waiting(orgId, before, RETRY_BATCH)) {
        const k = w.source_kind as PostingSource;
        if (ctx.settings.pausedSources.includes(k) || seen.has(`${k}|${w.source_id}`)) continue;
        byKind.set(k, [...(byKind.get(k) ?? []), w.source_id]);
      }
      for (const [kind, ids] of byKind) {
        add(totals, await processItems(port, orgId, kind, ids, ctx, today));
        totals.retried += ids.length;
      }
    } catch (err) {
      totals.errors++;
      log?.warn("accounting.post retry failed", { error: errText(err) });
    }
  }

  try {
    const r = await call<{ done?: unknown[] }>(port, "acc_run_auto_reversals", {
      p_org_id: orgId,
      p_today: today,
    });
    totals.auto_reversed += Array.isArray(r?.done) ? r.done.length : 0;
  } catch (err) {
    totals.errors++;
    log?.warn("accounting.post auto reversals failed", { error: errText(err) });
  }
  return totals;
}

/** Every organisation that has a ledger (a default accounting entity). */
export async function runAccountingPosting(
  admin: AdminClient | PostingPort,
  log: JobLogger,
  opts: RunOptions = {},
): Promise<RunTotals> {
  const port = toPort(admin);
  const totals = emptyTotals();
  const orgIds = opts.orgIds ?? (await port.orgsWithLedger());
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  for (const orgId of orgIds) {
    if (Date.now() - started > budget) break;
    try {
      add(
        totals,
        await runPostingForOrg(
          port,
          orgId,
          { ...opts, budgetMs: budget - (Date.now() - started) },
          log,
        ),
      );
      totals.orgs++;
    } catch (err) {
      totals.errors++;
      log.warn("accounting.post org failed", { error: errText(err) });
    }
  }
  log.info("accounting.post done", { ...totals });
  return totals;
}

/** Runs chosen items now (the Waiting to post page's retry button). */
export async function retryItems(
  admin: AdminClient | PostingPort,
  orgId: string,
  items: Array<{ kind: PostingSource; id: string }>,
  now: Date = new Date(),
): Promise<RunTotals> {
  const port = toPort(admin);
  const totals = emptyTotals();
  const ctx = await loadPostingContext(port, orgId);
  const today = await orgToday(port, orgId, now);
  const byKind = new Map<PostingSource, string[]>();
  for (const i of items) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i.id]);
  for (const [kind, ids] of byKind) {
    add(totals, await processItems(port, orgId, kind, ids, ctx, today));
    totals.retried += ids.length;
  }
  return totals;
}

/**
 * The journal Pulse would post for one item, without posting anything: its lines, or the reasons it cannot post. The
 * Tally bridge (22J) pushes these to Tally before the ledger start. Service role, after the caller's can() check.
 */
export async function buildJournalForSource(
  admin: AdminClient | PostingPort,
  orgId: string,
  kind: PostingSource,
  id: string,
): Promise<BuildResult> {
  const port = toPort(admin);
  const ctx = await loadPostingContext(port, orgId);
  const records = await loadRecords(port, orgId, kind, [id]);
  return buildItem(kind, records.get(id), ctx);
}
