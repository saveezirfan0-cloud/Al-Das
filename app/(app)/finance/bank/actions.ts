"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { openCopilot, recordCalls } from "@/lib/ai/copilot/server";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { runBankAiReview } from "@/lib/finance/bank-ai-server";
import { bankItemKey, isReasonCode, periodFor, runFigures } from "@/lib/finance/bank-recon";
import { loadBankSettings, loadRun } from "@/lib/finance/bank-server";
import { isBankImportKind, type AmountStyle, type DateFormat } from "@/lib/finance/import-kinds";
import {
  MAX_IMPORT_BYTES,
  parseBankStatement,
  parseSettlement,
  readImportFile,
} from "@/lib/finance/parse-import";
import { previewImportTable } from "@/lib/finance/import-preview";
import { redactText } from "@/lib/redact";
import type { UploadPreview } from "@/lib/upload/preview";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Bank and settlement reconciliation. Uploads, runs and decisions need finance.bank.manage; the sign-off needs
 * finance.bank.signoff and a different person from the preparer (the database enforces it too). Writes use the service
 * role after the check and are audited with ids, counts and codes only. A statement file is read once and never kept:
 * only its sha256 is stored. The AI reviewer (Phase 20H) also needs finance.bank.ai and the workspace AI gates; it only
 * suggests, and a person's acceptance goes through the same decision path as any proposal.
 */

const MANAGE = "finance.bank.manage";
const SIGNOFF = "finance.bank.signoff";
const AI = "finance.bank.ai";

async function gate(perm: string) {
  const member = await requireMember();
  return can(member, perm) ? member : null;
}
type Member = NonNullable<Awaited<ReturnType<typeof gate>>>;

const refresh = (recId?: string) => {
  revalidatePath("/finance/bank");
  if (recId) revalidatePath(`/finance/bank/${recId}`);
};

const importSchema = z.object({
  kind: z.string().refine(isBankImportKind, "Choose what you are importing."),
  format_id: uuid,
  account_id: z.string().optional(),
  payment_mode: z.string().trim().max(60).optional(),
});

export type ImportOutcome = {
  rows: number;
  skipped: number;
  firstDate: string | null;
  lastDate: string | null;
};

/**
 * Phase G upload preview: reads the file the person dropped with the import's own reader and shows the mapped columns of
 * the first rows (texts redacted as they would be stored), the names of columns the layout does not map, and any mapped
 * column that is missing. Nothing is stored or logged; the file is dropped when this returns.
 */
export async function previewStatement(fd: FormData): Promise<ActionResult<UploadPreview>> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const file = fd.get("file");
  const kind = fd.get("kind");
  const formatId = uuid.safeParse(fd.get("format_id"));
  if (!isBankImportKind(kind)) return fail("Choose what you are importing.");
  if (!formatId.success) return fail("Choose the layout first.");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a file.");
  if (file.size > MAX_IMPORT_BYTES) return fail("The file is larger than 5 MB. Split it.");
  if (!/\.(csv|xlsx)$/i.test(file.name)) return fail("Upload a .csv or .xlsx file.");
  const admin = createAdminClient(); // service role AFTER the permission check: the layout only
  const { data: format } = await admin
    .from("fin_import_formats")
    .select("kind, mapping, date_format, amount_style, active")
    .eq("org_id", member.orgId)
    .eq("id", formatId.data)
    .maybeSingle();
  if (!format || !format.active || format.kind !== kind)
    return fail("Choose an active layout for this kind of file.");
  let table: unknown[][];
  try {
    table = await readImportFile(Buffer.from(await file.arrayBuffer()));
  } catch {
    return fail("The file could not be read. Save it as .csv or .xlsx and try again.");
  }
  return {
    ok: true,
    data: previewImportTable(table, {
      kind,
      mapping: (format.mapping ?? {}) as Record<string, string>,
      dateFormat: format.date_format as DateFormat,
      amountStyle: format.amount_style as AmountStyle,
    }),
  };
}

