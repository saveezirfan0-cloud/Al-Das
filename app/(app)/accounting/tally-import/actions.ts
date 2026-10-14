"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import {
  commitTallyStep,
  MAX_TALLY_FILES,
  stageTallyFiles,
  TALLY_BUCKET,
  TallyCommitError,
  type CommitProgress,
} from "@/lib/accounting/tally/import-server";
import type { TallyPlanReport } from "@/lib/accounting/tally/plan";
import { MAX_TALLY_BYTES, TallyParseError } from "@/lib/accounting/tally/xml";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  optionalDate,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Tally import (Phase 22I), accounting.import. The XML files go from the browser to a private bucket by signed URL, are
 * read once here and ALWAYS deleted afterwards; only their sha256 and the sanitised staged rows are kept. The dry run
 * creates nothing in the ledger. The commit is idempotent and runs in steps the page repeats until nothing is left.
 * Every step is audited with ids and counts only.
 */

const PERM = "accounting.import";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const refresh = () => {
  revalidatePath("/accounting/tally-import");
  revalidatePath("/accounting/tally-reconciliation");
};

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  size: z
    .number()
    .int()
    .positive()
    .max(MAX_TALLY_BYTES, "The file is larger than 200 MB. Export it in parts."),
});

/** A signed upload URL so the browser sends the XML file straight to private storage. */
export async function createTallyUpload(
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = uploadSchema.safeParse(input);
  if (!p.success) return fail(firstIssue(p.error, "Invalid file."));
  if (!/\.xml$/i.test(p.data.filename)) return fail("Upload Tally's XML export (.xml).");
  const path = `${member.orgId}/tally/${randomUUID()}.xml`;
  const { data, error } = await createAdminClient()
    .storage.from(TALLY_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) return fail("Could not prepare the upload.");
  return { ok: true, data: { path: data.path, token: data.token } };
}

const stageSchema = z.object({
  paths: z.array(z.string()).min(1).max(MAX_TALLY_FILES),
  opening_date: optionalDate.default(""),
  force: z.boolean().default(false),
});

export type StageOutcome =
  | { kind: "duplicate"; committedAt: string | null }
  | { kind: "staged"; importId: string; report: TallyPlanReport };

/** Reads the uploaded files, runs the dry run and stores it. The files are deleted whatever happens. */
export async function stageTallyImport(
  input: z.input<typeof stageSchema>,
): Promise<ActionResult<StageOutcome>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = stageSchema.safeParse(input);
  const paths = Array.isArray(input?.paths) ? input.paths.filter((x) => typeof x === "string") : [];
  const own = paths.every((x) => x.startsWith(`${member.orgId}/tally/`) && !x.includes(".."));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  try {
    if (!p.success) return fail(firstIssue(p.error));
    if (!own) return fail("Invalid upload path.");
    const files: Array<{ bytes: Uint8Array }> = [];
    for (const path of p.data.paths) {
      const { data: blob, error } = await admin.storage.from(TALLY_BUCKET).download(path);
      if (error || !blob) return fail("An uploaded file could not be read. Try again.");
      if (blob.size > MAX_TALLY_BYTES)
        return fail("A file is larger than 200 MB. Export it in parts.");
      files.push({ bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    const out = await stageTallyFiles(admin, {
      orgId: member.orgId,
      userId: member.userId,
      files,
      openingDate: p.data.opening_date,
      force: p.data.force,
    });
    if (out.kind === "duplicate") return { ok: true, data: out };
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.tally_import.dry_run",
      entity: "acc_tally_imports",
      entityId: out.importId,
      diff: {
        files: files.length,
        forced: p.data.force,
        vouchers: out.report.counts.toPost,
        refused: out.report.counts.refused,
        blocking: out.report.blocking,
      },
    });
    refresh();
    return { ok: true, data: out };
  } catch (err) {
    if (err instanceof TallyParseError) return fail(err.message);
    console.error("[accounting] tally dry run failed", { error: redactText(err, 100) });
    return fail("The file could not be read. Check that it is Tally's XML export.");
  } finally {
    if (own && paths.length) await admin.storage.from(TALLY_BUCKET).remove(paths);
  }
}

const commitSchema = z.object({
  id: uuid,
  accept_refusals: z.boolean().default(false),
  confirm_links: z.boolean().default(false),
});

/** One step of the commit (masters and opening on the first, then vouchers); the page calls it until it is done. */
export async function commitTallyImport(
  input: z.input<typeof commitSchema>,
): Promise<ActionResult<CommitProgress>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = commitSchema.safeParse(input);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data: imp } = await admin
    .from("acc_tally_imports")
    .select("id, status, report, opening_date")
    .eq("org_id", member.orgId)
    .eq("id", p.data.id)
    .maybeSingle();
  if (!imp) return fail("Import not found.");
  if (imp.status !== "staged" && imp.status !== "committing")
    return fail("This import is already committed or discarded.");
  const report = imp.report as unknown as TallyPlanReport;
  if (imp.status === "staged") {
    if (report.blocking.length > 0)
      return fail(
        "The dry run found problems that stop the import. Fix them in Tally and export again.",
      );
    if (report.refusedTotal > 0 && !p.data.accept_refusals)
      return fail("Some vouchers are refused. Tick the box to import the rest without them.");
    if (report.ledgers.linkByName.length + report.groups.linked.length > 0 && !p.data.confirm_links)
      return fail("Confirm that the accounts with the same name may be linked.");
  }
  try {
    const progress = await commitTallyStep(admin, {
      orgId: member.orgId,
      userId: member.userId,
      importId: imp.id,
      openingDate: imp.opening_date,
      status: imp.status,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action:
        progress.status === "committed"
          ? "accounting.tally_import.committed"
          : "accounting.tally_import.step",
      entity: "acc_tally_imports",
      entityId: imp.id,
      diff: {
        posted: progress.posted,
        unchanged: progress.unchanged,
        older: progress.older,
        refused: progress.refused,
        remaining: progress.remaining,
        masters: progress.masters ?? null,
        opening: progress.opening
          ? { posted: progress.opening.posted, lines: progress.opening.lines }
          : null,
      },
    });
    refresh();
    revalidatePath("/accounting/journals");
    revalidatePath("/accounting/accounts");
    return { ok: true, data: progress };
  } catch (err) {
    if (err instanceof TallyCommitError)
      return fail(rpcErrorMessage(err.rpc, "The import could not continue."));
    console.error("[accounting] tally commit failed", { error: redactText(err, 100) });
    return fail("The import could not continue. Try again; nothing is posted twice.");
  }
}

/** Throws a dry run away (only before the commit started): its staged rows are deleted. */
export async function discardTallyImport(id: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("acc_tally_imports")
    .update({ status: "discarded" })
    .eq("org_id", member.orgId)
    .eq("id", id)
    .eq("status", "staged")
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("Only a dry run that was not committed can be discarded.");
  await admin.from("acc_tally_staged").delete().eq("import_id", id).eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.tally_import.discarded",
    entity: "acc_tally_imports",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Dry run discarded." };
}
