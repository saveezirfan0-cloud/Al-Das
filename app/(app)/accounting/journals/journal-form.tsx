"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Field, selectClass } from "@/components/finance/forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { manualAllowed } from "@/lib/accounting/accounts";
import { ACCOUNTING_ERRORS } from "@/lib/accounting/errors";
import {
  journalTotals,
  MANUAL_VOUCHER_TYPES,
  parseAmount,
  validateJournal,
  VOUCHER_TYPE_LABELS,
  type ManualVoucherType,
} from "@/lib/accounting/journal";
import { money } from "@/lib/finance/format";

import { saveJournal } from "./actions";

export type FormAccount = {
  id: string;
  code: string;
  name: string;
  group: string;
  is_group: boolean;
  is_active: boolean;
  control: string | null;
  allow_manual: boolean;
};

export type JournalFormOptions = {
  entities: Array<{ id: string; name: string; is_default: boolean }>;
  accounts: FormAccount[];
  taxCodes: Array<{ id: string; code: string; name: string }>;
  costCentres: Array<{ id: string; code: string; name: string }>;
  branches: Array<{ code: string; name: string }>;
  doctors: Array<{ id: string; name: string }>;
  payers: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  canOpening: boolean;
  canAdjustment: boolean;
  today: string;
};

export type FormLine = {
  key: string;
  account_id: string;
  debit: string;
  credit: string;
  description: string;
  tax_code_id: string;
  branch_code: string;
  department: string;
  doctor_id: string;
  payer_id: string;
  supplier_id: string;
  cost_centre_id: string;
  more: boolean;
};

export type JournalInitial = {
  id: string;
  entity_id: string;
  voucher_type: ManualVoucherType;
  journal_date: string;
  narration: string;
  is_adjustment: boolean;
  auto_reverse_on: string;
  lines: Array<Omit<FormLine, "key" | "more">>;
};

let seq = 0;
const blank = (): FormLine => ({
  key: `l${++seq}`,
  account_id: "",
  debit: "",
  credit: "",
  description: "",
  tax_code_id: "",
  branch_code: "",
  department: "",
  doctor_id: "",
  payer_id: "",
  supplier_id: "",
  cost_centre_id: "",
  more: false,
});

