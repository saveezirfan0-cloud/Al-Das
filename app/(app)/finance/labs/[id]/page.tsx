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
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn, uuid } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { LAB_REASONS, maskPin, PROVIDER_KINDS, type LabNote } from "@/lib/finance/labs";
import { loadStatement } from "@/lib/finance/labs-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { PostButton, ReasonForm, RemoveFileButton, ReopenButton, ReviewButton } from "../forms";

export const metadata = { title: "Lab statement" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  open: { label: "Open", variant: "outline" },
  reviewed: { label: "Reviewed, waiting to be posted", variant: "secondary" },
  posted: { label: "Posted to doctor charges", variant: "default" },
};
const WHY: Record<string, string> = {
  no_pin: "No PIN on the file",
  no_candidate: "Nothing in Unite",
  ambiguous: "Several fit (never guessed)",
};
const REASONS = Object.entries(LAB_REASONS) as Array<[string, string]>;
const MAX_ROWS = 300;

function More({ total }: { total: number }) {
  if (total <= MAX_ROWS) return null;
  return (
    <p className="text-muted-foreground mt-2 text-xs">
      Showing the first {MAX_ROWS} of {total}.
    </p>
  );
}

function Reason({
  note,
  statementId,
  itemKey,
  editable,
}: {
  note: LabNote | null;
  statementId: string;
  itemKey: string;
  editable: boolean;
}) {
  if (note && !editable)
    return (
      <span className="text-xs">
        {LAB_REASONS[note.code as keyof typeof LAB_REASONS] ?? note.code}
        {note.note ? `: ${note.note}` : ""}
      </span>
    );
  if (!editable) return <span className="text-muted-foreground text-xs">No reason</span>;
  return (
    <div className="flex flex-col gap-1">
      {note && (
        <span className="text-xs">
          {LAB_REASONS[note.code as keyof typeof LAB_REASONS] ?? note.code}
          {note.note ? `: ${note.note}` : ""}
        </span>
      )}
      <ReasonForm statementId={statementId} itemKey={itemKey} reasons={REASONS} />
    </div>
  );
}

