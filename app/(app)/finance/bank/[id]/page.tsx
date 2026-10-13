import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { readAiSettings } from "@/lib/ai/settings";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import {
  AI_REASON_CODES,
  suggestionQuality,
  type AiReasonCode,
  type SuggestionDecision,
} from "@/lib/finance/bank-ai";
import {
  AGE_BUCKETS,
  bankItemKey,
  RECON_REASONS,
  type AgeBucket,
  type ExpectedItem,
} from "@/lib/finance/bank-recon";
import { loadRun } from "@/lib/finance/bank-server";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  AiDecideButtons,
  AskAiButton,
  DecideButtons,
  ReasonForm,
  ReopenButton,
  ReviewButton,
  RunMatchingButton,
  SignButton,
  UndoMatchButton,
} from "./run-forms";

export const metadata = { title: "Bank reconciliation" };
export const dynamic = "force-dynamic";

const KIND: Record<ExpectedItem["kind"], string> = {
  collection: "Unite collections",
  payout: "Processor payout",
  insurance: "Insurance remittance",
  gap: "Unite vs processor",
};
const BUCKET: Record<AgeBucket, string> = {
  waiting: "Within the window / in transit",
  "0-7": "0-7 days late",
  "8-30": "8-30 days late",
  "31-60": "31-60 days late",
  "60+": "Over 60 days late",
};
const EXPECTED_REASONS = Object.entries(RECON_REASONS).filter(
  ([k]) => !["internal_transfer", "other_income"].includes(k),
);
const BANK_REASONS = Object.entries(RECON_REASONS).filter(([k]) =>
  [
    "other_period",
    "internal_transfer",
    "other_income",
    "other_account",
    "bank_query",
    "chargeback",
    "other",
  ].includes(k),
);

function ItemCell({ item }: { item: ExpectedItem }) {
  return (
    <div className="flex flex-col">
      <span>
        {KIND[item.kind]}
        {item.mode ? `: ${item.mode}` : ""}
      </span>
      <span className="text-muted-foreground text-xs">
        {item.kind === "payout" ? "Payout" : "Of"} {item.sourceDate}; expected {item.expectedDate}
        {item.fee ? `; gross ${money(item.gross)}, fee ${money(item.fee)}` : ""}
        {item.references.length ? `; ref ${item.references.join(", ")}` : ""}
      </span>
    </div>
  );
}

