import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

import {
  addMonths,
  depreciationForecast,
  monthStart,
  type DepreciationMethod,
} from "./depreciation";
import {
  registerAt,
  scheduleStatus,
  type Register,
  type RegisterAsset,
  type ScheduleRow,
  type ScheduleStatusRow,
} from "./register";
import {
  planDepreciationRun,
  planScheduleRun,
  runPayload,
  type AssetStatus,
  type PlanAsset,
  type PlanSchedule,
  type PostedLine,
  type RunKind,
  type RunStatus,
  type ScheduleStatus,
} from "./runs";
import type { ScheduleKind } from "./schedules";

/**
 * Server side of fixed assets and schedules (Phase 22H): loaders and the run preparation. Service role; every caller
 * has run can() first (or is the monthly job). The amounts come from the pure planners in runs.ts; the database derives
 * accounts and dimensions, hashes the lines and enforces the rules (acc_asset_run_prepare).
 */

export type AssetClassView = {
  id: string;
  code: string;
  name: string;
  method: DepreciationMethod;
  life_months: number;
  residual_pct: number;
  active: boolean;
  cost_account_id: string;
  accum_account_id: string;
  expense_account_id: string;
  disposal_account_id: string;
};

export async function loadAssetClasses(
  admin: AdminClient,
  orgId: string,
): Promise<AssetClassView[]> {
  const { data } = await admin
    .from("acc_asset_classes")
    .select(
      "id, code, name, method, life_months, residual_pct, active, cost_account_id, accum_account_id, expense_account_id, disposal_account_id",
    )
    .eq("org_id", orgId)
    .order("name");
  return (data ?? []).map((c) => ({
    ...c,
    method: c.method as DepreciationMethod,
    residual_pct: Number(c.residual_pct),
  }));
}

export type AssetView = RegisterAsset & {
  openingAccumulated: number;
  entityId: string;
  department: string | null;
  residual: number;
  lifeMonths: number;
  method: DepreciationMethod;
  supplierInvoiceId: string | null;
  disposalStatus: "prepared" | "posted" | "waiting_ledger_start" | null;
  disposalProceeds: number | null;
  disposalAccountId: string | null;
  disposalAccumulated: number | null;
  disposalSha256: string | null;
  disposalPreparedBy: string | null;
  disposalJournalId: string | null;
};

export async function loadAssets(admin: AdminClient, orgId: string): Promise<AssetView[]> {
  // Every asset (depreciation runs plan from this list), read in pages: PostgREST returns at most 1,000 per request.
  const { data } = await fetchAll((from, to) =>
    admin
      .from("acc_assets")
      .select(
        "id, entity_id, code, class_id, description, branch_code, department, acquisition_date, in_service_date, cost, residual, life_months, method, status, opening_accumulated, supplier_invoice_id, disposal_status, disposal_date, disposal_proceeds, disposal_account_id, disposal_accumulated, disposal_sha256, disposal_prepared_by, disposal_journal_id, acc_asset_classes(name)",
      )
      .eq("org_id", orgId)
      .order("code")
      .order("id")
      .range(from, to),
  );
  return (data ?? []).map((a) => ({
    id: a.id,
    entityId: a.entity_id,
    code: a.code,
    description: a.description,
    classId: a.class_id,
    className: a.acc_asset_classes?.name ?? "",
    branchCode: a.branch_code,
    department: a.department,
    acquisitionDate: a.acquisition_date,
    inServiceDate: a.in_service_date,
    cost: Number(a.cost),
    residual: Number(a.residual),
    lifeMonths: a.life_months,
    method: a.method as DepreciationMethod,
    status: a.status as AssetStatus,
    openingAccumulated: Number(a.opening_accumulated),
    supplierInvoiceId: a.supplier_invoice_id,
    disposalStatus: a.disposal_status as AssetView["disposalStatus"],
    disposalDate: a.disposal_date,
    disposalProceeds: a.disposal_proceeds === null ? null : Number(a.disposal_proceeds),
    disposalAccountId: a.disposal_account_id,
    disposalAccumulated: a.disposal_accumulated === null ? null : Number(a.disposal_accumulated),
    disposalSha256: a.disposal_sha256,
    disposalPreparedBy: a.disposal_prepared_by,
    disposalJournalId: a.disposal_journal_id,
  }));
}

