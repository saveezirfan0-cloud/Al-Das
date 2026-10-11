import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import type { ReadinessInput } from "./readiness";

export type Freshness = ReadinessInput & { openExceptions: number; lastCaptureAt: string | null };

/** Reads v_fin_data_freshness through the member's own client (RLS / permission-gated). */
export async function loadFreshness(supabase: SupabaseClient<Database>): Promise<Freshness | null> {
  const { data } = await supabase.from("v_fin_data_freshness").select("*").limit(1).maybeSingle();
  if (!data) return null;
  return {
    credentialsConfigured: !!data.credentials_configured,
    captureEnabled: !!data.capture_enabled,
    batchCount: Number(data.batch_count ?? 0),
    invoiceCount: Number(data.invoice_count ?? 0),
    claimCount: Number(data.claim_count ?? 0),
    branchesMapped: Number(data.branches_mapped ?? 0),
    activeRules: Number(data.active_rules ?? 0),
    lastImportAt: data.last_import_at ?? null,
    openExceptions: Number(data.open_exceptions ?? 0),
    lastCaptureAt: data.last_capture_at ?? null,
  };
}
