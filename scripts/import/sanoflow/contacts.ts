/**
 * Sanoflow contact CSV export → contacts. Idempotent: rows are matched by the Sanoflow contact id
 * (external_refs source='sanoflow'), then by E.164 phone, then by external id (Unite PIN).
 * Used by `pnpm import:sanoflow` (contacts only) and `pnpm import:sanoflow:all`.
 */
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { prepareImport } from "@/lib/contacts/import";
import {
  findExternalRef,
  matchContact,
  queueSyncReview,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";
import type { ParsedCsv } from "@/lib/csv";
import type { AdminClient } from "@/lib/supabase/admin";

import { findSanoflowIdHeader, sanoflowMapping } from "../mappers/sanoflow.contacts";
import { newRun, problem, type EntityRun } from "./run";

export type ContactImportResult = {
  run: EntityRun;
  mapping: Record<string, string | null>;
  idHeader: string | null;
};

export async function runSanoflowContacts(
  admin: AdminClient,
  orgId: string,
  csv: ParsedCsv,
  opts: {
    file: string;
    dryRun: boolean;
    mode: "update" | "skip";
    customFields: CustomFieldDef[];
    map?: Record<string, string | null>;
    onProgress?: (written: number) => void;
  },
): Promise<ContactImportResult> {
  const run = newRun("contact", "Contacts", opts.file);
  const c = run.counters;
  const mapping = opts.map ?? sanoflowMapping(csv.headers, opts.customFields);
  const idHeader = findSanoflowIdHeader(csv.headers);
  const idIndex = idHeader ? csv.headers.indexOf(idHeader) : -1;
  run.unknownHeaders = Object.entries(mapping)
    .filter(([h, f]) => !f && h !== idHeader && h.trim())
    .map(([h]) => h);

  const { rows, summary } = prepareImport(csv.headers, csv.rows, {
    mapping,
    customFields: opts.customFields,
    requirePhone: true,
  });
  c.read = rows.length;
  c.invalid = summary.invalid;
  c.duplicates = summary.duplicates;
  const batch = `sanoflow-${Date.now().toString(36)}`;
  const tagIds = new Map<string, string>();
  {
    const { data: tags } = await admin
      .from("tags")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("scope", "contact");
    for (const t of tags ?? []) tagIds.set(t.name.toLowerCase(), t.id);
  }

  for (const row of rows) {
    if (row.status !== "ok") {
      problem(
        run,
        row.line,
        row.status === "duplicate" ? `duplicate of line ${row.duplicateOf}` : row.errors.join("; "),
      );
      continue;
    }
    const sanoId = idIndex >= 0 ? (csv.rows[row.line - 1]?.[idIndex] ?? "").trim() : "";
    row.contact.source = "import_sanoflow";

    let existingId: string | null = null;
    let existingCustom: Record<string, unknown> | null = null;
    const ref = sanoId
      ? await findExternalRef(admin, {
          orgId,
          source: "sanoflow",
          entity: "contact",
          externalId: sanoId,
        })
      : null;
    if (ref) {
      const { data } = await admin
        .from("contacts")
        .select("id, custom")
        .eq("id", ref.localId)
        .is("deleted_at", null)
        .maybeSingle();
      if (data) {
        existingId = data.id;
        existingCustom = (data.custom as Record<string, unknown>) ?? {};
      }
    }
    if (!existingId) {
      const m = await matchContact(admin, orgId, {
        externalId: row.contact.external_id,
        phone: row.contact.phone_e164,
      });
      if (m.kind === "ambiguous") {
        c.review++;
        const { data: prior } = sanoId
          ? await admin
              .from("sync_reviews")
              .select("status")
              .eq("org_id", orgId)
              .eq("source", "sanoflow")
              .eq("entity", "contact")
              .eq("external_id", sanoId)
              .maybeSingle()
          : { data: null };
        // a person dismissed it in Portal → Sync review: never reopen it
        if (!opts.dryRun && sanoId && prior?.status !== "dismissed")
          await queueSyncReview(admin, {
            orgId,
            source: "sanoflow",
            entity: "contact",
            externalId: sanoId,
            reason: "multiple_matches",
            candidates: m.candidates,
          });
        problem(run, row.line, "ambiguous_match");
        continue;
      }
      if (m.kind === "match") {
        existingId = m.id;
        existingCustom = m.custom;
      }
    }
    if (existingId && opts.mode === "skip") {
      c.skipped++;
      continue;
    }
    const res = await writePreparedContact(admin, {
      orgId,
      existingId,
      existingCustom,
      contact: row.contact,
      defaultSource: "import_sanoflow",
      customFields: opts.customFields,
      tagIds,
      actorId: null,
      batch,
      dryRun: opts.dryRun,
    });
    if (!res.ok) {
      c.failed++;
      problem(run, row.line, res.error);
      continue;
    }
    if (res.created) c.created++;
    else c.updated++;
    if (!opts.dryRun && sanoId)
      await upsertExternalRef(admin, {
        orgId,
        source: "sanoflow",
        entity: "contact",
        externalId: sanoId,
        localTable: "contacts",
        localId: res.id,
      });
    if (c.created + c.updated > 0 && (c.created + c.updated) % 500 === 0)
      opts.onProgress?.(c.created + c.updated);
  }
  if (!idHeader) run.notes.push("no Sanoflow id column: contacts matched by phone only");
  return { run, mapping, idHeader };
}
