"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

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
import { headerKey, type DateFormat } from "@/lib/finance/import-kinds";
import { fileKindFor, isLabReasonCode, isProviderKind, statementFigures } from "@/lib/finance/labs";
import { loadStatement } from "@/lib/finance/labs-server";
import { MAX_IMPORT_BYTES, parseProviderLines, readImportFile } from "@/lib/finance/parse-import";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Lab and referral reconciliation (20E). Everything needs finance.labs.manage; posting also needs a different person
 * from the one who reviewed (the database enforces it too). Writes use the service role after the check and are audited
 * with ids, counts and codes only. A lab file is read once and never kept: only its sha256 and the sanitised rows of
 * the mapped columns are stored (no name or ID-number field exists to map).
 */

const MANAGE = "finance.labs.manage";

async function gate() {
  const member = await requireMember();
  return can(member, MANAGE) ? member : null;
}

const refresh = (statementId?: string) => {
  revalidatePath("/finance/labs");
  if (statementId) revalidatePath(`/finance/labs/${statementId}`);
};

const importSchema = z.object({
  provider_id: uuid,
  format_id: uuid,
  month: z.string().regex(/^\d{4}-\d{2}$/, "Choose the month."),
});

/** Reads a lab or provider file, stores the sanitised rows atomically in the provider's statement for the month. */
export async function importProviderFile(
  fd: FormData,
): Promise<ActionResult<{ statementId: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = importSchema.safeParse({
    provider_id: fd.get("provider_id"),
    format_id: fd.get("format_id"),
    month: String(fd.get("month") ?? "").slice(0, 7),
  });
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a file.");
  if (file.size > MAX_IMPORT_BYTES) return fail("The file is larger than 5 MB. Split it.");
  if (!/\.(csv|xlsx)$/i.test(file.name)) return fail("Upload a .csv or .xlsx file.");
  const v = parsed.data;
  const month = `${v.month}-01`;

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const [{ data: provider }, { data: format }, { data: branches }] = await Promise.all([
    admin
      .from("fin_providers")
      .select("id, kind, active")
      .eq("org_id", member.orgId)
      .eq("id", v.provider_id)
      .maybeSingle(),
    admin
      .from("fin_import_formats")
      .select("id, kind, mapping, date_format, active")
      .eq("org_id", member.orgId)
      .eq("id", v.format_id)
      .maybeSingle(),
    admin
      .from("fin_ref_branches")
      .select("code, name, unite_clinic_short_name, unite_clinic_long_name")
      .eq("org_id", member.orgId),
  ]);
  if (!provider || !provider.active || !isProviderKind(provider.kind))
    return fail("Choose an active provider.");
  const kind = fileKindFor(provider.kind);
  if (!format || !format.active || format.kind !== kind)
    return fail("Choose an active layout for this provider's files.");

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const sha = createHash("sha256").update(buffer).digest("hex");
    const { data: dup } = await admin
      .from("fin_provider_files")
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
    const result = parseProviderLines(table, {
      kind,
      mapping: (format.mapping ?? {}) as Record<string, string>,
      dateFormat: format.date_format as DateFormat,
      amountStyle: "signed",
    });
    if (!result.ok) {
      const head = result.missing.length ? `Missing columns: ${result.missing.join("; ")}. ` : "";
      return fail(`Nothing was imported. ${head}${result.errors.join(" ")}`.trim());
    }

    // a branch is stored only as a known branch code (never the text from the file)
    const branchCode = new Map<string, string>();
    for (const b of branches ?? [])
      for (const name of [b.code, b.name, b.unite_clinic_short_name, b.unite_clinic_long_name])
        if (name) branchCode.set(headerKey(name), b.code);
    const unknownRows: number[] = [];
    const rows = result.rows.map((r, i) => {
      const code = r.branch === null ? null : (branchCode.get(headerKey(r.branch)) ?? null);
      if (r.branch !== null && code === null) unknownRows.push(i + 1);
      return { ...r, branch: undefined, branch_code: code };
    });
    if (unknownRows.length > 0)
      return fail(
        `Nothing was imported: ${unknownRows.length} row(s) name a branch that is not in Reference data (data rows ${unknownRows.slice(0, 10).join(", ")}${unknownRows.length > 10 ? ", ..." : ""}). Add the branch or its Unite name there first.`,
      );

    const { data: statementId, error } = await admin.rpc("fin_provider_import", {
      p_org_id: member.orgId,
      p_provider_id: provider.id,
      p_month: month,
      p_format_id: format.id,
      p_file_name: /\.(csv|xlsx)$/i.exec(file.name)?.[0].toLowerCase() ?? "", // extension only, never the name
      p_sha256: sha,
      p_rows: rows as unknown as Json,
      p_user: member.userId,
    });
    if (error)
      return fail(
        error.code === "23505"
          ? "This file was already imported. Nothing was changed."
          : dbMessage(
              error,
              "Nothing was imported. Check that the statement is open and the service dates belong to the month.",
            ),
      );
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.labs.imported",
      entity: "fin_provider_statements",
      entityId: String(statementId),
      diff: {
        kind,
        month,
        rows: result.stats.rows,
        skipped: result.stats.skipped,
        first: result.stats.firstDate,
        last: result.stats.lastDate,
      },
    });
    refresh(String(statementId));
    return {
      ok: true,
      message: `Imported ${result.stats.rows} line(s)${result.stats.skipped ? `, skipped ${result.stats.skipped} blank or total line(s)` : ""}.`,
      data: { statementId: String(statementId) },
    };
  } catch (err) {
    console.error("[finance] lab import failed", { error: redactText(err, 100) });
    return fail("The file could not be processed.");
  }
}

