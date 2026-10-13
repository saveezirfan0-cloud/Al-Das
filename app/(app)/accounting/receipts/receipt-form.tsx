"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  allocateOldestFirst,
  RECEIPT_MODE_LABELS,
  RECEIPT_MODES,
  type ReceiptMode,
} from "@/lib/accounting/sales";
import { money } from "@/lib/finance/format";

import { allocateReceipt, saveReceipt } from "./actions";

export type OpenInvoiceOption = {
  id: string;
  number: string;
  invoiceDate: string;
  open: number;
  total: number;
};

const n = (s: string) => (s.trim() === "" ? 0 : Number(s.replace(/,/g, "")));
const cents = (x: number) => Math.round(x * 100);

/** Allocation lines for open invoices: oldest first by default, every amount editable. */
function useAllocation(invoices: OpenInvoiceOption[], amount: number, initial?: Record<string, string>) {
  const [manual, setManual] = React.useState(!!initial);
  const [values, setValues] = React.useState<Record<string, string>>(initial ?? {});
  const auto = React.useMemo(() => {
    const r = allocateOldestFirst(amount, invoices);
    return Object.fromEntries(r.allocations.map((a) => [a.invoiceId, a.amount.toFixed(2)]));
  }, [amount, invoices]);
  const shown = manual ? values : auto;
  const allocated = Object.values(shown).reduce((s, v) => s + cents(n(v)), 0) / 100;
  return {
    manual,
    shown,
    allocated,
    unallocated: Math.round((amount - allocated) * 100) / 100,
    edit: (id: string, v: string) => {
      if (!manual) setValues(auto);
      setManual(true);
      setValues((cur) => ({ ...(manual ? cur : auto), [id]: v }));
    },
    reset: () => {
      setManual(false);
      setValues({});
    },
    list: () =>
      Object.entries(shown)
        .filter(([, v]) => n(v) > 0)
        .map(([invoice_id, v]) => ({ invoice_id, amount: n(v) })),
  };
}

function AllocationTable({
  invoices,
  a,
}: {
  invoices: OpenInvoiceOption[];
  a: ReturnType<typeof useAllocation>;
}) {
  if (invoices.length === 0)
    return <p className="text-muted-foreground text-sm">No open invoices: the receipt stays on account.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">Allocation</span>
        <span className="text-muted-foreground">
          {a.manual ? "By hand." : "Oldest invoice first."} Allocated {money(a.allocated)}; on account{" "}
          {money(a.unallocated)}.
        </span>
        {a.manual && (
          <Button type="button" variant="ghost" size="sm" onClick={a.reset}>
            Oldest first again
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="py-1 font-medium">Invoice</th>
              <th className="py-1 font-medium">Date</th>
              <th className="py-1 text-right font-medium">Open</th>
              <th className="py-1 text-right font-medium">Allocate</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="py-1 font-mono text-xs">{i.number}</td>
                <td className="py-1">{i.invoiceDate}</td>
                <td className="py-1 text-right tabular-nums">{money(i.open)}</td>
                <td className="py-1 text-right">
                  <Input
                    className="ml-auto w-32 text-right"
                    inputMode="decimal"
                    value={a.shown[i.id] ?? ""}
                    onChange={(e) => a.edit(i.id, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {a.unallocated < 0 && (
        <p className="text-destructive text-xs">The allocations add up to more than the receipt.</p>
      )}
    </div>
  );
}

export function ReceiptForm({
  customerId,
  accounts,
  invoices,
  today,
}: {
  customerId: string;
  accounts: Array<{ id: string; label: string }>;
  invoices: OpenInvoiceOption[];
  today: string;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [date, setDate] = React.useState(today);
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = React.useState("");
  const [mode, setMode] = React.useState<ReceiptMode>("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const amt = n(amount);
  const a = useAllocation(invoices, Number.isFinite(amt) && amt > 0 ? amt : 0);

  function submit() {
    start(async () => {
      const res = await saveReceipt({
        customer_id: customerId,
        receipt_date: date,
        account_id: accountId,
        amount: amt,
        mode,
        reference,
        notes,
        allocations: a.manual ? a.list() : null,
      });
      if (res.ok && res.data) {
        toast.success(res.message ?? "Saved");
        router.push(`/accounting/receipts/${res.data.id}`);
        router.refresh();
      } else if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date received">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Amount (AED)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Received into">
          <select className={selectClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mode">
          <select className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as ReceiptMode)}>
            {RECEIPT_MODES.map((m) => (
              <option key={m} value={m}>
                {RECEIPT_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference" hint="Cheque or transfer reference; account numbers are masked.">
          <Input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Notes">
          <Input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <AllocationTable invoices={invoices} a={a} />
      <div>
        <Button onClick={submit} disabled={pending || !(amt > 0) || !accountId || a.unallocated < 0}>
          {pending && <Loader2 className="animate-spin" />} Record receipt
        </Button>
      </div>
    </div>
  );
}

/** Change a recorded receipt's allocation. */
export function ReallocateForm({
  receiptId,
  amount,
  invoices,
  current,
}: {
  receiptId: string;
  amount: number;
  invoices: OpenInvoiceOption[];
  current: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const a = useAllocation(invoices, amount, current);
  return (
    <div className="flex flex-col gap-3">
      <AllocationTable invoices={invoices} a={a} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || a.unallocated < 0}
          onClick={() =>
            start(async () => {
              const res = await allocateReceipt({ id: receiptId, allocations: a.manual ? a.list() : null });
              if (res.ok) {
                toast.success(res.message ?? "Saved");
                router.refresh();
              } else toast.error(res.error);
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />} Save allocation
        </Button>
      </div>
    </div>
  );
}
