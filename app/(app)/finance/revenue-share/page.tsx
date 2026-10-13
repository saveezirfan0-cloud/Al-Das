import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { monthLabel } from "@/lib/finance/close-pack";
import { lastClosedMonth } from "@/lib/finance/close-server";
import { money } from "@/lib/finance/format";
import {
  CHARGE_KIND_LABELS,
  percentText,
  readSnapshot,
  ruleSummary,
  type RunResult,
  type RunStatus,
} from "@/lib/finance/revshare";
import {
  loadInputs,
  loadLiability,
  MONTH_RE,
  profileNames,
  sameJson,
} from "@/lib/finance/revshare-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { BuildRunButton, PaymentSheet, PostForm, RunStepButton } from "./controls";
import { RevshareTabs, VIEW_PERMS } from "./tabs";

export const metadata = { title: "Doctor revenue share" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<RunStatus, string> = {
  draft: "Draft",
  verified: "Verified by Finance",
  approved: "Approved by the CEO",
  posted: "Posted to accounting",
  paid: "Paid",
};

function Steps({ r }: { r: RunResult }) {
  const c = r.calc;
  return (
    <div className="grid gap-3 text-xs sm:grid-cols-2">
      <div>
        <div className="font-medium">Revenue by category (net)</div>
        <table className="w-full">
          <tbody>
            {c.categories.map((k) => (
              <tr key={k.category}>
                <td className="py-0.5 pr-2">{k.category}</td>
                <td className="text-right tabular-nums">{money(k.net)}</td>
                <td className="px-2 text-right tabular-nums">
                  × {percentText(k.rate)}
                  {k.rate_source === "category" ? "" : " (default)"}
                </td>
                <td className="text-right tabular-nums">= {money(k.gross)}</td>
              </tr>
            ))}
            {c.categories.length === 0 && (
              <tr>
                <td className="text-muted-foreground py-0.5">No revenue this month</td>
              </tr>
            )}
            <tr className="border-t font-medium">
              <td className="py-0.5">Base</td>
              <td className="text-right tabular-nums">{money(c.base)}</td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1">
        <div className="font-medium">From base to payout</div>
        <div>
          Threshold:{" "}
          {c.threshold === null
            ? "none (all revenue earns a share)"
            : `${money(c.threshold)}; eligible share of revenue ${percentText(c.eligible_fraction)}`}
        </div>
        <div>
          Share earned: <span className="tabular-nums">{money(c.share)}</span>
          {c.threshold !== null && c.categories.length > 0 && (
            <span className="text-muted-foreground">
              {" "}
              ({c.categories.map((k) => `${k.category} ${money(k.earned)}`).join(", ")})
            </span>
          )}
        </div>
        {c.deductions.map((d) => (
          <div key={d.kind}>
            Less {CHARGE_KIND_LABELS[d.kind].toLowerCase()}: {money(d.charges)} ×{" "}
            {percentText(d.share)} = <span className="tabular-nums">−{money(d.deducted)}</span>
          </div>
        ))}
        {c.deductions.length === 0 && <div>No charges this month</div>}
        <div>
          Before guarantee: <span className="tabular-nums">{money(c.before_guarantee)}</span>
        </div>
        <div>
          Minimum guarantee: {c.minimum_guarantee === null ? "none" : money(c.minimum_guarantee)}
        </div>
        <div className="font-medium">
          Payout: <span className="tabular-nums">{money(r.payout)}</span>{" "}
          {c.outcome === "guarantee"
            ? "(the guarantee applies)"
            : c.outcome === "zero"
              ? "(charges exceed the share; never below zero)"
              : ""}
        </div>
        <div className="text-muted-foreground">
          Scheme version {r.scheme_version} from {r.effective_from.slice(0, 7)}:{" "}
          {ruleSummary(r.rule)}. Rule fingerprint{" "}
          <span className="font-mono">{r.rule_hash.slice(0, 12)}</span>
        </div>
      </div>
    </div>
  );
}

export default async function RevenueSharePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VIEW_PERMS)) redirect("/finance");
  const sp = await searchParams;
  const latest = lastClosedMonth(todayIn(member.org.timezone));
  const month = sp.month && MONTH_RE.test(sp.month) && sp.month <= latest ? sp.month : latest;

  // The member's own client: row level security decides what each table returns.
  const supabase = await createClient();
  const admin = createAdminClient(); // service role AFTER the permission check above (functions and names only)
  const [{ data: run }, { data: recent }, liability] = await Promise.all([
    supabase.from("fin_revshare_runs").select("*").eq("month", `${month}-01`).maybeSingle(),
    supabase
      .from("fin_revshare_runs")
      .select("month, status, total_payout")
      .order("month", { ascending: false })
      .limit(12),
    loadLiability(admin, member.orgId),
  ]);
  const { data: lines } = run
    ? await supabase
        .from("fin_revshare_lines")
        .select("id, doctor_dha_id, payout, paid_on, payment_ref, paid_by")
        .eq("run_id", run.id)
    : { data: [] };
  const snap = run ? readSnapshot(run.snapshot) : null;
  const status = (run?.status ?? null) as RunStatus | null;
  const name = await profileNames(admin, [
    run?.built_by,
    run?.verified_by,
    run?.approved_by,
    run?.posted_by,
    ...(lines ?? []).map((l) => l.paid_by),
  ]);
  // Has the month's source data changed since the run was built? (a read failure shows no warning rather than an error page)
  const current =
    run && snap ? await loadInputs(admin, member.orgId, month).catch(() => null) : null;
  const changed = current !== null && !!snap && !sameJson(current, snap.inputs);
  const lineBy = new Map((lines ?? []).map((l) => [l.doctor_dha_id, l]));
  const canManage = can(member, "finance.revshare.manage");
  const canVerify = can(member, "finance.revshare.verify");
  const canApprove = can(member, "finance.revshare.approve");
  const when = (t: string | null) => (t ? new Date(t).toLocaleString("en-GB") : "");

  const trail: Array<{ n: number; label: string; done: boolean; detail: string }> = [
    {
      n: 1,
      label: "Source data",
      done: !!snap,
      detail: snap
        ? `Invoice-line net by doctor and service category for ${monthLabel(`${month}-01`)} (deleted invoices excluded), built ${when(run!.built_at)} by ${name(run!.built_by) ?? "—"}`
        : "Not built yet",
    },
    {
      n: 2,
      label: "Approved formula",
      done: !!snap && snap.results.length > 0,
      detail: snap
        ? `${snap.results.length} doctors with an approved scheme version (shown per doctor below)`
        : "",
    },
    {
      n: 3,
      label: "Exclusions and adjustments",
      done: !!snap,
      detail: snap ? `Doctor charges deducted per scheme: ${money(snap.totals.deducted)}` : "",
    },
    {
      n: 4,
      label: "Calculation",
      done: !!snap,
      detail: snap ? `Payout ${money(snap.totals.payout)} (${snap.calc_version})` : "",
    },
    {
      n: 5,
      label: "Finance verification",
      done: !!run?.verified_at,
      detail: run?.verified_at ? `${name(run.verified_by)}, ${when(run.verified_at)}` : "Waiting",
    },
    {
      n: 6,
      label: "Approval",
      done: !!run?.approved_at,
      detail: run?.approved_at ? `${name(run.approved_by)}, ${when(run.approved_at)}` : "Waiting",
    },
    {
      n: 7,
      label: "Accounting",
      done: !!run?.posted_at,
      detail: run?.posted_at
        ? `${run.posted_ref}, ${name(run.posted_by)}, ${when(run.posted_at)}`
        : "Waiting",
    },
    {
      n: 8,
      label: "Payment",
      done: status === "paid",
      detail: snap
        ? `${(lines ?? []).filter((l) => l.paid_on).length} of ${(lines ?? []).filter((l) => Number(l.payout) > 0).length} doctors paid`
        : "",
    },
    {
      n: 9,
      label: "Payment reference",
      done: status === "paid",
      detail: "Per doctor in the table below",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Doctor revenue share"
        description="Each month's revenue share with its complete trail: source data, approved formula, charges, calculation, Finance verification, CEO approval, accounting and payment references."
      >
        {run && (
          <Button asChild variant="outline">
            <a href={`/api/finance/revenue-share?month=${month}`}>Trail CSV</a>
          </Button>
        )}
      </PageHeader>
      <RevshareTabs active="runs" />

      <div className="flex flex-wrap items-end gap-4">
        <form className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Month</span>
            <Input name="month" type="month" defaultValue={month} max={latest} />
          </label>
          <Button type="submit" variant="outline">
            Show
          </Button>
        </form>
        <Card className="min-w-56">
          <CardContent className="pt-4 text-sm">
            <div className="text-muted-foreground text-xs">Approved, not yet paid (liability)</div>
            <div className="text-lg font-semibold tabular-nums">{money(liability.total)}</div>
            {liability.runs.length > 0 && (
              <div className="text-muted-foreground text-xs">
                {liability.runs.map((r) => `${r.month.slice(0, 7)}: ${money(r.unpaid)}`).join("; ")}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {monthLabel(`${month}-01`)}
            <Badge variant={status === "paid" ? "success" : status ? "secondary" : "outline"}>
              {status ? STATUS_LABEL[status] : "Not built"}
            </Badge>
          </CardTitle>
          {run && (
            <CardDescription>
              Fingerprint of these figures:{" "}
              <span className="font-mono text-xs break-all">{run.snapshot_hash}</span>
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <ol className="grid gap-1 sm:grid-cols-3">
            {trail.map((t) => (
              <li key={t.n} className="flex gap-2">
                <Badge
                  variant={t.done ? "success" : "outline"}
                  className="h-5 w-5 justify-center p-0"
                >
                  {t.n}
                </Badge>
                <span>
                  <span className="font-medium">{t.label}</span>
                  {t.detail && (
                    <span className="text-muted-foreground block text-xs">{t.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>

          {changed && (
            <Alert variant={status === "draft" ? "default" : "destructive"}>
              <AlertTitle>The source data changed</AlertTitle>
              <AlertDescription>
                {status === "draft"
                  ? "Invoices, charges or schemes for this month changed since the draft was built. Rebuild it before verifying."
                  : "Invoices or schemes for this month changed after the run was verified. The run does not change; review whether a correction is needed next month."}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {(!run || status === "draft") && canManage && (
              <BuildRunButton month={month} rebuild={!!run} />
            )}
            {status === "draft" && run && canVerify && (
              <RunStepButton step="verify" id={run.id} month={month} hash={run.snapshot_hash} />
            )}
            {status === "verified" &&
              run &&
              canApprove &&
              (run.verified_by === member.userId ? (
                <span className="text-muted-foreground">
                  You verified this run, so a different person must approve it.
                </span>
              ) : (
                <RunStepButton step="approve" id={run.id} month={month} hash={run.snapshot_hash} />
              ))}
            {status === "verified" && run && canVerify && (
              <RunStepButton step="withdraw" id={run.id} month={month} hash={run.snapshot_hash} />
            )}
            {!run && !canManage && (
              <span className="text-muted-foreground">
                Not built yet. Finance builds the draft.
              </span>
            )}
          </div>
          {status === "approved" && run && canManage && (
            <div className="max-w-md">
              <PostForm id={run.id} month={month} />
            </div>
          )}
        </CardContent>
      </Card>

      {snap && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Doctors</CardTitle>
            <CardDescription>
              Revenue is the net of current invoice lines on the doctor basis set under Workflow
              settings (
              {snap.inputs && typeof snap.inputs === "object" && "doctor_basis" in snap.inputs
                ? String(
                    (snap.inputs as { doctor_basis: string | null }).doctor_basis ??
                      "invoice doctor",
                  )
                : "invoice doctor"}
              ). Open a doctor to see every step.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Doctor</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead className="text-right">Deducted</TableHead>
                  <TableHead className="text-right">Payout</TableHead>
                  <TableHead>Payment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snap.results.map((r) => {
                  const l = lineBy.get(r.doctor_dha_id);
                  return (
                    <TableRow key={r.doctor_dha_id}>
                      <TableCell className="align-top text-xs" colSpan={1}>
                        <details>
                          <summary className="cursor-pointer">
                            {r.doctor_name ?? r.doctor_dha_id}{" "}
                            <span className="text-muted-foreground">{r.doctor_dha_id}</span>
                          </summary>
                          <div className="mt-2 w-[min(90vw,48rem)]">
                            <Steps r={r} />
                          </div>
                        </details>
                      </TableCell>
                      <TableCell className="text-right align-top text-xs tabular-nums">
                        {money(r.calc.base)}
                      </TableCell>
                      <TableCell className="text-right align-top text-xs tabular-nums">
                        {money(r.calc.share)}
                      </TableCell>
                      <TableCell className="text-right align-top text-xs tabular-nums">
                        {money(r.calc.total_deductions)}
                      </TableCell>
                      <TableCell className="text-right align-top text-xs font-medium tabular-nums">
                        {money(r.payout)}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {l?.paid_on
                          ? `${l.paid_on}, ${l.payment_ref}`
                          : r.payout > 0
                            ? "Not paid"
                            : "Nothing to pay"}
                        {status === "posted" && canManage && l && r.payout > 0 && (
                          <div className="mt-1">
                            <PaymentSheet
                              lineId={l.id}
                              month={month}
                              doctor={r.doctor_name ?? r.doctor_dha_id}
                              paidOn={l.paid_on}
                              paymentRef={l.payment_ref}
                            />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="font-medium">
                  <TableCell className="text-xs">Total ({snap.totals.doctors} doctors)</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(snap.totals.revenue)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(snap.totals.share)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(snap.totals.deducted)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(snap.totals.payout)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {snap && (snap.no_scheme.length > 0 || snap.unassigned_revenue !== 0) && (
        <Alert>
          <AlertTitle>Not in this run</AlertTitle>
          <AlertDescription className="flex flex-col gap-1 text-xs">
            {snap.no_scheme.map((n) => (
              <span key={n.doctor_dha_id}>
                {n.doctor_name ?? n.doctor_dha_id} ({n.doctor_dha_id}): no approved scheme for this
                month; revenue {money(n.revenue)}, charges {money(n.charges)}.
              </span>
            ))}
            {snap.unassigned_revenue !== 0 && (
              <span>Revenue with no doctor on the invoice: {money(snap.unassigned_revenue)}.</span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {(recent ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent months</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Payout</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent ?? []).map((r) => (
                  <TableRow key={r.month}>
                    <TableCell className="text-xs">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/finance/revenue-share?month=${r.month.slice(0, 7)}`}
                      >
                        {monthLabel(r.month)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">
                      {STATUS_LABEL[r.status as RunStatus] ?? r.status}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {money(r.total_payout)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
