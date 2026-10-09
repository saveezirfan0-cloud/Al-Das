import "server-only";

import { DILIGENCE_FIELD_NAMES } from "@/lib/finance/diligence-mapping";
import type { DiligenceStore, FileRow, FileStatus } from "@/lib/finance/diligence-service";
import type { InvoiceCandidate } from "@/lib/finance/match-claims";
import type { ClaimRow } from "@/lib/finance/parse-diligence";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, TablesUpdate } from "@/lib/supabase/types";

type J = NonNullable<Json>;

/** Supabase (service role) implementation of DiligenceStore. Callers must have checked can(). */

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const CLAIM_COLUMNS = [
  "claim_activity_number",
  ...DILIGENCE_FIELD_NAMES.filter((n) => n !== "claim_activity_number"),
].join(", ");
const PAGE = 1000;

export function dbDiligenceStore(admin: AdminClient): DiligenceStore {
  const toFileRow = (r: {
    id: string;
    status: string;
    uploaded_at: string;
    row_count: number | null;
  }): FileRow => ({
    id: r.id,
    status: r.status as FileStatus,
    uploadedAt: r.uploaded_at,
    rowCount: r.row_count,
  });

  return {
    async findFileBySha(orgId, sha) {
      const { data, error } = await admin
        .from("fin_raw_diligence_files")
        .select("id, status, uploaded_at, row_count")
        .eq("org_id", orgId)
        .eq("file_sha256", sha)
        .maybeSingle();
      if (error) throw new Error(`find file: ${error.message}`);
      return data ? toFileRow(data) : null;
    },

    async createFile(orgId, f) {
      // Created as 'rejected' (incomplete) and promoted to 'validated' only once staging is done.
      const { data, error } = await admin
        .from("fin_raw_diligence_files")
        .insert({
          org_id: orgId,
          storage_path: f.storagePath,
          file_name: f.fileName,
          file_sha256: f.sha,
          uploaded_by: f.userId,
          status: "rejected",
          errors: [{ row: null, code: "incomplete" }] as J,
        })
        .select("id")
        .single();
      if (error) throw new Error(`create file: ${error.message}`);
      return data.id;
    },

    async resetFile(orgId, fileId, f) {
      must(
        await admin
          .from("ins_staged_activities")
          .delete()
          .eq("file_id", fileId)
          .eq("org_id", orgId),
        "clear staging",
      );
      must(
        await admin
          .from("fin_raw_diligence_files")
          .update({
            status: "rejected",
            errors: [{ row: null, code: "incomplete" }] as J,
            header_check: {},
            storage_path: f.storagePath,
            file_name: f.fileName,
            uploaded_by: f.userId,
            uploaded_at: new Date().toISOString(),
          })
          .eq("id", fileId)
          .eq("org_id", orgId),
        "reset file",
      );
    },

    async updateFile(fileId, p) {
      const patch: TablesUpdate<"fin_raw_diligence_files"> = {};
      if (p.status !== undefined) patch.status = p.status;
      if (p.rowCount !== undefined) patch.row_count = p.rowCount;
      if (p.sumNet !== undefined) patch.sum_net = p.sumNet;
      if (p.sumRemitted !== undefined) patch.sum_remitted = p.sumRemitted;
      if (p.sumRejected !== undefined) patch.sum_rejected = p.sumRejected;
      if (p.headerCheck !== undefined) patch.header_check = p.headerCheck as J;
      if (p.errors !== undefined) patch.errors = p.errors as J;
      must(
        await admin.from("fin_raw_diligence_files").update(patch).eq("id", fileId),
        "update file",
      );
    },

    async stageRows(orgId, fileId, rows) {
      for (const part of chunk(rows, 500)) {
        must(
          await admin.from("ins_staged_activities").insert(
            part.map((r) => ({
              org_id: orgId,
              file_id: fileId,
              row_no: r.row_no,
              claim_activity_number: r.claim_activity_number,
              data: r.data as unknown as J,
            })),
          ),
          "stage rows",
        );
      }
    },

    async loadFile(orgId, fileId) {
      const { data, error } = await admin
        .from("fin_raw_diligence_files")
        .select(
          "id, status, uploaded_at, row_count, file_name, header_check, errors, sum_net, sum_remitted, sum_rejected",
        )
        .eq("id", fileId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new Error(`load file: ${error.message}`);
      return data
        ? {
            ...toFileRow(data),
            fileName: data.file_name,
            headerCheck: data.header_check,
            errors: data.errors,
            sumNet: data.sum_net,
            sumRemitted: data.sum_remitted,
            sumRejected: data.sum_rejected,
          }
        : null;
    },

    async loadStaged(orgId, fileId) {
      const rows: ClaimRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from("ins_staged_activities")
          .select("data")
          .eq("org_id", orgId)
          .eq("file_id", fileId)
          .order("row_no")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`load staged: ${error.message}`);
        rows.push(...(data ?? []).map((d) => d.data as unknown as ClaimRow));
        if (!data || data.length < PAGE) break;
      }
      return rows;
    },

    async existingClaims(orgId, numbers) {
      const map = new Map<string, Partial<ClaimRow>>();
      for (const part of chunk(numbers, 200)) {
        const { data, error } = await admin
          .from("ins_claim_activities")
          .select(CLAIM_COLUMNS)
          .eq("org_id", orgId)
          .in("claim_activity_number", part);
        if (error) throw new Error(`existing claims: ${error.message}`);
        for (const r of (data ?? []) as unknown as Array<
          Partial<ClaimRow> & { claim_activity_number: string }
        >)
          map.set(r.claim_activity_number, r);
      }
      return map;
    },

    async lastCommittedFile(orgId, excludeFileId) {
      const { data, error } = await admin
        .from("fin_raw_diligence_files")
        .select("id")
        .eq("org_id", orgId)
        .eq("status", "committed")
        .neq("id", excludeFileId)
        .order("committed_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`last committed file: ${error.message}`);
      return data?.[0] ?? null;
    },

    async claimNumbersSeenInFile(orgId, fileId) {
      const out: string[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from("ins_claim_activities")
          .select("claim_activity_number")
          .eq("org_id", orgId)
          .eq("last_seen_file_id", fileId)
          .order("claim_activity_number")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`claims in file: ${error.message}`);
        out.push(...(data ?? []).map((r) => r.claim_activity_number));
        if (!data || data.length < PAGE) break;
      }
      return out;
    },

    async openException(orgId, rule, entityType, key, detail) {
      must(
        await admin.rpc("fin_open_exception", {
          p_org_id: orgId,
          p_rule_code: rule,
          p_entity_type: entityType,
          p_entity_key: key,
          p_detail: detail as J,
        }),
        "open exception",
      );
    },

    async commit(a) {
      const res = must(
        await admin.rpc("ins_commit_import", {
          p_org_id: a.orgId,
          p_file_id: a.fileId,
          p_user_id: a.userId,
          p_rows: a.rows as unknown as J,
          p_events: a.events as unknown as J,
          p_seen: a.seen,
          p_missing: a.missing,
          p_raise_missing: a.raiseMissing,
        }),
        "commit import",
      );
      return (res ?? {}) as Record<string, number>;
    },

    async discard(orgId, fileId, reason) {
      must(
        await admin.rpc("ins_discard_import", {
          p_org_id: orgId,
          p_file_id: fileId,
          p_reason: reason,
        }),
        "discard import",
      );
    },

    async claimsForMatching(orgId, scope, afterId, limit) {
      let q = admin
        .from("ins_claim_activities")
        .select(
          "id, claim_activity_number, invoice_no, cpt_code, initial_net, net, quantity, clinician_id, activity_start_date",
        )
        .eq("org_id", orgId)
        .order("id")
        .limit(limit);
      q =
        scope.kind === "file"
          ? q.eq("last_seen_file_id", scope.fileId)
          : q.neq("match_status", "matched");
      if (afterId) q = q.gt("id", afterId);
      const { data, error } = await q;
      if (error) throw new Error(`claims for matching: ${error.message}`);
      return data ?? [];
    },

    async invoicesByKeys(orgId, keys) {
      const out: InvoiceCandidate[] = [];
      for (const part of chunk(keys, 100)) {
        const { data, error } = await admin
          .from("fin_invoices")
          .select(
            "id, inv_key, is_deleted, doctor_dha_id, fin_invoice_lines(id, position, item_code, cpt_code, qty, line_net, is_current)",
          )
          .eq("org_id", orgId)
          .in("inv_key", part);
        if (error) throw new Error(`invoices by keys: ${error.message}`);
        for (const inv of data ?? []) {
          out.push({
            id: inv.id,
            inv_key: inv.inv_key as string,
            is_deleted: inv.is_deleted,
            doctor_dha_id: inv.doctor_dha_id,
            lines: (inv.fin_invoice_lines ?? [])
              .filter((l) => l.is_current)
              .map((l) => ({
                id: l.id,
                position: l.position,
                item_code: l.item_code,
                cpt_code: l.cpt_code,
                qty: l.qty,
                line_net: l.line_net,
              })),
          });
        }
      }
      return out;
    },

    async applyMatches(orgId, matches) {
      let changed = 0;
      for (const part of chunk(matches, 1000)) {
        const n = must(
          await admin.rpc("ins_apply_matches", {
            p_org_id: orgId,
            p_matches: part as unknown as J,
          }),
          "apply matches",
        );
        changed += Number(n ?? 0);
      }
      return changed;
    },
  };
}
