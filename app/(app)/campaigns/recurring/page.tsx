import Link from "next/link";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { campaignBudgetStatus } from "@/lib/campaigns/queries";
import {
  describeCron,
  SKIP_REASON_LABEL,
  type RecurrenceSkipReason,
} from "@/lib/campaigns/recurrence";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { BudgetMeter } from "../budget-meter";
import { formatShortWhen } from "../format";
import { RecurrenceControls } from "./recurrence-controls";

export const metadata = { title: "Recurring campaigns" };
export const dynamic = "force-dynamic";

function outcomeText(outcome: string | null): string {
  if (!outcome) return "Not run yet";
  if (outcome === "created" || outcome === "running") return "Sent a campaign";
  if (outcome === "no_next_run") return "Stopped: the schedule has no further dates";
  if (outcome.startsWith("skipped:")) {
    const reason = outcome.slice(8) as RecurrenceSkipReason;
    return `Skipped: ${SKIP_REASON_LABEL[reason] ?? reason}`;
  }
  return outcome;
}

/**
 * Recurring campaigns (Phase 20d). Read through the member's own client, so RLS (campaigns.view) decides; changes
 * go through server actions that need campaigns.create.
 */
export default async function RecurringCampaignsPage() {
  const member = await requirePerm("campaigns.view");
  const canCreate = can(member, "campaigns.create");
  const tz = member.org.timezone;
  const supabase = await createClient();
  const [{ data: rows }, budget] = await Promise.all([
    supabase
      .from("campaign_recurrences")
      .select(
        "id, name, status, cron, timezone, next_run_at, last_run_at, last_run_outcome, last_campaign_id, runs, channels(name), wa_templates(name, language), segments(name)",
      )
      .eq("org_id", member.orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    campaignBudgetStatus(createAdminClient(), member.orgId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Recurring campaigns"
        description="Campaigns that send again on a schedule. Each run picks up the segment as it is at that moment and is checked again before anything goes out."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
        {canCreate && (
          <Button asChild size="sm">
            <Link href="/campaigns/new?repeat=1">
              <Plus /> New recurring campaign
            </Link>
          </Button>
        )}
      </PageHeader>

      <BudgetMeter
        used={budget.used}
        limit={budget.limit}
        canEdit={can(member, "settings.manage")}
      />

      {!rows?.length ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No recurring campaigns yet. Create a campaign and choose Repeat under When and how.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <span className="font-medium">{r.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {r.wa_templates?.name ?? "—"} · {r.segments?.name ?? "segment deleted"} ·{" "}
                      {r.channels?.name ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {describeCron(r.cron) ?? r.cron}
                    <span className="text-muted-foreground block text-xs">
                      {r.timezone} · <code>{r.cron}</code>
                    </span>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {r.status === "active" ? formatShortWhen(r.next_run_at, tz) : "—"}
                  </TableCell>
                  <TableCell className="max-w-64 text-xs">
                    {r.last_run_at ? formatShortWhen(r.last_run_at, tz) : ""}
                    <span className="text-muted-foreground block">
                      {outcomeText(r.last_run_outcome)}
                    </span>
                    {r.last_campaign_id && (
                      <Link href={`/campaigns?c=${r.last_campaign_id}`} className="underline">
                        Open that run
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.status === "active" ? "success" : "secondary"}>
                      {r.status === "active" ? "Active" : "Paused"}
                    </Badge>
                    <span className="text-muted-foreground block text-xs">{r.runs} runs</span>
                  </TableCell>
                  <TableCell>
                    {canCreate && <RecurrenceControls id={r.id} active={r.status === "active"} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
