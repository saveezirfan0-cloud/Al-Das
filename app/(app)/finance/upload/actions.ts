"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { runRulesForOrg } from "@/lib/finance/rules-db";
import { dbDiligenceStore } from "@/lib/finance/diligence-db";
import {
  buildPreview,
  commitImport,
  discardImport,
  stageDiligenceUpload,
  type Preview,
} from "@/lib/finance/diligence-service";
import type { HeaderReport, ParseStats, ValidationError } from "@/lib/finance/parse-diligence";
import { createAdminClient } from "@/lib/supabase/admin";

const FINANCE_BUCKET = "finance-files";
const PERM = "finance.claims.import";
const MAX_BYTES = 25 * 1024 * 1024;

export type ActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

export type ProcessOutcome =
  | { kind: "duplicate"; fileId: string; committedAt: string }
  | {
      kind: "rejected";
      fileId: string;
      errors: ValidationError[];
      totalErrors: number;
      header: HeaderReport;
    }
  | { kind: "staged"; fileId: string; preview: Preview };

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(MAX_BYTES, "The file is larger than 25 MB."),
});

/** Signed upload URL so the browser uploads straight to Storage (no Vercel body limit). */
export async function createDiligenceUpload(
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string }>> {
  const member = await requirePerm(PERM);
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid file." };
  if (!/\.xlsx$/i.test(parsed.data.filename))
    return { ok: false, error: "Upload the .xlsx file from Diligence." };
  const path = `${member.orgId}/diligence/${randomUUID()}.xlsx`;
  const { data, error } = await createAdminClient()
    .storage.from(FINANCE_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data)
    return { ok: false, error: `Could not prepare the upload: ${error?.message ?? "unknown"}` };
  return { ok: true, data: { path: data.path, token: data.token } };
}

/**
 * Parse, validate and stage the uploaded file. The original file is deleted from Storage in every
 * case (it contains patient names and Emirates IDs); only sanitised rows are kept.
 */
export async function processDiligenceUpload(input: {
  path: string;
  filename: string;
}): Promise<ActionResult<ProcessOutcome>> {
  const member = await requirePerm(PERM);
  if (!input.path.startsWith(`${member.orgId}/diligence/`))
    return { ok: false, error: "Invalid upload path." };
  const admin = createAdminClient();
  try {
    const { data: blob, error } = await admin.storage.from(FINANCE_BUCKET).download(input.path);
    if (error || !blob)
      return { ok: false, error: "The uploaded file could not be read. Try again." };
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.length > MAX_BYTES) return { ok: false, error: "The file is larger than 25 MB." };

    const store = dbDiligenceStore(admin);
    const out = await stageDiligenceUpload(store, {
      orgId: member.orgId,
      userId: member.userId,
      fileName: input.filename.slice(0, 200),
      storagePath: input.path,
      buffer,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.diligence.uploaded",
      entity: "fin_raw_diligence_files",
      entityId: out.fileId,
      diff: { outcome: out.status },
    });
    revalidatePath("/finance/upload");
    if (out.status === "duplicate")
      return {
        ok: true,
        data: { kind: "duplicate", fileId: out.fileId, committedAt: out.committedAt },
      };
    if (out.status === "rejected")
      return {
        ok: true,
        data: {
          kind: "rejected",
          fileId: out.fileId,
          errors: out.errors,
          totalErrors: out.totalErrors,
          header: out.header,
        },
      };
    const preview = await buildPreview(store, member.orgId, out.fileId);
    if (!preview) return { ok: false, error: "Could not build the preview." };
    return { ok: true, data: { kind: "staged", fileId: out.fileId, preview } };
  } catch (err) {
    console.error("[finance] diligence upload failed", { name: (err as Error).name });
    return {
      ok: false,
      error: "The file could not be processed. Check that it is the Diligence claims report.",
    };
  } finally {
    await admin.storage.from(FINANCE_BUCKET).remove([input.path]);
  }
}

export async function getImportPreview(fileId: string): Promise<ActionResult<Preview>> {
  const member = await requirePerm(PERM);
  if (!z.string().uuid().safeParse(fileId).success) return { ok: false, error: "Invalid file." };
  const preview = await buildPreview(dbDiligenceStore(createAdminClient()), member.orgId, fileId);
  return preview ? { ok: true, data: preview } : { ok: false, error: "File not found." };
}

export async function commitDiligenceImport(input: {
  fileId: string;
  raiseMissing: boolean;
}): Promise<ActionResult<Record<string, number>>> {
  const member = await requirePerm(PERM);
  if (!z.string().uuid().safeParse(input.fileId).success)
    return { ok: false, error: "Invalid file." };
  const admin = createAdminClient();
  try {
    const res = await commitImport(dbDiligenceStore(admin), {
      orgId: member.orgId,
      userId: member.userId,
      fileId: input.fileId,
      raiseMissing: input.raiseMissing,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.diligence.committed",
      entity: "fin_raw_diligence_files",
      entityId: input.fileId,
      diff: { ...res.summary, matched_changed: res.matched.changed },
    });
    // fresh claim data changes what the rules see; a failure here must not undo the import
    await runRulesForOrg(admin, member.orgId).catch((err) =>
      console.error("[finance] rules after import failed", { name: (err as Error).name }),
    );
    revalidatePath("/finance/upload");
    revalidatePath("/finance/claims");
    revalidatePath("/finance/exceptions");
    return {
      ok: true,
      message: "Import committed.",
      data: {
        ...res.summary,
        matched_examined: res.matched.examined,
        matched_changed: res.matched.changed,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not commit the import.",
    };
  }
}

export async function discardDiligenceImport(fileId: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!z.string().uuid().safeParse(fileId).success) return { ok: false, error: "Invalid file." };
  const admin = createAdminClient();
  await discardImport(dbDiligenceStore(admin), member.orgId, fileId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.diligence.discarded",
    entity: "fin_raw_diligence_files",
    entityId: fileId,
  });
  revalidatePath("/finance/upload");
  return { ok: true, message: "Import discarded.", data: undefined };
}

export type { HeaderReport, ParseStats };
