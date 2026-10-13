"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  creditNoteLate,
  dueDateFor,
  invoiceForm,
  invoiceTotals,
  lineAmounts,
  lineProblem,
  type SalesDocKind,
} from "@/lib/accounting/sales";
import { money } from "@/lib/finance/format";

import { saveSalesDoc } from "./actions";

type Opt = { id: string; label: string };

export type SalesFormOptions = {
  customers: Array<{ id: string; name: string; trn: string | null; terms: number }>;
  incomeAccounts: Opt[];
  taxCodes: Array<{ id: string; code: string; name: string; rate: number }>;
  branches: Array<{ code: string; name: string }>;
  costCentres: Opt[];
  today: string;
  simplifiedLimit: number;
  approvalThreshold: number;
  creditNoteDays: number;
};

export type SalesFormLine = {
  description: string;
  quantity: string;
  unit_price: string;
  discount: string;
  income_account_id: string;
  tax_code_id: string;
  branch_code: string;
  department: string;
  cost_centre_id: string;
};

export type SalesFormInitial = {
  id?: string;
  kind: SalesDocKind;
  customer_id: string;
  original_invoice_id?: string;
  original_number?: string | null;
  invoice_date?: string;
  supply_date?: string;
  due_date?: string;
  event_date?: string;
  credit_reason?: string;
  reference?: string;
  notes?: string;
  lines: SalesFormLine[];
};

const blank = (): SalesFormLine & { key: string } => ({
  key: crypto.randomUUID(),
  description: "",
  quantity: "1",
  unit_price: "",
  discount: "",
  income_account_id: "",
  tax_code_id: "",
  branch_code: "",
  department: "",
  cost_centre_id: "",
});

const n = (s: string) => (s.trim() === "" ? 0 : Number(s.replace(/,/g, "")));

