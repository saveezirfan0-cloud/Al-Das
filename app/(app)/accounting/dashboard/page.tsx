import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadEntities } from "@/lib/accounting/accounting-server";
import { fiscalYearOf, periodLabel } from "@/lib/accounting/numbering";
import { canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Accounting" };
export const dynamic = "force-dynamic";

/** Overview: the current period and fiscal year, journals waiting to be posted, drafts, and this month's postings (counts only). */
export default async function AccountingDashboard() {
  const member = await requirePerm("accounting.view");
  const admin = createAdminClient(); // service role AFTER the permission check
  const today = todayIn(member.org.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const seeJournals = canAny(member, [
    "accounting.ledger.view",
    "accounting.journals.prepare",
    "accounting.journals.approve",
  ]);

  const entities = await loadEntities(admin, member.orgId);
  const head = () =>
    admin
      .from("acc_journals")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId);
  const [periods, waiting, drafts, posted, accounts] = await Promise.all([
    admin
      .from("acc_periods")
      .select("entity_id, status")
      .eq("org_id", member.orgId)
      .eq("year", year)
      .eq("month", month),
    seeJournals
      ? head().eq("status", "draft").not("submitted_at", "is", null)
      : Promise.resolve({ count: null }),
    seeJournals
      ? head().eq("status", "draft").is("submitted_at", null)
      : Promise.resolve({ count: null }),
    seeJournals
      ? head().in("status", ["posted", "reversed"]).gte("journal_date", monthStart)
      : Promise.resolve({ count: null }),
    admin
      .from("acc_accounts")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("is_group", false)
      .eq("is_active", true),
  ]);
  const statusOf = new Map((periods.data ?? []).map((p) => [p.entity_id, p.status]));

  const tile = (label: string, value: number | null, href?: string) => (
    <Card key={label}>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-semibold tabular-nums">
        {href && value !== null ? (
          <Link className="hover:underline" href={href}>
            {value}
          </Link>
        ) : (
          (value ?? "-")
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Accounting"
        description="The general ledger: every posted journal, from people or from the finance sub-ledgers, in one place."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {seeJournals &&
          tile("Waiting to post", waiting.count ?? 0, "/accounting/journals?status=waiting")}
        {seeJournals && tile("Drafts", drafts.count ?? 0, "/accounting/journals?status=draft")}
        {seeJournals &&
          tile(
            "Posted this month",
            posted.count ?? 0,
            `/accounting/journals?status=posted&from=${monthStart}`,
          )}
        {tile("Active ledger accounts", accounts.count ?? 0, "/accounting/accounts")}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current period</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {entities.length === 0 && (
            <p className="text-muted-foreground">The chart of accounts has not been set up yet.</p>
          )}
          {entities.map((e) => {
            const fy = fiscalYearOf(e.fiscal_year_start_month, today);
            const status = statusOf.get(e.id) ?? "open";
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-2">
                {entities.length > 1 && <span className="font-medium">{e.name}</span>}
                <span>
                  {periodLabel(year, month)} in {fy.label} ({fy.start} to {fy.end})
                </span>
                <Badge
                  variant={
                    status === "open" ? "success" : status === "closed" ? "warning" : "secondary"
                  }
                >
                  {status}
                </Badge>
              </div>
            );
          })}
          <Link className="text-muted-foreground underline" href="/accounting/periods">
            All periods
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
