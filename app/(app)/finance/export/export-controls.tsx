"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { money } from "@/lib/finance/format";

import {
  deleteAccountMapping,
  previewAccountingExport,
  saveAccountMapping,
  type ExportPreview,
} from "./actions";

export function ExportPanel({
  defaultFrom,
  defaultTo,
}: {
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = React.useState(defaultFrom);
  const [to, setTo] = React.useState(defaultTo);
  const [res, setRes] = React.useState<ExportPreview | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <Input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setRes(null);
          }}
          aria-label="From"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setRes(null);
          }}
          aria-label="To"
        />
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await previewAccountingExport({ from, to });
              if (r.ok && r.data) setRes(r.data);
              else if (!r.ok) toast.error(r.error);
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />} Check the period
        </Button>
        <Button asChild disabled={!res?.ready}>
          <a
            aria-disabled={!res?.ready}
            href={res?.ready ? `/api/finance/export/accounting?from=${from}&to=${to}` : undefined}
          >
            Download CSV
          </a>
        </Button>
      </div>
      {res && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={res.status === "final" ? "success" : "warning"}>
              {res.status === "final" ? "FINAL: every month is locked" : "PROVISIONAL"}
            </Badge>
            {res.ready ? (
              <span>
                {res.rows} journal line(s), debits {money(res.debit)} = credits {money(res.credit)}.
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">Not ready: map the accounts marked below.</span>
            )}
          </div>
          {res.openMonths.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Not locked yet: {res.openMonths.join(", ")}. Their figures can still change, so
              re-export after the close.
            </p>
          )}
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            {res.needed.map((n) => (
              <li
                key={`${n.kind}:${n.key}`}
                className={n.mapped ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}
              >
                {n.mapped ? "✓" : "✗"} {n.kind.replaceAll("_", " ")}
                {n.key !== "*" ? `: ${n.key}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const KINDS: Array<[string, string]> = [
  ["revenue", "Revenue by service category"],
  ["payment_mode", "Payment mode (cash, card…)"],
  ["receivable", "Receivable (insurance or self-pay)"],
  ["vat_output", "VAT output"],
  ["writeoff", "Write-offs"],
  ["credit_note", "Credit notes"],
  ["rounding", "Rounding difference"],
];

export function MappingForm() {
  const [kind, setKind] = React.useState("revenue");
  const needsKey = ["revenue", "payment_mode", "receivable"].includes(kind);
  return (
    <ActionForm action={saveAccountMapping} submitLabel="Save account" variant="secondary">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="What">
          <select
            name="kind"
            className={selectClass}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            kind === "receivable"
              ? "insurance or self_pay"
              : kind === "payment_mode"
                ? "Mode, as in Unite"
                : kind === "revenue"
                  ? "Service category"
                  : "Applies to"
          }
        >
          <Input
            name="key"
            required={needsKey}
            defaultValue={needsKey ? "" : "*"}
            disabled={!needsKey}
          />
          {!needsKey && <input type="hidden" name="key" value="*" />}
        </Field>
        <Field label="Account code">
          <Input name="account_code" required maxLength={40} />
        </Field>
        <Field label="Account name">
          <Input name="account_name" maxLength={120} />
        </Field>
      </div>
    </ActionForm>
  );
}

export function RemoveMapping({ kind, keyName }: { kind: string; keyName: string }) {
  return (
    <RunButton
      variant="ghost"
      confirm="Remove this account mapping?"
      action={() => deleteAccountMapping({ kind, key: keyName })}
    >
      Remove
    </RunButton>
  );
}