/** Reads an uploaded statement or settlement report, stores the sanitised rows atomically, and keeps only the sha256. */
export async function importStatement(fd: FormData): Promise<ActionResult<ImportOutcome>> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const file = fd.get("file");
  const parsed = importSchema.safeParse({
    kind: fd.get("kind"),
    format_id: fd.get("format_id"),
    account_id: fd.get("account_id") ?? undefined,
    payment_mode: fd.get("payment_mode") ?? undefined,
  });
  if (!parsed.success) return fail(firstIssue(parsed.error));
  if (!(file instanceof File) || file.size === 0) return fail("Choose a file.");
  if (file.size > MAX_IMPORT_BYTES) return fail("The file is larger than 5 MB. Split it.");
  if (!/\.(csv|xlsx)$/i.test(file.name)) return fail("Upload a .csv or .xlsx file.");
  const v = parsed.data;
  const kind = v.kind as "bank_statement" | "settlement";

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data: format } = await admin
    .from("fin_import_formats")
    .select("id, kind, mapping, date_format, amount_style, active")
    .eq("org_id", member.orgId)
    .eq("id", v.format_id)
    .maybeSingle();
  if (!format || !format.active || format.kind !== kind)
    return fail("Choose an active layout for this kind of file.");

  let accountId: string | null = null;
  let mode: string | null = null;
  if (kind === "bank_statement") {
    if (!uuid.safeParse(v.account_id).success) return fail("Choose the bank account.");
    const { data: account } = await admin
      .from("fin_bank_accounts")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("id", v.account_id!)
      .eq("active", true)
      .maybeSingle();
    if (!account) return fail("Choose an active bank account.");
    accountId = account.id;
  } else {
    const { data: rule } = await admin
      .from("fin_ref_settlement_rules")
      .select("payment_mode")
      .eq("org_id", member.orgId)
      .eq("payment_mode", v.payment_mode ?? "")
      .maybeSingle();
    if (!rule) return fail("Choose the payment mode this report is for.");
    mode = rule.payment_mode;
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const sha = createHash("sha256").update(buffer).digest("hex");
    const { data: dup } = await admin
      .from("fin_bank_imports")
      .select("imported_at")
      .eq("org_id", member.orgId)
      .eq("file_sha256", sha)
      .maybeSingle();
    if (dup)
      return fail(
        `This file was already imported on ${dup.imported_at.slice(0, 10)}. Nothing was changed.`,
      );

    let table: unknown[][];
    try {
      table = await readImportFile(buffer);
    } catch {
      return fail("The file could not be read. Save it as .csv or .xlsx and try again.");
    }
    const layout = {
      kind,
      mapping: (format.mapping ?? {}) as Record<string, string>,
      dateFormat: format.date_format as DateFormat,
      amountStyle: format.amount_style as AmountStyle,
    };
    const result =
      kind === "bank_statement"
        ? parseBankStatement(table, layout)
        : parseSettlement(table, layout);
    if (!result.ok) {
      const head = result.missing.length ? `Missing columns: ${result.missing.join("; ")}. ` : "";
      return fail(`Nothing was imported. ${head}${result.errors.join(" ")}`.trim());
    }

    // friendlier than the database's refusal (which still applies): an overlapping statement would double-count
    const { stats } = result;
    const overlap =
      kind === "bank_statement"
        ? await admin
            .from("fin_bank_lines")
            .select("id")
            .eq("org_id", member.orgId)
            .eq("account_id", accountId!)
            .gte("value_date", stats.firstDate!)
            .lte("value_date", stats.lastDate!)
            .limit(1)
        : await admin
            .from("fin_settlement_lines")
            .select("id")
            .eq("org_id", member.orgId)
            .eq("payment_mode", mode!)
            .gte("txn_date", stats.firstDate!)
            .lte("txn_date", stats.lastDate!)
            .limit(1);
    if ((overlap.data ?? []).length > 0)
      return fail(
        `Nothing was imported: dates ${stats.firstDate} to ${stats.lastDate} overlap a file already imported. Remove that import first, or export only the new dates.`,
      );

    const { data: importId, error } = await admin.rpc("fin_bank_import", {
      p_org_id: member.orgId,
      p_kind: kind,
      p_account_id: accountId as string,
      p_payment_mode: mode as string,
      p_format_id: format.id,
      // the extension only: a file name can carry a person's name (the database keeps the extension at most, too)
      p_file_name: /\.(csv|xlsx)$/i.exec(file.name)?.[0].toLowerCase() ?? "",
      p_sha256: sha,
      p_rows: result.rows as unknown as Json,
      p_user: member.userId,
    });
    if (error) return fail(dbMessage(error, "Nothing was imported. Check the file and try again."));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.bank.imported",
      entity: "fin_bank_imports",
      entityId: String(importId),
      diff: {
        kind,
        rows: stats.rows,
        skipped: stats.skipped,
        first: stats.firstDate,
        last: stats.lastDate,
      },
    });
    refresh();
    return {
      ok: true,
      message: `Imported ${stats.rows} row(s)${stats.skipped ? `, skipped ${stats.skipped} blank or balance line(s)` : ""}.`,
      data: {
        rows: stats.rows,
        skipped: stats.skipped,
        firstDate: stats.firstDate,
        lastDate: stats.lastDate,
      },
    };
  } catch (err) {
    console.error("[finance] bank import failed", { error: redactText(err, 100) });
    return fail("The file could not be processed.");
  }
}

