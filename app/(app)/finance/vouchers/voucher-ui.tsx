"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, Loader2, Pencil, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import {
  DocumentChip,
  FinanceUploadButton,
  type UploadedDocument,
} from "@/components/finance/finance-upload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/finance/format";
import {
  approvalRoute,
  EVENT_LABEL,
  METHOD_LABEL,
  PAYMENT_METHODS,
  SPECIAL_CATEGORIES,
  SPECIAL_LABEL,
  STATUS_LABEL,
  requiredApprovals,
  waitingFor,
  type ApprovalTier,
  type SpecialCategory,
  type VoucherAction,
  type VoucherStatus,
} from "@/lib/finance/vouchers";
import type { VoucherDetail } from "@/lib/finance/vouchers-server";

import { bulkCheckVouchers, saveVoucher, voucherStep } from "./actions";

export type VoucherFormOptions = {
  suppliers: Array<{ id: string; name: string; default_category: string | null }>;
  invoices: Array<{
    id: string;
    supplier_id: string;
    invoice_number: string;
    invoice_date: string;
    total: number;
    category: string;
    branch_code: string | null;
    document: UploadedDocument | null;
  }>;
  branches: Array<{ code: string; name: string }>;
  banks: string[];
  categories: string[];
  tiers: ApprovalTier[];
  approvalMode: "pulse" | "tally";
  today: string;
};

export type VoucherPerms = {
  prepare: boolean;
  check: boolean;
  dept: boolean;
  ceo: boolean;
  pay: boolean;
};

const STATUS_VARIANT: Record<
  VoucherStatus,
  "outline" | "secondary" | "warning" | "success" | "destructive"
> = {
  draft: "outline",
  submitted: "warning",
  checked: "warning",
  dept_approved: "warning",
  approved: "success",
  for_tally: "secondary",
  paid: "success",
  rejected: "destructive",
  cancelled: "outline",
};