export function SalesForm({
  options,
  initial,
}: {
  options: SalesFormOptions;
  initial: SalesFormInitial;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const credit = initial.kind === "credit_note";
  const [customerId, setCustomerId] = React.useState(initial.customer_id);
  const [date, setDate] = React.useState(initial.invoice_date ?? options.today);
  const [supply, setSupply] = React.useState(initial.supply_date ?? "");
  const [due, setDue] = React.useState(initial.due_date ?? "");
  const [eventDate, setEventDate] = React.useState(initial.event_date ?? "");
  const [reason, setReason] = React.useState(initial.credit_reason ?? "");
  const [reference, setReference] = React.useState(initial.reference ?? "");
  const [notes, setNotes] = React.useState(initial.notes ?? "");
  const [lines, setLines] = React.useState(() =>
    initial.lines.length
      ? initial.lines.map((l) => ({ ...l, key: crypto.randomUUID() }))
      : [blank()],
  );

  const customer = options.customers.find((c) => c.id === customerId) ?? null;
  const rateOf = new Map(options.taxCodes.map((t) => [t.id, t.rate]));
  const priced = lines.map((l) => {
    const input = {
      quantity: n(l.quantity),
      unitPrice: n(l.unit_price),
      discount: n(l.discount),
      vatRate: rateOf.get(l.tax_code_id) ?? 0,
    };
    const problem = lineProblem(input);
    return { input, problem, amounts: problem ? null : lineAmounts(input) };
  });
  const totals = invoiceTotals(priced.filter((p) => !p.problem).map((p) => p.input));
  const set = (key: string, patch: Partial<SalesFormLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const late = credit && creditNoteLate(eventDate || null, date, options.creditNoteDays);

  function submit() {
    start(async () => {
      const res = await saveSalesDoc({
        id: initial.id ?? "",
        kind: initial.kind,
        customer_id: customerId,
        original_invoice_id: initial.original_invoice_id ?? "",
        invoice_date: date,
        supply_date: supply,
        due_date: credit ? "" : due,
        event_date: credit ? eventDate : "",
        credit_reason: credit ? reason : "",
        reference,
        notes,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: n(l.quantity),
          unit_price: n(l.unit_price),
          discount: n(l.discount),
          income_account_id: l.income_account_id,
          tax_code_id: l.tax_code_id,
          branch_code: l.branch_code,
          department: l.department,
          cost_centre_id: l.cost_centre_id,
        })),
      });
      if (res.ok && res.data) {
        toast.success(res.message ?? "Saved");
        router.push(`/accounting/sales-invoices/${res.data.id}`);
        router.refresh();
      } else if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Customer">
          <select
            className={selectClass}
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={credit}
          >
            <option value="">Choose a customer</option>
            {options.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={credit ? "Credit note date" : "Invoice date"}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        {credit ? (
          <Field label="Date of the event" hint="The return, price change or cancellation the credit note is for.">
            <Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
          </Field>
        ) : (
          <Field
            label="Due date"
            hint={
              customer
                ? `Blank = ${customer.terms} days' terms (${dueDateFor(date || options.today, customer.terms)}).`
                : "Blank = the customer's credit terms."
            }
          >
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        )}
        <Field label="Date of supply" hint="Only when it differs from the document date.">
          <Input type="date" value={supply} onChange={(e) => setSupply(e.target.value)} />
        </Field>
        <Field label="Customer reference" hint="PO, contract or claim batch number.">
          <Input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
        </Field>
        {credit && (
          <Field label="Reason" hint={initial.original_number ? `Credits ${initial.original_number}.` : undefined}>
            <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </div>
      {late && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
          This credit note comes more than {options.creditNoteDays} days after its event. The FTA expects a tax credit
          note within 14 days; it is still issued, but tell the accountant.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {lines.map((l, i) => {
          const pr = priced[i];
          return (
            <div key={l.key} className="rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-12">
                <Field label={`Line ${i + 1}`} className="sm:col-span-5">
                  <Input
                    value={l.description}
                    maxLength={200}
                    placeholder="What is sold"
                    onChange={(e) => set(l.key, { description: e.target.value })}
                  />
                </Field>
                <Field label="Qty" className="sm:col-span-1">
                  <Input inputMode="decimal" value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} />
                </Field>
                <Field label="Unit price" className="sm:col-span-2">
                  <Input inputMode="decimal" value={l.unit_price} onChange={(e) => set(l.key, { unit_price: e.target.value })} />
                </Field>
                <Field label="Discount" className="sm:col-span-2">
                  <Input inputMode="decimal" value={l.discount} onChange={(e) => set(l.key, { discount: e.target.value })} />
                </Field>
                <div className="flex items-end justify-end gap-2 sm:col-span-2">
                  <span className="text-sm tabular-nums">{pr.amounts ? money(pr.amounts.total) : "-"}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Remove line"
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Field label="Income account" className="sm:col-span-4">
                  <select
                    className={selectClass}
                    value={l.income_account_id}
                    onChange={(e) => set(l.key, { income_account_id: e.target.value })}
                  >
                    <option value="">Choose</option>
                    {options.incomeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="VAT" className="sm:col-span-2">
                  <select
                    className={selectClass}
                    value={l.tax_code_id}
                    onChange={(e) => set(l.key, { tax_code_id: e.target.value })}
                  >
                    <option value="">Choose</option>
                    {options.taxCodes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} ({t.rate}%)
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Branch" className="sm:col-span-2">
                  <select
                    className={selectClass}
                    value={l.branch_code}
                    onChange={(e) => set(l.key, { branch_code: e.target.value })}
                  >
                    <option value="">None</option>
                    {options.branches.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.name || b.code}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Department" className="sm:col-span-2">
                  <Input value={l.department} maxLength={60} onChange={(e) => set(l.key, { department: e.target.value })} />
                </Field>
                <Field label="Cost centre" className="sm:col-span-2">
                  <select
                    className={selectClass}
                    value={l.cost_centre_id}
                    onChange={(e) => set(l.key, { cost_centre_id: e.target.value })}
                  >
                    <option value="">None</option>
                    {options.costCentres.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {pr.problem && (l.unit_price !== "" || l.discount !== "") && (
                <p className="text-destructive mt-1 text-xs">Check the quantity, price and discount.</p>
              )}
            </div>
          );
        })}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>
            <Plus /> Add a line
          </Button>
        </div>
      </div>

      <Field label="Notes" hint="Printed on the document. Never a patient's details.">
        <Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <div className="flex flex-col items-end gap-1 text-sm tabular-nums">
        <span>Net {money(totals.net)}</span>
        {totals.byRate
          .filter((r) => r.rate > 0)
          .map((r) => (
            <span key={r.rate}>
              VAT {r.rate}% {money(r.vat)}
            </span>
          ))}
        <span className="text-base font-semibold">Total AED {money(totals.total)}</span>
        {!credit && customer && (
          <span className="text-muted-foreground text-xs">
            {invoiceForm(customer.trn, totals.total, options.simplifiedLimit) === "simplified"
              ? "Issued as a simplified tax invoice (customer not registered, AED 10,000 or less)."
              : "Issued as a full tax invoice."}
          </span>
        )}
        {totals.total > options.approvalThreshold && (
          <span className="text-muted-foreground text-xs">
            Above the approval limit (AED {money(options.approvalThreshold)}): someone else with the approval
            permission issues it.
          </span>
        )}
      </div>

      <div>
        <Button onClick={submit} disabled={pending || !customerId}>
          {pending && <Loader2 className="animate-spin" />} Save draft
        </Button>
      </div>
    </div>
  );
}
