import type { ProcessDeps } from "@/lib/finance/process-batch";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Supabase-backed dependencies of `processBatch`. Kept apart from lib/finance/db.ts (which is server-only) so the
 * command-line scripts (`finance:replay`) process a stored raw batch exactly as the app does.
 */

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export function dbProcessDeps(admin: AdminClient): ProcessDeps {
  return {
    loadBatch: async (batchId) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .select("id, org_id, payload, record_count")
        .eq("id", batchId)
        .maybeSingle();
      if (error) throw new Error(`load batch: ${error.message}`);
      return data
        ? { id: data.id, orgId: data.org_id, payload: data.payload, recordCount: data.record_count }
        : null;
    },
    apply: async (orgId, batchId, invoices, duplicates) => {
      const counts = must(
        await admin.rpc("fin_apply_invoices", {
          p_org_id: orgId,
          p_batch_id: batchId,
          p_invoices: invoices as unknown as Json,
          p_duplicates: duplicates,
        }),
        "fin_apply_invoices",
      );
      // Ordering / performing doctor, when Unite sent them: stored apart from the invoice doctor, never overwriting it.
      const roles = invoices
        .filter((i) => i.doctor_roles)
        .map((i) => ({ inv: i.inv_display_number, ...i.doctor_roles }));
      if (roles.length > 0) {
        must(
          await admin.rpc("fin_set_invoice_doctor_roles", {
            p_org_id: orgId,
            p_rows: roles as unknown as Json,
          }),
          "fin_set_invoice_doctor_roles",
        );
      }
      return (counts ?? {}) as Record<string, number>;
    },
    markFailed: async (batchId, error) => {
      must(
        await admin.rpc("fin_batch_mark_failed", { p_batch_id: batchId, p_error: error }),
        "fin_batch_mark_failed",
      );
    },
  };
}
