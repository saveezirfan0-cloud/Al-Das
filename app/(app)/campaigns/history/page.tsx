import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { pct } from "@/lib/campaigns/funnel";
import { createClient } from "@/lib/supabase/server";

import { formatShortWhen } from "../format";

export const metadata = { title: "Campaign history" };

const PAGE_SIZE = 50;

/**
 * Campaigns sent from Sanoflow before the move (Phase 20a). Read-only: the rows come from the import,
 * hold statuses and counts only, and can never be sent again. Read through the member's own client,
 * so RLS (campaigns.view) decides.
 */
export default async function CampaignHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("campaigns.view");
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(String(sp.page ?? "1"), 10) || 1);
  const supabase = await createClient();
  const { data: rows, count } = await supabase
    .from("campaign_archive")
    .select("id, name, template_name, sent_at, totals", { count: "exact" })
    .eq("org_id", member.orgId)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const n = (t: unknown, k: string) => {
    const v = (t as Record<string, unknown> | null)?.[k];
    return typeof v === "number" ? v : 0;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Campaign history"
        description="Campaigns sent from Sanoflow before Pulse. Read-only: kept for reporting and to see who received what."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      </PageHeader>
      {!rows?.length ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No campaign history has been imported.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Read</TableHead>
                <TableHead className="text-right">Replied</TableHead>
                <TableHead className="text-right">Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const total = n(r.totals, "recipients");
                // a read or replied message was delivered too
                const replied = n(r.totals, "replied");
                const read = n(r.totals, "read") + replied;
                const delivered = n(r.totals, "delivered") + read;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-muted-foreground">{r.template_name ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.sent_at ? formatShortWhen(r.sent_at, member.org.timezone) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{total}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(delivered, total)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(read, total)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(replied, total)}%</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {n(r.totals, "failed")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          {page > 1 && (
            <Link className="underline" href={`/campaigns/history?page=${page - 1}`}>
              Previous
            </Link>
          )}
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link className="underline" href={`/campaigns/history?page=${page + 1}`}>
              Next
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
