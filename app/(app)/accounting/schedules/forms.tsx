"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { saveSchedule, scheduleStep } from "./actions";

/** Add and edit a prepayment, accrual or deferred revenue schedule; cancel or delete one. */

type Ledger = { id: string; code: string; name: string; nature: string };

export type ScheduleFormValue = {
  id: string;
  kind: string;
  description: string;
  plAccountId: string;
  bsAccountId: string;
  total: number;
  startMonth: string;
  months: number;
  branchCode: string | null;
  department: string | null;
  autoReverse: boolean;
  supplierInvoiceId: string | null;
};

export function ScheduleButton({
  schedule,
  ledgers,
  branches,
  invoices,
  defaultMonth,
}: {
  schedule?: ScheduleFormValue;
  ledgers: Ledger[];
  branches: string[];
  invoices: Array<{ id: string; label: string }>;
  defaultMonth: string;
}) {
  const router = useRouter();
  const options = (natures: string[]) =>
    ledgers
      .filter((l) => natures.includes(l.nature))
      .map((l) => (
        <option key={l.id} value={l.id}>
          {l.code} {l.name}
        </option>
      ));
  return (
    <FormSheet
      trigger={schedule ? "Edit" : "Add schedule"}
      title={schedule ? "Edit schedule" : "Add a schedule"}
      description="Prepayment: expense and the prepayment (asset) ledger. Accrual: expense and the accrued (liability) ledger. Deferred revenue: income and the deferred revenue (liability) ledger. Released evenly each month by the schedule runs."
      variant={schedule ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveSchedule}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {schedule && <input type="hidden" name="id" value={schedule.id} />}
          <Field label="Kind">
            <select
              name="kind"
              defaultValue={schedule?.kind ?? "prepayment"}
              className={selectClass}
            >
              <option value="prepayment">Prepayment</option>
              <option value="accrual">Accrual</option>
              <option value="deferred_revenue">Deferred revenue</option>
            </select>
          </Field>
          <Field
            label="Description"
            hint="For example: insurance premium 2026-27, rent of the leased unit."
          >
            <Input
              name="description"
              defaultValue={schedule?.description ?? ""}
              maxLength={200}
              required
            />
          </Field>
          <Field label="Expense or income ledger">
            <select
              name="pl_account_id"
              defaultValue={schedule?.plAccountId ?? ""}
              className={selectClass}
              required
            >
              <option value="">Choose</option>
              {options(["expense", "income"])}
            </select>
          </Field>
          <Field
            label="Balance sheet ledger"
            hint="Prepayments (asset), accrued expenses or deferred revenue (liability)."
          >
            <select
              name="bs_account_id"
              defaultValue={schedule?.bsAccountId ?? ""}
              className={selectClass}
              required
            >
              <option value="">Choose</option>
              {options(["asset", "liability"])}
            </select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Total (AED)">
              <Input
                name="total"
                inputMode="decimal"
                defaultValue={schedule ? schedule.total.toFixed(2) : ""}
                required
              />
            </Field>
            <Field label="First month">
              <Input
                type="month"
                name="start_month"
                defaultValue={schedule?.startMonth.slice(0, 7) ?? defaultMonth}
                required
              />
            </Field>
            <Field label="Months">
              <Input
                name="months"
                inputMode="numeric"
                defaultValue={schedule ? String(schedule.months) : "12"}
                required
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <select
                name="branch_code"
                defaultValue={schedule?.branchCode ?? ""}
                className={selectClass}
              >
                <option value="">None</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Department">
              <Input name="department" defaultValue={schedule?.department ?? ""} maxLength={60} />
            </Field>
          </div>
          <Field label="Bill (optional)">
            <select
              name="supplier_invoice_id"
              defaultValue={schedule?.supplierInvoiceId ?? ""}
              className={selectClass}
            >
              <option value="">None</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="auto_reverse"
              defaultChecked={schedule?.autoReverse ?? false}
            />{" "}
            Accrual only: reverse each month&apos;s accrual on the 1st of the next month (for
            estimates replaced by the real bill)
          </label>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function ScheduleStepButton({ id, action }: { id: string; action: "cancel" | "delete" }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      confirm={
        action === "cancel"
          ? "Cancel this schedule? Nothing more is released; what was released stays in the ledger."
          : "Delete this schedule? Only a schedule with no releases can be deleted."
      }
      action={() => scheduleStep({ id, action })}
      onDone={() => router.refresh()}
    >
      {action === "cancel" ? "Cancel" : "Delete"}
    </RunButton>
  );
}