export function JournalForm({
  options,
  initial,
}: {
  options: JournalFormOptions;
  initial?: JournalInitial;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [type, setType] = React.useState<ManualVoucherType>(initial?.voucher_type ?? "journal");
  const [entityId, setEntityId] = React.useState(
    initial?.entity_id ?? options.entities.find((e) => e.is_default)?.id ?? "",
  );
  const [date, setDate] = React.useState(initial?.journal_date ?? options.today);
  const [narration, setNarration] = React.useState(initial?.narration ?? "");
  const [adjustment, setAdjustment] = React.useState(initial?.is_adjustment ?? false);
  const [autoReverse, setAutoReverse] = React.useState(initial?.auto_reverse_on ?? "");
  const [lines, setLines] = React.useState<FormLine[]>(() =>
    initial?.lines.length
      ? initial.lines.map((l) => ({
          ...l,
          key: `l${++seq}`,
          more: !!(
            l.tax_code_id ||
            l.branch_code ||
            l.department ||
            l.doctor_id ||
            l.payer_id ||
            l.supplier_id ||
            l.cost_centre_id
          ),
        }))
      : [blank(), blank()],
  );

  const opening = type === "opening";
  const accountById = React.useMemo(
    () => new Map(options.accounts.map((a) => [a.id, a])),
    [options.accounts],
  );
  const choices = options.accounts.filter(
    (a) => !a.is_group && a.is_active && manualAllowed(a, opening),
  );
  const groups = [...new Set(choices.map((a) => a.group))];

  const checked = lines.map((l) => {
    const a = accountById.get(l.account_id);
    return {
      accountId: l.account_id || null,
      debit: parseAmount(l.debit),
      credit: parseAmount(l.credit),
      isGroup: a?.is_group,
      isActive: a?.is_active,
      control: a?.control ?? null,
      allowManual: a?.allow_manual,
    };
  });
  const totals = journalTotals(checked);
  const problems = validateJournal(checked, { manual: true, voucherType: type });

  const set = (key: string, patch: Partial<FormLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = () =>
    start(async () => {
      const res = await saveJournal({
        id: initial?.id ?? "",
        entity_id: entityId,
        voucher_type: type,
        journal_date: date,
        narration,
        is_adjustment: adjustment,
        auto_reverse_on: autoReverse,
        lines: lines
          .filter((l) => l.account_id || l.debit || l.credit)
          .map((l) => ({
            account_id: l.account_id,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            tax_code_id: l.tax_code_id,
            branch_code: l.branch_code,
            department: l.department,
            doctor_id: l.doctor_id,
            payer_id: l.payer_id,
            supplier_id: l.supplier_id,
            cost_centre_id: l.cost_centre_id,
          })),
      });
      if (res.ok && res.data) {
        toast.success(res.message ?? "Saved");
        router.push(`/accounting/journals/${res.data.id}`);
        router.refresh();
      } else if (!res.ok) toast.error(res.error);
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Type">
          <select
            className={selectClass}
            value={type}
            onChange={(e) => setType(e.target.value as ManualVoucherType)}
          >
            {MANUAL_VOUCHER_TYPES.filter((t) => t !== "opening" || options.canOpening).map((t) => (
              <option key={t} value={t}>
                {VOUCHER_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        {options.entities.length > 1 && (
          <Field label="Entity">
            <select
              className={selectClass}
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
            >
              {options.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label="Reverse automatically on"
          hint="Optional: for an accrual, the reversal is posted on this date."
        >
          <Input type="date" value={autoReverse} onChange={(e) => setAutoReverse(e.target.value)} />
        </Field>
      </div>
      <Field
        label="Narration"
        hint="What the journal is for. No patient names: card, account and phone numbers are masked."
      >
        <Input
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          maxLength={300}
          required
        />
      </Field>
      {options.canAdjustment && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={adjustment}
            onChange={(e) => setAdjustment(e.target.checked)}
          />
          Post to the year&apos;s adjustment period (dated the last day of the fiscal year)
        </label>
      )}

      <div className="flex flex-col gap-3">
        {lines.map((l, i) => {
          const lineProblems = problems.filter((p) => p.line === i + 1);
          return (
            <div key={l.key} className="rounded-md border p-3">
              <div className="grid gap-2 md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Field label={`Line ${i + 1}: account`}>
                  <select
                    className={selectClass}
                    value={l.account_id}
                    onChange={(e) => set(l.key, { account_id: e.target.value })}
                  >
                    <option value="">Choose an account</option>
                    {groups.map((g) => (
                      <optgroup key={g} label={g}>
                        {choices
                          .filter((a) => a.group === g)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} {a.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
                <Field label="Debit">
                  <Input
                    inputMode="decimal"
                    value={l.debit}
                    onChange={(e) =>
                      set(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })
                    }
                    className="text-right tabular-nums"
                  />
                </Field>
                <Field label="Credit">
                  <Input
                    inputMode="decimal"
                    value={l.credit}
                    onChange={(e) =>
                      set(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })
                    }
                    className="text-right tabular-nums"
                  />
                </Field>
                <div className="flex items-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => set(l.key, { more: !l.more })}
                  >
                    {l.more ? "Less" : "More"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {l.more && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Line description">
                    <Input
                      value={l.description}
                      maxLength={200}
                      onChange={(e) => set(l.key, { description: e.target.value })}
                    />
                  </Field>
                  <Field label="Branch">
                    <select
                      className={selectClass}
                      value={l.branch_code}
                      onChange={(e) => set(l.key, { branch_code: e.target.value })}
                    >
                      <option value="">None</option>
                      {options.branches.map((b) => (
                        <option key={b.code} value={b.code}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Department">
                    <Input
                      value={l.department}
                      maxLength={60}
                      onChange={(e) => set(l.key, { department: e.target.value })}
                    />
                  </Field>
                  <Field label="Cost centre">
                    <select
                      className={selectClass}
                      value={l.cost_centre_id}
                      onChange={(e) => set(l.key, { cost_centre_id: e.target.value })}
                    >
                      <option value="">None</option>
                      {options.costCentres.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tax code">
                    <select
                      className={selectClass}
                      value={l.tax_code_id}
                      onChange={(e) => set(l.key, { tax_code_id: e.target.value })}
                    >
                      <option value="">None</option>
                      {options.taxCodes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.code} {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Doctor">
                    <select
                      className={selectClass}
                      value={l.doctor_id}
                      onChange={(e) => set(l.key, { doctor_id: e.target.value })}
                    >
                      <option value="">None</option>
                      {options.doctors.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Payer">
                    <select
                      className={selectClass}
                      value={l.payer_id}
                      onChange={(e) => set(l.key, { payer_id: e.target.value })}
                    >
                      <option value="">None</option>
                      {options.payers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Supplier">
                    <select
                      className={selectClass}
                      value={l.supplier_id}
                      onChange={(e) => set(l.key, { supplier_id: e.target.value })}
                    >
                      <option value="">None</option>
                      {options.suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
              {lineProblems.length > 0 && (l.account_id || l.debit || l.credit) && (
                <p className="text-destructive mt-2 text-xs">
                  {lineProblems.map((p) => ACCOUNTING_ERRORS[p.code] ?? p.code).join(" ")}
                </p>
              )}
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((ls) => [...ls, blank()])}
          >
            <Plus /> Add a line
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
        <span>
          Debits <strong className="tabular-nums">{money(totals.debit)}</strong>
        </span>
        <span>
          Credits <strong className="tabular-nums">{money(totals.credit)}</strong>
        </span>
        {totals.difference === 0 && totals.debit > 0 ? (
          <Badge variant="secondary">Balanced</Badge>
        ) : (
          <Badge variant="destructive">Difference {money(Math.abs(totals.difference))}</Badge>
        )}
        {problems
          .filter((p) => !p.line)
          .map((p) => (
            <span key={p.code} className="text-muted-foreground text-xs">
              {ACCOUNTING_ERRORS[p.code] ?? p.code}
            </span>
          ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={submit} disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save draft
        </Button>
        <p className="text-muted-foreground self-center text-xs">
          A draft can be unbalanced. Submit it from the journal page when it is ready; someone else
          posts it.
        </p>
      </div>
    </div>
  );
}
