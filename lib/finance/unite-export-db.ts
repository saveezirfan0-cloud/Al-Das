import "server-only";

import { dbProcessDeps } from "@/lib/finance/db";
import { processBatch } from "@/lib/finance/process-batch";
import type { ExportDeps } from "@/lib/finance/unite-export-server";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/** Supabase-backed dependencies for storeAndProcessUniteExport (service role, after the caller's can() check). */
export function dbUniteExportDeps(admin: AdminClient, orgId: string): ExportDeps {
  const process = dbProcessDeps(admin);
  return {
    findBySha: async (sha) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .select("id, process_status")
        .eq("org_id", orgId)
        .eq("source", "file")
        .eq("payload_sha256", sha)
        .maybeSingle();
      if (error) throw new Error(`look up batch: ${error.message}`);
      return data ? { id: data.id, processStatus: data.process_status } : null;
    },
    insertRaw: async (row) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .insert({ ...row, org_id: orgId, payload: row.payload as Json })
        .select("id")
        .single();
      if (error) throw new Error(`insert raw batch: ${error.message}`);
      return data.id;
    },
    processBatch: (id) => processBatch(process, id),
  };
}