const fileSchema = z.object({ statement_id: uuid, file_id: uuid });

/** Removes one imported file and its lines while the statement is open (the database refuses otherwise). */
export async function removeProviderFile(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = fileSchema.safeParse(values);
  if (!p.success) return fail("Choose a file.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_provider_files")
    .delete()
    .eq("org_id", member.orgId)
    .eq("statement_id", p.data.statement_id)
    .eq("id", p.data.file_id)
    .select("id");
  if (error || !data?.length)
    return fail(dbMessage(error, "Could not remove the file (is the statement still open?)."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.file_removed",
    entity: "fin_provider_statements",
    entityId: p.data.statement_id,
    diff: { file: p.data.file_id },
  });
  refresh(p.data.statement_id);
  return { ok: true, message: "File removed." };
}

const reasonSchema = z.object({
  statement_id: uuid,
  item_key: z.string().max(120).optional().default(""),
  list: z.enum(["", "not_billed", "not_on_file"]).optional().default(""),
  code: z.string().refine(isLabReasonCode, "Choose a reason."),
  note: z.string().trim().max(200, "Keep the note under 200 characters.").default(""),
});

/**
 * The reason a line was not matched to Unite, or a billed test is missing from the file. One item (`item_key`), or
 * every item of one list that has no reason yet (`list`). Items are checked against the statement as computed now.
 */
export async function saveLabReason(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = reasonSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const { statement_id, item_key, list, code } = p.data;
  const note = p.data.note ? redactText(p.data.note, 200) : "";
  if (code === "other" && !note) return fail("Explain the reason in the note.");
  if (!item_key && !list) return fail("Choose an item.");
  const admin = createAdminClient(member.userId);
  const loaded = await loadStatement(
    admin,
    member.orgId,
    statement_id,
    todayIn(member.org.timezone),
  );
  if (!loaded) return fail("Statement not found.");
  if (loaded.statement.status !== "open") return fail("This statement is not open.");
  const open = [
    ...loaded.result.notBilled.map((n) => ({ key: n.key, list: "not_billed", note: n.note })),
    ...loaded.result.notOnFile.map((n) => ({ key: n.key, list: "not_on_file", note: n.note })),
  ];
  const keys = item_key
    ? open.filter((o) => o.key === item_key).map((o) => o.key)
    : open.filter((o) => o.list === list && !o.note).map((o) => o.key);
  if (keys.length === 0)
    return fail(item_key ? "That item is no longer open. Reload the page." : "Nothing to explain.");
  const now = new Date().toISOString();
  const { error } = await admin.from("fin_provider_notes").upsert(
    keys.map((k) => ({
      org_id: member.orgId,
      statement_id,
      item_key: k,
      reason_code: code,
      note: note || null,
      decided_by: member.userId,
      decided_at: now,
    })),
    { onConflict: "statement_id,item_key" },
  );
  if (error)
    return fail(dbMessage(error, "Could not save the reason (is the statement still open?)."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.reason_saved",
    entity: "fin_provider_statements",
    entityId: statement_id,
    diff: { items: keys.length, list: list || null, code, has_note: !!note },
  });
  refresh(statement_id);
  return {
    ok: true,
    message: keys.length === 1 ? "Reason saved." : `Reason saved for ${keys.length} items.`,
  };
}

