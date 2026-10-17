"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, type ActionResult } from "@/lib/finance/action-support";
import { MAX_APPOINTMENT_BYTES } from "@/lib/finance/appointment-mapping";
import {
  importAppointmentFile,
  safeImportMessage,
  type ImportSummary,
} from "@/lib/finance/appointment-billing-server";
import { readImportFile } from "@/lib/finance/parse-import";
import { previewAppointmentTable } from "@/lib/finance/parse-appointments";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UploadPreview } from "@/lib/upload/preview";

/**
 * W2: the Unite appointment export upload. Needs finance.revenue.import (the Unite collection report's own key). The file
 * is read once and never kept: only its sha256 and the sanitised rows of the mapped columns are stored (no name, date of
 * birth, Emirates ID, phone or member id field exists to map). The write uses the service role after the check and is
 * audited with counts and dates only.
 */

async function gate() {
  const member = await requireMember();
  return can(member, "finance.revenue.import") ? member : null;
}

function fileOf(fd: FormData): File | { error: string } {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };
  if (file.size > MAX_APPOINTMENT_BYTES)
    return { error: "The file is larger than 10 MB. Export one month at a time." };
  if (!/\.(csv|xlsx)$/i.test(file.name)) return { error: "Upload a .csv or .xlsx file." };
  return file;
}

/** The first rows of the columns that will be read, the names of the columns that will be ignored, and what is missing. */
export async function previewAppointmentFile(fd: FormData): Promise<ActionResult<UploadPreview>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const file = fileOf(fd);
  if ("error" in file) return fail(file.error);
  try {
    return {
      ok: true,
      data: previewAppointmentTable(await readImportFile(Buffer.from(await file.arrayBuffer()))),
    };
  } catch {
    return fail("The file could not be read. Save it as .csv or .xlsx and try again.");
  }
}

export async function importAppointmentUpload(fd: FormData): Promise<ActionResult<ImportSummary>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const file = fileOf(fd);
  if ("error" in file) return fail(file.error);
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  try {
    const out = await importAppointmentFile(admin, {
      orgId: member.orgId,
      userId: member.userId,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    if (!out.ok) {
      const head = out.missing.length ? `Missing: ${out.missing.join("; ")}. ` : "";
      const tail = out.unrecognised.length
        ? ` Columns not recognised: ${out.unrecognised.join(", ")}.`
        : "";
      return fail(`Nothing was imported. ${head}${out.errors.join(" ")}${tail}`.trim());
    }
    const s = out.summary;
    if (!s.existing)
      await recordAudit(admin, {
        orgId: member.orgId,
        userId: member.userId,
        action: "finance.appointments.imported",
        entity: "fin_appt_uploads",
        entityId: s.uploadId,
        diff: {
          from_date: s.fromDate,
          to_date: s.toDate,
          rows: s.rows,
          superseded: s.superseded,
          skipped: s.skipped,
        },
      });
    revalidatePath("/finance/appointment-billing");
    return {
      ok: true,
      message: s.existing
        ? "This exact file was imported before. Nothing was changed."
        : `Imported ${s.rows} appointment(s)${s.superseded ? `, replacing ${s.superseded} from earlier files` : ""}.`,
      data: s,
    };
  } catch (err) {
    console.error("[finance] appointment import failed", { error: redactText(err, 100) });
    return fail(safeImportMessage(err));
  }
}