export function StatusBadge({ status }: { status: VoucherStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------------------------------------------------

type Initial = {
  id?: string;
  voucher_date: string;
  payee_name: string;
  supplier_id: string;
  amount: string;
  category: string;
  special_category: SpecialCategory;
  branch_code: string;
  cost_centre: string;
  pay_from: string;
  payment_method: string;
  narration: string;
  invoiceIds: string[];
  documents: UploadedDocument[];
};

export function VoucherForm({
  options,
  initial,
  warnReturnToDraft,
  onDone,
}: {
  options: VoucherFormOptions;
  initial: Initial;
  warnReturnToDraft?: boolean;
  onDone: (id: string) => void;
}) {
  const [supplierId, setSupplierId] = React.useState(initial.supplier_id);
  const [payee, setPayee] = React.useState(initial.payee_name);
  const [amount, setAmount] = React.useState(initial.amount);
  const [category, setCategory] = React.useState(initial.category);
  const [branch, setBranch] = React.useState(initial.branch_code);
  const [special, setSpecial] = React.useState<SpecialCategory>(initial.special_category);
  const [invoiceIds, setInvoiceIds] = React.useState<string[]>(initial.invoiceIds);
  const [documents, setDocuments] = React.useState<UploadedDocument[]>(initial.documents);
  const [pending, start] = React.useTransition();

  const visibleInvoices = options.invoices.filter(
    (i) => !supplierId || i.supplier_id === supplierId,
  );
  const selected = options.invoices.filter((i) => invoiceIds.includes(i.id));
  const invoiceTotal = Math.round(selected.reduce((a, i) => a + i.total, 0) * 100) / 100;
  const amountNum = Number(amount.replace(/,/g, ""));
  const route =
    options.approvalMode === "tally"
      ? null
      : Number.isFinite(amountNum) && amountNum > 0
        ? requiredApprovals(amountNum, special, options.tiers)
        : undefined;
  const backupCount = documents.length + selected.filter((i) => i.document).length;

  const toggleInvoice = (id: string) => {
    const inv = options.invoices.find((i) => i.id === id);
    setInvoiceIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (inv && !cur.includes(id) && cur.length === 0) {
        // first invoice: fill what is empty from it
        const supplier = options.suppliers.find((s) => s.id === inv.supplier_id);
        if (!supplierId) setSupplierId(inv.supplier_id);
        if (!payee && supplier) setPayee(supplier.name);
        if (!category) setCategory(inv.category);
        if (!branch && inv.branch_code) setBranch(inv.branch_code);
      }
      return next;
    });
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const values: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
        values.invoice_ids = invoiceIds.join(",");
        values.document_ids = documents.map((d) => d.id).join(",");
        start(async () => {
          const res = await saveVoucher(values);
          if (res.ok && res.data) {
            toast.success(res.message ?? "Saved");
            onDone(res.data.id);
          } else if (!res.ok) toast.error(res.error);
        });
      }}
    >
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      {warnReturnToDraft && (
        <p className="rounded-md border border-amber-300 dark:border-amber-500/30 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          This voucher has been submitted. Saving a change returns it to draft and clears every
          approval; it must be submitted and approved again.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Voucher date">
          <Input type="date" name="voucher_date" defaultValue={initial.voucher_date} required />
        </Field>
        <Field label="Supplier (optional)">
          <select
            name="supplier_id"
            className={selectClass}
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value);
              const s = options.suppliers.find((x) => x.id === e.target.value);
              if (s && !payee) setPayee(s.name);
              if (s?.default_category && !category) setCategory(s.default_category);
            }}
          >
            <option value="">Not a supplier</option>
            {options.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Payee">
        <Input
          name="payee_name"
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          maxLength={120}
          required
        />
      </Field>

      {visibleInvoices.length > 0 && (
        <Field
          label="Supplier invoices paid by this voucher"
          hint="Their documents travel with the voucher."
        >
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2">
            {visibleInvoices.map((i) => (
              <label key={i.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={invoiceIds.includes(i.id)}
                  onChange={() => toggleInvoice(i.id)}
                />
                <span className="font-mono text-xs">{i.invoice_number}</span>
                <span className="text-muted-foreground text-xs">{i.invoice_date}</span>
                <span className="ml-auto tabular-nums">{money(i.total)}</span>
              </label>
            ))}
          </div>
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Amount (AED)"
          hint={selected.length ? `Selected invoices: ${money(invoiceTotal)}` : undefined}
        >
          <div className="flex gap-2">
            <Input
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            {selected.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAmount(invoiceTotal.toFixed(2))}
              >
                Use total
              </Button>
            )}
          </div>
        </Field>
        <Field
          label="Special category"
          hint="Payroll, intercompany and related-party always go to the CEO."
        >
          <select
            name="special_category"
            className={selectClass}
            value={special}
            onChange={(e) => setSpecial(e.target.value as SpecialCategory)}
          >
            {SPECIAL_CATEGORIES.map((s) => (
              <option key={s} value={s}>
                {SPECIAL_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <Input
            name="category"
            list="voucher-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={60}
            required
          />
          <datalist id="voucher-categories">
            {options.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Branch (cost centre)">
          <select
            name="branch_code"
            className={selectClass}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">None</option>
            {options.branches.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Other cost centre (optional)">
          <Input name="cost_centre" defaultValue={initial.cost_centre} maxLength={40} />
        </Field>
        <Field label="Pay from" hint="The bank or cash account (mapped to a Tally ledger).">
          <Input
            name="pay_from"
            list="voucher-banks"
            defaultValue={initial.pay_from}
            maxLength={40}
          />
          <datalist id="voucher-banks">
            {options.banks.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </Field>
        <Field label="Payment method">
          <select
            name="payment_method"
            className={selectClass}
            defaultValue={initial.payment_method}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Narration" hint="What the payment is for. It goes to Tally with the voucher.">
        <Textarea
          name="narration"
          defaultValue={initial.narration}
          maxLength={500}
          rows={3}
          required
        />
      </Field>

      <Field
        label="Supporting documents"
        hint="Zero paper: attach the backup (PDF or a photo of the paper invoice)."
      >
        <div className="flex flex-col gap-2">
          {documents.map((d) => (
            <DocumentChip
              key={d.id}
              doc={d}
              onRemove={() => setDocuments((cur) => cur.filter((x) => x.id !== d.id))}
            />
          ))}
          {selected
            .filter((i) => i.document)
            .map((i) => (
              <DocumentChip key={i.document!.id} doc={i.document!} />
            ))}
          <div>
            <FinanceUploadButton
              kind="voucher_backup"
              onUploaded={(d) =>
                setDocuments((cur) => (cur.some((x) => x.id === d.id) ? cur : [...cur, d]))
              }
            />
          </div>
          {backupCount === 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              A voucher cannot be submitted without at least one document.
            </p>
          )}
        </div>
      </Field>

      <p className="text-muted-foreground rounded-md border p-2 text-xs">
        {options.approvalMode === "tally"
          ? "Approval mode is Tally: on submission the voucher goes to Tally for authorisation."
          : route === undefined
            ? "Enter the amount to see who approves it."
            : route === null
              ? "No approval rule covers this amount or category; it cannot be submitted until Voucher settings are fixed."
              : `Approval: ${approvalRoute({ route: "pulse", tier: route.tier, needsDept: route.needsDept, needsCeo: route.needsCeo })}`}
      </p>

      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save draft
        </Button>
      </div>
    </form>
  );
}

export function NewVoucherButton({
  options,
  prefill,
}: {
  options: VoucherFormOptions;
  prefill?: Partial<Initial> & { open?: boolean };
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(!!prefill?.open);
  const initial: Initial = {
    voucher_date: options.today,
    payee_name: "",
    supplier_id: "",
    amount: "",
    category: "",
    special_category: "none",
    branch_code: "",
    cost_centre: "",
    pay_from: "",
    payment_method: "bank_transfer",
    narration: "",
    invoiceIds: [],
    documents: [],
    ...prefill,
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>New voucher</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>New payment voucher</SheetTitle>
            <SheetDescription>
              Saved as a draft. Attach the backup, then submit it for verification.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <VoucherForm
              options={options}
              initial={initial}
              onDone={(id) => {
                setOpen(false);
                router.push(`/finance/vouchers?tab=drafts&v=${id}`);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The record drawer
// ---------------------------------------------------------------------------------------------------------------------

function StepButton({
  label,
  run,
  variant = "default",
  disabled,
}: {
  label: string;
  run: () => Promise<void>;
  variant?: "default" | "outline" | "destructive" | "secondary";
  disabled?: boolean;
}) {
  const [pending, start] = React.useTransition();
  return (
    <Button
      className="min-h-11"
      variant={variant}
      disabled={pending || disabled}
      onClick={() => start(run)}
    >
      {pending && <Loader2 className="animate-spin" />} {label}
    </Button>
  );
}

export function VoucherDrawer({
  detail,
  perms,
  userId,
  options,
  closeHref,
}: {
  detail: VoucherDetail;
  perms: VoucherPerms;
  userId: string;
  options: VoucherFormOptions | null;
  closeHref: string;
}) {
  const router = useRouter();
  const v = detail.voucher;
  const [editing, setEditing] = React.useState(false);
  const [remarks, setRemarks] = React.useState("");
  const [payDate, setPayDate] = React.useState(options?.today ?? "");
  const [payRef, setPayRef] = React.useState("");
  const isMaker = detail.makers.includes(userId);
  const next = waitingFor({ status: v.status, needsDept: v.needs_dept, needsCeo: v.needs_ceo });
  const intact = !v.content_sha256 || v.content_sha256 === detail.currentHash;

  const step = async (
    action: VoucherAction,
    extra: { remarks?: string; payment_date?: string; payment_reference?: string } = {},
  ) => {
    const res = await voucherStep({ id: v.id, action, hash: v.content_sha256, ...extra });
    if (res.ok) {
      toast.success(res.message ?? "Done");
      setRemarks("");
      router.refresh();
    } else toast.error(res.error);
  };

  const canDecide =
    !isMaker &&
    ((next.step === "check" && perms.check) ||
      (next.step === "approve_dept" && perms.dept) ||
      (next.step === "approve_ceo" && perms.ceo));
  const editable =
    perms.prepare &&
    !["paid", "cancelled"].includes(v.status) &&
    !v.tally_exported_at &&
    !detail.locked;

  return (
    <Sheet open onOpenChange={(o) => !o && router.push(closeHref)}>
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {v.voucher_no} <StatusBadge status={v.status} />
          </SheetTitle>
          <SheetDescription>
            {v.payee_name}, AED {money(v.amount)}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-8">
          {editing && options ? (
            <>
              <VoucherForm
                options={options}
                warnReturnToDraft={!["draft", "rejected"].includes(v.status)}
                initial={{
                  id: v.id,
                  voucher_date: v.voucher_date,
                  payee_name: v.payee_name,
                  supplier_id: v.supplier_id ?? "",
                  amount: v.amount.toFixed(2),
                  category: v.category,
                  special_category: v.special_category,
                  branch_code: v.branch_code ?? "",
                  cost_centre: v.cost_centre ?? "",
                  pay_from: v.pay_from ?? "",
                  payment_method: v.payment_method,
                  narration: v.narration,
                  invoiceIds: detail.invoices.map((i) => i.id),
                  documents: detail.documents
                    .filter((d) => d.via === "voucher")
                    .map((d) => ({
                      id: d.id,
                      kind: d.kind,
                      sha256: d.sha256,
                      size: Number(d.size_bytes),
                      scan: d.scan_status,
                    })),
                }}
                onDone={() => {
                  setEditing(false);
                  router.refresh();
                }}
              />
              <Button variant="outline" onClick={() => setEditing(false)}>
                Back
              </Button>
            </>
          ) : (
            <>
              {v.status === "rejected" && v.rejection_remarks && (
                <div className="rounded-md border border-red-300 dark:border-red-500/30 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-100">
                  <p className="font-medium">Rejected</p>
                  <p className="whitespace-pre-wrap">{v.rejection_remarks}</p>
                </div>
              )}
              {detail.locked && (
                <p className="text-muted-foreground text-sm">
                  The month of this voucher is locked; it cannot change.
                </p>
              )}

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Date</dt>
                <dd>{v.voucher_date}</dd>
                <dt className="text-muted-foreground">Payee</dt>
                <dd>
                  {v.payee_name}
                  {v.supplier_name && v.supplier_name !== v.payee_name
                    ? ` (supplier ${v.supplier_name})`
                    : ""}
                </dd>
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-medium tabular-nums">
                  {v.currency} {money(v.amount)}
                </dd>
                <dt className="text-muted-foreground">Category</dt>
                <dd>
                  {v.category}
                  {v.special_category !== "none" && (
                    <Badge variant="warning" className="ml-2">
                      {SPECIAL_LABEL[v.special_category]}
                    </Badge>
                  )}
                </dd>
                <dt className="text-muted-foreground">Branch</dt>
                <dd>{[v.branch_code, v.cost_centre].filter(Boolean).join(" / ") || "-"}</dd>
                <dt className="text-muted-foreground">Pay from</dt>
                <dd>
                  {v.pay_from ?? "-"} ({METHOD_LABEL[v.payment_method]})
                </dd>
                <dt className="text-muted-foreground">Approval</dt>
                <dd>
                  {approvalRoute({
                    route: v.route,
                    tier: v.tier_code,
                    needsDept: v.needs_dept,
                    needsCeo: v.needs_ceo,
                  })}
                </dd>
                {v.payment_reference && (
                  <>
                    <dt className="text-muted-foreground">Paid</dt>
                    <dd>
                      {v.payment_date}, ref {v.payment_reference}
                    </dd>
                  </>
                )}
                {v.tally_exported_at && (
                  <>
                    <dt className="text-muted-foreground">Tally</dt>
                    <dd>Exported {v.tally_exported_at.slice(0, 10)}</dd>
                  </>
                )}
              </dl>
              <p className="text-sm whitespace-pre-wrap">{v.narration}</p>

              {detail.invoices.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Supplier invoices</p>
                  {detail.invoices.map((i) => (
                    <p key={i.id} className="flex justify-between text-sm">
                      <span className="font-mono text-xs">{i.invoice_number}</span>
                      <span className="tabular-nums">{money(i.total)}</span>
                    </p>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Supporting documents</p>
                {detail.documents.length === 0 ? (
                  <p className="text-muted-foreground text-sm">None attached yet.</p>
                ) : (
                  detail.documents.map((d) => (
                    <DocumentChip
                      key={d.id}
                      doc={{
                        id: d.id,
                        kind: d.kind,
                        sha256: d.sha256,
                        size: Number(d.size_bytes),
                        scan: d.scan_status,
                      }}
                    />
                  ))
                )}
              </div>

              <p className="flex items-center gap-1 text-xs">
                {intact ? (
                  <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <ShieldAlert className="size-4 text-red-600 dark:text-red-400" />
                )}
                <span className="text-muted-foreground">Fingerprint</span>
                <span className="font-mono" title={detail.currentHash}>
                  {detail.currentHash.slice(0, 16)}…
                </span>
                {!intact && <span className="text-red-700 dark:text-red-300">does not match what was approved</span>}
              </p>

              {/* ---- actions ---- */}
              <div className="flex flex-col gap-3 rounded-md border p-3">
                {next.step &&
                  next.step !== "pay" &&
                  isMaker &&
                  (perms.check || perms.dept || perms.ceo) && (
                    <p className="text-muted-foreground text-sm">
                      You prepared or changed this voucher, so someone else must verify and approve
                      it.
                    </p>
                  )}
                {(v.status === "draft" || v.status === "rejected") && perms.prepare && (
                  <div className="flex flex-wrap gap-2">
                    <StepButton
                      label="Submit for verification"
                      run={() => step("submit")}
                      disabled={detail.locked}
                    />
                    {v.status === "rejected" && (
                      <StepButton
                        label="Reopen as draft"
                        variant="outline"
                        run={() => step("reopen")}
                      />
                    )}
                  </div>
                )}
                {canDecide && (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      placeholder="Remarks (required to reject)"
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      rows={2}
                      maxLength={1000}
                    />
                    <div className="flex flex-wrap gap-2">
                      <StepButton
                        label={
                          next.step === "check"
                            ? "Verify"
                            : next.step === "approve_dept"
                              ? "Approve"
                              : "Authorise"
                        }
                        run={() => step(next.step as VoucherAction, { remarks })}
                        disabled={!intact}
                      />
                      <StepButton
                        label="Reject"
                        variant="destructive"
                        disabled={remarks.trim().length < 3}
                        run={() => step("reject", { remarks })}
                      />
                    </div>
                  </div>
                )}
                {next.step === "pay" && perms.pay && (
                  <div className="flex flex-col gap-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="Payment date">
                        <Input
                          type="date"
                          value={payDate}
                          onChange={(e) => setPayDate(e.target.value)}
                        />
                      </Field>
                      <Field label="Bank reference">
                        <Input
                          value={payRef}
                          onChange={(e) => setPayRef(e.target.value)}
                          maxLength={60}
                        />
                      </Field>
                    </div>
                    <div>
                      <StepButton
                        label="Record payment"
                        disabled={!payDate || payRef.trim() === ""}
                        run={() =>
                          step("pay", { payment_date: payDate, payment_reference: payRef })
                        }
                      />
                    </div>
                  </div>
                )}
                {perms.prepare &&
                  ["draft", "rejected", "for_tally"].includes(v.status) &&
                  !v.tally_exported_at && (
                    <div className="flex flex-col gap-2 border-t pt-3">
                      <Input
                        placeholder="Why cancel? (required)"
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        maxLength={1000}
                      />
                      <div>
                        <StepButton
                          label="Cancel voucher"
                          variant="outline"
                          disabled={remarks.trim().length < 3}
                          run={() => step("cancel", { remarks })}
                        />
                      </div>
                    </div>
                  )}
                <div className="flex flex-wrap gap-2">
                  {editable && options && (
                    <Button variant="outline" className="min-h-11" onClick={() => setEditing(true)}>
                      <Pencil /> Edit
                    </Button>
                  )}
                  <Button asChild variant="outline" className="min-h-11">
                    <a href={`/api/finance/vouchers/${v.id}/certificate`}>
                      <Download /> Approval certificate
                    </a>
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Trail</p>
                <ol className="flex flex-col gap-2">
                  {detail.events.map((e) => (
                    <li key={e.id} className="border-l-2 pl-3 text-sm">
                      <p className="font-medium">{EVENT_LABEL[e.action] ?? e.action}</p>
                      <p className="text-muted-foreground text-xs">
                        {e.actor}, {new Date(e.at).toLocaleString("en-GB")}
                      </p>
                      {e.remarks && <p className="text-sm whitespace-pre-wrap">{e.remarks}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Bulk verification (Tier 1 only)
// ---------------------------------------------------------------------------------------------------------------------

export function BulkCheck({
  rows,
}: {
  rows: Array<{ id: string; voucher_no: string; payee_name: string; amount: number; hash: string }>;
}) {
  const router = useRouter();
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [pending, start] = React.useTransition();
  if (rows.length === 0) return null;
  const total = rows.filter((r) => chosen.includes(r.id)).reduce((a, r) => a + r.amount, 0);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Routine Tier 1 vouchers you can verify together</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setChosen(chosen.length === rows.length ? [] : rows.map((r) => r.id))}
        >
          {chosen.length === rows.length ? "Clear" : "Select all"}
        </Button>
      </div>
      {rows.map((r) => (
        <label key={r.id} className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.includes(r.id)}
            onChange={() =>
              setChosen((c) => (c.includes(r.id) ? c.filter((x) => x !== r.id) : [...c, r.id]))
            }
          />
          <span className="font-mono text-xs">{r.voucher_no}</span>
          <span className="truncate">{r.payee_name}</span>
          <span className="ml-auto tabular-nums">{money(r.amount)}</span>
        </label>
      ))}
      <div>
        <Button
          className="min-h-11"
          disabled={pending || chosen.length === 0}
          onClick={() =>
            start(async () => {
              const res = await bulkCheckVouchers({
                items: rows
                  .filter((r) => chosen.includes(r.id))
                  .map((r) => ({ id: r.id, hash: r.hash })),
              });
              if (res.ok) {
                toast.success(res.message ?? "Done");
                setChosen([]);
                router.refresh();
              } else toast.error(res.error);
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Verify {chosen.length}{" "}
          (AED {money(total)})
        </Button>
      </div>
    </div>
  );
}

export function VoucherLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} scroll={false} className="block rounded-md border p-3 hover:bg-accent/50">
      {children}
    </Link>
  );
}
