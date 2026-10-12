"use client";

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { ReviewDecision, ReviewEntry } from "@/lib/security/access-review";

import {
  attestAccessReview,
  refreshAccessReview,
  setReviewDecision,
  startAccessReview,
} from "./actions";

export function StartReviewButton({ period }: { period: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await startAccessReview(period);
          if (res.ok) {
            toast.success(res.message);
            router.refresh();
          } else toast.error(res.error);
        })
      }
    >
      {pending && <Loader2 className="animate-spin" />} Start the {period} review
    </Button>
  );
}

function lastActive(e: ReviewEntry): string {
  if (!e.lastActiveAt) return "Never seen";
  return e.idleDays === 0 ? "Today" : `${e.idleDays} day${e.idleDays === 1 ? "" : "s"} ago`;
}

export function ReviewBoard({
  reviewId,
  period,
  entries,
  selfUserId,
  signerName,
}: {
  reviewId: string;
  period: string;
  entries: ReviewEntry[];
  selfUserId: string;
  signerName: string;
}) {
  const router = useRouter();
  const [decisions, setDecisions] = React.useState<Record<string, ReviewDecision>>(() =>
    Object.fromEntries(entries.map((e) => [e.userId, e.decision])),
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  const active = entries.filter((e) => e.status === "active");
  const undecided = active.filter((e) => !decisions[e.userId]).length;

  async function decide(userId: string, decision: "keep" | "revoke") {
    setBusy(userId);
    const res = await setReviewDecision({ reviewId, userId, decision });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setDecisions((d) => ({ ...d, [userId]: decision }));
  }

  function sign() {
    setError(null);
    start(async () => {
      const res = await attestAccessReview({ reviewId, typedName: typed, confirmed, note });
      if (!res.ok) return setError(res.error);
      toast.success(res.message);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Review for {period}
          <Badge variant="warning">Open</Badge>
        </CardTitle>
        <CardDescription>
          {active.length} active people · {entries.filter((e) => e.dormant).length} dormant (no
          activity for the dormant period) · {undecided} still need a decision. Choose <b>Keep</b>{" "}
          or <b>Revoke</b> for each; then use Settings → Users → Off-board for anyone you revoke.
        </CardDescription>
        <div className="col-start-2 row-start-1 self-start justify-self-end">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await refreshAccessReview(reviewId);
                if (res.ok) {
                  toast.success(res.message);
                  router.refresh();
                } else toast.error(res.error);
              })
            }
          >
            <RefreshCw /> Refresh facts
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 p-0 sm:p-6">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead>API keys</TableHead>
                <TableHead className="text-right">Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.userId}>
                  <TableCell>
                    <div className="font-medium">
                      {e.name}{" "}
                      {e.userId === selfUserId && (
                        <span className="text-muted-foreground font-normal">(you)</span>
                      )}
                    </div>
                    <div className="text-muted-foreground text-xs">{e.email}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {e.roleName}
                      {e.fullAccess && <Badge variant="outline">Full access</Badge>}
                      {e.status === "suspended" && <Badge variant="warning">Suspended</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1 text-sm">
                      {lastActive(e)}
                      {e.dormant && <Badge variant="destructive">Dormant</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {e.apiKeys.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      e.apiKeys.map((k) => (
                        <div key={k.id} className="text-xs">
                          {k.name} <span className="text-muted-foreground">({k.prefix}…)</span>
                        </div>
                      ))
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {e.status === "suspended" ? (
                      <span className="text-muted-foreground text-xs">Already suspended</span>
                    ) : (
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant={decisions[e.userId] === "keep" ? "default" : "outline"}
                          disabled={busy === e.userId}
                          onClick={() => void decide(e.userId, "keep")}
                        >
                          Keep
                        </Button>
                        <Button
                          size="sm"
                          variant={decisions[e.userId] === "revoke" ? "destructive" : "outline"}
                          disabled={busy === e.userId}
                          onClick={() => void decide(e.userId, "revoke")}
                        >
                          Revoke
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="grid max-w-xl gap-4 px-6 pb-6 sm:px-0 sm:pb-0">
          <h3 className="font-medium">Sign the review</h3>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(c) => setConfirmed(c === true)}
              className="mt-0.5"
            />
            <span>I have looked at every person above and the decisions are mine.</span>
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="sign-name">Type your full name to sign ({signerName})</Label>
            <Input
              id="sign-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sign-note">Note (optional)</Label>
            <Textarea
              id="sign-note"
              rows={2}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div>
            <Button
              onClick={sign}
              disabled={pending || !confirmed || undecided > 0 || typed.trim().length < 2}
            >
              {pending && <Loader2 className="animate-spin" />} Sign and close the review
            </Button>
            {undecided > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                {undecided} decision{undecided === 1 ? "" : "s"} missing.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