export type ScheduleView = ScheduleRow & {
  entityId: string;
  plAccountId: string;
  bsAccountId: string;
  department: string | null;
  supplierInvoiceId: string | null;
};

export async function loadSchedules(admin: AdminClient, orgId: string): Promise<ScheduleView[]> {
  // Every schedule, read in pages (PostgREST returns at most 1,000 per request).
  const { data } = await fetchAll((from, to) =>
    admin
      .from("acc_schedules")
      .select(
        "id, entity_id, kind, description, pl_account_id, bs_account_id, total, start_month, months, branch_code, department, auto_reverse, status, supplier_invoice_id",
      )
      .eq("org_id", orgId)
      .order("start_month", { ascending: false })
      .order("id")
      .range(from, to),
  );
  return (data ?? []).map((s) => ({
    id: s.id,
    entityId: s.entity_id,
    kind: s.kind as ScheduleKind,
    description: s.description,
    plAccountId: s.pl_account_id,
    bsAccountId: s.bs_account_id,
    total: Number(s.total),
    startMonth: s.start_month,
    months: s.months,
    branchCode: s.branch_code,
    department: s.department,
    autoReverse: s.auto_reverse,
    status: s.status as ScheduleStatus,
    supplierInvoiceId: s.supplier_invoice_id,
  }));
}

export type RunView = {
  id: string;
  entityId: string;
  kind: RunKind;
  periodMonth: string;
  version: number;
  status: RunStatus;
  total: number;
  lineCount: number;
  sha256: string;
  preparedBy: string | null;
  preparedAt: string;
  postedBy: string | null;
  postedAt: string | null;
  postedVersion: number | null;
  journalId: string | null;
};

export async function loadRuns(
  admin: AdminClient,
  orgId: string,
  kinds: readonly RunKind[],
  limit = 60,
): Promise<RunView[]> {
  const { data } = await admin
    .from("acc_depreciation_runs")
    .select(
      "id, entity_id, kind, period_month, version, status, total, line_count, sha256, prepared_by, prepared_at, posted_by, posted_at, posted_version, journal_id",
    )
    .eq("org_id", orgId)
    .in("kind", [...kinds])
    .order("period_month", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    kind: r.kind as RunKind,
    periodMonth: r.period_month,
    version: r.version,
    status: r.status as RunStatus,
    total: Number(r.total),
    lineCount: r.line_count,
    sha256: r.sha256,
    preparedBy: r.prepared_by,
    preparedAt: r.prepared_at,
    postedBy: r.posted_by,
    postedAt: r.posted_at,
    postedVersion: r.posted_version,
    journalId: r.journal_id,
  }));
}

/** The lines of one run version (for the preview), with the asset or schedule they belong to. */
export async function loadRunLines(
  admin: AdminClient,
  orgId: string,
  runId: string,
  version: number,
) {
  const { data } = await fetchAll((from, to) =>
    admin
      .from("acc_asset_run_lines")
      .select("id, asset_id, schedule_id, branch_code, amount, debit_account_id, credit_account_id")
      .eq("org_id", orgId)
      .eq("run_id", runId)
      .eq("version", version)
      .order("id")
      .range(from, to),
  );
  return (data ?? []).map((l) => ({ ...l, amount: Number(l.amount) }));
}

/**
 * The lines of the POSTED version of every run, as { ref (asset or schedule id), month, amount }: the books' per-asset
 * accumulated depreciation and per-schedule releases. `entityId` and `kinds` narrow it.
 */
