import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

export type BatchRow = {
  id: string;
  requestedAt: string;
  fromDate: string;
  toDate: string;
  httpStatus: number | null;
  messageStatus: string | null;
  recordCount: number | null;
  balanceInRange: number | null;
  processStatus: "received" | "processed" | "failed";
  error: string | null;
};

export type FinanceHealth = {
  captureEnabled: boolean;
  batchSize: number;
  windowFrom: string;
  lastBatch: BatchRow | null;
  /** DataBalancetoSync reported by the latest batch: records still waiting at Unite. */
  remainingBalance: number | null;
  batches: BatchRow[];
  pendingBatches: number;
  lastImport: { uploadedAt: string; status: string; rowCount: number | null } | null;
  unmappedServices: number;
  unknownClinicInvoices: number;
};

/**
 * Data-health numbers for /finance/health. Service-role reads, so the caller
 * MUST have checked can(member, 'finance.capture.manage'). The raw payload
 * column is deliberately never selected.
 */
export async function getFinanceHealth(admin: AdminClient, orgId: string): Promise<FinanceHealth> {
  const [settings, batches, pending, files, unmapped, unknown] = await Promise.all([
    admin.from("fin_capture_settings").select("*").eq("org_id", orgId).maybeSingle(),
    admin
      .from("fin_raw_unite_batches")
      .select(
        "id, requested_at, from_date, to_date, http_status, message_status, record_count, balance_in_range, process_status, error",
      )
      .eq("org_id", orgId)
      .order("requested_at", { ascending: false })
      .limit(25),
    admin
      .from("fin_raw_unite_batches")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .neq("process_status", "processed"),
    admin
      .from("fin_raw_diligence_files")
      .select("uploaded_at, status, row_count")
      .eq("org_id", orgId)
      .order("uploaded_at", { ascending: false })
      .limit(1),
    admin
      .from("fin_ref_services")
      .select("item_code", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("service_category", "Unmapped"),
    admin
      .from("fin_invoices")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .is("branch_code", null),
  ]);

  const rows: BatchRow[] = (batches.data ?? []).map((b) => ({
    id: b.id,
    requestedAt: b.requested_at,
    fromDate: b.from_date,
    toDate: b.to_date,
    httpStatus: b.http_status,
    messageStatus: b.message_status,
    recordCount: b.record_count,
    balanceInRange: b.balance_in_range,
    processStatus: b.process_status as BatchRow["processStatus"],
    error: b.error,
  }));
  const file = files.data?.[0];

  return {
    captureEnabled: settings.data?.enabled ?? false,
    batchSize: settings.data?.batch_size ?? 50,
    windowFrom: settings.data?.window_from ?? "2026-01-01",
    lastBatch: rows[0] ?? null,
    remainingBalance: rows[0]?.balanceInRange ?? null,
    batches: rows,
    pendingBatches: pending.count ?? 0,
    lastImport: file
      ? { uploadedAt: file.uploaded_at, status: file.status, rowCount: file.row_count }
      : null,
    unmappedServices: unmapped.count ?? 0,
    unknownClinicInvoices: unknown.count ?? 0,
  };
}
