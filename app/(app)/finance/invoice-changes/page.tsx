import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { money } from "@/lib/finance/format";
import {
  bulkEligible,
  CHANGE_KINDS,
  changeKpi,
  DECISION_LABELS,
  defaultPeriod,
  KIND_LABELS,
  needsApproval,
  periodProblem,
  reviewOrder,
  statusLabel,
  totalsByKind,
  type ChangeEvent,
  type ChangeKind,
  type ChangeRegister,
} from "@/lib/finance/invoice-changes";
import { loadChanges } from "@/lib/finance/invoice-changes-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { BulkApprove, ChangeDrawer, ReviewForm } from "./change-controls";

export const metadata = { title: "Invoice changes" };
export const dynamic = "force-dynamic";

type Search = { from?: string; to?: string; kind?: string; change?: string };
const SHOWN = 500;

export default async function InvoiceChangesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const member = await requirePerm("finance.changes.view");
  const sp = await searchParams;
  const def = defaultPeriod(todayIn(member.org.timezone));
  const asked = { from: (sp.from ?? "").slice(0, 10), to: (sp.to ?? "").slice(0, 10) };
  const bad = asked.from || asked.to ? periodProblem(asked.from, asked.to) : null;
  const from = asked.from && asked.to && !bad ? asked.from : def.from;
  const to = asked.from && asked.to && !bad ? asked.to : def.to;
  const kind = (CHANGE_KINDS as readonly string[]).includes(sp.kind ?? "")
    ? (sp.kind as ChangeKind)
    : null;
  const changeKey = /^[0-9a-f]{32}$/.test(sp.change ?? "") ? (sp.change as string) : null;

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const reg = await loadChanges(admin, member.orgId, from, to);
  await recordAccess(admin, member, { entity: "finance_invoice", action: "list" });
  const canReview = can(member, "finance.changes.review");
  const canOpenInvoice = can(member, "finance.invoices.view");

  const kpi = changeKpi(reg);
  const totals = totalsByKind(reg.events);
  const shown = reviewOrder(
    reg.events.filter((e) => kind === null || e.kind === kind),
    reg,
  );
  const eligible = canReview ? bulkEligible(reg.events, reg.bulkMax, kind) : [];
  const selected = changeKey ? (reg.events.find((e) => e.changeKey === changeKey) ?? null) : null;

  const qs = (over: Partial<Record<keyof Search, string | null>>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | null> = { from, to, kind, change: null, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/finance/invoice-changes?${p.toString()}`;
  };
  const csvHref = `/api/finance/invoice-changes?${new URLSearchParams({ from, to, ...(kind ? { kind } : {}) }).toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoice changes"
        description={`Discounts, cancellations, credit notes, write-offs, reduced amounts and refunds on Unite invoices from ${from} to ${to}, as Pulse received them from Unite. Unreviewed changes first. Amounts in AED.`}
      >
        <Button asChild size="sm" variant="outline">
          <a href={csvHref}>Download CSV</a>
        </Button>
      </PageHeader>

      {bad && (
        <Alert variant="destructive">
          <AlertTitle>Period not changed</AlertTitle>
          <AlertDescription>{bad} Showing the month so far.</AlertDescription>
        </Alert>
      )}

      <KpiLine reg={reg} kpi={kpi} />

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">From</span>
          <Input type="date" name="from" defaultValue={from} className="h-9" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">To</span>
          <Input type="date" name="to" defaultValue={to} className="h-9" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Change</span>
          <select
            name="kind"
            defaultValue={kind ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="">All changes</option>
            {CHANGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {totals.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {totals.map((t) => (
            <Link
              key={t.kind}
              href={qs({ kind: kind === t.kind ? null : t.kind })}
              className={`rounded-md border p-3 text-sm hover:bg-muted/50 ${kind === t.kind ? "border-primary" : ""}`}
            >
              <div className="text-muted-foreground text-xs">{KIND_LABELS[t.kind]}</div>
              <div className="font-semibold tabular-nums">{money(t.amount)}</div>
              <div className="text-muted-foreground text-xs">
                {t.count.toLocaleString()} change(s), {t.unreviewed.toLocaleString()} unreviewed
              </div>
            </Link>
          ))}
        </div>
      )}

      {eligible.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {eligible.length} unreviewed change(s) of up to {money(reg.bulkMax)} can be approved
            together.
          </span>
          <BulkApprove
            from={from}
            to={to}
            kind={kind}
            count={eligible.length}
            label={`Approves ${eligible.length} unreviewed ${kind ? KIND_LABELS[kind].toLowerCase() : "change"}(s) from ${from} to ${to}, each up to ${money(reg.bulkMax)}, ${money(eligible.reduce((a, e) => a + e.amount, 0))} in all, with the reason you give.`}
          />
        </div>
      )}

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No invoice changes in this period. Changes appear once Unite invoices are captured.
            </p>
          ) : (
            <>
              {shown.length > SHOWN && (
                <p className="text-muted-foreground mb-3 text-xs">
                  Showing the first {SHOWN} of {shown.length.toLocaleString()}; the CSV has them
                  all.
                </p>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Unite user</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.slice(0, SHOWN).map((e) => (
                    <TableRow
                      key={e.changeKey}
                      data-state={e.changeKey === changeKey ? "selected" : undefined}
                    >
                      <TableCell className="text-xs">{e.changeDate}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={qs({ change: e.changeKey })}
                          scroll={false}
                          className="underline-offset-2 hover:underline"
                        >
                          {e.invoiceNo}
                        </Link>
                        {e.invType && <div className="text-muted-foreground">{e.invType}</div>}
                      </TableCell>
                      <TableCell className="text-xs">{e.branch ?? "—"}</TableCell>
                      <TableCell className="text-xs">{KIND_LABELS[e.kind]}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(e.amount)}
                      </TableCell>
                      <TableCell className="text-xs">{e.uniteUser ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge e={e} reg={reg} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      {selected && (
        <ChangePanel
          e={selected}
          reg={reg}
          canReview={canReview}
          canOpenInvoice={canOpenInvoice}
          closeHref={qs({ change: null })}
          member={member}
        />
      )}
    </div>
  );
}

function KpiLine({ reg, kpi }: { reg: ChangeRegister; kpi: ReturnType<typeof changeKpi> }) {
  if (!kpi.measured)
    return (
      <Alert>
        <AlertTitle>Unapproved changes: not measured yet</AlertTitle>
        <AlertDescription>
          The register works, but the measure (target zero) starts on the date Finance sets in
          Workflow settings, &ldquo;Count unapproved invoice changes from&rdquo;.
        </AlertDescription>
      </Alert>
    );
  if (kpi.from > reg.to)
    return (
      <Alert>
        <AlertTitle>Unapproved changes: not measured in this period</AlertTitle>
        <AlertDescription>Counting starts on {reg.startDate}.</AlertDescription>
      </Alert>
    );
  const zero = kpi.unapproved.count === 0;
  return (
    <Alert variant={zero ? "default" : "destructive"}>
      <AlertTitle>
        Unapproved changes from {kpi.from} to {reg.to}: {kpi.unapproved.count.toLocaleString()} (
        {money(kpi.unapproved.amount)}). Target: zero.
      </AlertTitle>
      <AlertDescription>
        Awaiting review {kpi.awaiting.count.toLocaleString()} ({money(kpi.awaiting.amount)}); not
        approved {kpi.rejected.count.toLocaleString()} ({money(kpi.rejected.amount)}).
        {reg.minAmount > 0
          ? ` Changes below ${money(reg.minAmount)} need no approval.`
          : " Every change needs an approval."}
      </AlertDescription>
    </Alert>
  );
}

function StatusBadge({ e, reg }: { e: ChangeEvent; reg: ChangeRegister }) {
  const variant = e.review
    ? e.review.decision === "rejected"
      ? "destructive"
      : "secondary"
    : needsApproval(e, reg)
      ? "warning"
      : "outline";
  return (
    <Badge variant={variant}>
      {statusLabel(e, reg)}
      {e.review?.bulk ? " (bulk)" : ""}
    </Badge>
  );
}

async function ChangePanel({
  e,
  reg,
  canReview,
  canOpenInvoice,
  closeHref,
  member,
}: {
  e: ChangeEvent;
  reg: ChangeRegister;
  canReview: boolean;
  canOpenInvoice: boolean;
  closeHref: string;
  member: Awaited<ReturnType<typeof requirePerm>>;
}) {
  await recordAccess(createAdminClient(), member, {
    entity: "finance_invoice",
    entityId: e.invoiceId,
    action: "view",
  });
  let reviewer = "—";
  if (e.review?.reviewedBy) {
    const { data } = await (
      await createClient()
    )
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", e.review.reviewedBy)
      .maybeSingle();
    if (data) reviewer = `${data.first_name} ${data.last_name}`.trim() || "—";
  }
  return (
    <ChangeDrawer
      title={`${KIND_LABELS[e.kind]} on ${e.invoiceNo}`}
      description={`${money(e.amount)} · ${e.changeDate} · ${statusLabel(e, reg)}`}
      closeHref={closeHref}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Invoice</dt>
        <dd className="font-mono text-xs">{e.invoiceNo}</dd>
        <dt className="text-muted-foreground">Invoice type</dt>
        <dd>{e.invType ?? "—"}</dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd>{e.branch ?? "—"}</dd>
        <dt className="text-muted-foreground">Doctor ID</dt>
        <dd>{e.doctorId ?? "—"}</dd>
        <dt className="text-muted-foreground">Change</dt>
        <dd>{KIND_LABELS[e.kind]}</dd>
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="tabular-nums">{money(e.amount)}</dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd>{e.changeDate}</dd>
        <dt className="text-muted-foreground">Unite user</dt>
        <dd>{e.uniteUser ?? "not in the Unite record"}</dd>
      </dl>
      {e.monthLocked && (
        <p className="text-muted-foreground text-xs">
          This change falls in a locked month. A review is still recorded (it is evidence, not a
          figure) and marked as made after the lock.
        </p>
      )}
      {e.review ? (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="font-semibold">Review</h3>
          <div>
            {DECISION_LABELS[e.review.decision]}
            {e.review.bulk ? " (bulk approval)" : ""} by {reviewer},{" "}
            {e.review.reviewedAt.slice(0, 16).replace("T", " ")}
            {e.review.monthLocked ? ", after the month was locked" : ""}
          </div>
          <p className="whitespace-pre-wrap">{e.review.reason}</p>
        </section>
      ) : canReview ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Review this change</h3>
          <ReviewForm changeKey={e.changeKey} changeDate={e.changeDate} closeHref={closeHref} />
        </section>
      ) : (
        <p className="text-muted-foreground text-sm">Not reviewed yet.</p>
      )}
      {canOpenInvoice && (
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href={`/finance/invoices/${e.invoiceId}`}>Open the invoice</Link>
        </Button>
      )}
    </ChangeDrawer>
  );
}
