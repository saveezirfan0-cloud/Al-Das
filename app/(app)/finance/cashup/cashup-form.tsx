"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RunButton } from "@/components/finance/forms";
import { money } from "@/lib/finance/format";
import { summariseCashup } from "@/lib/finance/cashup";

import { reopenCashup, saveCashupCounts, submitCashup } from "./actions";

export type CashupLine = {
  mode: string;
  expected: number;
  counted: number | null;
  reason: string | null;
};

export function CashupForm({
  id,
  status,
  lines: initial,
  note: initialNote,
  tolerance,
}: {
  id: string;
  status: "draft" | "submitted";
  lines: CashupLine[];
  note: string | null;
  tolerance: number;
}) {
  const [lines, setLines] = React.useState(
    initial.map((l) => ({ ...l, text: l.counted === null ? "" : String(l.counted) })),
  );
  const [note, setNote] = React.useState(initialNote ?? "");
  const [extra, setExtra] = React.useState("");
  const [pending, start] = React.useTransition();
  const frozen = status === "submitted";
  const counted = (t: string) => (t.trim() === "" ? null : Number(t.replace(/,/g, "")));
  const parsed = lines.map((l) => ({
    mode: l.mode,
    expected: l.expected,
    counted:
      counted(l.text) !== null &&
      Number.isFinite(counted(l.text)) &&
      (counted(l.text) as number) >= 0
        ? counted(l.text)
        : null,
    reason: l.reason,
  }));
  const sum = summariseCashup(parsed, tolerance);

  const payload = () => ({
    id,
    note,
    lines: sum.lines.map((l) => ({ mode: l.mode, counted: l.counted, reason: l.reason ?? "" })),
  });

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Payment mode</TableHead>
            <TableHead className="text-right">Expected</TableHead>
            <TableHead className="w-40">Counted</TableHead>
            <TableHead className="text-right">Difference</TableHead>
            <TableHead>Reason (needed beyond {money(tolerance)})</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sum.lines.map((l, i) => (
            <TableRow key={l.mode}>
              <TableCell className="text-sm">{l.mode}</TableCell>
              <TableCell className="text-right text-sm tabular-nums">{money(l.expected)}</TableCell>
              <TableCell>
                <Input
                  inputMode="decimal"
                  disabled={frozen}
                  value={lines[i].text}
                  aria-label={`Counted ${l.mode}`}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                    )
                  }
                />
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {l.variance === null ? (
                  "—"
                ) : (
                  <Badge variant={l.needsReason ? "warning" : "secondary"}>
                    {money(l.variance)}
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                <Input
                  disabled={frozen}
                  maxLength={200}
                  value={lines[i].reason ?? ""}
                  aria-label={`Reason ${l.mode}`}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)),
                    )
                  }
                />
              </TableCell>
            </TableRow>
          ))}
          {sum.lines.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground text-sm">
                No payments are recorded for this branch and day. If cash was taken, add its payment
                mode below.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {!frozen && (
        <div className="flex items-center gap-2">
          <Input
            className="max-w-52"
            placeholder="Another payment mode"
            value={extra}
            maxLength={60}
            onChange={(e) => setExtra(e.target.value.toUpperCase())}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (extra.trim() && !lines.some((l) => l.mode === extra.trim()))
                setLines((ls) => [
                  ...ls,
                  { mode: extra.trim(), expected: 0, counted: null, reason: null, text: "" },
                ]);
              setExtra("");
            }}
          >
            Add
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-6 text-sm tabular-nums">
        <span>
          Expected <strong>{money(sum.expectedTotal)}</strong>
        </span>
        <span>
          Counted <strong>{money(sum.countedTotal)}</strong>
        </span>
        <span>
          Difference{" "}
          <strong className={sum.varianceTotal === 0 ? "" : "text-amber-600"}>
            {money(sum.varianceTotal)}
          </strong>
        </span>
      </div>
      <Input
        disabled={frozen}
        placeholder="Note (optional)"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      {!frozen && sum.problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-600">
          {sum.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {!frozen ? (
          <>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await saveCashupCounts(payload());
                  if (r.ok) toast.success(r.message);
                  else toast.error(r.error);
                })
              }
            >
              {pending && <Loader2 className="animate-spin" />} Save counts
            </Button>
            <Button
              disabled={pending || !sum.canSubmit}
              onClick={() =>
                start(async () => {
                  const saved = await saveCashupCounts(payload());
                  if (!saved.ok) return void toast.error(saved.error);
                  const r = await submitCashup(id);
                  if (r.ok) toast.success(r.message);
                  else toast.error(r.error);
                })
              }
            >
              Submit the cash-up
            </Button>
          </>
        ) : (
          <RunButton
            variant="outline"
            confirm="Reopen this cash-up to correct it?"
            action={() => reopenCashup(id)}
          >
            Reopen to correct
          </RunButton>
        )}
      </div>
    </div>
  );
}