/** Removes an import and its lines; refused while any of its bank lines is matched (the database refuses it too). */
export async function deleteImport(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(values.id);
  if (!id.success) return fail("Choose an import.");
  const admin = createAdminClient(member.userId);
  const { data: matched } = await admin
    .from("fin_bank_lines")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("import_id", id.data)
    .eq("match_status", "matched")
    .limit(1);
  if ((matched ?? []).length > 0)
    return fail("Some lines of this import are matched. Undo those matches first.");
  const { data, error } = await admin
    .from("fin_bank_imports")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id.data)
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not remove the import."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.import_removed",
    entity: "fin_bank_imports",
    entityId: id.data,
  });
  refresh();
  return { ok: true, message: "Import removed." };
}

const runSchema = z.object({
  account_id: uuid,
  month: z.string().regex(/^\d{4}-\d{2}$/, "Choose a month."),
});

/** Opens the reconciliation of one account for one month (period from the cut-off day setting). */
export async function createRun(
  values: Record<string, string>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = runSchema.safeParse({
    account_id: values.account_id,
    month: (values.month ?? "").slice(0, 7),
  });
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const settings = await loadBankSettings(admin, member.orgId);
  const month = `${p.data.month}-01`;
  const period = periodFor(month, settings.cutoffDay);
  const { data, error } = await admin
    .from("fin_bank_recs")
    .insert({
      org_id: member.orgId,
      account_id: p.data.account_id,
      month,
      period_start: period.start,
      period_end: period.end,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return fail(dbMessage(error, "Could not open the reconciliation."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.run_opened",
    entity: "fin_bank_recs",
    entityId: data.id,
    diff: { month, period_start: period.start, period_end: period.end },
  });
  refresh();
  return {
    ok: true,
    message: `Reconciliation opened for ${period.start} to ${period.end}.`,
    data: { id: data.id },
  };
}

const recOnly = z.object({ rec_id: uuid });
const pairSchema = z.object({ rec_id: uuid, key: z.string().min(1).max(160), line_id: uuid });

/** Saves every automatic match the rules allow right now (score above the threshold and the only candidate both ways). */
export async function runMatching(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = recOnly.safeParse(values);
  if (!p.success) return fail("Choose a reconciliation.");
  const admin = createAdminClient(member.userId);
  const run = await loadRun(admin, member.orgId, p.data.rec_id, todayIn(member.org.timezone));
  if (!run) return fail("Reconciliation not found.");
  if (run.rec.status !== "open") return fail("This reconciliation is not open.");
  const rows = run.result.autoReady.map(({ item, candidate }) => {
    return {
      org_id: member.orgId,
      rec_id: run.rec.id,
      bank_line_id: candidate.lineId,
      expected_key: item.key,
      expected_kind: item.kind,
      expected_date: item.expectedDate,
      expected_amount: item.amount,
      bank_amount: candidate.bankAmount,
      score: candidate.score,
      reasons: candidate.reasons,
      status: "matched",
      auto: true,
      decided_by: member.userId,
    };
  });
  if (rows.length === 0) return { ok: true, message: "No automatic matches to save." };
  const { error } = await admin.from("fin_bank_matches").insert(rows);
  if (error) return fail(dbMessage(error, "Nothing was saved. Reload and try again."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.auto_matched",
    entity: "fin_bank_recs",
    entityId: run.rec.id,
    diff: { matches: rows.length },
  });
  refresh(run.rec.id);
  return { ok: true, message: `${rows.length} automatic match(es) saved.` };
}

/** Accepts or rejects one proposed pair. The pair must still be a candidate when the server recomputes the run. */
export async function decideMatch(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = pairSchema.safeParse(values);
  if (!p.success || !["accept", "reject"].includes(values.decision ?? ""))
    return fail("Choose a proposed match.");
  return applyMatchDecision(member, p.data, values.decision === "accept");
}

/**
 * The one code path that saves a person's decision on a pair: a proposal on the run page, or an AI suggestion a person
 * accepted (Phase 20H). It recomputes the run and refuses unless the run is open and the pair is still a candidate; the
 * database guards (open run, unlocked month, each line and item matched once) apply to the insert. Callers have checked
 * finance.bank.manage.
 */
async function applyMatchDecision(
  member: Member,
  pair: { rec_id: string; key: string; line_id: string },
  accept: boolean,
): Promise<ActionResult> {
  const admin = createAdminClient(member.userId);
  const run = await loadRun(admin, member.orgId, pair.rec_id, todayIn(member.org.timezone));
  if (!run) return fail("Reconciliation not found.");
  if (run.rec.status !== "open") return fail("This reconciliation is not open.");
  const pool = [
    ...run.result.proposals.map((x) => ({ item: x.item, candidates: x.candidates })),
    ...run.result.autoReady.map((x) => ({ item: x.item, candidates: [x.candidate] })),
  ];
  const entry = pool.find((x) => x.item.key === pair.key);
  const candidate = entry?.candidates.find((c) => c.lineId === pair.line_id);
  if (!entry || !candidate) return fail("That pair is no longer a candidate. Reload the page.");
  const { error } = await admin.from("fin_bank_matches").insert({
    org_id: member.orgId,
    rec_id: run.rec.id,
    bank_line_id: candidate.lineId,
    expected_key: entry.item.key,
    expected_kind: entry.item.kind,
    expected_date: entry.item.expectedDate,
    expected_amount: entry.item.amount,
    bank_amount: candidate.bankAmount,
    score: candidate.score,
    reasons: candidate.reasons,
    status: accept ? "matched" : "rejected",
    auto: false,
    decided_by: member.userId,
  });
  if (error) return fail(dbMessage(error, "Nothing was saved. Reload and try again."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: accept ? "finance.bank.match_accepted" : "finance.bank.match_rejected",
    entity: "fin_bank_recs",
    entityId: run.rec.id,
    diff: { key: entry.item.key, line: candidate.lineId, score: candidate.score },
  });
  refresh(run.rec.id);
  return { ok: true, message: accept ? "Match accepted." : "Proposal rejected." };
}

/** Undoes a saved match (automatic or accepted) while the run is open. */
export async function undoMatch(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = pairSchema.safeParse(values);
  if (!p.success) return fail("Choose a match.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_bank_matches")
    .delete()
    .eq("org_id", member.orgId)
    .eq("rec_id", p.data.rec_id)
    .eq("expected_key", p.data.key)
    .eq("bank_line_id", p.data.line_id)
    .eq("status", "matched")
    .select("id");
  if (error || !data?.length)
    return fail(dbMessage(error, "Could not undo the match (is the reconciliation still open?)."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.match_undone",
    entity: "fin_bank_recs",
    entityId: p.data.rec_id,
    diff: { key: p.data.key, line: p.data.line_id },
  });
  refresh(p.data.rec_id);
  return { ok: true, message: "Match undone." };
}

const reasonSchema = z.object({
  rec_id: uuid,
  item_key: z.string().min(1).max(160),
  code: z.string().refine(isReasonCode, "Choose a reason."),
  note: z.string().trim().max(200, "Keep the note under 200 characters.").default(""),
});

/** The reason an expected item has not arrived, or what an unmatched bank credit is. */
export async function saveReason(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = reasonSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  if (p.data.code === "other" && !p.data.note) return fail("Explain the reason in the note.");
  const admin = createAdminClient(member.userId);
  const run = await loadRun(admin, member.orgId, p.data.rec_id, todayIn(member.org.timezone));
  if (!run) return fail("Reconciliation not found.");
  const known =
    run.result.unmatched.some((u) => u.item.key === p.data.item_key) ||
    run.result.bankUnmatched.some((b) => bankItemKey(b.line.id) === p.data.item_key);
  if (!known) return fail("That item is no longer open. Reload the page.");
  const { error } = await admin.from("fin_bank_rec_notes").upsert(
    {
      org_id: member.orgId,
      rec_id: run.rec.id,
      item_key: p.data.item_key,
      reason_code: p.data.code,
      note: p.data.note || null,
      decided_by: member.userId,
      decided_at: new Date().toISOString(),
    },
    { onConflict: "rec_id,item_key" },
  );
  if (error)
    return fail(dbMessage(error, "Could not save the reason (is the reconciliation still open?)."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.reason_saved",
    entity: "fin_bank_recs",
    entityId: run.rec.id,
    diff: { item: p.data.item_key, code: p.data.code, has_note: !!p.data.note },
  });
  refresh(run.rec.id);
  return { ok: true, message: "Reason saved." };
}

/** Freezes the figures (the database stores their sha256). Refused while anything is still open. */
export async function markReviewed(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = recOnly.safeParse(values);
  if (!p.success) return fail("Choose a reconciliation.");
  const admin = createAdminClient(member.userId);
  const run = await loadRun(admin, member.orgId, p.data.rec_id, todayIn(member.org.timezone));
  if (!run) return fail("Reconciliation not found.");
  if (run.rec.status !== "open") return fail("This reconciliation is not open.");
  if (run.result.problems.length > 0) return fail(`Not yet: ${run.result.problems.join(" ")}`);
  const figures = runFigures(run.result, {
    accountId: run.account.id,
    period: { start: run.rec.period_start, end: run.rec.period_end },
  });
  const { data, error } = await admin
    .from("fin_bank_recs")
    .update({ status: "reviewed", figures: figures as unknown as Json, prepared_by: member.userId })
    .eq("org_id", member.orgId)
    .eq("id", run.rec.id)
    .eq("status", "open")
    .select("figures_sha256");
  if (error || !data?.length) return fail(dbMessage(error, "Could not mark it reviewed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.reviewed",
    entity: "fin_bank_recs",
    entityId: run.rec.id,
    diff: { sha256: data[0].figures_sha256, matched: figures.summary.matchedCount },
  });
  refresh(run.rec.id);
  return {
    ok: true,
    message: "Reviewed. Another person with the sign-off permission can now sign it.",
  };
}

/** Withdraws the review (back to open) before anyone signs. */
export async function reopenRun(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const p = recOnly.safeParse(values);
  if (!p.success) return fail("Choose a reconciliation.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_bank_recs")
    .update({ status: "open" })
    .eq("org_id", member.orgId)
    .eq("id", p.data.rec_id)
    .eq("status", "reviewed")
    .select("id");
  if (error || !data?.length)
    return fail(dbMessage(error, "Only a reviewed, unsigned reconciliation can be reopened."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.reopened",
    entity: "fin_bank_recs",
    entityId: p.data.rec_id,
  });
  refresh(p.data.rec_id);
  return { ok: true, message: "Reopened." };
}

const signSchema = z.object({
  rec_id: uuid,
  hash: z.string().regex(/^[0-9a-f]{64}$/, "Reload the page and try again."),
});

/** Signs the reviewed figures the signer was shown (bound to their sha256). The preparer cannot sign. */
export async function signRun(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(SIGNOFF);
  if (!member) return fail(DENIED);
  const p = signSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data: rec } = await admin
    .from("fin_bank_recs")
    .select("status, prepared_by, figures_sha256")
    .eq("org_id", member.orgId)
    .eq("id", p.data.rec_id)
    .maybeSingle();
  if (!rec || rec.status !== "reviewed")
    return fail("Only a reviewed reconciliation can be signed.");
  if (rec.prepared_by === member.userId)
    return fail("You prepared this reconciliation; another person must sign it.");
  if (rec.figures_sha256 !== p.data.hash)
    return fail("The figures changed since you opened the page. Reload and review them again.");
  const { data, error } = await admin
    .from("fin_bank_recs")
    .update({ status: "signed", signed_by: member.userId })
    .eq("org_id", member.orgId)
    .eq("id", p.data.rec_id)
    .eq("status", "reviewed")
    .eq("figures_sha256", p.data.hash)
    .select("id");
  if (error || !data?.length)
    return fail(dbMessage(error, "Could not sign. Reload and try again."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.bank.signed",
    entity: "fin_bank_recs",
    entityId: p.data.rec_id,
    diff: { sha256: p.data.hash },
  });
  refresh(p.data.rec_id);
  return { ok: true, message: "Signed." };
}

// ---- Phase 20H: the AI reviewer. It suggests; a person decides each suggestion. ----------------------------------

/**
 * Asks the AI to review an open reconciliation. Needs finance.bank.manage AND finance.bank.ai, then the workspace AI
 * gates (master switch, per-person limit, daily cap, key). The model sees ids, amounts, dates, modes and reference tokens
 * only; its answer is checked against each item's shortlist and stored as a draft review with pending suggestions.
 */
export async function askAiReview(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member || !can(member, AI)) return fail(DENIED);
  const p = recOnly.safeParse(values);
  if (!p.success) return fail("Choose a reconciliation.");
  const admin = createAdminClient(member.userId);
  const { data: rec } = await admin
    .from("fin_bank_recs")
    .select("id, status")
    .eq("org_id", member.orgId)
    .eq("id", p.data.rec_id)
    .maybeSingle();
  if (!rec) return fail("Reconciliation not found.");
  if (rec.status !== "open") return fail("This reconciliation is not open.");
  const opened = await openCopilot(member);
  if (!opened.ok) return fail(opened.error);
  const out = await runBankAiReview(
    { admin, llm: opened.llm },
    {
      orgId: member.orgId,
      userId: member.userId,
      recId: rec.id,
      today: todayIn(member.org.timezone),
    },
  );
  await recordCalls(opened, member, "bank_review", out.calls);
  if (out.reviewId)
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.bank.ai_reviewed",
      entity: "fin_bank_ai_reviews",
      entityId: out.reviewId,
      diff: {
        rec: rec.id,
        status: out.ok ? "ok" : "rejected",
        suggestions: out.ok ? out.suggestions : 0,
        repaired: out.ok ? out.repaired : false,
      },
    });
  refresh(rec.id);
  if (!out.ok) return fail(out.error);
  return {
    ok: true,
    message: `The AI made ${out.suggestions} suggestion(s). Check each one before accepting it.`,
  };
}

