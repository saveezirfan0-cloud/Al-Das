import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";

import { FirstRunChecklist } from "@/components/shell/first-run-checklist";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { firstRunFor } from "@/lib/help/first-steps";
import { branchView } from "@/lib/branches/server";
import { todayIn } from "@/lib/finance/action-support";
import {
  cardLinks,
  HUB_GROUPS,
  HUB_PERMISSIONS,
  hubBranches,
  hubCardsFor,
  hubContext,
  hubQuery,
  parseHubParams,
  PERIOD_OPTION_COUNT,
  periodOptions,
  periodRange,
  previousKey,
  type HubUse,
} from "@/lib/finance/reports-hub";
import { createAdminClient } from "@/lib/supabase/admin";

import { HubPicker } from "./hub-picker";

export const metadata = { title: "Reports hub" };
export const dynamic = "force-dynamic";

const USE_LABEL: Record<HubUse, string> = {
  period: "Period",
  day: "Last day of the period",
  as_of: "As at the period end",
  branch: "Branch",
  compare: "Comparison",
};

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export default async function FinanceReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  if (!canAny(member, HUB_PERMISSIONS)) throw new ForbiddenError("finance.view");
  const today = todayIn(member.org.timezone);
  const admin = createAdminClient(); // service role AFTER the permission check: branch names and codes only
  const [{ data: finBranches }, { data: locations }] = await Promise.all([
    admin
      .from("fin_ref_branches")
      .select("code, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("code"),
    admin.from("locations").select("id, branch_code").eq("org_id", member.orgId).eq("active", true),
  ]);
  const view = await branchView(
    member,
    (locations ?? []).map((l) => l.id),
  );
  const { options: branches, defaultCode } = hubBranches(
    finBranches ?? [],
    locations ?? [],
    view.access,
    view.current,
  );
  const picker = parseHubParams(
    await searchParams,
    today,
    branches.map((b) => b.code),
    defaultCode,
  );
  const ctx = hubContext(picker, today, addDays(today, -1));
  const previous = periodRange(picker.kind, previousKey(picker.kind, picker.key))!;
  const cards = hubCardsFor(member);
  const branchName = picker.branch
    ? (branches.find((b) => b.code === picker.branch)?.name ?? picker.branch)
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports hub"
        description="Every finance and accounting report in one place. Pick the branch and period once; each report opens with them, and the download buttons give the same view as Excel, CSV or PDF."
      />
      <FirstRunChecklist firstRun={firstRunFor(member)} />
      <HubPicker
        key={hubQuery(picker)}
        branches={branches}
        branch={picker.branch}
        kind={picker.kind}
        periodKey={picker.key}
        options={periodOptions(picker.kind, today, PERIOD_OPTION_COUNT[picker.kind])}
        compare={picker.compare}
      />
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {ctx.range.label}
        {ctx.to < ctx.range.to ? ` (to ${ctx.to})` : ""}
        {branchName ? `, ${branchName}` : ", all branches"}
        {picker.compare ? `, compared with ${previous.label}` : ""}. Reports that cannot narrow by
        branch or compare say so on their card.
      </p>
      {cards.length === 0 && (
        <p className="text-muted-foreground text-sm">No reports are open to your role.</p>
      )}
      {HUB_GROUPS.map((group) => {
        const list = cards.filter((c) => c.group === group);
        if (list.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`hub-${group}`} className="flex flex-col gap-3">
            <h3
              id={`hub-${group}`}
              className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
            >
              {group}
            </h3>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((card) => {
                const links = cardLinks(card, ctx);
                const ignored = [
                  picker.branch && !card.uses.includes("branch") ? "all branches" : null,
                  picker.compare && !card.uses.includes("compare") ? "no comparison" : null,
                ].filter(Boolean);
                return (
                  <li key={card.key} className="bg-card flex flex-col gap-2 rounded-xl border p-4">
                    <div className="font-medium">{card.title}</div>
                    <p className="text-muted-foreground text-sm">{card.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {card.uses.length === 0 ? (
                        <Badge variant="outline">As of today</Badge>
                      ) : (
                        card.uses.map((u) => (
                          <Badge key={u} variant="outline">
                            {USE_LABEL[u]}
                          </Badge>
                        ))
                      )}
                      {ignored.length > 0 && (
                        <Badge variant="secondary">Shows {ignored.join(", ")}</Badge>
                      )}
                    </div>
                    <div className="mt-auto flex flex-wrap gap-2 pt-1">
                      <Button asChild size="sm">
                        <Link href={links.view}>
                          View <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                      {links.exports.map((e) => (
                        <Button key={e.label} asChild size="sm" variant="outline">
                          <a href={e.href} aria-label={`${card.title} as ${e.label}`}>
                            <Download aria-hidden /> {e.label}
                          </a>
                        </Button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="text-muted-foreground text-xs">
        Statements and balance confirmations are e-mailed from Accounting, Statements; the close
        pack from Finance, Month-end close.
      </p>
    </div>
  );
}
