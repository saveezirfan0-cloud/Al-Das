import { NextResponse } from "next/server";

import { loadLedger } from "@/lib/accounting/accounting-server";
import { rangeProblem, type LedgerData, type LedgerLine } from "@/lib/accounting/reports";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tableWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import { EXPORT_MAX_ROWS, truncatedLine } from "@/lib/finance/list-exports";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/accounting/ledger/export?account=<id>&from&to -> one account's general ledger (opening balance, every posted
 * line with its running balance, closing balance) as Excel, read in pages of 1,000 lines through acc_ledger. Needs
 * accounting.ledger.view. Audited and written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "accounting.ledger.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const accountId = sp.get("account") ?? "";
  const from = (sp.get("from") ?? "").slice(0, 10);
  const to = (sp.get("to") ?? "").slice(0, 10);
  if (!UUID.test(accountId) || rangeProblem(from, to))
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  let head: LedgerData | null = null;
  const res = await fetchAll<LedgerLine>(
    async (a, b) => {
      const page = await loadLedger(admin, member.orgId, accountId, from, to, b - a + 1, a);
      if (!page) return { data: null, error: { message: "ledger failed" } };
      head ??= page;
      return { data: page.lines, error: null };
    },
    { max: EXPORT_MAX_ROWS },
  );
  const ledger = head as LedgerData | null;
  if (res.error || !ledger) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await tableWorkbook({
    org: member.org.name,
    builtAt: new Date().toISOString(),
    sheet: "General ledger",
    title: `General ledger: ${ledger.account.code} ${ledger.account.name}, ${from} to ${to}`,
    lines: truncatedLine(res.truncated),
    columns: [
      { header: "Date", kind: "date" },
      { header: "Number", width: 16 },
      { header: "Type", width: 12 },
      { header: "Narration", width: 44 },
      { header: "Line description", width: 30 },
      { header: "Account", width: 28 },
      { header: "Branch", width: 8 },
      { header: "Status", width: 10 },
      { header: "Debit", kind: "money" },
      { header: "Credit", kind: "money" },
      { header: "Balance", kind: "money" },
    ],
    rows: [
      [from, "", "", "Opening balance", "", "", "", "", null, null, Number(ledger.opening)],
      ...res.data.map((l) => [
        l.date,
        l.number,
        l.voucher_type,
        l.narration,
        l.description,
        ledger.account.is_group ? `${l.account_code} ${l.account_name}` : "",
        l.branch_code,
        l.status,
        Number(l.debit) || null,
        Number(l.credit) || null,
        Number(l.balance),
      ]),
    ],
    totals: [
      to,
      "",
      "",
      "Closing balance",
      "",
      "",
      "",
      "",
      Number(ledger.period_debit),
      Number(ledger.period_credit),
      Number(ledger.closing),
    ],
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.ledger.exported",
    entity: "acc_accounts",
    entityId: accountId,
    diff: { from, to, rows: res.data.length, truncated: res.truncated },
  });
  await recordExport(admin, member, {
    dataset: "accounting:general_ledger",
    rows: res.data.length,
    format: "xlsx",
  });
  return new NextResponse(
    new Uint8Array(body),
    xlsxResponseInit(`ledger-${ledger.account.code}-${from}-${to}`),
  );
}
