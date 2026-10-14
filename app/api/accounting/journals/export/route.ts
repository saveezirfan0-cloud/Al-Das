import { NextResponse } from "next/server";

import { loadEntities } from "@/lib/accounting/accounting-server";
import {
  SOURCE_KIND_LABELS,
  VOUCHER_TYPE_LABELS,
  VOUCHER_TYPES,
  type SourceKind,
  type VoucherType,
} from "@/lib/accounting/journal";
import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { tableWorkbook, xlsxResponseInit } from "@/lib/export/table-xlsx";
import { EXPORT_MAX_ROWS, truncatedLine } from "@/lib/finance/list-exports";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

const READ = [
  "accounting.ledger.view",
  "accounting.journals.prepare",
  "accounting.journals.approve",
] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/accounting/journals/export?status&type&from&to -> the Journals list as Excel (every matching journal, paged; the
 * page shows the latest 300). Same keys as the page. Numbers, dates, types, narrations and totals: no patient identity in
 * the ledger. Audited and written to the export log.
 */
export async function GET(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canAny(member, READ)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const status = ["waiting", "draft", "posted", "reversed"].includes(sp.get("status") ?? "")
    ? (sp.get("status") as string)
    : null;
  const type = (VOUCHER_TYPES as readonly string[]).includes(sp.get("type") ?? "")
    ? (sp.get("type") as VoucherType)
    : null;
  const day = (k: string) => {
    const v = (sp.get(k) ?? "").slice(0, 10);
    return DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
  };
  const from = day("from");
  const to = day("to");

  const admin = createAdminClient(); // service role AFTER the permission check
  const [res, entities] = await Promise.all([
    fetchAll(
      (a, b) => {
        let q = admin
          .from("acc_journals")
          .select(
            "id, number, journal_date, voucher_type, narration, status, total, source_kind, entity_id, is_adjustment",
          )
          .eq("org_id", member.orgId);
        if (status === "waiting") q = q.eq("status", "draft").not("submitted_at", "is", null);
        else if (status) q = q.eq("status", status);
        if (type) q = q.eq("voucher_type", type);
        if (from) q = q.gte("journal_date", from);
        if (to) q = q.lte("journal_date", to);
        return q.order("journal_date", { ascending: false }).order("id").range(a, b);
      },
      { max: EXPORT_MAX_ROWS },
    ),
    loadEntities(admin, member.orgId),
  ]);
  if (res.error) return NextResponse.json({ error: "query failed" }, { status: 500 });
  const rows = res.data;
  const entityName = new Map(entities.map((e) => [e.id, e.name]));
  const filters = [
    status && `status ${status}`,
    type && `type ${VOUCHER_TYPE_LABELS[type]}`,
    from && `from ${from}`,
    to && `to ${to}`,
  ].filter(Boolean);
  const body = await tableWorkbook({
    org: member.org.name,
    builtAt: new Date().toISOString(),
    sheet: "Journals",
    title: "Journals",
    lines: [
      filters.length ? `Filters: ${filters.join(", ")}` : "All journals",
      ...truncatedLine(res.truncated),
    ],
    columns: [
      { header: "Number", width: 16 },
      { header: "Date", kind: "date" },
      { header: "Type", width: 14 },
      { header: "Narration", width: 48 },
      { header: "Status", width: 10 },
      { header: "Source", width: 20 },
      { header: "Adjustment period", width: 10 },
      ...(entities.length > 1 ? [{ header: "Entity", width: 22 }] : []),
      { header: "Total", kind: "money" as const },
    ],
    rows: rows.map((j) => [
      j.number ?? "draft",
      j.journal_date,
      VOUCHER_TYPE_LABELS[j.voucher_type as VoucherType] ?? j.voucher_type,
      j.narration,
      j.status,
      j.source_kind ? (SOURCE_KIND_LABELS[j.source_kind as SourceKind] ?? j.source_kind) : "Manual",
      j.is_adjustment ? "yes" : "",
      ...(entities.length > 1 ? [entityName.get(j.entity_id) ?? ""] : []),
      Number(j.total),
    ]),
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.journals.exported",
    entity: "acc_journals",
    diff: { status, type, from, to, rows: rows.length, truncated: res.truncated },
  });
  await recordExport(admin, member, {
    dataset: "accounting:journals",
    rows: rows.length,
    format: "xlsx",
  });
  return new NextResponse(new Uint8Array(body), xlsxResponseInit("journals"));
}
