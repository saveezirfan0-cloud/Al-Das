import "server-only";

import { createHash } from "node:crypto";

import { loadAccount, readConfig } from "@/lib/integrations/accounts";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { Json } from "@/lib/supabase/types";

import { pickImportEntity, sameCompany, type CompanyEntity } from "./companies";
import { parseTallyXml, type TallyParseResult } from "./parse";
import { mergeParsed, planTallyImport, type PlanContext, type TallyPlanReport } from "./plan";
import { chunk, stagedRows } from "./stage";

/**
 * Server side of the Tally import (Phase 22I). Every caller has run can(member, 'accounting.import'); the database
 * functions check the permission again. The uploaded files are read once here and never kept (sha256 and size only);
 * only the sanitised staged rows reach the database.
 */

export const TALLY_BUCKET = "accounting-imports";
export const MAX_TALLY_FILES = 4;
/** Vouchers posted per database call; the commit loops until the time budget is spent, the page continues it. */
const VOUCHER_BATCH = 250;
const STEP_BUDGET_MS = 20_000;

export async function loadPlanContext(admin: AdminClient, orgId: string): Promise<PlanContext> {
  const [acc, cc, jr] = await Promise.all([
    // Every account and cost centre (the plan matches against all of them), read in pages: PostgREST returns at most
    // 1,000 rows per request, and a missed account would be planned as new.
    fetchAll((from, to) =>
      admin
        .from("acc_accounts")
        .select("id, code, name, is_group, is_system, tally_guid, tally_group, control")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    fetchAll((from, to) =>
      admin
        .from("acc_cost_centres")
        .select("id, code, name")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    loadTallyJournals(admin, orgId),
  ]);
  return { accounts: acc.data ?? [], costCentres: cc.data ?? [], tallyJournals: jr };
}

async function loadTallyJournals(admin: AdminClient, orgId: string) {
  const out: Array<{ guid: string; version: number }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("acc_journals")
      .select("tally_guid, source_version")
      .eq("org_id", orgId)
      .eq("source_kind", "tally_import")
      .eq("status", "posted")
      .order("id")
      .range(from, from + 999);
    for (const j of data ?? [])
      if (j.tally_guid && j.source_version)
        out.push({ guid: j.tally_guid, version: j.source_version });
    if (!data || data.length < 1000) return out;
  }
}

export type StagedImport =
  | { kind: "duplicate"; committedAt: string | null }
  | { kind: "refused"; reason: "company_not_linked" | "mixed_companies"; company: string | null }
  | { kind: "staged"; importId: string; report: TallyPlanReport };

/** The org's entities as the company rule sees them, and the Tally bridge integration's company (the default entity's fallback). */
export async function loadCompanyEntities(
  admin: AdminClient,
  orgId: string,
): Promise<{ entities: CompanyEntity[]; fallback: string | null }> {
  const [{ data }, account] = await Promise.all([
    admin.from("acc_entities").select("id, is_default, active, tally_company").eq("org_id", orgId),
    loadAccount(admin, orgId, "tally_bridge"),
  ]);
  const fb = String(readConfig(account).company ?? "").trim();
  return { entities: data ?? [], fallback: fb || null };
}

/** Parses the files, plans the import against the current chart and stores the dry run with its staged rows. */
export async function stageTallyFiles(
  admin: AdminClient,
  input: {
    orgId: string;
    userId: string;
    files: Array<{ bytes: Uint8Array }>;
    openingDate: string | null;
    force: boolean;
  },
): Promise<StagedImport> {
  const shas = input.files.map((f) => createHash("sha256").update(f.bytes).digest("hex"));
  if (!input.force) {
    const { data: dup } = await admin
      .from("acc_tally_imports")
      .select("committed_at")
      .eq("org_id", input.orgId)
      .eq("status", "committed")
      .overlaps("file_sha256", shas)
      .limit(1)
      .maybeSingle();
    if (dup) return { kind: "duplicate", committedAt: dup.committed_at };
  }
  const parsed: TallyParseResult[] = input.files.map((f) => parseTallyXml(f.bytes));
  // The file's own company decides the entity (W7): a file from another Tally company never lands in the default entity
  const companies = parsed.map((f) => f.company).filter((c): c is string => !!c);
  if (companies.some((c) => !sameCompany(c, companies[0])))
    return { kind: "refused", reason: "mixed_companies", company: null };
  const { entities, fallback } = await loadCompanyEntities(admin, input.orgId);
  const chosen = pickImportEntity(companies[0] ?? null, entities, fallback);
  if (!chosen.ok) {
    if (chosen.code === "no_default_entity") throw new Error("no default entity");
    return { kind: "refused", reason: chosen.code, company: companies[0]?.slice(0, 120) ?? null };
  }
  const ctx = await loadPlanContext(admin, input.orgId);
  const plan = planTallyImport(mergeParsed(parsed), ctx, { openingDate: input.openingDate });

  const { data: imp, error } = await admin
    .from("acc_tally_imports")
    .insert({
      org_id: input.orgId,
      entity_id: chosen.entityId,
      file_sha256: shas,
      file_bytes: input.files.reduce((a, f) => a + f.bytes.length, 0),
      forced: input.force,
      company: plan.report.company?.slice(0, 120) ?? null,
      report: plan.report as unknown as NonNullable<Json>,
      opening_date: plan.report.opening.date,
      first_date: plan.report.firstDate,
      last_date: plan.report.lastDate,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error || !imp) throw new Error("the import could not be saved");
  for (const batch of chunk(stagedRows(input.orgId, imp.id, plan), 1000)) {
    const { error: e } = await admin
      .from("acc_tally_staged")
      .insert(batch.map((r) => ({ ...r, payload: r.payload as NonNullable<Json> })));
    if (e) {
      await admin.from("acc_tally_imports").delete().eq("id", imp.id);
      throw new Error("the staged rows could not be saved");
    }
  }
  return { kind: "staged", importId: imp.id, report: plan.report };
}

export type CommitProgress = {
  status: "committing" | "committed";
  posted: number;
  unchanged: number;
  older: number;
  refused: number;
  remaining: number;
  masters?: { done: number; unchanged: number; refused: number };
  opening?: { posted: number; unchanged: number; lines: number };
};

type RpcError = { code?: string; hint?: string | null };
export class TallyCommitError extends Error {
  constructor(readonly rpc: RpcError) {
    super("tally commit step failed");
  }
}

/**
 * One step of the commit: on the first call the masters and the opening balances, then vouchers in batches until the
 * time budget is spent; when none is left, the summary. Safe to call again after a failure or a timeout (every part is
 * idempotent).
 */
export async function commitTallyStep(
  admin: AdminClient,
  input: {
    orgId: string;
    userId: string;
    importId: string;
    openingDate: string | null;
    status: string;
  },
): Promise<CommitProgress> {
  const progress: CommitProgress = {
    status: "committing",
    posted: 0,
    unchanged: 0,
    older: 0,
    refused: 0,
    remaining: 0,
  };
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn as never, args as never);
    if (error) throw new TallyCommitError(error);
    return data as T;
  };
  if (input.status === "staged")
    progress.masters = await call("acc_tally_apply_masters", {
      p_org_id: input.orgId,
      p_import_id: input.importId,
      p_user_id: input.userId,
    });
  // every step: idempotent by content, so a step that failed after the masters still posts the opening next time
  if (input.openingDate)
    progress.opening = await call("acc_tally_post_opening", {
      p_org_id: input.orgId,
      p_import_id: input.importId,
      p_user_id: input.userId,
      p_date: input.openingDate,
    });
  const started = Date.now();
  for (;;) {
    const b = await call<{
      done: number;
      unchanged: number;
      older: number;
      refused: number;
      remaining: number;
    }>("acc_tally_post_vouchers", {
      p_org_id: input.orgId,
      p_import_id: input.importId,
      p_user_id: input.userId,
      p_limit: VOUCHER_BATCH,
    });
    progress.posted += b.done;
    progress.unchanged += b.unchanged;
    progress.older += b.older;
    progress.refused += b.refused;
    progress.remaining = Number(b.remaining);
    if (progress.remaining === 0 || Date.now() - started > STEP_BUDGET_MS) break;
  }
  if (progress.remaining === 0) {
    await call("acc_tally_finish", {
      p_org_id: input.orgId,
      p_import_id: input.importId,
      p_user_id: input.userId,
    });
    progress.status = "committed";
  }
  return progress;
}