export default async function LabStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const member = await requirePerm("finance.labs.view");
  const manage = can(member, "finance.labs.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const loaded = await loadStatement(admin, member.orgId, id, todayIn(member.org.timezone));
  if (!loaded) notFound();
  const { statement, provider, files, result, settings } = loaded;
  const editable = manage && statement.status === "open";
  const { data: doctorRows } = await admin
    .from("fin_ref_doctors")
    .select("dha_id, name")
    .eq("org_id", member.orgId);
  const doctorName = new Map((doctorRows ?? []).map((d) => [d.dha_id.toUpperCase(), d.name]));
  const doc = (d: string | null) =>
    d ? `${doctorName.get(d.toUpperCase()) ?? ""} ${d}`.trim() : "No doctor";
  const st = STATUS[statement.status] ?? STATUS.open;
  const s = result.summary;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${provider.name}, ${statement.month.slice(0, 7)}`}
        description={`${PROVIDER_KINDS[provider.kind]}. Lines are matched to Unite by PIN, code (item code or CPT) and date within ${settings.windowDays} day(s); a pair is made only when it is the only candidate on both sides.`}
      >
        <Badge variant={st.variant}>{st.label}</Badge>
        <Button asChild variant="outline">
          <Link href="/finance/labs">Back to labs and referrals</Link>
        </Button>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          ["Lines on the file", String(s.lines)],
          ["Matched to Unite", String(s.matched)],
          ["Done but not billed", String(s.notBilled)],
          [
            "Billed, not on the file",
            provider.kind === "send_out_lab" ? String(s.notOnFile) : "n/a",
          ],
          ["Price differences", String(s.priceVariances)],
          ["Late results", String(s.late)],
          ["Total cost", money(s.totalCost)],
          ["Charged to doctors", money(s.allocated)],
          ["No doctor (not charged)", money(s.unallocated)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      {statement.status === "open" && result.problems.length > 0 && (
        <Alert>
          <AlertTitle>Before the review</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review and posting</CardTitle>
          <CardDescription>
            Reviewing freezes the figures (with their fingerprint). A different person then posts
            each doctor&apos;s cost to their charges for the month, where the revenue share deducts
            it. Posting again replaces only this statement&apos;s charges.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {statement.status !== "open" && (
            <p className="text-muted-foreground text-xs">
              Reviewed {statement.prepared_at?.slice(0, 16).replace("T", " ")}
              {statement.posted_at
                ? `, posted ${statement.posted_at.slice(0, 16).replace("T", " ")}`
                : ""}
              . Fingerprint{" "}
              <span className="font-mono">{statement.figures_sha256?.slice(0, 16)}</span>
            </p>
          )}
          {manage && (
            <div className="flex flex-wrap gap-2">
              {statement.status === "open" && (
                <ReviewButton statementId={statement.id} disabled={result.problems.length > 0} />
              )}
              {statement.status !== "open" &&
                statement.figures_sha256 &&
                statement.prepared_by !== member.userId && (
                  <PostButton
                    statementId={statement.id}
                    hash={statement.figures_sha256}
                    label={statement.status === "posted" ? "Post again" : "Post to doctor charges"}
                  />
                )}
              {statement.status !== "open" && (
                <ReopenButton statementId={statement.id} posted={statement.status === "posted"} />
              )}
            </div>
          )}
          {manage && statement.status === "reviewed" && statement.prepared_by === member.userId && (
            <p className="text-muted-foreground text-xs">
              You reviewed it, so another person must post it.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost by doctor and branch</CardTitle>
          <CardDescription>
            {provider.kind === "in_house_lab"
              ? `The fixed monthly fee of ${money(provider.fixedFee)} shared by ${provider.basis === "revenue" ? "billed revenue of the matched tests" : "number of tests"}.`
              : "The amounts on the provider's invoice."}{" "}
            The doctor is the one Unite billed the matched test under (per the doctor basis in
            Workflow settings), otherwise the ordering doctor on the file.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Doctor</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Tests</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.allocation.map((a) => (
                <TableRow key={`${a.doctor}|${a.branch}`}>
                  <TableCell>{doc(a.doctor)}</TableCell>
                  <TableCell>{a.branch ?? "-"}</TableCell>
                  <TableCell className="tabular-nums">{a.tests}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(a.cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              Done but not billed ({result.notBilled.length})
            </CardTitle>
            <CardDescription>
              On the provider&apos;s file with no matching Unite line: revenue leakage, or a test
              billed under another code, day or patient. Each needs a reason.
            </CardDescription>
          </div>
          {editable && result.notBilled.some((n) => !n.note) && (
            <ReasonForm statementId={statement.id} list="not_billed" reasons={REASONS} />
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service date</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>PIN</TableHead>
                <TableHead>Doctor</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.notBilled.slice(0, MAX_ROWS).map((n) => (
                <TableRow key={n.key}>
                  <TableCell className="tabular-nums">{n.line.serviceDate}</TableCell>
                  <TableCell className="font-mono text-xs">{n.line.code}</TableCell>
                  <TableCell className="font-mono text-xs">{maskPin(n.line.pin)}</TableCell>
                  <TableCell>{n.line.doctor ?? "-"}</TableCell>
                  <TableCell>
                    {WHY[n.why]}
                    {n.why === "ambiguous" ? ` (${n.candidates})` : ""}
                  </TableCell>
                  <TableCell>
                    <Reason
                      note={n.note}
                      statementId={statement.id}
                      itemKey={n.key}
                      editable={editable}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <More total={result.notBilled.length} />
        </CardContent>
      </Card>

      {provider.kind === "send_out_lab" && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                Billed but not on the file ({result.notOnFile.length})
              </CardTitle>
              <CardDescription>
                Unite billed one of this lab&apos;s tests in the month and the lab has no record of
                it. Only the codes in the provider&apos;s test list are checked. Each needs a
                reason.
              </CardDescription>
            </div>
            {editable && result.notOnFile.some((n) => !n.note) && (
              <ReasonForm statementId={statement.id} list="not_on_file" reasons={REASONS} />
            )}
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice date</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>PIN</TableHead>
                  <TableHead>Doctor</TableHead>
                  <TableHead className="text-right">Billed</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.notOnFile.slice(0, MAX_ROWS).map((n) => (
                  <TableRow key={n.key}>
                    <TableCell className="tabular-nums">{n.unite.date}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {n.unite.itemCode ?? n.unite.lineCpt ?? n.unite.refCpt}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{maskPin(n.unite.pin)}</TableCell>
                    <TableCell>{n.unite.doctor ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(n.unite.net)}</TableCell>
                    <TableCell>
                      <Reason
                        note={n.note}
                        statementId={statement.id}
                        itemKey={n.key}
                        editable={editable}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <More total={result.notOnFile.length} />
          </CardContent>
        </Card>
      )}

      {result.priceVariances.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Price differences ({result.priceVariances.length})
            </CardTitle>
            <CardDescription>
              Invoice lines that differ from the agreed price by more than{" "}
              {money(settings.priceTolerance)}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service date</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Agreed</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.priceVariances.slice(0, MAX_ROWS).map((v) => (
                  <TableRow key={v.line.id}>
                    <TableCell className="tabular-nums">{v.line.serviceDate}</TableCell>
                    <TableCell className="font-mono text-xs">{v.line.code}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(v.line.amount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.agreed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(v.diff)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <More total={result.priceVariances.length} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Turnaround</CardTitle>
          <CardDescription>
            {result.turnaround.withExpectation === 0
              ? "Add the expected days per test in Settings to see late results."
              : `${result.turnaround.onTime} of ${result.turnaround.withExpectation} tests with an expected turnaround came back on time; ${result.turnaround.late.length} are late or still waiting past the expected days.`}
          </CardDescription>
        </CardHeader>
        {result.turnaround.late.length > 0 && (
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service date</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>PIN</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Expected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.turnaround.late.slice(0, MAX_ROWS).map((l) => (
                  <TableRow key={l.line.id}>
                    <TableCell className="tabular-nums">{l.line.serviceDate}</TableCell>
                    <TableCell className="font-mono text-xs">{l.line.code}</TableCell>
                    <TableCell className="font-mono text-xs">{maskPin(l.line.pin)}</TableCell>
                    <TableCell>
                      {l.pending ? (
                        <Badge variant="destructive">Still waiting</Badge>
                      ) : (
                        l.line.resultDate
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{l.days}</TableCell>
                    <TableCell className="tabular-nums">{l.expectedDays}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <More total={result.turnaround.late.length} />
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matched ({result.matched.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service date</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>PIN</TableHead>
                <TableHead>Unite date</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.matched.slice(0, MAX_ROWS).map((m) => (
                <TableRow key={m.line.id}>
                  <TableCell className="tabular-nums">{m.line.serviceDate}</TableCell>
                  <TableCell className="font-mono text-xs">{m.line.code}</TableCell>
                  <TableCell className="font-mono text-xs">{maskPin(m.line.pin)}</TableCell>
                  <TableCell className="tabular-nums">{m.unite.date}</TableCell>
                  <TableCell className="tabular-nums">{m.score}</TableCell>
                  <TableCell className="text-xs">{m.reasons.join("; ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <More total={result.matched.length} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Files</CardTitle>
          <CardDescription>
            The files themselves are not kept, only their fingerprint.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File type</TableHead>
                <TableHead>Lines</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="uppercase">{f.file_name ?? "-"}</TableCell>
                  <TableCell className="tabular-nums">{f.row_count}</TableCell>
                  <TableCell className="tabular-nums">
                    {f.first_date} to {f.last_date}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.kind === "provider_invoice" ? money(f.total_amount) : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {editable && <RemoveFileButton statementId={statement.id} fileId={f.id} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