const aiDecisionSchema = z.object({
  rec_id: uuid,
  suggestion_id: uuid,
  decision: z.enum(["accept", "reject"]),
});

/**
 * Records a person's decision on one AI suggestion. Accepting a suggested pair saves the match through the SAME path as
 * accepting a proposal (applyMatchDecision): every 20C rule, audit and lock applies. Accepting "no match" changes nothing
 * else (the reason is still given in the list). Rejecting only records the decision; the pair stays open to a person.
 */
export async function decideAiSuggestion(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member || !can(member, AI)) return fail(DENIED);
  const p = aiDecisionSchema.safeParse(values);
  if (!p.success) return fail("Choose a suggestion.");
  const accept = p.data.decision === "accept";
  const admin = createAdminClient(member.userId);
  const { data: s } = await admin
    .from("fin_bank_ai_suggestions")
    .select("id, rec_id, item_key, candidate_line_id, decision")
    .eq("org_id", member.orgId)
    .eq("rec_id", p.data.rec_id)
    .eq("id", p.data.suggestion_id)
    .maybeSingle();
  if (!s) return fail("Suggestion not found.");
  if (s.decision !== "pending") return fail("This suggestion has already been decided.");
  if (accept && s.candidate_line_id) {
    const applied = await applyMatchDecision(
      member,
      { rec_id: s.rec_id, key: s.item_key, line_id: s.candidate_line_id },
      true,
    );
    if (!applied.ok) return applied;
  }
  const { data, error } = await admin
    .from("fin_bank_ai_suggestions")
    .update({
      decision: accept ? "accepted" : "rejected",
      decided_by: member.userId,
      decided_at: new Date().toISOString(),
    })
    .eq("org_id", member.orgId)
    .eq("id", s.id)
    .eq("decision", "pending")
    .select("id");
  if (error || !data?.length)
    return fail(
      dbMessage(
        error,
        accept && s.candidate_line_id
          ? "The match was saved, but the suggestion could not be marked. Reload the page."
          : "Could not save the decision (is the reconciliation still open?).",
      ),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: accept ? "finance.bank.ai_suggestion_accepted" : "finance.bank.ai_suggestion_rejected",
    entity: "fin_bank_ai_suggestions",
    entityId: s.id,
    diff: { rec: s.rec_id, key: s.item_key, line: s.candidate_line_id },
  });
  refresh(s.rec_id);
  return {
    ok: true,
    message: accept
      ? s.candidate_line_id
        ? "Suggestion accepted: the match is saved."
        : "Suggestion accepted. Give the reason in the list below."
      : "Suggestion rejected.",
  };
}
