"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { branchAllowed } from "@/lib/branches/guard";
import type { PreparedContact } from "@/lib/contacts/import";
import {
  matchContact,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";
import { loadCustomFields } from "@/lib/contacts/server";
import {
  ENQUIRY_IMPORT_FIELDS,
  MAX_IMPORT_ROWS,
  mappingProblem,
  prepareEnquiryImport,
  type EnquiryImportField,
  type PreparedEnquiryRow,
} from "@/lib/enquiries/csv-import";
import { loadPipelines } from "@/lib/enquiries/server";
import { createEnquiry } from "@/lib/enquiries/service";
import type { AdminClient } from "@/lib/supabase/admin";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Enquiries CSV import (Phase F). The browser reads the file and sends its cells; the server prepares every row again
 * (lib/enquiries/csv-import.ts), so nothing the browser decided is trusted. Idempotent: each row's natural key is hashed
 * with the organisation into external_refs (source 'csv', entity 'enquiry'), and a row whose key is already there is
 * skipped. Rows are written through the enquiry service (its own history, audit and events); the import itself is
 * audited per chunk with counts only. No cell value is ever logged or echoed back in an error.
 */

export type ImportResult<T> = { ok: true; data: T } | { ok: false; error: string };

const CSV_SOURCE = "csv";
const CSV_ENTITY = "enquiry";
const CHUNK_MAX = 100;

const fieldKeys = ENQUIRY_IMPORT_FIELDS.map((f) => f.key) as [
  EnquiryImportField,
  ...EnquiryImportField[],
];

const fileSchema = z.object({
  headers: z.array(z.string().max(200)).min(1).max(100),
  rows: z
    .array(z.array(z.string().max(2000)).max(100))
    .min(1)
    .max(MAX_IMPORT_ROWS),
  mapping: z.record(z.string().max(200), z.enum(fieldKeys).nullable()),
  pipeline_id: z.string().uuid(),
});

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The key stored in external_refs: a SHA-256 of the organisation and the natural key (no phone in clear). */
function refKey(orgId: string, key: string): string {
  return createHash("sha256").update(`${orgId}|${key}`).digest("hex");
}

async function prepare(
  admin: AdminClient,
  member: CurrentMember,
  input: z.infer<typeof fileSchema>,
) {
  const [pipelines, { data: locations }] = await Promise.all([
    loadPipelines(admin, member.orgId),
    admin.from("locations").select("id, name").eq("org_id", member.orgId).eq("active", true),
  ]);
  const live = pipelines.filter((p) => !p.archived);
  const prepared = prepareEnquiryImport(input.headers, input.rows, {
    mapping: input.mapping,
    pipelines: live.map((p) => ({
      id: p.id,
      name: p.name,
      stages: p.stages.map((s) => ({ id: s.id, name: s.name })),
    })),
    defaultPipelineId: input.pipeline_id,
    branches: locations ?? [],
  });
  // Phase B: a branch the member does not work in is refused per row.
  for (const r of prepared.rows) {
    if (
      r.status !== "invalid" &&
      r.enquiry?.locationId &&
      !branchAllowed(member, r.enquiry.locationId)
    ) {
      r.status = "invalid";
      r.errors = ["That branch is one you do not work in."];
      r.enquiry = null;
    }
  }
  return prepared.rows;
}

/** Which of these keys were imported before (external_refs lookup in batches). */
async function existingKeys(
  admin: AdminClient,
  orgId: string,
  keys: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const { data } = await admin
      .from("external_refs")
      .select("external_id")
      .eq("org_id", orgId)
      .eq("source", CSV_SOURCE)
      .eq("entity", CSV_ENTITY)
      .in("external_id", slice);
    for (const r of data ?? []) found.add(r.external_id);
  }
  return found;
}

export type PreviewRow = {
  line: number;
  status: "ok" | "invalid" | "duplicate" | "exists";
  errors: string[];
  duplicateOf?: number;
};

export type PreviewSummary = {
  total: number;
  ok: number;
  invalid: number;
  duplicates: number;
  exists: number;
};

/** Dry run: every row's outcome without writing anything. */
export async function previewEnquiryImport(
  input: z.input<typeof fileSchema>,
): Promise<ImportResult<{ rows: PreviewRow[]; summary: PreviewSummary }>> {
  const member = await requirePerm("enquiries.manage");
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success)
    return fail(`The file must have a header row and at most ${MAX_IMPORT_ROWS} rows.`);
  const problem = mappingProblem(parsed.data.mapping);
  if (problem) return fail(problem);
  const admin = createAdminClient();
  const rows = await prepare(admin, member, parsed.data);
  const keyed = rows.filter((r) => r.key && r.status !== "invalid");
  const done = await existingKeys(
    admin,
    member.orgId,
    keyed.map((r) => refKey(member.orgId, r.key!)),
  );
  const out: PreviewRow[] = rows.map((r) => ({
    line: r.line,
    status:
      r.status === "ok" && r.key && done.has(refKey(member.orgId, r.key)) ? "exists" : r.status,
    errors: r.errors,
    duplicateOf: r.duplicateOf,
  }));
  return {
    ok: true,
    data: {
      rows: out,
      summary: {
        total: out.length,
        ok: out.filter((r) => r.status === "ok").length,
        invalid: out.filter((r) => r.status === "invalid").length,
        duplicates: out.filter((r) => r.status === "duplicate").length,
        exists: out.filter((r) => r.status === "exists").length,
      },
    },
  };
}

