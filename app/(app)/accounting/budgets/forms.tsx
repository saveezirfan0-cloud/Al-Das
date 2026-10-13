"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { monthLabel } from "@/lib/accounting/statements/report";

import { actOnBudget, importBudgetCsv, saveBudgetGrid, saveBudgetHeader } from "./actions";

export function BudgetHeaderButton({
  budget,
  years,
  entities,
}: {
  budget?: { id: string; name: string; fy_start: string; entity_id: string };
  years: Array<{ start: string; label: string }>;
  entities: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger={budget ? "Rename" : "New budget"}
      title={budget ? "Rename the budget" : "New budget"}
      description="A budget covers one fiscal year. Enter the amounts in the grid or import a CSV; a different person approves it."
      variant={budget ? "outline" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveBudgetHeader}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {budget && <input type="hidden" name="id" value={budget.id} />}
          {budget ? (
            <>
              <input type="hidden" name="fy_start" value={budget.fy_start} />
              <input type="hidden" name="entity_id" value={budget.entity_id} />
            </>
          ) : (
            <>
              {entities.length > 1 && (
                <Field label="Entity">
                  <select name="entity_id" className={selectClass} defaultValue="">
                    <option value="">The default entity</option>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Fiscal year">
                <select name="fy_start" className={selectClass} defaultValue={years[0]?.start}>
                  {years.map((y) => (
                    <option key={y.start} value={y.start}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label="Name">
            <Input name="name" defaultValue={budget?.name ?? ""} maxLength={80} required />
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export type GridAccount = { id: string; code: string; name: string; nature: "income" | "expense" };

/** Twelve months by ledger. Saves the whole-entity lines; lines with a branch or department are kept as they are. */
export function BudgetGrid({
  budgetId,
  accounts,
  months,
  initial,
  editable,
}: {
  budgetId: string;
  accounts: GridAccount[];
  months: string[];
  initial: Record<string, number>;
  editable: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ? String(v) : ""])),
  );
  const [pending, start] = React.useTransition();
  const key = (a: string, m: string) => `${a}|${m}`;
  const num = (s: string | undefined) => {
    const v = Number((s ?? "").replace(/,/g, ""));
    return Number.isFinite(v) ? v : 0;
  };
  const save = () => {
    const cells: Array<{ account_id: string; month: string; amount: number }> = [];
    for (const a of accounts)
      for (const m of months) {
        const raw = (values[key(a.id, m)] ?? "").trim().replace(/,/g, "");
        if (raw === "") continue;
        if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
          toast.error(
            `${a.code} ${monthLabel(m)}: amounts are zero or more with at most two decimals.`,
          );
          return;
        }
        cells.push({ account_id: a.id, month: m, amount: Number(raw) });
      }
    start(async () => {
      const res = await saveBudgetGrid({ id: budgetId, cells });
      if (res.ok) {
        toast.success(res.message ?? "Saved");
        router.refresh();
      } else toast.error(res.error);
    });
  };
  const sections: Array<{ title: string; list: GridAccount[] }> = [
    { title: "Income", list: accounts.filter((a) => a.nature === "income") },
    { title: "Expenses", list: accounts.filter((a) => a.nature === "expense") },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-10 bg-inherit px-2 py-2 text-left font-medium">
                Ledger
              </th>
              {months.map((m) => (
                <th key={m} className="px-1 py-2 text-right font-medium whitespace-nowrap">
                  {monthLabel(m)}
                </th>
              ))}
              <th className="px-2 py-2 text-right font-medium">Year</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <React.Fragment key={s.title}>
                <tr>
                  <td colSpan={months.length + 2} className="px-2 pt-3 pb-1 font-medium">
                    {s.title}
                  </td>
                </tr>
                {s.list.map((a) => {
                  const total = months.reduce((t, m) => t + num(values[key(a.id, m)]), 0);
                  return (
                    <tr key={a.id} className="border-t">
                      <td className="bg-background sticky left-0 z-10 px-2 py-1 whitespace-nowrap">
                        <span className="text-muted-foreground mr-2 font-mono text-xs">
                          {a.code}
                        </span>
                        {a.name}
                      </td>
                      {months.map((m) => (
                        <td key={m} className="px-1 py-1">
                          {editable ? (
                            <Input
                              aria-label={`${a.name} ${monthLabel(m)}`}
                              inputMode="decimal"
                              className="h-8 w-24 text-right tabular-nums"
                              value={values[key(a.id, m)] ?? ""}
                              onChange={(e) =>
                                setValues((v) => ({ ...v, [key(a.id, m)]: e.target.value }))
                              }
                            />
                          ) : (
                            <span className="block w-24 text-right tabular-nums">
                              {num(values[key(a.id, m)]).toLocaleString("en-GB", {
                                minimumFractionDigits: 2,
                              })}
                            </span>
                          )}
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right tabular-nums">
                        {total.toLocaleString("en-GB", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save the grid
          </Button>
        </div>
      )}
    </div>
  );
}

export function BudgetCsvImport({ budgetId }: { budgetId: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const file = (e.currentTarget.elements.namedItem("file") as HTMLInputElement | null)
          ?.files?.[0];
        if (!file) return toast.error("Choose a CSV file.");
        if (file.size > 2_000_000) return toast.error("The file is larger than 2 MB.");
        start(async () => {
          const csv = await file.text();
          const res = await importBudgetCsv({ id: budgetId, csv });
          if (res.ok) {
            toast.success("Budget imported.");
            router.refresh();
          } else toast.error(res.error);
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Import a CSV (replaces every line)</span>
        <Input type="file" name="file" accept=".csv,text/csv" className="w-72" />
      </label>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />} Import
      </Button>
    </form>
  );
}

export function BudgetActions({
  id,
  status,
  hash,
  canApprove,
  canManage,
}: {
  id: string;
  status: "draft" | "approved";
  hash: string | null;
  canApprove: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const done = () => router.refresh();
  return (
    <div className="flex flex-wrap gap-2">
      {status === "draft" && canApprove && (
        <RunButton
          variant="default"
          confirm="Approve this budget as it is shown now?"
          action={() => actOnBudget({ id, action: "approve", hash })}
          onDone={done}
        >
          Approve
        </RunButton>
      )}
      {status === "approved" && canManage && (
        <RunButton
          confirm="Reopen the budget as a draft? It will need approving again."
          action={() => actOnBudget({ id, action: "reopen" })}
          onDone={done}
        >
          Reopen
        </RunButton>
      )}
      {status === "draft" && canManage && (
        <RunButton
          variant="ghost"
          confirm="Delete this draft budget?"
          action={() => actOnBudget({ id, action: "delete" })}
          onDone={() => router.push("/accounting/budgets")}
        >
          Delete
        </RunButton>
      )}
    </div>
  );
}
