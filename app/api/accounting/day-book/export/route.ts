import { NextResponse } from "next/server";

import { loadAccounts, loadEntities } from "@/lib/accounting/accounting-server";
import {
  SOURCE_KIND_LABELS,
  VOUCHER_TYPE_LABELS,
  type SourceKind,
  type VoucherType,
} from "@/lib/accounting/journal";
import { rangeProblem } from "@/lib/accounting/reports";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tableWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import { EXPORT_MAX_ROWS, truncatedLine } from "@/lib/finance/list-exports";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * GET /api/accounting/day-book/export?from&to[&entity] -> every posted (and reversed) journal in the range with its lines,
 * as Excel: one row per line. Read in pages (the page itself shows at most 1,000 journals). Needs accounting.ledger.view.
 * Accounts, amounts, dates and dimensions only. Audited and written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "accounting.ledger.view"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const from = (sp.get("from") ?? "").slice(0, 10);
  const to = (sp.get("to") ?? "").slice(0, 10);
  if (rangeProblem(from, to)) return NextResponse.json({ error: "bad range" }, { status: 400 });

  const admin = createAdminClient(); // service role AFTER the permission check
  try {
    const [entities, accounts] = await Promise.all([
      loadEntities(admin, member.orgId),
      loadAccounts(admin, member.orgId),
    ]);
    const entity = entities.find((e) => e.id === sp.get("entity")) ?? null;
    const journals = await fetchAll(
      (a, b) => {
        let q = admin
          .from("acc_journals")
          .select(
            "id, number, journal_date, voucher_type, narration, status, source_kind, posted_at",
          )
          .eq("org_id", member.orgId)
          .in("status", ["posted", "reversed"])
          .gte("journal_date", from)
          .lte("journal_date", to);
        if (entity) q = q.eq("entity_id", entity.id);
        return q.order("id").range(a, b);
      },
      { max: EXPORT_MAX_ROWS },
    );
    if (journals.error) throw new Error("journals");
    const ids = journals.data.map((j) => j.id);
    const lines: Array<{
      journal_id: string;
      line_no: number;
      account_id: string;
      debit: number;
      credit: number;
      description: string | null;
      branch_code: string | null;
      department: string | null;
    }> = [];
    // the lines of these journals, a few hundred journal ids per request so the URL stays short
    for (let i = 0; i < ids.length && lines.length < EXPORT_MAX_ROWS * 4; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const res = await fetchAll((a, b) =>
        admin
          .from("acc_journal_lines")
          .select(
            "id, journal_id, line_no, account_id, debit, credit, description, branch_code, department",
          )
          .eq("org_id", member.orgId)
          .in("journal_id", chunk)
          .order("id")
          .range(a, b),
      );
      if (res.error) throw new Error("lines");
      lines.push(...res.data);
    }
    const acc = new Map(accounts.map((x) => [x.id, x]));
    const byJournal = new Map<string, typeof lines>();
    for (const l of lines) byJournal.set(l.journal_id, [...(byJournal.get(l.journal_id) ?? []), l]);
    const ordered = [...journals.data].sort(
      (x, y) =>
        x.journal_date.localeCompare(y.journal_date) ||
        (x.posted_at ?? "").localeCompare(y.posted_at ?? "") ||
        (x.number ?? "").localeCompare(y.number ?? ""),
    );
    const rows = ordered.flatMap((j) =>
      (byJournal.get(j.id) ?? [])
        .sort((x, y) => x.line_no - y.line_no)
        .map((l) => [
          j.journal_date,
          j.number,
          VOUCHER_TYPE_LABELS[j.voucher_type as VoucherType] ?? j.voucher_type,
          j.narration,
          j.status,
          j.source_kind
            ? (SOURCE_KIND_LABELS[j.source_kind as SourceKind] ?? j.source_kind)
            : "Manual",
          l.line_no,
          acc.get(l.account_id)?.code ?? "",
          acc.get(l.account_id)?.name ?? "",
          l.description,
          l.branch_code,
          l.department,
          Number(l.debit) || null,
          Number(l.credit) || null,
        ]),
    );
    const debit = lines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0) / 100;
    const credit = lines.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0) / 100;
    const body = await tableWorkbook({
      org: member.org.name,
      builtAt: new Date().toISOString(),
      sheet: "Day book",
      title: `Day book ${from} to ${to}`,
      lines: [
        ...(entities.length > 1 ? [`Entity: ${entity?.name ?? "All entities"}`] : []),
        ...truncatedLine(journals.truncated),
      ],
      columns: [
        { header: "Date", kind: "date" },
        { header: "Number", width: 16 },
        { header: "Type", width: 12 },
        { header: "Narration", width: 44 },
        { header: "Status", width: 10 },
        { header: "Source", width: 18 },
        { header: "Line", kind: "number", width: 6 },
        { header: "Account code", width: 12 },
        { header: "Account", width: 32 },
        { header: "Line description", width: 30 },
        { header: "Branch", width: 8 },
        { header: "Department", width: 16 },
        { header: "Debit", kind: "money" },
        { header: "Credit", kind: "money" },
      ],
      rows,
      totals: ["", "", "", "Total", "", "", null, "", "", "", "", "", debit, credit],
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.day_book.exported",
      entity: "acc_journals",
      diff: { from, to, entity: entity?.id ?? null, journals: ordered.length, lines: rows.length },
    });
    await recordExport(admin, member, {
      dataset: "accounting:day_book",
      rows: rows.length,
      format: "xlsx",
    });
    return new NextResponse(new Uint8Array(body), xlsxResponseInit(`day-book-${from}-${to}`));
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