const statementOnly = z.object({ statement_id: uuid });

/** Freezes the figures (the database stores their sha256). Refused while anything is still open. */
export async function reviewStatement(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = statementOnly.safeParse(values);
  if (!p.success) return fail("Choose a statement.");
  const admin = createAdminClient(member.userId);
  const loaded = await loadStatement(
    admin,
    member.orgId,
    p.data.statement_id,
    todayIn(member.org.timezone),
  );
  if (!loaded) return fail("Statement not found.");
  if (loaded.statement.status !== "open") return fail("This statement is not open.");
  if (loaded.result.problems.length > 0)
    return fail(`Not yet: ${loaded.result.problems.join(" ")}`);
  const figures = statementFigures(loaded.result, {
    statementId: loaded.statement.id,
    providerId: loaded.provider.id,
    providerKind: loaded.provider.kind,
    month: loaded.statement.month,
  });
  const { data, error } = await admin
    .from("fin_provider_statements")
    .update({ status: "reviewed", figures: figures as unknown as Json, prepared_by: member.userId })
    .eq("org_id", member.orgId)
    .eq("id", loaded.statement.id)
    .eq("status", "open")
    .select("figures_sha256");
  if (error || !data?.length) return fail(dbMessage(error, "Could not mark it reviewed."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.reviewed",
    entity: "fin_provider_statements",
    entityId: loaded.statement.id,
    diff: {
      sha256: data[0].figures_sha256,
      lines: figures.summary.lines,
      matched: figures.summary.matched,
      doctors: figures.doctors.length,
    },
  });
  refresh(loaded.statement.id);
  return {
    ok: true,
    message: "Reviewed. Another person can now post the costs to the doctors' charges.",
  };
}

const postSchema = z.object({
  statement_id: uuid,
  hash: z.string().regex(/^[0-9a-f]{64}$/, "Reload the page and try again."),
});

/**
 * Posts the reviewed per-doctor costs into the doctors' charges for the month (20F), bound to the figures the poster was
 * shown. The person who reviewed cannot post. Re-posting replaces only this statement's charges.
 */
export async function postStatement(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = postSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data: st } = await admin
    .from("fin_provider_statements")
    .select("status, prepared_by, figures_sha256")
    .eq("org_id", member.orgId)
    .eq("id", p.data.statement_id)
    .maybeSingle();
  if (!st || !["reviewed", "posted"].includes(st.status))
    return fail("Only a reviewed statement can be posted.");
  if (st.prepared_by === member.userId)
    return fail("You reviewed this statement; another person must post it.");
  if (st.figures_sha256 !== p.data.hash)
    return fail("The figures changed since you opened the page. Reload and check them again.");
  const { data, error } = await admin.rpc("fin_lab_post", {
    p_org_id: member.orgId,
    p_statement_id: p.data.statement_id,
    p_hash: p.data.hash,
    p_user: member.userId,
  });
  if (error)
    return fail(
      dbMessage(
        error,
        "Could not post. The month may be locked, or its revenue share already verified (return it to draft first).",
      ),
    );
  const counts = (data ?? {}) as { added?: number; removed?: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.posted",
    entity: "fin_provider_statements",
    entityId: p.data.statement_id,
    diff: { sha256: p.data.hash, added: counts.added ?? 0, removed: counts.removed ?? 0 },
  });
  refresh(p.data.statement_id);
  revalidatePath("/finance/revenue-share/charges");
  return { ok: true, message: `Posted: ${counts.added ?? 0} doctor charge(s).` };
}

/** Returns a reviewed or posted statement to open; a posted statement's charges are removed with it. */
export async function reopenStatement(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = statementOnly.safeParse(values);
  if (!p.success) return fail("Choose a statement.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_lab_reopen", {
    p_org_id: member.orgId,
    p_statement_id: p.data.statement_id,
  });
  if (error)
    return fail(
      dbMessage(
        error,
        "Could not reopen. The month may be locked, or its revenue share already verified.",
      ),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.labs.reopened",
    entity: "fin_provider_statements",
    entityId: p.data.statement_id,
  });
  refresh(p.data.statement_id);
  revalidatePath("/finance/revenue-share/charges");
  return { ok: true, message: "Reopened." };
}
