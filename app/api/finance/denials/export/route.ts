import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tableWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import { todayIn } from "@/lib/finance/action-support";
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  type CaseStatus,
  type DenialCategory,
} from "@/lib/finance/denials";
import {
  ACTIVE_DENIAL_STATUSES,
  EXPORT_MAX_ROWS,
  parseDenialFilters,
  truncatedLine,
} from "@/lib/finance/list-exports";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/finance/denials/export?<the list's filters> -> the denial cases as Excel, every matching case (paged). Needs
 * finance.denials.manage (the list's own key); read with the member's own client (RLS). Claim and invoice numbers, codes,
 * payers, amounts, deadlines and the owner's name: no patient identity. Audited and logged.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "finance.denials.manage"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const f = parseDenialFilters(Object.fromEntries(new URL(req.url).searchParams));
  const supabase = await createClient(); // the member's own client: RLS decides, as on the page
  const settings = await loadFinanceSettings(supabase, member.orgId);
  const today = todayIn(member.org.timezone);
  const warnBy = new Date(Date.parse(`${today}T00:00:00Z`) + settings.denialWarnDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const res = await fetchAll(
    (from, to) => {
      let q = supabase
        .from("ins_denial_cases")
        .select(
          "id, claim_number, invoice_no, cpt_code, payer_id, reason_code, category, rejected_amount, status, denied_on, deadline_on, owner_user_id",
        )
        .order("deadline_on", { ascending: true })
        .order("id")
        .range(from, to);
      if (f.status === "active") q = q.in("status", [...ACTIVE_DENIAL_STATUSES]);
      else if (f.status !== "all") q = q.eq("status", f.status);
      if (f.payer) q = q.eq("payer_id", f.payer);
      if (f.q)
        q = q.or(
          `claim_number.ilike.%${f.q}%,invoice_no.ilike.%${f.q}%,reason_code.ilike.%${f.q}%`,
        );
      if (f.mine) q = q.eq("owner_user_id", member.userId);
      if (f.due) q = q.lte("deadline_on", warnBy).in("status", ["open", "in_progress"]);
      return q;
    },
    { max: EXPORT_MAX_ROWS },
  );
  if (res.error) return NextResponse.json({ error: "query failed" }, { status: 500 });
  const rows = res.data;
  const owners = [...new Set(rows.map((r) => r.owner_user_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  for (let i = 0; i < owners.length; i += 200) {
    const { data } = await supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", owners.slice(i, i + 200));
    for (const p of data ?? []) names.set(p.id, `${p.first_name} ${p.last_name}`.trim() || "-");
  }
  const filters = [
    f.status === "active"
      ? "active cases"
      : f.status === "all"
        ? "every status"
        : `status ${f.status}`,
    f.payer && `payer ${f.payer}`,
    f.q && `search ${f.q}`,
    f.mine && "mine",
    f.due && "deadline soon",
  ].filter(Boolean);
  const body = await tableWorkbook({
    org: member.org.name,
    builtAt: new Date().toISOString(),
    sheet: "Denials",
    title: "Denial cases",
    lines: [`Filters: ${filters.join(", ")}`, ...truncatedLine(res.truncated)],
    columns: [
      { header: "Claim", width: 20 },
      { header: "Invoice", width: 16 },
      { header: "CPT", width: 10 },
      { header: "Payer", width: 12 },
      { header: "Reason code", width: 12 },
      { header: "Category", width: 18 },
      { header: "Rejected", kind: "money" },
      { header: "Status", width: 14 },
      { header: "Denied on", kind: "date" },
      { header: "Deadline", kind: "date" },
      { header: "Owner", width: 22 },
    ],
    rows: rows.map((r) => [
      r.claim_number,
      r.invoice_no,
      r.cpt_code,
      r.payer_id,
      r.reason_code,
      CATEGORY_LABELS[r.category as DenialCategory] ?? r.category,
      r.rejected_amount,
      STATUS_LABELS[r.status as CaseStatus] ?? r.status,
      r.denied_on,
      r.deadline_on,
      r.owner_user_id ? (names.get(r.owner_user_id) ?? "-") : "",
    ]),
  });
  const admin = createAdminClient(); // audit and export log only
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.denials.exported",
    entity: "ins_denial_cases",
    diff: { status: f.status, rows: rows.length, truncated: res.truncated },
  });
  await recordExport(admin, member, {
    dataset: "finance:denials",
    rows: rows.length,
    format: "xlsx",
  });
  return new NextResponse(new Uint8Array(body), xlsxResponseInit("finance-denials"));
}
