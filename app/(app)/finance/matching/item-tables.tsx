"use client";

import * as React from "react";
import { toast } from "sonner";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { CappedNote, EmptyState } from "@/components/shell/empty-state";
import { useConfirm } from "@/components/shell/confirm-dialog";
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
import { money } from "@/lib/finance/format";
import { CLOSE_REASONS } from "@/lib/finance/match-close-reasons";

import { allocateManually, closeItem, reopenItem, undoDecision } from "./actions";

const ROW_CAP = 300;

export type AllocationLine = {
  id: string;
  lineDate: string | null;
  amount: number;
  rule: string;
  auto: boolean;
};

export type ItemRow = {
  ref: string;
  label: string;
  payer: string | null;
  date: string;
  total: number;
  allocated: number;
  open: number;
  status: "open" | "part" | "paid" | "closed";
  age: string | null;
  source: "receipt" | "remittance" | "both";
  mismatch: boolean;
  matchedByMonthlyRun: boolean;
  allocations: AllocationLine[];
  closure: { id: string; kind: "write_off" | "cancelled"; reasonCode: string } | null;
};

export type CreditRow = { id: string; date: string; amount: number; open: number; text: string };

const STATUS: Record<
  ItemRow["status"],
  { label: string; variant: "outline" | "warning" | "success" | "secondary" }
> = {
  open: { label: "Open", variant: "outline" },
  part: { label: "Part paid", variant: "warning" },
  paid: { label: "Paid", variant: "success" },
  closed: { label: "Closed", variant: "secondary" },
};
const RULE_WORDS: Record<string, string> = {
  reference: "reference",
  payer_sum: "payer and amount",
  amount_date: "amount and date",
  manual: "by hand",
};
const AGE_WORDS: Record<string, string> = {
  waiting: "Not due yet",
  "0-7": "Up to 7 days",
  "8-30": "8 to 30 days",
  "31-60": "31 to 60 days",
  "60+": "Over 60 days",
};

const creditLabel = (c: CreditRow) =>
  `${c.date} · deposit ${money(c.amount)} · left ${money(c.open)}`;
const parseAmount = (v: string) => Number(v.replace(/,/g, "").trim());

/** One undo button for an allocation (asks first; nothing is deleted, the history keeps it). */
function UndoButton({ id }: { id: string }) {
  const [ask, dialog] = useConfirm();
  const [pending, start] = React.useTransition();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label="Undo this allocation"
        onClick={async () => {
          if (!(await ask({ title: "Undo this allocation?", description: "The amount goes back to the deposit and to the payment. The history keeps the record.", confirmLabel: "Undo" })))
            return;
          start(async () => {
            const res = await undoDecision({ id });
            if (res.ok) toast.success(res.message ?? "Undone.");
            else toast.error(res.error);
          });
        }}
      >
        Undo
      </Button>
      {dialog}
    </>
  );
}