const chunkSchema = fileSchema.extend({
  batch_id: z.string().regex(/^csv-[a-z0-9]{4,20}$/),
  offset: z.number().int().min(0).max(MAX_IMPORT_ROWS),
  limit: z.number().int().min(1).max(CHUNK_MAX),
});

export type ImportChunkCounts = {
  created: number;
  skipped: number;
  failed: number;
  contactsCreated: number;
};

function contactFor(e: NonNullable<PreparedEnquiryRow["enquiry"]>): PreparedContact {
  return {
    first_name: e.firstName,
    last_name: e.lastName,
    phone_e164: e.phone,
    alternate_phones: [],
    email: e.email,
    gender: null,
    nationality: null,
    country: null,
    language: null,
    dob: null,
    label: null,
    external_id: null,
    promotions_opt_in: null,
    stop_marketing: null,
    tags: [],
    source: e.source,
    note: null,
    custom: {},
  };
}

/**
 * Writes rows [offset, offset + limit) of the file. Re-running a chunk, or the whole file, creates nothing twice: the
 * external_refs key is checked before each write and recorded after it.
 */
export async function runEnquiryImportChunk(
  input: z.input<typeof chunkSchema>,
): Promise<ImportResult<ImportChunkCounts>> {
  const member = await requirePerm("enquiries.manage");
  const parsed = chunkSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid import request.");
  const problem = mappingProblem(parsed.data.mapping);
  if (problem) return fail(problem);
  const canLink = can(member, "contacts.view");
  const canCreateContacts = can(member, "contacts.manage");
  // History (record_history) names the person who imported.
  const admin = createAdminClient(member.userId);
  const all = await prepare(admin, member, parsed.data);
  const rows = all.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);
  const counts: ImportChunkCounts = { created: 0, skipped: 0, failed: 0, contactsCreated: 0 };
  const customFields = await loadCustomFields(admin, member.orgId);
  const tagIds = new Map<string, string>();
  const ctx = { admin, orgId: member.orgId, userId: member.userId };

  for (const r of rows) {
    if (r.status !== "ok" || !r.enquiry || !r.key) {
      if (r.status === "duplicate") counts.skipped++;
      else counts.failed++;
      continue;
    }
    const e = r.enquiry;
    const key = refKey(member.orgId, r.key);
    if ((await existingKeys(admin, member.orgId, [key])).size) {
      counts.skipped++;
      continue;
    }
    let contactId: string | null = null;
    if (e.phone && canLink) {
      const m = await matchContact(admin, member.orgId, {
        phone: e.phone,
        fullName: `${e.firstName} ${e.lastName}`.trim() || null,
      });
      if (m.kind === "ambiguous") {
        counts.failed++;
        continue;
      }
      if (m.kind === "match") contactId = m.id;
      else if (canCreateContacts) {
        const w = await writePreparedContact(admin, {
          orgId: member.orgId,
          existingId: null,
          contact: contactFor(e),
          defaultSource: "import_csv",
          customFields,
          tagIds,
          actorId: member.userId,
          batch: parsed.data.batch_id,
        });
        if (!w.ok) {
          counts.failed++;
          continue;
        }
        contactId = w.id;
        counts.contactsCreated++;
      }
    }
    try {
      const created = await createEnquiry(ctx, {
        title: e.title,
        pipelineId: e.pipelineId,
        stageId: e.stageId,
        contactId,
        source: e.source ?? "import_csv",
        estValue: e.estValue,
        locationId: e.locationId,
        apptDate: e.apptDate,
      });
      await upsertExternalRef(admin, {
        orgId: member.orgId,
        source: CSV_SOURCE,
        entity: CSV_ENTITY,
        externalId: key,
        localTable: "enquiries",
        localId: created.id,
        meta: { batch: parsed.data.batch_id },
      });
      counts.created++;
    } catch {
      // Counted, never logged per row (the enquiry service logs its own database error codes).
      counts.failed++;
    }
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "enquiry.imported",
    entity: "enquiry",
    entityId: parsed.data.batch_id,
    diff: { rows: rows.length, ...counts, offset: parsed.data.offset },
  });
  revalidatePath("/enquiries");
  return { ok: true, data: counts };
}