export default async function BankRunPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("finance.bank.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const run = await loadRun(admin, member.orgId, id, todayIn(member.org.timezone));
  if (!run) notFound();
  const { rec, account, result: r } = run;
  const manage = can(member, "finance.bank.manage");
  const signoff = can(member, "finance.bank.signoff");
  const open = rec.status === "open";
  const editable = manage && open;

  const people = [rec.prepared_by, rec.signed_by].filter((x): x is string => !!x);
  const { data: profiles } = people.length
    ? await admin.from("profiles").select("id, first_name, last_name").in("id", people)
    : { data: [] };
  const nameOf = (uid: string | null) => {
    const p = (profiles ?? []).find((x) => x.id === uid);
    return p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "a team member" : "";
  };
  const lineText = (lineId: string) => {
    const l = run.lines.get(lineId);
    return l ? [l.valueDate, l.reference, l.description].filter(Boolean).join(" · ") : "";
  };
  const s = r.summary;

  // Phase 20H: the latest AI review and every AI suggestion on this run (the quality line counts them all)
  const [{ data: aiReviews }, { data: aiRows }] = await Promise.all([
    admin
      .from("fin_bank_ai_reviews")
      .select("id, status, summary, reject_reason, item_count, suggestion_count, created_at")
      .eq("org_id", member.orgId)
      .eq("rec_id", rec.id)
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("fin_bank_ai_suggestions")
      .select("id, review_id, item_key, candidate_line_id, reason_code, confidence, decision")
      .eq("org_id", member.orgId)
      .eq("rec_id", rec.id)
      .order("created_at"),
  ]);
  const latestReview = aiReviews?.[0] ?? null;
  const suggestions = aiRows ?? [];
  const quality = suggestionQuality(
    suggestions.map((x) => ({ reviewId: x.review_id, decision: x.decision as SuggestionDecision })),
    latestReview?.id ?? null,
  );
  const latestSuggestions = suggestions.filter((x) => x.review_id === latestReview?.id);
  const aiAllowed = can(member, "finance.bank.ai");
  const aiBlocked = !open
    ? "Only an open reconciliation can be reviewed."
    : !aiAllowed
      ? "Needs the permission AI review of bank reconciliation."
      : !readAiSettings(member.org.settings).enabled
        ? "AI is turned off for this workspace. An administrator can turn it on in Settings, AI & knowledge base."
        : null;
  const itemOf = (key: string) => r.items.find((i) => i.key === key) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${account.name} (•••• ${account.last4}): ${rec.month.slice(0, 7)}`}
        description={`Period ${rec.period_start} to ${rec.period_end}. Statement imported up to ${r.asOf ?? "nothing yet"}. Amounts in ${account.currency}.`}
      >
        <Button asChild variant="outline">
          <Link href="/finance/bank">All reconciliations</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            Status:{" "}
            <Badge variant={rec.status === "signed" ? "default" : "secondary"}>
              {rec.status === "open" ? "Open" : rec.status === "reviewed" ? "Reviewed" : "Signed"}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {editable && r.autoReady.length > 0 && (
              <RunMatchingButton recId={rec.id} count={r.autoReady.length} />
            )}
            {editable && r.problems.length === 0 && <ReviewButton recId={rec.id} />}
            {manage && rec.status === "reviewed" && <ReopenButton recId={rec.id} />}
            {signoff &&
              rec.status === "reviewed" &&
              rec.figures_sha256 &&
              rec.prepared_by !== member.userId && (
                <SignButton recId={rec.id} hash={rec.figures_sha256} />
              )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {rec.status !== "open" && (
            <p>
              Reviewed by {nameOf(rec.prepared_by)} on {rec.prepared_at?.slice(0, 10)}
              {rec.status === "signed"
                ? `; signed by ${nameOf(rec.signed_by)} on ${rec.signed_at?.slice(0, 10)}`
                : ""}
              . Figures fingerprint{" "}
              <span className="font-mono text-xs">{rec.figures_sha256?.slice(0, 16)}</span>.
              {rec.status !== "signed" &&
                rec.prepared_by === member.userId &&
                " Another person must sign it."}
            </p>
          )}
          {open && r.problems.length > 0 && (
            <Alert>
              <AlertTitle>Before it can be marked reviewed</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {r.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {rec.status !== "open" && (
            <p className="text-muted-foreground text-xs">
              The lists below are worked out from the data as it is now; the reviewed figures are
              frozen with their fingerprint.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Expected receipts"
              value={`${s.expectedCount} / ${money(s.expectedAmount)}`}
            />
            <Stat
              label="Matched (bank amount)"
              value={`${s.matchedCount} / ${money(s.matchedBank)}`}
              hint={
                s.matchedDifference
                  ? `Bank minus expected on matched items: ${money(s.matchedDifference)}`
                  : undefined
              }
            />
            <Stat label="Proposed / ready to save" value={`${s.proposed} / ${s.autoReady}`} />
            {AGE_BUCKETS.map((b) => (
              <Stat
                key={b}
                label={`Not received: ${BUCKET[b]}`}
                value={`${s.unmatched[b].count} / ${money(s.unmatched[b].amount)}`}
              />
            ))}
            <Stat
              label="Unite vs processor differences"
              value={`${s.gaps.count} / ${money(s.gaps.amount)}`}
            />
            <Stat
              label="Unmatched bank credits"
              value={`${s.bankUnmatched.count} / ${money(s.bankUnmatched.amount)}`}
            />
            <Stat
              label="Bank debits in the period (not reconciled here)"
              value={`${s.bankDebits.count} / ${money(s.bankDebits.amount)}`}
            />
          </div>
        </CardContent>
      </Card>

      {(manage || latestReview) && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <CardTitle className="text-base">AI review</CardTitle>
              <CardDescription>
                The AI sees ids, amounts, dates, payment modes and references only, and can only
                suggest a bank line from Pulse&apos;s own candidates. Nothing changes until a person
                accepts a suggestion.
              </CardDescription>
            </div>
            {manage &&
              (aiBlocked ? (
                <div className="flex max-w-xs flex-col items-end gap-1">
                  <Button size="sm" variant="outline" disabled>
                    Ask AI to review
                  </Button>
                  <span className="text-muted-foreground text-right text-xs">{aiBlocked}</span>
                </div>
              ) : (
                <AskAiButton recId={rec.id} />
              ))}
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {suggestions.length > 0 && (
              <p className="text-muted-foreground text-xs">
                AI suggestions on this reconciliation: {quality.accepted} accepted,{" "}
                {quality.rejected} rejected, {quality.pending} waiting for a decision
                {quality.superseded
                  ? `, ${quality.superseded} from earlier reviews never decided`
                  : ""}
                .
              </p>
            )}
            {!latestReview ? (
              <p className="text-muted-foreground text-sm">No AI review yet.</p>
            ) : latestReview.status === "rejected" ? (
              <Alert>
                <AlertTitle>The last AI answer was rejected by the checks</AlertTitle>
                <AlertDescription>
                  Nothing was suggested ({latestReview.created_at.slice(0, 10)}).{" "}
                  {latestReview.reject_reason}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="rounded-md border border-dashed p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge variant="outline">AI draft, check before relying on it</Badge>
                    <span className="text-muted-foreground text-xs">
                      {latestReview.created_at.slice(0, 10)}; {latestReview.item_count} item(s)
                      reviewed
                    </span>
                  </div>
                  <p className="whitespace-pre-line">{latestReview.summary}</p>
                </div>
                {latestSuggestions.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Open item</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>AI suggests</TableHead>
                        <TableHead>Why</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {latestSuggestions.map((x) => {
                        const item = itemOf(x.item_key);
                        const lineId = x.item_key.startsWith("bank|") ? x.item_key.slice(5) : null;
                        const amount = item
                          ? item.amount
                          : lineId
                            ? run.lines.get(lineId)?.amount
                            : undefined;
                        return (
                          <TableRow key={x.id}>
                            <TableCell>
                              {item ? (
                                <ItemCell item={item} />
                              ) : lineId && run.lines.has(lineId) ? (
                                <span className="text-xs">Bank credit: {lineText(lineId)}</span>
                              ) : (
                                <span className="text-muted-foreground text-xs">
                                  No longer open
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {amount === undefined ? "" : money(amount)}
                            </TableCell>
                            <TableCell className="text-xs">
                              {x.candidate_line_id ? (
                                <>
                                  Match with {lineText(x.candidate_line_id) || "a bank line"}
                                  {run.lines.get(x.candidate_line_id)
                                    ? ` (${money(run.lines.get(x.candidate_line_id)!.amount)})`
                                    : ""}
                                </>
                              ) : (
                                "No match"
                              )}
                            </TableCell>
                            <TableCell className="text-xs">
                              {AI_REASON_CODES[x.reason_code as AiReasonCode] ?? x.reason_code};{" "}
                              {x.confidence} confidence
                            </TableCell>
                            <TableCell>
                              {x.decision !== "pending" ? (
                                <Badge variant="secondary">
                                  {x.decision === "accepted" ? "Accepted" : "Rejected"}
                                </Badge>
                              ) : editable && aiAllowed ? (
                                <AiDecideButtons
                                  recId={rec.id}
                                  suggestionId={x.id}
                                  pair={!!x.candidate_line_id}
                                />
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {r.notReconciled.length > 0 && (
        <Alert>
          <AlertTitle>Collections not reconciled in any account yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {r.notReconciled.map((n) => (
                <li key={n.mode}>
                  {n.mode}: {money(n.gross)} over {n.days} day(s). {n.why}.
                </li>
              ))}
            </ul>
            {manage && (
              <Link className="underline" href="/finance/bank/settings">
                Set the rules
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      {r.autoReady.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Ready to match automatically ({r.autoReady.length})
            </CardTitle>
            <CardDescription>
              The only candidate on both sides, scoring at least the auto-accept threshold.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Expected amount</TableHead>
                  <TableHead className="text-right">Bank amount</TableHead>
                  <TableHead>Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.autoReady.map(({ item, candidate }) => (
                  <TableRow key={item.key}>
                    <TableCell>
                      <ItemCell item={item} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(item.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(candidate.bankAmount)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {candidate.score}: {candidate.reasons.join("; ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Proposed matches ({r.proposals.length})</CardTitle>
          <CardDescription>
            A person decides. &quot;Several fit&quot; means more than one pairing is possible: Pulse
            never picks one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r.proposals.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing to decide.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Expected amount</TableHead>
                  <TableHead>Bank line</TableHead>
                  <TableHead className="text-right">Bank amount</TableHead>
                  <TableHead>Score and reasons</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.proposals.flatMap(({ item, candidates }) =>
                  candidates.map((c, idx) => (
                    <TableRow key={`${item.key}|${c.lineId}`}>
                      <TableCell>{idx === 0 ? <ItemCell item={item} /> : null}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {idx === 0 ? money(item.amount) : ""}
                      </TableCell>
                      <TableCell className="text-xs">{lineText(c.lineId)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(c.bankAmount)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-medium">{c.score}</span>
                        {c.ambiguous && (
                          <Badge variant="destructive" className="ml-2">
                            Several fit
                          </Badge>
                        )}
                        <div>{c.reasons.join("; ")}</div>
                      </TableCell>
                      <TableCell>
                        {editable && (
                          <DecideButtons recId={rec.id} itemKey={item.key} lineId={c.lineId} />
                        )}
                      </TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Expected but not found in the bank ({r.unmatched.length})
          </CardTitle>
          <CardDescription>
            Aged from the expected date to the last statement date. Past the date window each item
            needs a reason.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r.unmatched.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing outstanding.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.unmatched.map((u) => (
                  <TableRow key={u.item.key}>
                    <TableCell>
                      <ItemCell item={u.item} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(u.item.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.needsReason && !u.note ? "destructive" : "outline"}>
                        {BUCKET[u.bucket]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {editable ? (
                        <ReasonForm
                          recId={rec.id}
                          itemKey={u.item.key}
                          reasons={EXPECTED_REASONS}
                          code={u.note?.code ?? null}
                          note={u.note?.note ?? null}
                        />
                      ) : (
                        <ReasonText code={u.note?.code} note={u.note?.note} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Bank credits with no match ({r.bankUnmatched.length})
          </CardTitle>
          <CardDescription>
            Money in during the period that no expected receipt explains. Each needs a reason.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r.bankUnmatched.length === 0 ? (
            <p className="text-muted-foreground text-sm">None.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bank line</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.bankUnmatched.map(({ line, note }) => (
                  <TableRow key={line.id}>
                    <TableCell className="text-xs">{lineText(line.id)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.amount)}</TableCell>
                    <TableCell>
                      {editable ? (
                        <ReasonForm
                          recId={rec.id}
                          itemKey={bankItemKey(line.id)}
                          reasons={BANK_REASONS}
                          code={note?.code ?? null}
                          note={note?.note ?? null}
                        />
                      ) : (
                        <ReasonText code={note?.code} note={note?.note} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matched ({r.matched.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {r.matched.length === 0 ? (
            <p className="text-muted-foreground text-sm">No matches saved yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Expected</TableHead>
                  <TableHead className="text-right">Expected amount</TableHead>
                  <TableHead>Bank line</TableHead>
                  <TableHead className="text-right">Bank amount</TableHead>
                  <TableHead>How</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.matched.map((m) => (
                  <TableRow key={`${m.expectedKey}|${m.lineId}`}>
                    <TableCell>
                      {m.item ? (
                        <ItemCell item={m.item} />
                      ) : (
                        <span className="text-destructive">No longer expected</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.item ? money(m.item.amount) : ""}
                    </TableCell>
                    <TableCell className="text-xs">
                      {m.line ? lineText(m.lineId) : "Line removed"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.line ? money(m.line.amount) : ""}
                    </TableCell>
                    <TableCell className="text-xs">
                      {m.auto ? "Automatic" : "Accepted"} ({m.score})
                      {m.changed && (
                        <Badge variant="destructive" className="ml-2">
                          Changed since
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {editable && (
                        <UndoMatchButton recId={rec.id} itemKey={m.expectedKey} lineId={m.lineId} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

function ReasonText({ code, note }: { code?: string | null; note?: string | null }) {
  if (!code) return <span className="text-muted-foreground text-xs">No reason given</span>;
  return (
    <span className="text-xs">
      {RECON_REASONS[code as keyof typeof RECON_REASONS] ?? code}
      {note ? `: ${note}` : ""}
    </span>
  );
}
