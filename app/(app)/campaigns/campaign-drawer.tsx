import Link from "next/link";
import { Download, TriangleAlert } from "lucide-react";

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
import { skipReasonLabel, type CampaignStatus } from "@/lib/campaigns/constants";
import { funnelStages } from "@/lib/campaigns/funnel";
import { parseGuardrails } from "@/lib/campaigns/guardrails";
import type { CampaignDetail, RecipientRow } from "@/lib/campaigns/queries";
import { formatPhone } from "@/lib/phone";
import { mapMetaError } from "@/lib/whatsapp/errors";
import { cn } from "@/lib/utils";

import { DrawerControls } from "./drawer-controls";
import { DrawerShell } from "./drawer-shell";
import { campaignsHref, formatShortWhen, formatWhen } from "./format";
import { CampaignStatusBadge, RecipientStatusBadge } from "./status-badge";

export type DrawerFilters = { status: string; q: string; page: number };

const RECIPIENT_FILTERS: Array<{
  key: string;
  label: string;
  stage?: "sent" | "delivered" | "read" | "replied" | "failed" | "skipped";
}> = [
  { key: "all", label: "All" },
  { key: "sent", label: "Sent", stage: "sent" },
  { key: "delivered", label: "Delivered", stage: "delivered" },
  { key: "read", label: "Read", stage: "read" },
  { key: "replied", label: "Replied", stage: "replied" },
  { key: "failed", label: "Failed", stage: "failed" },
  { key: "skipped", label: "Skipped", stage: "skipped" },
  { key: "pending", label: "Pending" },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function CampaignDrawer({
  campaign,
  tab,
  recipients,
  recipientFilter,
  recipientPage,
  list,
  timezone,
  canManage,
}: {
  campaign: CampaignDetail;
  tab: "details" | "recipients";
  recipients: { rows: RecipientRow[]; total: number; page: number; pageSize: number } | null;
  recipientFilter: string;
  recipientPage: number;
  list: DrawerFilters;
  timezone: string;
  canManage: boolean;
}) {
  const closeHref = campaignsHref({ status: list.status, q: list.q, page: list.page });
  const base = { status: list.status, q: list.q, page: list.page, c: campaign.id };
  const status = campaign.status as CampaignStatus;
  const stages = funnelStages(campaign.funnel);
  const guard = parseGuardrails(campaign.guardrails);
  const map = (campaign.variable_map ?? {}) as Record<string, string>;

  return (
    <DrawerShell
      title={campaign.name}
      closeHref={closeHref}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <CampaignStatusBadge status={campaign.status} />
          <span className="text-muted-foreground text-xs">
            {campaign.channel?.name ?? "Number removed"} ·{" "}
            {campaign.template?.name ?? "Template removed"}
          </span>
        </span>
      }
    >
      {campaign.paused_reason && status === "paused" && (
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>Paused:</strong> {campaign.paused_reason}
          </span>
        </div>
      )}
      {campaign.error && (
        <p className="text-muted-foreground rounded-md border p-3 text-sm">{campaign.error}</p>
      )}

      {canManage && <DrawerControls id={campaign.id} status={status} closeHref={closeHref} />}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {stages.map((s) => (
          <div key={s.key} className="rounded-lg border p-2 text-center">
            <div className="text-lg font-semibold tabular-nums">{s.count.toLocaleString()}</div>
            <div className="text-muted-foreground text-xs">{s.label}</div>
            {s.key !== "total" && <div className="text-xs tabular-nums">{s.pct}%</div>}
          </div>
        ))}
      </div>
      {(campaign.funnel.skipped > 0 || campaign.funnel.pending + campaign.funnel.queued > 0) && (
        <p className="text-muted-foreground -mt-3 text-xs">
          {campaign.funnel.skipped > 0 &&
            `${campaign.funnel.skipped.toLocaleString()} skipped before sending. `}
          {campaign.funnel.pending + campaign.funnel.queued > 0 &&
            `${(campaign.funnel.pending + campaign.funnel.queued).toLocaleString()} still to send.`}
        </p>
      )}

      <nav className="flex gap-1 border-b text-sm" aria-label="Campaign sections">
        {(["details", "recipients"] as const).map((t) => (
          <Link
            key={t}
            href={campaignsHref({ ...base, tab: t === "details" ? null : t })}
            scroll={false}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 capitalize",
              tab === t
                ? "border-primary font-medium"
                : "text-muted-foreground border-transparent hover:text-foreground",
            )}
          >
            {t}
          </Link>
        ))}
      </nav>

      {tab === "details" && (
        <dl className="flex flex-col gap-2">
          <Field label="Number">{campaign.channel?.name ?? "—"}</Field>
          <Field label="Template">
            {campaign.template ? (
              <span className="flex flex-wrap items-center gap-1">
                {campaign.template.name}
                <Badge variant="outline">{campaign.template.language}</Badge>
                <Badge variant="outline">{campaign.template.category}</Badge>
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Audience">
            {campaign.audience_type === "segment"
              ? `Segment: ${campaign.segmentName ?? "deleted segment"}`
              : "Uploaded CSV"}
          </Field>
          <Field label="Created by">
            {campaign.createdBy || "—"} · {formatWhen(campaign.created_at, timezone)}
          </Field>
          {campaign.scheduled_at && (
            <Field label="Scheduled for">{formatWhen(campaign.scheduled_at, timezone)}</Field>
          )}
          <Field label="Started">{formatWhen(campaign.started_at, timezone)}</Field>
          <Field label="Completed">{formatWhen(campaign.completed_at, timezone)}</Field>
          <Field label="Retries">
            {campaign.retry_rounds === 0
              ? "Off"
              : `Up to ${campaign.retry_rounds} round${campaign.retry_rounds > 1 ? "s" : ""}, ${campaign.retry_delay_minutes} min apart (round ${campaign.retry_round} so far)`}
            {campaign.next_retry_at && (
              <span className="text-muted-foreground block text-xs">
                Next round at {formatWhen(campaign.next_retry_at, timezone)}
              </span>
            )}
          </Field>
          <Field label="Safety">
            Pauses at {guard.max_failure_pct}% send failures or {guard.max_total_failure_pct}%
            undeliverable (after {guard.min_sample} sends)
            {guard.pause_on_quality_drop ? ", or when the number's quality drops" : ""}.
          </Field>
          {Object.keys(map).length > 0 && (
            <Field label="Variables">
              <ul className="flex flex-col gap-0.5">
                {Object.entries(map).map(([k, v]) => (
                  <li key={k} className="text-xs">
                    <code>{k}</code> ← {v.startsWith("text:") ? `“${v.slice(5)}”` : v}
                  </li>
                ))}
              </ul>
            </Field>
          )}
        </dl>
      )}

      {tab === "recipients" && recipients && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {RECIPIENT_FILTERS.map((f) => {
                const count = f.stage ? campaign.funnel[f.stage] : null;
                return (
                  <Link
                    key={f.key}
                    href={campaignsHref({ ...base, tab: "recipients", rs: f.key })}
                    scroll={false}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      recipientFilter === f.key
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-accent",
                    )}
                  >
                    {f.label}
                    {count !== null && (
                      <span className="ml-1 opacity-70">{count.toLocaleString()}</span>
                    )}
                  </Link>
                );
              })}
            </div>
            <Button asChild size="sm" variant="outline">
              <a href={`/api/campaigns/${campaign.id}/report`} download>
                <Download /> Download report
              </a>
            </Button>
          </div>

          {recipients.rows.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
              No recipients match this filter.
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Patient</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last event</TableHead>
                    <TableHead>Replied</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipients.rows.map((r) => {
                    const when = r.read_at ?? r.delivered_at ?? r.sent_at ?? r.failed_at;
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <span className="block text-sm">{r.name}</span>
                          <span className="text-muted-foreground block text-xs">
                            {formatPhone(r.phone)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <RecipientStatusBadge status={r.status} />
                          {r.status === "failed" && (
                            <span className="text-muted-foreground mt-1 block max-w-56 text-xs">
                              {r.error_code && r.error_code > 0 ? `${r.error_code} · ` : ""}
                              {r.error_message ?? mapMetaError(r.error_code).message}
                              {r.round > 0 && ` (round ${r.round})`}
                            </span>
                          )}
                          {r.status === "skipped" && (
                            <span className="text-muted-foreground mt-1 block text-xs">
                              {skipReasonLabel(r.skip_reason)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatShortWhen(when, timezone)}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatShortWhen(r.replied_at, timezone)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>
              {recipients.total === 0
                ? "0 recipients"
                : `${(recipients.page - 1) * recipients.pageSize + 1}–${Math.min(
                    recipients.page * recipients.pageSize,
                    recipients.total,
                  ).toLocaleString()} of ${recipients.total.toLocaleString()}`}
            </span>
            <span className="flex gap-2">
              {recipientPage > 1 && (
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={campaignsHref({
                      ...base,
                      tab: "recipients",
                      rs: recipientFilter,
                      rp: recipientPage - 1,
                    })}
                    scroll={false}
                  >
                    Previous
                  </Link>
                </Button>
              )}
              {recipients.page * recipients.pageSize < recipients.total && (
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={campaignsHref({
                      ...base,
                      tab: "recipients",
                      rs: recipientFilter,
                      rp: recipientPage + 1,
                    })}
                    scroll={false}
                  >
                    Next
                  </Link>
                </Button>
              )}
            </span>
          </div>
        </div>
      )}
    </DrawerShell>
  );
}
