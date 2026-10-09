import Link from "next/link";
import { Plus } from "lucide-react";

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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import {
  CAMPAIGN_STATUSES,
  STATUS_LABEL,
  isActiveStatus,
  type CampaignStatus,
} from "@/lib/campaigns/constants";
import { pct } from "@/lib/campaigns/funnel";
import {
  CAMPAIGN_PAGE_SIZE,
  RECIPIENT_PAGE_SIZE,
  getCampaignDetail,
  listCampaigns,
  listRecipients,
} from "@/lib/campaigns/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { AutoRefresh } from "./auto-refresh";
import { CampaignDrawer } from "./campaign-drawer";
import { campaignsHref, formatShortWhen } from "./format";
import { CampaignStatusBadge } from "./status-badge";

export const metadata = { title: "Campaigns" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const int = (v: string, fallback: number) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("campaigns.view");
  const sp = await searchParams;
  const status = one(sp.status) || "all";
  const q = one(sp.q);
  const page = int(one(sp.page), 1);
  const openId = one(sp.c);
  const tab = one(sp.tab) === "recipients" ? "recipients" : "details";
  const recipientFilter = one(sp.rs) || "all";
  const recipientPage = int(one(sp.rp), 1);

  const supabase = await createClient();
  const admin = createAdminClient();
  const canCreate = can(member, "campaigns.create");
  const tz = member.org.timezone;

  const [list, detail] = await Promise.all([
    listCampaigns(supabase, member.orgId, { status, q, page }),
    openId ? getCampaignDetail(supabase, admin, member.orgId, openId) : Promise.resolve(null),
  ]);
  const recipients =
    detail && tab === "recipients"
      ? await listRecipients(supabase, detail.id, {
          status: recipientFilter === "replied" ? undefined : recipientFilter,
          replied: recipientFilter === "replied",
          page: recipientPage,
          pageSize: RECIPIENT_PAGE_SIZE,
        })
      : null;

  const filters = { status, q, page };
  const live =
    list.rows.some((c) => isActiveStatus(c.status as CampaignStatus)) ||
    (detail ? isActiveStatus(detail.status as CampaignStatus) : false);
  const pages = Math.max(1, Math.ceil(list.total / CAMPAIGN_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-5">
      <AutoRefresh active={live} />
      <PageHeader
        title="Campaigns"
        description="Template broadcasts to a segment or an uploaded list, with delivery funnel and retries."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/templates">Manage templates</Link>
        </Button>
        {canCreate && (
          <Button asChild size="sm">
            <Link href="/campaigns/new">
              <Plus /> New campaign
            </Link>
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {["all", ...CAMPAIGN_STATUSES.filter((s) => s !== "preparing")].map((s) => (
            <Link
              key={s}
              href={campaignsHref({ status: s, q })}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                status === s ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {s === "all" ? "All" : STATUS_LABEL[s as CampaignStatus]}
            </Link>
          ))}
        </div>
        <form action="/campaigns" className="flex gap-2">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <input
            name="q"
            defaultValue={q}
            placeholder="Search campaigns"
            className="border-input bg-background h-8 w-56 rounded-md border px-2 text-sm"
          />
        </form>
      </div>

      {list.rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          {q || status !== "all" ? "No campaigns match." : "No campaigns yet."}
          {canCreate && !q && status === "all" && (
            <>
              {" "}
              <Link href="/campaigns/new" className="text-foreground underline">
                Create your first campaign
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Template</TableHead>
                <TableHead className="min-w-44">Progress</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((c) => (
                <TableRow key={c.id} className={cn(openId === c.id && "bg-accent/50")}>
                  <TableCell className="font-medium">
                    <Link
                      href={campaignsHref({ ...filters, c: c.id })}
                      scroll={false}
                      className="hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs">{c.createdBy}</span>
                  </TableCell>
                  <TableCell>
                    <CampaignStatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>{c.channel?.name ?? "—"}</TableCell>
                  <TableCell className="max-w-48 truncate">{c.template?.name ?? "—"}</TableCell>
                  <TableCell>
                    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                      <div
                        className="bg-primary h-full"
                        style={{
                          width: `${Math.min(100, pct(c.funnel.sent + c.funnel.failed, c.funnel.eligible))}%`,
                        }}
                      />
                    </div>
                    <span className="text-muted-foreground mt-1 block text-xs tabular-nums">
                      {c.funnel.sent.toLocaleString()} sent · {c.funnel.read.toLocaleString()} read
                      {c.funnel.failed > 0 &&
                        ` · ${c.funnel.failed.toLocaleString()} failed`} of{" "}
                      {c.funnel.eligible.toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatShortWhen(c.scheduled_at, tz)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatShortWhen(c.created_at, tz)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>
            Page {page} of {pages} · {list.total.toLocaleString()} campaigns
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Button asChild size="sm" variant="outline">
                <Link href={campaignsHref({ status, q, page: page - 1 })}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild size="sm" variant="outline">
                <Link href={campaignsHref({ status, q, page: page + 1 })}>Next</Link>
              </Button>
            )}
          </span>
        </div>
      )}

      {detail && (
        <CampaignDrawer
          campaign={detail}
          tab={tab}
          recipients={recipients}
          recipientFilter={recipientFilter}
          recipientPage={recipientPage}
          list={filters}
          timezone={tz}
          canManage={canCreate}
        />
      )}
    </div>
  );
}
