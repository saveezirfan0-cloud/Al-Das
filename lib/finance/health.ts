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
  maxBatchesPerRun: number;
  digestEnabled: boolean;
  /** Credentials metadata only; secrets never leave the server. */
  integration: {
    configured: boolean;
    status: string | null;
    tokenExpiresAt: string | null;
    lastError: string | null;
  };
  lastSuccessfulCaptureAt: string | null;
  /** True when the last batches returned records but the remaining balance did not drop. */
  balanceStalled: boolean;
  openCaptureExceptions: number;
  /** Share of invoices (last 60 days, after the first synced appointment) whose AppointmentId resolves. */
  appointmentResolution: { withId: number; resolved: number };
  openByRule: Record<string, number>;
  gaps: Array<{ series: string; missingFrom: number; missingTo: number; missingCount: number }>;
};

/** Balance is stalled when the last two non-empty batches did not lower it. */
export function isBalanceStalled(
  newestFirst: ReadonlyArray<{ recordCount: number | null; balanceInRange: number | null }>,
): boolean {
  const withData = newestFirst
    .filter((b) => (b.recordCount ?? 0) > 0 && b.balanceInRange !== null)
    .slice(0, 3);
  if (withData.length < 3) return false;
  const [a, b, c] = withData.map((x) => x.balanceInRange as number);
  return a >= b && b >= c;
}

/**
 * Data-health numbers for /finance/health. Service-role reads, so the caller
 * MUST have checked can(member, 'finance.capture.manage'). The raw payload
 * column is deliberately never selected.
 */
export async function getFinanceHealth(admin: AdminClient, orgId: string): Promise<FinanceHealth> {
  const [
    settings,
    batches,
    pending,
    files,
    unmapped,
    unknown,
    account,
    success,
    exceptions,
    gaps,
    resolution,
    openRules,
  ] = await Promise.all([
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
    admin
      .from("integration_accounts")
      .select("status, token_expires_at, last_error")
      .eq("org_id", orgId)
      .eq("kind", "unite")
      .maybeSingle(),
    admin
      .from("fin_raw_unite_batches")
      .select("processed_at")
      .eq("org_id", orgId)
      .eq("process_status", "processed")
      .order("processed_at", { ascending: false })
      .limit(1),
    admin
      .from("ops_exceptions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("rule_code", "E09")
      .in("status", ["open", "in_progress"]),
    admin.rpc("fin_invoice_number_gaps", { p_org_id: orgId, p_from: "2026-01-01" }),
    admin.rpc("fin_appointment_resolution", { p_org_id: orgId, p_days: 60 }),
    admin
      .from("ops_exceptions")
      .select("rule_code")
      .eq("org_id", orgId)
      .in("status", ["open", "in_progress"])
      .limit(20000),
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
    maxBatchesPerRun: settings.data?.max_batches_per_run ?? 1,
    digestEnabled: settings.data?.digest_enabled ?? false,
    integration: {
      configured: !!account.data,
      status: account.data?.status ?? null,
      tokenExpiresAt: account.data?.token_expires_at ?? null,
      lastError: account.data?.last_error ?? null,
    },
    lastSuccessfulCaptureAt: success.data?.[0]?.processed_at ?? null,
    balanceStalled: isBalanceStalled(rows),
    openCaptureExceptions: exceptions.count ?? 0,
    appointmentResolution: {
      withId: Number(resolution.data?.[0]?.with_id ?? 0),
      resolved: Number(resolution.data?.[0]?.resolved ?? 0),
    },
    openByRule: (openRules.data ?? []).reduce<Record<string, number>>((acc, e) => {
      acc[e.rule_code] = (acc[e.rule_code] ?? 0) + 1;
      return acc;
    }, {}),
    gaps: (gaps.data ?? []).slice(0, 100).map((g) => ({
      series: g.series,
      missingFrom: Number(g.missing_from),
      missingTo: Number(g.missing_to),
      missingCount: Number(g.missing_count),
    })),
  };
}
