import "server-only";

import { dbDiligenceStore } from "@/lib/finance/diligence-db";
import { matchClaimsForOrg } from "@/lib/finance/diligence-service";
import {
  runMaintenance,
  type MaintenanceDeps,
  type MaintenanceResult,
} from "@/lib/finance/maintenance";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export function dbMaintenanceDeps(admin: AdminClient, orgId: string): MaintenanceDeps {
  const store = dbDiligenceStore(admin);
  return {
    now: () => new Date(),
    eligibleBatches: async (cutoffIso, limit) => {
      const { data, error } = await admin
        .from("fin_raw_unite_batches")
        .select("id, payload")
        .eq("org_id", orgId)
        .eq("process_status", "processed")
        .is("payload_stripped_at", null)
        .not("payload", "is", null)
        .lt("processed_at", cutoffIso)
        .order("processed_at")
        .limit(limit);
      if (error) throw new Error(`eligible batches: ${error.message}`);
      return (data ?? []).map((b) => ({ id: b.id, payload: b.payload }));
    },
    saveStripped: async (id, payload) => {
      const { error } = await admin
        .from("fin_raw_unite_batches")
        .update({
          payload: payload as NonNullable<Json>,
          payload_stripped_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("org_id", orgId);
      if (error) throw new Error(`save stripped payload: ${error.message}`);
    },
    rematchUnresolved: async () =>
      (await matchClaimsForOrg(store, orgId, { kind: "unresolved" })).changed,
    purgeStaleStaging: async () => {
      const { data, error } = await admin.rpc("ins_purge_stale_staging");
      if (error) throw new Error(`purge staging: ${error.message}`);
      return Number(data ?? 0);
    },
  };
}

export const runMaintenanceForOrg = (
  admin: AdminClient,
  orgId: string,
): Promise<MaintenanceResult> => runMaintenance(dbMaintenanceDeps(admin, orgId));
