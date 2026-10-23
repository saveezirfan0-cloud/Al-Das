import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  ageingBuckets,
  daysBetween,
  followupFrom,
  OUTCOME_LABELS,
  parseWorklist,
  stageLabel,
  stageReached,
  type FollowupAgeBasis,
  type FollowupOutcome,
} from "@/lib/finance/followup";
import {
  buildSubmissionSequence,
  MODE_LABELS,
  ordinal,
  type SequenceEvent,
} from "@/lib/finance/submission-sequence";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { ClaimDrawer, FollowupForm } from "./followup-controls";

export const metadata = { title: "Insurance follow-up" };
export const dynamic = "force-dynamic";

type Search = { stage?: string; payer?: string; branch?: string; claim?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: string | undefined, max: number) =>
  (v ?? "")
    .replace(/[^A-Za-z0-9 ._()-]/g, "")
    .trim()
    .slice(0, max);
const fmtDate = (v: string | null | undefined) => (v ? v.slice(0, 10) : "—");

export default async function FollowupPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.claims.view");
  const sp = await searchParams;
  const today = todayIn(member.org.timezone);
  const stage = /^\d{1,4}$/.test(sp.stage ?? "") ? Number(sp.stage) : null;
  const payer = clean(sp.payer, 60) || null;
  const branch = clean(sp.branch, 8).toUpperCase() || null;
  const claimId = UUID.test(sp.claim ?? "") ? (sp.claim as string) : null;

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data } = await admin.rpc("fin_followup_worklist", {
    p_org_id: member.orgId,
    p_today: today,
    p_stage: stage ?? undefined,
    p_payer: payer ?? undefined,
    p_branch: branch ?? undefined,
    p_limit: 500,
  });
  const w = parseWorklist(data);
  await recordAccess(admin, member, { entity: "finance_claim", action: "list" });
  const buckets = ageingBuckets(w.bucketDays);
  const canWrite = can(member, "finance.followup.manage");

  const qs = (over: Partial<Record<keyof Search, string | null>>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | null> = {
      stage: stage === null ? null : String(stage),
      payer,
      branch,
      claim: null,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/finance/followup?${s}` : "/finance/followup";
  };
  const stageCount = (s: number | null) => w.byStage.find((b) => b.stage === s);
  const allCount = w.byStage.reduce((n, b) => n + b.claims, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Insurance follow-up"
        description={`Unpaid insurance claims as of ${w.today || today}, oldest first, with the follow-up stage each has reached (${w.stageDays.join(", ")} days after ${w.ageBasis === "visit" ? "the visit" : "submission"}). Amounts in AED.`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/finance/receivables">Receivables by age</Link>
        </Button>
      </PageHeader>

      {!w.tasksEnabled && (
        <Alert>
          <AlertTitle>Follow-up tasks are off</AlertTitle>
          <AlertDescription>
            This list always works. To get a task for each claim as it reaches a stage, set
            &ldquo;Create follow-up tasks from&rdquo; in Settings, Finance workflow settings. Stages
            reached before that date never create a task.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant={stage === null ? "default" : "outline"}>
          <Link href={qs({ stage: null })}>All open ({allCount.toLocaleString()})</Link>
        </Button>
        {w.stageDays.map((s) => (
          <Button key={s} asChild size="sm" variant={stage === s ? "default" : "outline"}>
            <Link href={qs({ stage: String(s) })}>
              {s} days ({(stageCount(s)?.claims ?? 0).toLocaleString()})
            </Link>
          </Button>
        ))}
        <Button asChild size="sm" variant={stage === 0 ? "default" : "outline"}>
          <Link href={qs({ stage: "0" })}>
            Not yet due ({(stageCount(null)?.claims ?? 0).toLocaleString()})
          </Link>
        </Button>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        {stage !== null && <input type="hidden" name="stage" value={stage} />}
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Payer</span>
          <select
            name="payer"
            defaultValue={payer ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="">All payers</option>
            {w.payers.map((p) => (
              <option key={p.payerId} value={p.payerId}>
                {p.payerName ? `${p.payerName} (${p.payerId})` : p.payerId}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Branch</span>
          <select
            name="branch"
            defaultValue={branch ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="">All branches</option>
            {w.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {w.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No unpaid claims match. Claims appear after a Diligence report is imported.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground mb-3 text-xs">
                {w.total.toLocaleString()} claim(s), {money(w.totalOutstanding)} outstanding
                {w.total > w.rows.length ? `; showing the oldest ${w.rows.length}` : ""}.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Claim</TableHead>
                    <TableHead>Payer</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Claim date</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Resubmitted</TableHead>
                    <TableHead>Last follow-up</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {w.rows.map((r) => (
                    <TableRow key={r.id} data-state={r.id === claimId ? "selected" : undefined}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={qs({ claim: r.id })}
                          scroll={false}
                          className="underline-offset-2 hover:underline"
                        >
                          {r.claimActivityNumber}
                        </Link>
                        {r.invoiceNo && <div className="text-muted-foreground">{r.invoiceNo}</div>}
                      </TableCell>
                      <TableCell className="text-xs">{r.payerName ?? r.payerId ?? "—"}</TableCell>
                      <TableCell className="text-xs">{r.branch ?? "—"}</TableCell>
                      <TableCell className="text-xs">{fmtDate(r.transactionDate)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.ageDays === null ? "—" : r.ageDays}
                        {r.bucket !== null && (
                          <div className="text-muted-foreground">{buckets[r.bucket]?.label}</div>
                        )}
                        {w.ageBasis === "submission" &&
                          r.followupAgeDays !== null &&
                          r.followupAgeDays !== r.ageDays && (
                            <div className="text-muted-foreground">
                              {r.followupAgeDays} since resubmission
                            </div>
                          )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.stage === null
                              ? "outline"
                              : r.stage === w.stageDays[w.stageDays.length - 1]
                                ? "destructive"
                                : "warning"
                          }
                        >
                          {stageLabel(r.stage)}
                        </Badge>
                        {r.task && r.task.taskId && (
                          <div className="text-muted-foreground mt-1 text-xs">
                            task {r.task.done ? "done" : "open"}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {money(r.outstanding)}
                        {r.rejected > 0 && (
                          <div className="text-muted-foreground">rejected {money(r.rejected)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.resubmissionCount > 0
                          ? `${r.resubmissionCount}x, last ${fmtDate(r.lastResubmissionDate)}`
                          : "—"}
                      </TableCell>
                      <TableCell className="max-w-56 text-xs">
                        {r.lastFollowup ? (
                          <>
                            <div>
                              {OUTCOME_LABELS[r.lastFollowup.outcome]},{" "}
                              {fmtDate(r.lastFollowup.createdAt)}
                            </div>
                            {r.lastFollowup.nextActionDate && (
                              <div
                                className={
                                  r.lastFollowup.nextActionDate <= today
                                    ? "font-medium text-amber-700 dark:text-amber-400"
                                    : "text-muted-foreground"
                                }
                              >
                                next {r.lastFollowup.nextActionDate}
                              </div>
                            )}
                            {r.lastFollowup.note && (
                              <div className="text-muted-foreground truncate">
                                {r.lastFollowup.note}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">None yet</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      {claimId && (
        <ClaimPanel
          claimId={claimId}
          today={today}
          stageDays={w.stageDays}
          ageBasis={w.ageBasis}
          canWrite={canWrite}
          closeHref={qs({ claim: null })}
          member={member}
        />
      )}
    </div>
  );
}

async function ClaimPanel({
  claimId,
  today,
  stageDays,
  ageBasis,
  canWrite,
  closeHref,
  member,
}: {
  claimId: string;
  today: string;
  stageDays: number[];
  ageBasis: FollowupAgeBasis;
  canWrite: boolean;
  closeHref: string;
  member: Awaited<ReturnType<typeof requirePerm>>;
}) {
  // the member's own client: row level security decides (finance.claims.view)
  const supabase = await createClient();
  const { data: claim } = await supabase
    .from("ins_claim_activities")
    .select(
      "id, claim_activity_number, invoice_no, payer_id, transaction_date, initial_net, initial_rejected, net, remitted, rejected, write_off, write_off_status, resubmission_count, last_resubmission_date, last_remittance_date, claim_status",
    )
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return null;
  await recordAccess(createAdminClient(), member, {
    entity: "finance_claim",
    entityId: claimId,
    action: "view",
  });
  const [{ data: events }, { data: followups }, { data: people }] = await Promise.all([
    supabase
      .from("ins_claim_activity_events")
      .select("observed_at, changed_fields")
      .eq("claim_activity_id", claimId)
      .order("observed_at", { ascending: true })
      .limit(500),
    supabase
      .from("ins_claim_followups")
      .select("id, stage, outcome, note, next_action_date, created_by, created_at")
      .eq("claim_activity_id", claimId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("profiles").select("id, first_name, last_name"),
  ]);
  const names = new Map(
    (people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim() || "—"]),
  );
  const seq = buildSubmissionSequence(
    {
      transactionDate: claim.transaction_date,
      initialNet: claim.initial_net,
      initialRejected: claim.initial_rejected,
      net: claim.net,
      remitted: claim.remitted,
      rejected: claim.rejected,
      resubmissionCount: claim.resubmission_count,
      lastResubmissionDate: claim.last_resubmission_date,
      lastRemittanceDate: claim.last_remittance_date,
    },
    (events ?? []).map((e): SequenceEvent => ({
      observedAt: e.observed_at,
      changedFields: (e.changed_fields ?? {}) as SequenceEvent["changedFields"],
    })),
  );
  const age = daysBetween(claim.transaction_date, today);
  const stage = stageReached(
    daysBetween(
      followupFrom(
        {
          transactionDate: claim.transaction_date,
          lastResubmissionDate: claim.last_resubmission_date,
        },
        ageBasis,
      ),
      today,
    ),
    stageDays,
  );

  return (
    <ClaimDrawer
      title={`Claim ${claim.claim_activity_number}`}
      description={`${claim.payer_id ?? "No payer"} · claim date ${fmtDate(claim.transaction_date)} · ${age === null ? "no age" : `${age} days`} · ${stageLabel(stage)}`}
      closeHref={closeHref}
    >
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Submissions</h3>
        <p className="text-muted-foreground text-xs">
          Rebuilt from the Diligence uploads Pulse has seen. Whether a resubmission was a correction
          (the whole amount sent back, including what was paid) is inferred from the amounts:
          Diligence&apos;s report does not say.
        </p>
        <ol className="flex flex-col gap-3">
          {seq.steps.map((s) => (
            <li key={s.n} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{ordinal(s.n)} submission</span>
                <Badge variant={s.mode === "correction" ? "warning" : "secondary"}>
                  {MODE_LABELS[s.mode]}
                </Badge>
                {s.current && <Badge variant="outline">current</Badge>}
                {s.amended && <Badge variant="outline">amount amended</Badge>}
              </div>
              {s.inferred ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  Known only from the resubmission count; no upload captured its figures.
                </p>
              ) : (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Date</dt>
                  <dd>{fmtDate(s.date)}</dd>
                  <dt className="text-muted-foreground">Claimed</dt>
                  <dd className="tabular-nums">{money(s.claimed)}</dd>
                  <dt className="text-muted-foreground">Remitted in this step</dt>
                  <dd className="tabular-nums">
                    {s.remittedInStep === null ? "not known" : money(s.remittedInStep)}
                  </dd>
                  <dt className="text-muted-foreground">Remitted so far</dt>
                  <dd className="tabular-nums">{money(s.remittedCumulative)}</dd>
                  <dt className="text-muted-foreground">Rejected</dt>
                  <dd className="tabular-nums">{money(s.rejected)}</dd>
                  {s.observedAt && (
                    <>
                      <dt className="text-muted-foreground">First seen in upload</dt>
                      <dd>{fmtDate(s.observedAt)}</dd>
                    </>
                  )}
                </dl>
              )}
            </li>
          ))}
        </ol>
        {seq.remittedExceedsClaimed && (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Remitted so far is more than any amount claimed. A correction&apos;s remittance may
            repeat what was already paid: check against the bank and the remittance received.
          </p>
        )}
        {!seq.complete && (
          <p className="text-muted-foreground text-xs">
            Part of this history happened before Pulse saw the claim, so some figures are missing.
          </p>
        )}
      </section>

      {canWrite && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Record a follow-up</h3>
          <FollowupForm claimId={claim.id} minDate={today} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Follow-up history</h3>
        {(followups ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {(followups ?? []).map((f) => (
              <li key={f.id} className="border-l-2 pl-3 text-sm">
                <div className="text-muted-foreground text-xs">
                  {new Date(f.created_at).toLocaleString("en-GB")} ·{" "}
                  {(f.created_by && names.get(f.created_by)) || "—"} · {stageLabel(f.stage)}
                </div>
                <div className="font-medium">
                  {OUTCOME_LABELS[f.outcome as FollowupOutcome] ?? f.outcome}
                </div>
                {f.note && <p className="whitespace-pre-wrap">{f.note}</p>}
                {f.next_action_date && (
                  <div className="text-muted-foreground text-xs">
                    Next action {f.next_action_date}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <Button asChild variant="outline" size="sm" className="w-fit">
        <Link href={`/finance/claims/${claim.id}`}>Open the full claim</Link>
      </Button>
    </ClaimDrawer>
  );
}
