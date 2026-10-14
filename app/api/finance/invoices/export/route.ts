import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tableWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import {
  claimProgress,
  CLAIM_PROGRESS_LABEL,
  filterProblem,
  parseInvoiceFilters,
} from "@/lib/finance/invoice-list";
import { EXPORT_MAX_ROWS, truncatedLine } from "@/lib/finance/list-exports";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/finance/invoices/export?<the list's filters> -> the Finance invoices list as Excel, every matching row (paged).
 * Needs finance.invoices.view; read with the member's own client like the page (RLS on v_fin_invoice_list). Invoice
 * numbers, dates, doctors, types and amounts: no patient identity. Audited and written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.invoices.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const f = parseInvoiceFilters(Object.fromEntries(new URL(req.url).searchParams));
  if (filterProblem(f)) return NextResponse.json({ error: "bad range" }, { status: 400 });

  const supabase = await createClient(); // the member's own client: RLS decides, as on the page
  const res = await fetchAll(
    (from, to) => {
      let q = supabase
        .from("v_fin_invoice_list")
        .select(
          "id, inv_display_number, transaction_date, branch_code, doctor_name, doctor_dha_id, inv_type, is_deleted, net, total, version, claim_count, claimed, remitted, rejected, paid",
        )
        .order("transaction_date", { ascending: false, nullsFirst: false })
        .order("inv_display_number", { ascending: false })
        .order("id")
        .range(from, to);
      if (f.q) q = q.ilike("inv_display_number", `%${f.q}%`);
      if (f.from) q = q.gte("transaction_date", f.from);
      if (f.to) q = q.lte("transaction_date", f.to);
      if (f.branch) q = q.eq("branch_code", f.branch.toUpperCase());
      if (f.doctor) q = q.or(`doctor_name.ilike.%${f.doctor}%,doctor_dha_id.eq.${f.doctor}`);
      if (f.type) q = q.ilike("inv_type", `%${f.type}%`);
      return q;
    },
    { max: EXPORT_MAX_ROWS },
  );
  if (res.error) return NextResponse.json({ error: "query failed" }, { status: 500 });
  const rows = res.data;
  const filters = [
    f.q && `invoice ${f.q}`,
    f.from && `from ${f.from}`,
    f.to && `to ${f.to}`,
    f.branch && `branch ${f.branch.toUpperCase()}`,
    f.doctor && `doctor ${f.doctor}`,
    f.type && `type ${f.type}`,
  ].filter(Boolean);
  const body = await tableWorkbook({
    org: member.org.name,
    builtAt: new Date().toISOString(),
    sheet: "Invoices",
    title: "Finance invoices (from Unite)",
    lines: [
      filters.length ? `Filters: ${filters.join(", ")}` : "All invoices",
      ...truncatedLine(res.truncated),
    ],
    columns: [
      { header: "Invoice", width: 16 },
      { header: "Date", kind: "date" },
      { header: "Branch", width: 8 },
      { header: "Doctor", width: 28 },
      { header: "Doctor DHA ID", width: 14 },
      { header: "Type", width: 14 },
      { header: "Deleted in Unite", width: 10 },
      { header: "Version", kind: "number", width: 8 },
      { header: "Net", kind: "money" },
      { header: "Total", kind: "money" },
      { header: "Claims", kind: "number", width: 8 },
      { header: "Claimed", kind: "money" },
      { header: "Remitted", kind: "money" },
      { header: "Rejected", kind: "money" },
      { header: "Paid", kind: "money" },
      { header: "Claim progress", width: 16 },
    ],
    rows: rows.map((r) => [
      r.inv_display_number,
      r.transaction_date,
      r.branch_code,
      r.doctor_name,
      r.doctor_dha_id,
      r.inv_type,
      r.is_deleted ? "yes" : "",
      r.version,
      r.net,
      r.total,
      r.claim_count,
      r.claimed,
      r.remitted,
      r.rejected,
      r.paid,
      CLAIM_PROGRESS_LABEL[claimProgress(r)],
    ]),
  });
  const admin = createAdminClient(); // audit and export log only
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.invoices.exported",
    entity: "fin_invoices",
    diff: { filters: filters.length, rows: rows.length, truncated: res.truncated },
  });
  await recordExport(admin, member, {
    dataset: "finance:invoices",
    rows: rows.length,
    format: "xlsx",
  });
  return new NextResponse(new Uint8Array(body), xlsxResponseInit("finance-invoices"));
}
