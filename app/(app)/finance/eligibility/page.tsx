import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { REASON_LABELS, REASON_SHORT, type ReadinessReason } from "@/lib/finance/bill-readiness";
import { money } from "@/lib/finance/format";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createClient } from "@/lib/supabase/server";
import { daysUntil } from "@/lib/documents/expiry";
import { cn } from "@/lib/utils";

import { CheckDrawer, CheckStatusBadge, NewCheckButton, type CheckRow } from "./eligibility-forms";

export const metadata = { title: "Eligibility" };
export const dynamic = "force-dynamic";

type Search = { tab?: string; q?: string; status?: string; page?: string };
const PAGE_SIZE = 50;
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 60);

export default async function EligibilityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.eligibility.manage");
  const sp = await searchParams;
  const tab = sp.tab === "checks" ? "checks" : "ready";
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const settings = await loadFinanceSettings(supabase, member.orgId);
  const today = todayIn(member.org.timezone);
  const canSeeCards = can(member, "documents.view");

  const tabLink = (t: string) => `/finance/eligibility?tab=${t}`;
  const header = (
    <PageHeader
      title="Eligibility"
      description="Check the patient's cover before the visit, file the insurance card you saw, and see which insurance invoices are not ready to bill."
    >
      <NewCheckButton canSeeCards={canSeeCards} />
    </PageHeader>
  );
  const tabs = (
    <div className="flex gap-2 border-b">
      {[
        ["ready", "Not ready to bill"],
        ["checks", "Checks"],
      ].map(([k, label]) => (
        <Link
          key={k}
          href={tabLink(k)}
          className={cn(
            "border-b-2 px-3 py-2 text-sm",
            tab === k ? "border-primary font-medium" : "text-muted-foreground border-transparent",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );

  if (tab === "ready") {
    const { data, count } = await supabase
      .from("v_fin_billing_readiness")
      .select(
        "invoice_id, inv_display_number, transaction_date, branch_code, patient_pin, net, reasons",
        { count: "exact" },
      )
      .order("transaction_date", { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    const total = count ?? 0;
    return (
      <div className="flex flex-col gap-6">
        {header}
        {tabs}
        {!settings.readyStartDate && (
          <Card>
            <CardContent className="pt-6 text-sm">
              The “not ready to bill” flag is switched off. Set{" "}
              <strong>Check ready-to-bill from</strong> in Finance, Workflow settings to start
              flagging insurance invoices dated from that day.
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="pt-6">
            {(data ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {settings.readyStartDate
                  ? "Every unclaimed insurance invoice is ready to bill."
                  : "Nothing is being checked yet."}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>PIN</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead>Why it is not ready</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data ?? []).map((r) => (
                    <TableRow key={r.invoice_id ?? r.inv_display_number}>
                      <TableCell className="font-mono text-xs">{r.inv_display_number}</TableCell>
                      <TableCell className="text-xs">{r.transaction_date}</TableCell>
                      <TableCell className="text-xs">{r.branch_code ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{r.patient_pin ?? "—"}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(r.net)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(r.reasons ?? []).map((x) => (
                            <Badge
                              key={x}
                              variant="warning"
                              title={REASON_LABELS[x as ReadinessReason]}
                            >
                              {REASON_SHORT[x as ReadinessReason] ?? x}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {r.patient_pin && (
                          <NewCheckButton canSeeCards={canSeeCards} defaultPin={r.patient_pin} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-sm">
          {total.toLocaleString()} invoice(s) not ready. Invoices already claimed in Diligence, and
          the last {settings.readyGraceDays} day(s), are not listed.
        </p>
      </div>
    );
  }

  let query = supabase
    .from("fin_eligibility_checks")
    .select(
      "id, patient_pin, payer_id, status, method, valid_from, valid_to, checked_on, document_id, result_note",
      { count: "exact" },
    )
    .order("checked_on", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const q = safe(sp.q);
  if (q) query = query.or(`patient_pin.ilike.%${q}%,payer_id.ilike.%${q}%`);
  if (["pending", "verified", "failed", "expired"].includes(sp.status ?? ""))
    query = query.eq("status", sp.status as string);
  const { data, count } = await query;
  const rows: CheckRow[] = (data ?? []).map((r) => ({
    ...r,
    status: r.status as CheckRow["status"],
    has_card: !!r.document_id,
  }));
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  return (
    <div className="flex flex-col gap-6">
      {header}
      {tabs}
      <form className="grid gap-2 sm:grid-cols-5">
        <input type="hidden" name="tab" value="checks" />
        <Input name="q" placeholder="PIN or payer" defaultValue={sp.q} className="sm:col-span-2" />
        <select
          name="status"
          defaultValue={sp.status ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">Any result</option>
          <option value="pending">Pending</option>
          <option value="verified">Verified</option>
          <option value="failed">Failed</option>
          <option value="expired">Expired</option>
        </select>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No checks recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PIN</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Cover until</TableHead>
                  <TableHead>Card</TableHead>
                  <TableHead>Checked</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const left = r.status === "verified" ? daysUntil(r.valid_to, today) : null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.patient_pin ?? "—"}</TableCell>
                      <TableCell className="text-xs">{r.payer_id}</TableCell>
                      <TableCell>
                        <CheckStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.valid_to ?? "—"}
                        {left !== null && left < 0 && (
                          <Badge variant="destructive" className="ml-2">
                            ended
                          </Badge>
                        )}
                        {left !== null && left >= 0 && left <= 30 && (
                          <Badge variant="warning" className="ml-2">
                            {left} d
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.has_card ? "Filed" : <span className="text-muted-foreground">None</span>}
                      </TableCell>
                      <TableCell className="text-xs">{r.checked_on ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <CheckDrawer row={r} canSeeCards={canSeeCards} />
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
      </div>
    </div>
  );
}