export async function loadPostedLines(
  admin: AdminClient,
  orgId: string,
  opts: { entityId?: string; kinds: readonly RunKind[] },
): Promise<PostedLine[]> {
  // Accumulated depreciation is summed from these, so runs and lines are read in pages (PostgREST returns at most
  // 1,000 rows per request).
  const { data: runs } = await fetchAll((from, to) => {
    let q = admin
      .from("acc_depreciation_runs")
      .select("id, period_month, posted_version")
      .eq("org_id", orgId)
      .in("kind", [...opts.kinds])
      .not("posted_version", "is", null);
    if (opts.entityId) q = q.eq("entity_id", opts.entityId);
    return q.order("id").range(from, to);
  });
  const out: PostedLine[] = [];
  const byRun = new Map((runs ?? []).map((r) => [r.id, r]));
  const ids = [...byRun.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const { data: lines } = await fetchAll(
      (from, to) =>
        admin
          .from("acc_asset_run_lines")
          .select("run_id, version, asset_id, schedule_id, amount")
          .eq("org_id", orgId)
          .in("run_id", part)
          .order("id")
          .range(from, to),
      { max: 1_000_000 },
    );
    for (const l of lines ?? []) {
      const r = byRun.get(l.run_id);
      if (!r || l.version !== r.posted_version) continue;
      out.push({
        ref: (l.asset_id ?? l.schedule_id)!,
        month: r.period_month,
        amount: Number(l.amount),
      });
    }
  }
  return out;
}

export type PrepareResult = {
  id: string;
  version: number;
  status: RunStatus;
  sha256: string;
  total: number;
  lines: number;
  changed: boolean;
};

/**
 * Plans and saves one month's run for an entity (a draft; it never posts). `userId` null = the monthly job. An empty run
 * is still saved for a person (it reverses a previous version when posted). Throws the database error (with its HINT)
 * when the database refuses.
 */
export async function prepareRun(
  admin: AdminClient,
  input: {
    orgId: string;
    entityId: string;
    kind: RunKind;
    month: string;
    userId: string | null;
    /** The job: do not create a run with nothing in it (returns null). */
    skipEmpty?: boolean;
  },
): Promise<PrepareResult | null> {
  const month = monthStart(input.month);
  if (!month) throw new Error("invalid month");
  const posted = await loadPostedLines(admin, input.orgId, {
    entityId: input.entityId,
    kinds: [input.kind],
  });
  let payload: ReturnType<typeof runPayload>;
  if (input.kind === "depreciation") {
    const assets: PlanAsset[] = (await loadAssets(admin, input.orgId))
      .filter((a) => a.entityId === input.entityId)
      .map((a) => ({
        id: a.id,
        status: a.status,
        cost: a.cost,
        residual: a.residual,
        lifeMonths: a.lifeMonths,
        method: a.method,
        inServiceDate: a.inServiceDate,
        openingAccumulated: a.openingAccumulated,
      }));
    payload = runPayload("depreciation", planDepreciationRun({ month, assets, posted }));
  } else {
    const schedules: PlanSchedule[] = (await loadSchedules(admin, input.orgId))
      .filter((s) => s.entityId === input.entityId)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        autoReverse: s.autoReverse,
        status: s.status,
        total: s.total,
        months: s.months,
        startMonth: s.startMonth,
      }));
    payload = runPayload(
      input.kind,
      planScheduleRun({ kind: input.kind, month, schedules, posted }),
    );
  }
  if (input.skipEmpty && payload.length === 0) return null;
  const { data, error } = await admin.rpc("acc_asset_run_prepare", {
    p_org_id: input.orgId,
    p_entity_id: input.entityId,
    p_kind: input.kind,
    p_month: month,
    p_user_id: input.userId as string,
    p_lines: payload,
  });
  if (error) throw error;
  return data as unknown as PrepareResult;
}

