import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tableWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import { CLAIM_STATUS_LABELS } from "@/lib/finance/claim-status";
import { claimStatusesFor, loadClaimStatusSettings } from "@/lib/finance/claim-status-server";
import { EXPORT_MAX_ROWS, parseClaimFilters, truncatedLine } from "@/lib/finance/list-exports";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/finance/claims/export?<the list's filters> -> the Claims list (Diligence claim activities) as Excel, every
 * matching row (paged). Needs finance.claims.view; read with the member's own client like the page (RLS). Claim and
 * invoice numbers, codes, payers and amounts: the staged claims hold no names or ID numbers. Audited and logged.
 * The Status column is Pulse's one status per claim (claimStatus, docs/48), with the page's own loader.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.claims.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const f = parseClaimFilters(Object.fromEntries(new URL(req.url).searchParams));

  const supabase = await createClient(); // the member's own client: RLS decides, as on the page
  const res = await fetchAll(
    (from, to) => {
      let q = supabase
        .from("ins_claim_activities")
        .select(
          "id, claim_activity_number, invoice_no, transaction_date, cpt_code, payer_id, net, remitted, rejected, write_off, write_off_status, claim_status, resubmission_count, last_resubmission_date, last_remittance_date, denial_type, match_status, match_reason",
        )
        .order("transaction_date", { ascending: false, nullsFirst: false })
        .order("claim_activity_number")
        .order("id")
        .range(from, to);
      if (f.q) q = q.or(`claim_activity_number.ilike.%${f.q}%,invoice_no.ilike.%${f.q}%`);
      if (f.status) q = q.eq("claim_status", f.status);
      if (f.payer) q = q.eq("payer_id", f.payer);
      if (f.denial) q = q.eq("denial_type", f.denial);
      if (f.match) q = q.eq("match_status", f.match);
      return q;
    },
    { max: EXPORT_MAX_ROWS },
  );
  if (res.error) return NextResponse.json({ error: "query failed" }, { status: 500 });
  const admin = createAdminClient(); // status facts (after the key above), audit and export log
  const statusSettings = await loadClaimStatusSettings(admin, member);
  const statuses = await claimStatusesFor(admin, member, res.data, statusSettings);
  const rows = f.cstatus
    ? res.data.filter((r) => statuses.get(r.id)?.status === f.cstatus)
    : res.data;
  const filters = [
    f.q && `number ${f.q}`,
    f.status && `status ${f.status}`,
    f.payer && `payer ${f.payer}`,
    f.denial && `denial ${f.denial}`,
    f.match && `match ${f.match}`,
    f.cstatus && `status ${CLAIM_STATUS_LABELS[f.cstatus]}`,
  ].filter(Boolean);
  const body = await tableWorkbook({
    org: member.org.name,
    builtAt: new Date().toISOString(),
    sheet: "Claims",
    title: "Claim activities (Diligence)",
    lines: [
      filters.length ? `Filters: ${filters.join(", ")}` : "All claims",
      ...truncatedLine(res.truncated),
      ...(statusSettings.remittedNetsTakebacks === null
        ? [
            "Status: whether Diligence Remitted already deducts payments taken back is unconfirmed; Pulse deducts them itself.",
          ]
        : []),
    ],
    columns: [
      { header: "Claim activity", width: 20 },
      { header: "Invoice", width: 16 },
      { header: "Date", kind: "date" },
      { header: "CPT", width: 10 },
      { header: "Payer", width: 12 },
      { header: "Net", kind: "money" },
      { header: "Remitted", kind: "money" },
      { header: "Rejected", kind: "money" },
      { header: "Status", width: 18 },
      { header: "Still owed", kind: "money" },
      { header: "Diligence status", width: 16 },
      { header: "Denial type", width: 16 },
      { header: "Match", width: 12 },
      { header: "Match reason", width: 30 },
    ],
    rows: rows.map((r) => [
      r.claim_activity_number,
      r.invoice_no,
      r.transaction_date,
      r.cpt_code,
      r.payer_id,
      r.net,
      r.remitted,
      r.rejected,
      CLAIM_STATUS_LABELS[statuses.get(r.id)?.status ?? "unknown"],
      statuses.get(r.id)?.outstanding ?? null,
      r.claim_status,
      r.denial_type,
      r.match_status,
      r.match_reason,
    ]),
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.claims.exported",
    entity: "ins_claim_activities",
    diff: { filters: filters.length, rows: rows.length, truncated: res.truncated },
  });
  await recordExport(admin, member, {
    dataset: "finance:claims",
    rows: rows.length,
    format: "xlsx",
  });
  return new NextResponse(new Uint8Array(body), xlsxResponseInit("finance-claims"));
}
