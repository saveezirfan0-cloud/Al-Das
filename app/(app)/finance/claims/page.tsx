import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Term } from "@/components/shell/term";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_VARIANT,
  CLAIM_STATUSES,
  type ClaimStatus,
} from "@/lib/finance/claim-status";
import { claimStatusesFor, loadClaimStatusSettings } from "@/lib/finance/claim-status-server";
import { exportQuery, parseClaimFilters } from "@/lib/finance/list-exports";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Claims" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
/** With the status filter on, the status is worked out for at most this many claims (most recent first). */
const STATUS_FILTER_CAP = 5000;
const MATCH_VARIANT = {
  matched: "success",
  ambiguous: "warning",
  unmatched: "destructive",
} as const;
const SELECT =
  "id, claim_activity_number, invoice_no, transaction_date, cpt_code, payer_id, net, remitted, rejected, write_off, write_off_status, claim_status, resubmission_count, last_resubmission_date, last_remittance_date, denial_type, match_status, match_reason";

type Search = {
  q?: string;
  status?: string;
  payer?: string;
  denial?: string;
  match?: string;
  cstatus?: string;
  page?: string;
};

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.claims.view");
  const sp = await searchParams;
  const f = parseClaimFilters(sp);
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient(); // the member's own client: RLS decides what they see

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same filters on two query shapes
  const filtered = <Q extends { or: any; eq: any }>(query: Q): Q => {
    let q = query;
    if (f.q) q = q.or(`claim_activity_number.ilike.%${f.q}%,invoice_no.ilike.%${f.q}%`);
    if (f.status) q = q.eq("claim_status", f.status);
    if (f.payer) q = q.eq("payer_id", f.payer);
    if (f.denial) q = q.eq("denial_type", f.denial);
    if (f.match) q = q.eq("match_status", f.match);
    return q;
  };

  // The status needs facts from tables with their own keys: read only those, with the service role, after the key.
  const admin = createAdminClient();
  const statusSettings = await loadClaimStatusSettings(admin, member);

  let rows;
  let total: number;
  let capped = false;
  let statuses: Awaited<ReturnType<typeof claimStatusesFor>>;
  if (!f.cstatus) {
    const { data, count } = await filtered(
      supabase
        .from("ins_claim_activities")
        .select(SELECT, { count: "exact" })
        .order("transaction_date", { ascending: false, nullsFirst: false })
        .order("claim_activity_number")
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    );
    rows = data ?? [];
    total = count ?? 0;
    statuses = await claimStatusesFor(admin, member, rows, statusSettings);
  } else {
    const res = await fetchAll(
      (from, to) =>
        filtered(
          supabase
            .from("ins_claim_activities")
            .select(SELECT)
            .order("transaction_date", { ascending: false, nullsFirst: false })
            .order("claim_activity_number")
            .order("id")
            .range(from, to),
        ),
      { max: STATUS_FILTER_CAP },
    );
    const all = res.data ?? [];
    capped = res.truncated;
    statuses = await claimStatusesFor(admin, member, all, statusSettings);
    const wanted = all.filter((r) => statuses.get(r.id)?.status === f.cstatus);
    total = wanted.length;
    rows = wanted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const params = new URLSearchParams(
      Object.entries({ ...sp, page: String(p) }).filter(([, v]) => v) as [string, string][],
    );
    return `/finance/claims?${params.toString()}`;
  };
  const anyFilter = !!(f.q || f.status || f.payer || f.denial || f.match || f.cstatus);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Claims"
        description={`${total.toLocaleString()} claim activities from Diligence, matched to Unite invoices.`}
      >
        {total > 0 && (
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/finance/claims/export${exportQuery(sp, ["q", "status", "payer", "denial", "match", "cstatus"])}`}
            >
              Excel
            </a>
          </Button>
        )}
      </PageHeader>
      <form className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <Input
          name="q"
          placeholder="Claim or invoice no."
          aria-label="Claim or invoice number"
          defaultValue={sp.q}
          className="sm:col-span-2"
        />
        <select
          name="cstatus"
          aria-label="Status"
          defaultValue={f.cstatus ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Any status</option>
          {CLAIM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CLAIM_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <Input
          name="status"
          placeholder="Diligence status"
          aria-label="Diligence status"
          defaultValue={sp.status}
        />
        <Input name="payer" placeholder="Payer ID" aria-label="Payer ID" defaultValue={sp.payer} />
        <Input
          name="denial"
          placeholder="Denial type"
          aria-label="Denial type"
          defaultValue={sp.denial}
        />
        <select
          name="match"
          aria-label="Match"
          defaultValue={sp.match ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Any match</option>
          <option value="matched">Matched</option>
          <option value="ambiguous">Ambiguous</option>
          <option value="unmatched">Unmatched</option>
        </select>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p>
          <Term k="claim-status">Status</Term> is one status per claim activity, worked out from the
          Diligence figures, <Term k="taken-back">payments taken back</Term> on payment advices and
          the denial case. Paid means paid in full; Closed needs the bank receipt, which is not yet
          linked to single claims, so a paid claim stays Paid unless its denial case was lost.
        </p>
        {statusSettings.remittedNetsTakebacks === null && (
          <p role="note">
            <Badge variant="warning" className="mr-1">
              Unconfirmed
            </Badge>
            Whether Diligence&apos;s Remitted already deducts payments taken back is not confirmed
            yet; Pulse assumes it does not and deducts them itself. Set it in Finance, Workflow
            settings once confirmed.
          </p>
        )}
        {capped && (
          <p role="note">
            The status filter looked at the {STATUS_FILTER_CAP.toLocaleString()} most recent claim
            activities that match the other filters. Narrow them (payer, invoice) to see older ones.
          </p>
        )}
      </div>
      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <EmptyState
              title={anyFilter ? "No claims match these filters" : "No claims yet"}
              description={
                anyFilter
                  ? "Clear or change the filters to see more claims."
                  : "Claims appear after the Diligence report is imported (Finance, Claims, Uploads)."
              }
              className="border-0 p-6"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim activity</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Diligence status</TableHead>
                  <TableHead>Match</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => {
                  const st = statuses.get(c.id);
                  const s: ClaimStatus = st?.status ?? "unknown";
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/finance/claims/${c.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {c.claim_activity_number}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.invoice_no}</TableCell>
                      <TableCell className="text-xs">{c.transaction_date ?? "—"}</TableCell>
                      <TableCell className="text-xs">{c.cpt_code}</TableCell>
                      <TableCell className="text-xs">{c.payer_id ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.net?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.remitted?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.rejected?.toLocaleString() ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={CLAIM_STATUS_VARIANT[s]}
                          title={
                            st && st.outstanding > 0
                              ? `Still owed ${st.outstanding.toLocaleString()}`
                              : undefined
                          }
                        >
                          {CLAIM_STATUS_LABELS[s]}
                        </Badge>
                        {st && st.overpaid > 0 && (
                          <Badge variant="warning" className="ml-1">
                            Overpaid
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{c.claim_status ?? "—"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            MATCH_VARIANT[c.match_status as keyof typeof MATCH_VARIANT] ??
                            "secondary"
                          }
                          title={c.match_reason ?? undefined}
                        >
                          {c.match_reason && c.match_reason !== "ok"
                            ? c.match_reason.replaceAll("_", " ")
                            : c.match_status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page - 1)}>Previous</Link>
            </Button>
          )}
          {page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page + 1)}>Next</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