export type AssetReport = {
  asOf: string;
  register: Register;
  forecastFrom: string;
  forecast: Array<{ month: string; amount: number }>;
  schedules: ScheduleStatusRow[];
};

/**
 * The register at a date (books: posted runs only), the 12-month forecast from the month after the latest posted
 * depreciation month (or this month when nothing is posted yet) and the schedule status.
 */
export async function loadAssetReport(
  admin: AdminClient,
  orgId: string,
  asOf: string,
  today: string,
): Promise<AssetReport> {
  const [assets, schedules, depLines, schedLines] = await Promise.all([
    loadAssets(admin, orgId),
    loadSchedules(admin, orgId),
    loadPostedLines(admin, orgId, { kinds: ["depreciation"] }),
    loadPostedLines(admin, orgId, { kinds: ["schedules", "reversing_accruals"] }),
  ]);
  const register = registerAt(assets, depLines, asOf);
  const latest = depLines.reduce<string | null>(
    (m, l) => (m === null || l.month > m ? l.month : m),
    null,
  );
  const forecastFrom = latest ? addMonths(latest, 1) : monthStart(today)!;
  const accum = new Map<string, number>();
  for (const l of depLines) accum.set(l.ref, (accum.get(l.ref) ?? 0) + l.amount);
  const forecast = depreciationForecast(
    assets
      .filter((a) => a.status !== "disposed")
      .map((a) => ({ ...a, postedAccumulated: a.openingAccumulated + (accum.get(a.id) ?? 0) })),
    forecastFrom,
    12,
  );
  return {
    asOf,
    register,
    forecastFrom,
    forecast,
    schedules: scheduleStatus(schedules, schedLines),
  };
}

export type InvoiceOption = {
  id: string;
  label: string;
  invoiceDate: string;
  net: number;
  branchCode: string | null;
  capitalised: number;
};

/** Recent 20D supplier invoices (bills) an asset or schedule may link to, with what is already capitalised. */
export async function loadInvoiceOptions(
  admin: AdminClient,
  orgId: string,
): Promise<InvoiceOption[]> {
  const [{ data }, { data: used }] = await Promise.all([
    admin
      .from("fin_supplier_invoices")
      .select("id, invoice_number, invoice_date, net, branch_code, status, fin_suppliers(name)")
      .eq("org_id", orgId)
      .neq("status", "void")
      .order("invoice_date", { ascending: false })
      .limit(200),
    // Summed per invoice, so every linked asset is read in pages (PostgREST returns at most 1,000 per request).
    fetchAll((from, to) =>
      admin
        .from("acc_assets")
        .select("supplier_invoice_id, cost")
        .eq("org_id", orgId)
        .not("supplier_invoice_id", "is", null)
        .order("id")
        .range(from, to),
    ),
  ]);
  const cap = new Map<string, number>();
  for (const u of used ?? [])
    if (u.supplier_invoice_id)
      cap.set(u.supplier_invoice_id, (cap.get(u.supplier_invoice_id) ?? 0) + Number(u.cost));
  return (data ?? []).map((i) => ({
    id: i.id,
    label: `${i.fin_suppliers?.name ?? "Supplier"} ${i.invoice_number} (${i.invoice_date})`,
    invoiceDate: i.invoice_date,
    net: Number(i.net),
    branchCode: i.branch_code,
    capitalised: Math.round((cap.get(i.id) ?? 0) * 100) / 100,
  }));
}

export async function loadBranchCodes(admin: AdminClient, orgId: string): Promise<string[]> {
  const { data } = await admin
    .from("acc_entity_branches")
    .select("branch_code")
    .eq("org_id", orgId)
    .order("branch_code");
  return (data ?? []).map((b) => b.branch_code);
}

export async function defaultEntityId(admin: AdminClient, orgId: string): Promise<string | null> {
  const { data } = await admin
    .from("acc_entities")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  return data?.id ?? null;
}