function AllocateToItem({ item, credits }: { item: ItemRow; credits: CreditRow[] }) {
  return (
    <FormSheet
      trigger="Allocate"
      variant="outline"
      size="sm"
      title={`Allocate to ${item.label}`}
      description={`${money(item.open)} is still to be received. Choose the bank deposit that paid it, and how much of that deposit.`}
    >
      {(close) =>
        credits.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No bank deposit has anything left to explain. Import the bank statement first.
          </p>
        ) : (
          <ActionForm
            submitLabel="Allocate"
            onDone={close}
            action={(v) =>
              allocateManually({ lineId: v.lineId, itemRef: item.ref, amount: parseAmount(v.amount) })
            }
          >
            <Field label="Bank deposit">
              <select name="lineId" className={selectClass} required defaultValue="">
                <option value="" disabled>
                  Choose a deposit
                </option>
                {credits.slice(0, ROW_CAP).map((c) => (
                  <option key={c.id} value={c.id}>
                    {creditLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount to allocate" hint="Not more than the deposit has left or the payment still needs.">
              <Input name="amount" inputMode="decimal" required defaultValue={item.open.toFixed(2)} />
            </Field>
          </ActionForm>
        )
      }
    </FormSheet>
  );
}

function CloseSheet({ item }: { item: ItemRow }) {
  const canCancel = item.allocated === 0;
  return (
    <FormSheet
      trigger="Close"
      variant="outline"
      size="sm"
      title={`Close ${item.label}`}
      description="Use this when the rest will never be received. A written-off payment leaves the open list; the figures stay in the history and you can reopen it."
    >
      {(close) => (
        <ActionForm
          submitLabel="Close payment"
          variant="destructive"
          onDone={close}
          action={(v) =>
            closeItem({
              itemRef: item.ref,
              kind: v.kind as "write_off" | "cancelled",
              reasonCode: v.reasonCode as keyof typeof CLOSE_REASONS,
              note: v.note,
            })
          }
        >
          <Field label="What happened">
            <select name="kind" className={selectClass} defaultValue="write_off">
              <option value="write_off">Write off the remaining {money(item.open)}</option>
              {canCancel && <option value="cancelled">Cancel the payment (entered by mistake)</option>}
            </select>
          </Field>
          <Field label="Reason">
            <select name="reasonCode" className={selectClass} required defaultValue="">
              <option value="" disabled>
                Choose a reason
              </option>
              {Object.entries(CLOSE_REASONS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" hint="Required for Other. No names or ID numbers. 200 characters at most.">
            <Input name="note" maxLength={200} />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

function ReopenButton({ id }: { id: string }) {
  const [pending, start] = React.useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await reopenItem({ id });
          if (res.ok) toast.success(res.message ?? "Reopened.");
          else toast.error(res.error);
        })
      }
    >
      Reopen
    </Button>
  );
}

export function OpenItemsTable({
  items,
  credits,
  canManage,
  canApprove,
  total,
}: {
  items: ItemRow[];
  credits: CreditRow[];
  canManage: boolean;
  canApprove: boolean;
  total: number;
}) {
  const [q, setQ] = React.useState("");
  const needle = q.trim().toUpperCase();
  const shown = needle
    ? items.filter((i) => i.label.toUpperCase().includes(needle) || (i.payer ?? "").includes(needle))
    : items;
  if (items.length === 0)
    return (
      <EmptyState
        title="Nothing to show here"
        description="Insurer payments appear when the receipt register is imported (Overview) or a remittance advice is uploaded under Remittance."
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a payment reference or payer"
        aria-label="Find a payment reference or payer"
        className="max-w-sm"
      />
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Payment reference</TableHead>
              <TableHead>Payer</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Still to receive</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.slice(0, ROW_CAP).map((i) => (
              <React.Fragment key={i.ref}>
                <TableRow>
                  <TableCell className="font-medium">
                    {i.label}
                    <div className="text-muted-foreground text-xs">
                      {i.source === "both"
                        ? "Receipt register and remittance"
                        : i.source === "receipt"
                          ? "Receipt register"
                          : "Remittance advice only"}
                    </div>
                    {i.mismatch && (
                      <Badge variant="warning" className="mt-1">
                        Receipt and remittance differ
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{i.payer ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{i.date}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(i.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(i.allocated)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{money(i.open)}</TableCell>
                  <TableCell>{i.age ? (AGE_WORDS[i.age] ?? i.age) : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS[i.status].variant}>{STATUS[i.status].label}</Badge>
                    {i.matchedByMonthlyRun && (
                      <div className="text-muted-foreground mt-1 text-xs">Matched in the monthly bank run</div>
                    )}
                    {i.closure && (
                      <div className="text-muted-foreground mt-1 text-xs">
                        {i.closure.kind === "write_off" ? "Written off" : "Cancelled"}:{" "}
                        {CLOSE_REASONS[i.closure.reasonCode as keyof typeof CLOSE_REASONS] ?? i.closure.reasonCode}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {canManage && (i.status === "open" || i.status === "part") && (
                      <AllocateToItem item={i} credits={credits} />
                    )}{" "}
                    {canApprove && (i.status === "open" || i.status === "part") && !i.matchedByMonthlyRun && (
                      <CloseSheet item={i} />
                    )}
                    {canApprove && i.closure && <ReopenButton id={i.closure.id} />}
                  </TableCell>
                </TableRow>
                {i.allocations.length > 0 && (
                  <TableRow className="bg-muted/30">
                    <TableCell colSpan={9}>
                      <details>
                        <summary className="cursor-pointer text-sm">
                          {i.allocations.length} allocation{i.allocations.length === 1 ? "" : "s"}
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1 text-sm">
                          {i.allocations.map((a) => (
                            <li key={a.id} className="flex flex-wrap items-center gap-x-3">
                              <span className="tabular-nums">{money(a.amount)}</span>
                              <span className="text-muted-foreground">
                                from the deposit of {a.lineDate ?? "an earlier date"}, matched {a.auto ? "automatically" : "by a person"} (
                                {RULE_WORDS[a.rule] ?? a.rule})
                              </span>
                              {canManage && <UndoButton id={a.id} />}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      {(shown.length > ROW_CAP || total > items.length) && (
        <CappedNote shown={Math.min(ROW_CAP, shown.length)} total={needle ? shown.length : total} />
      )}
    </div>
  );
}

function AllocateFromCredit({ credit, items }: { credit: CreditRow; items: ItemRow[] }) {
  return (
    <FormSheet
      trigger="Allocate"
      variant="outline"
      size="sm"
      title={`Allocate the deposit of ${credit.date}`}
      description={`${money(credit.open)} of ${money(credit.amount)} is still unexplained. Choose the insurer payment it paid.`}
    >
      {(close) =>
        items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No insurer payment is open.</p>
        ) : (
          <ActionForm
            submitLabel="Allocate"
            onDone={close}
            action={(v) =>
              allocateManually({ lineId: credit.id, itemRef: v.itemRef, amount: parseAmount(v.amount) })
            }
          >
            <Field label="Insurer payment">
              <select name="itemRef" className={selectClass} required defaultValue="">
                <option value="" disabled>
                  Choose a payment
                </option>
                {items.slice(0, ROW_CAP).map((i) => (
                  <option key={i.ref} value={i.ref}>
                    {i.label} · {i.payer ?? "no payer"} · {i.date} · {money(i.open)} to receive
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount to allocate">
              <Input name="amount" inputMode="decimal" required defaultValue={credit.open.toFixed(2)} />
            </Field>
          </ActionForm>
        )
      }
    </FormSheet>
  );
}

export function CreditsTable({
  credits,
  openItems,
  canManage,
  hasAccount,
}: {
  credits: CreditRow[];
  openItems: ItemRow[];
  canManage: boolean;
  hasAccount: boolean;
}) {
  if (!hasAccount)
    return (
      <EmptyState
        title="No bank account receives insurers' payments yet"
        description="Mark the account that insurers pay into under Bank reconciliation, Accounts, then import its statement."
      />
    );
  if (credits.length === 0)
    return (
      <EmptyState
        title="Every deposit is explained"
        description="Bank deposits into the insurance account appear here until they are matched to insurer payments. Import the next statement to see more."
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Deposit</TableHead>
              <TableHead className="text-right">Not yet explained</TableHead>
              <TableHead>Bank narrative</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {credits.slice(0, ROW_CAP).map((c) => (
              <TableRow key={c.id}>
                <TableCell className="tabular-nums">{c.date}</TableCell>
                <TableCell className="text-right tabular-nums">{money(c.amount)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{money(c.open)}</TableCell>
                <TableCell className="max-w-md truncate" title={c.text}>
                  {c.text || "—"}
                </TableCell>
                <TableCell className="text-right">
                  {canManage && <AllocateFromCredit credit={c} items={openItems} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {credits.length > ROW_CAP && <CappedNote shown={ROW_CAP} total={credits.length} />}
    </div>
  );
}
