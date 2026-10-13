import "server-only";

import {
  isProviderKind,
  reconcileStatement,
  type AllocationBasis,
  type LabSettings,
  type Provider,
  type ProviderLine,
  type ProviderTest,
  type StatementResult,
  type UniteLine,
} from "@/lib/finance/labs";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Loads one provider statement's inputs with the service role (callers have run can() first) and computes it with the
 * pure rules in labs.ts. Nothing here decides; it only moves data.
 */

const PAGE = 1000;

async function all<T>(
  fetch: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { code?: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetch(from, from + PAGE - 1);
    if (error) throw new Error(`labs load: ${error.code ?? "unknown"}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

/** The lab thresholds. A missing settings row is created with the table's own defaults (never defaults from code). */
export async function loadLabSettings(admin: AdminClient, orgId: string): Promise<LabSettings> {
  const read = () =>
    admin
      .from("fin_ref_finance_settings")
      .select("lab_date_window_days, lab_price_tolerance")
      .eq("org_id", orgId)
      .maybeSingle();
  let { data } = await read();
  if (!data) {
    await admin
      .from("fin_ref_finance_settings")
      .upsert({ org_id: orgId }, { onConflict: "org_id", ignoreDuplicates: true });
    data = (await read()).data;
  }
  if (!data) throw new Error("lab settings missing");
  return {
    windowDays: Number(data.lab_date_window_days),
    priceTolerance: Number(data.lab_price_tolerance),
  };
}

export async function loadProviderTests(
  admin: AdminClient,
  orgId: string,
  providerId: string,
): Promise<ProviderTest[]> {
  const rows = await all((from, to) =>
    admin
      .from("fin_ref_provider_tests")
      .select("code, expected_days, agreed_price")
      .eq("org_id", orgId)
      .eq("provider_id", providerId)
      .order("code")
      .range(from, to),
  );
  return rows.map((t) => ({
    code: t.code,
    expectedDays: t.expected_days,
    agreedPrice: t.agreed_price === null ? null : Number(t.agreed_price),
  }));
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export type LoadedStatement = {
  statement: {
    id: string;
    provider_id: string;
    month: string;
    status: string;
    figures: unknown;
    figures_sha256: string | null;
    prepared_by: string | null;
    prepared_at: string | null;
    posted_by: string | null;
    posted_at: string | null;
  };
  provider: Provider & { name: string };
  files: Array<{
    id: string;
    kind: string;
    file_name: string | null;
    row_count: number;
    total_amount: number;
    first_date: string | null;
    last_date: string | null;
    imported_at: string;
  }>;
  tests: ProviderTest[];
  settings: LabSettings;
  result: StatementResult;
};

/** One statement with everything the page and the actions need, computed now. */
export async function loadStatement(
  admin: AdminClient,
  orgId: string,
  statementId: string,
  today: string,
): Promise<LoadedStatement | null> {
  const { data: statement } = await admin
    .from("fin_provider_statements")
    .select(
      "id, provider_id, month, status, figures, figures_sha256, prepared_by, prepared_at, posted_by, posted_at",
    )
    .eq("org_id", orgId)
    .eq("id", statementId)
    .maybeSingle();
  if (!statement) return null;
  const { data: p } = await admin
    .from("fin_providers")
    .select("id, name, kind, fixed_monthly_fee, allocation_basis")
    .eq("org_id", orgId)
    .eq("id", statement.provider_id)
    .maybeSingle();
  if (!p || !isProviderKind(p.kind)) return null;
  const provider = {
    id: p.id,
    name: p.name,
    kind: p.kind,
    fixedFee: p.fixed_monthly_fee === null ? null : Number(p.fixed_monthly_fee),
    basis: p.allocation_basis as AllocationBasis,
  };

  const [files, lineRows, noteRows, tests, settings] = await Promise.all([
    admin
      .from("fin_provider_files")
      .select("id, kind, file_name, row_count, total_amount, first_date, last_date, imported_at")
      .eq("org_id", orgId)
      .eq("statement_id", statementId)
      .order("imported_at"),
    all((from, to) =>
      admin
        .from("fin_provider_lines")
        .select(
          "id, service_date, code, patient_pin, doctor_dha_id, branch_code, result_date, amount",
        )
        .eq("org_id", orgId)
        .eq("statement_id", statementId)
        .order("id")
        .range(from, to),
    ),
    all((from, to) =>
      admin
        .from("fin_provider_notes")
        .select("item_key, reason_code, note")
        .eq("org_id", orgId)
        .eq("statement_id", statementId)
        .order("item_key")
        .range(from, to),
    ),
    loadProviderTests(admin, orgId, provider.id),
    loadLabSettings(admin, orgId),
  ]);

  const lines: ProviderLine[] = lineRows.map((l) => ({
    id: l.id,
    serviceDate: l.service_date,
    code: l.code,
    pin: l.patient_pin,
    doctor: l.doctor_dha_id,
    branch: l.branch_code,
    resultDate: l.result_date,
    amount: l.amount === null ? null : Number(l.amount),
  }));

  // the Unite lines that can matter: the statement's codes and the provider's tests, around the month and the file dates
  const codes = [...new Set([...lines.map((l) => l.code), ...tests.map((t) => t.code)])];
  const dates = lines.map((l) => l.serviceDate).sort();
  const first = dates[0] && dates[0] < statement.month ? dates[0] : statement.month;
  const end = monthEnd(statement.month);
  const last = dates.at(-1) && dates.at(-1)! > end ? dates.at(-1)! : end;
  let unite: UniteLine[] = [];
  if (codes.length > 0) {
    const { data, error } = await admin.rpc("fin_lab_unite_lines", {
      p_org_id: orgId,
      p_from: addDays(first, -settings.windowDays),
      p_to: addDays(last, settings.windowDays),
      p_codes: codes,
    });
    if (error) throw new Error(`labs load: ${error.code ?? "unknown"}`);
    unite = ((data ?? []) as Array<Record<string, unknown>>).map((u) => ({
      id: String(u.id),
      invoiceId: String(u.invoice_id),
      pin: (u.pin as string | null) ?? null,
      date: String(u.date),
      itemCode: (u.item_code as string | null) ?? null,
      lineCpt: (u.line_cpt as string | null) ?? null,
      refCpt: (u.ref_cpt as string | null) ?? null,
      net: Number(u.net ?? 0),
      branch: (u.branch as string | null) ?? null,
      doctor: (u.doctor as string | null) ?? null,
    }));
  }

  const result = reconcileStatement({
    provider,
    month: statement.month,
    lines,
    unite,
    tests,
    notes: noteRows.map((n) => ({ itemKey: n.item_key, code: n.reason_code, note: n.note })),
    settings,
    today,
  });
  return {
    statement,
    provider,
    files: (files.data ?? []).map((f) => ({ ...f, total_amount: Number(f.total_amount) })),
    tests,
    settings,
    result,
  };
}
