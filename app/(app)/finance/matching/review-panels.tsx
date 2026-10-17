"use client";

import * as React from "react";
import { toast } from "sonner";

import { ActionForm, Field, RunButton } from "@/components/finance/forms";
import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/finance/format";

import {
  acceptSuggestion,
  decideAlias,
  proposeAliasManually,
  rejectSuggestion,
  runMatching,
  setRuleAuto,
} from "./actions";

export function RunMatchingButton() {
  return (
    <RunButton variant="default" size="default" action={runMatching}>
      Run matching
    </RunButton>
  );
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalOption = {
  index: number;
  fingerprint: string;
  score: number;
  reasons: string[];
  allocations: Array<{ itemRef: string; label: string; amount: number }>;
  lineLeft: number;
  itemsLeft: number;
};
export type ProposalRow = {
  lineId: string;
  lineDate: string;
  lineOpen: number;
  lineText: string;
  rule: string;
  ruleLabel: string;
  auto: boolean;
  options: ProposalOption[];
};

function OptionButtons({
  lineId,
  rule,
  option,
  ambiguous,
}: {
  lineId: string;
  rule: string;
  option: ProposalOption;
  ambiguous: boolean;
}) {
  const [pending, start] = React.useTransition();
  const act = (fn: () => ReturnType<typeof acceptSuggestion>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message ?? "Done.");
      else toast.error(res.error);
    });
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          act(() =>
            acceptSuggestion({
              lineId,
              rule: rule as "reference" | "payer_sum" | "amount_date",
              optionIndex: option.index,
              expect: option.fingerprint,
            }),
          )
        }
      >
        {ambiguous ? "Choose this one" : "Accept"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          act(() => rejectSuggestion({ lineId, itemRefs: option.allocations.map((a) => a.itemRef) }))
        }
      >
        {ambiguous ? "Not this one" : "Reject"}
      </Button>
    </div>
  );
}

export function ProposalList({ rows, canManage }: { rows: ProposalRow[]; canManage: boolean }) {
  if (rows.length === 0)
    return (
      <EmptyState
        title="No proposals right now"
        description="Run matching on the Overview page after importing a bank statement or the receipt register. Anything Pulse cannot settle on its own waits here for a person."
      />
    );
  return (
    <ul className="flex flex-col gap-4">
      {rows.map((p) => {
        const ambiguous = p.options.length > 1;
        return (
          <li key={p.lineId} className="bg-card rounded-xl border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="font-medium">
                  Deposit of {p.lineDate}: {money(p.lineOpen)} not yet explained
                </div>
                {p.lineText && <div className="text-muted-foreground text-sm">{p.lineText}</div>}
              </div>
              <div className="flex gap-2">
                <Badge variant="outline">{p.ruleLabel}</Badge>
                {p.auto && <Badge variant="success">Would match by itself once automatic matching is on</Badge>}
                {ambiguous && <Badge variant="warning">Ambiguous: choose one</Badge>}
              </div>
            </div>
            <ul className="mt-3 flex flex-col gap-3">
              {p.options.map((o) => (
                <li key={o.index} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-col gap-1 text-sm">
                      {o.allocations.map((a) => (
                        <div key={a.itemRef}>
                          <span className="tabular-nums font-medium">{money(a.amount)}</span> to {a.label}
                        </div>
                      ))}
                      <ul className="text-muted-foreground mt-1 list-disc pl-5">
                        {o.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                        {o.lineLeft > 0 && <li>{money(o.lineLeft)} of the deposit stays unexplained</li>}
                        {o.itemsLeft > 0 && <li>{money(o.itemsLeft)} stays open on the payment(s)</li>}
                      </ul>
                    </div>
                    {canManage && (
                      <OptionButtons lineId={p.lineId} rule={p.rule} option={o} ambiguous={ambiguous} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Rules and names
// ---------------------------------------------------------------------------

export type RuleRow = {
  rule: "reference" | "payer_sum";
  label: string;
  on: boolean;
  ok: boolean;
  reason: string;
  months: Array<{ month: string; decisions: number; precision: number; qualifies: boolean }>;
};

function RuleSwitch({ rule, on, ok, label }: { rule: RuleRow["rule"]; on: boolean; ok: boolean; label: string }) {
  const [pending, start] = React.useTransition();
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={on}
        disabled={pending || (!on && !ok)}
        aria-label={`Automatic matching: ${label}`}
        onCheckedChange={(enabled) =>
          start(async () => {
            const res = await setRuleAuto({ rule, enabled });
            if (res.ok) toast.success(res.message ?? "Saved.");
            else toast.error(res.error);
          })
        }
      />
      <span className="text-sm">{on ? "Automatic" : "Off"}</span>
    </div>
  );
}

export function RulesPanel({
  rules,
  canApprove,
  thresholds,
}: {
  rules: RuleRow[];
  canApprove: boolean;
  thresholds: { minPrecision: number; minMonths: number; minDecisions: number };
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        A rule matches by itself only when the Finance Manager switches it on, and only after its own record is good
        enough: at least {thresholds.minDecisions} decisions a month at {thresholds.minPrecision}% right or better, for{" "}
        {thresholds.minMonths} months. A decision is wrong when a person rejects it or takes it back. Amount and date
        alone, and anything done by hand, never match automatically.
      </p>
      {rules.map((r) => (
        <section key={r.rule} className="bg-card rounded-xl border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">{r.label}</h3>
              <p className="text-muted-foreground text-sm">{r.reason}</p>
            </div>
            {canApprove ? (
              <RuleSwitch rule={r.rule} on={r.on} ok={r.ok} label={r.label} />
            ) : (
              <Badge variant={r.on && r.ok ? "success" : r.on ? "warning" : "outline"}>{r.on && r.ok ? "Automatic" : r.on ? "Paused: record too weak" : "Off"}</Badge>
            )}
          </div>
          {r.months.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm">
              No record yet. Accept or reject proposals made by this rule to build one.
            </p>
          ) : (
            <Table className="mt-3">
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Decisions</TableHead>
                  <TableHead className="text-right">Right</TableHead>
                  <TableHead>Good enough</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.months.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{m.month}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.decisions}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.precision.toFixed(2)}%</TableCell>
                    <TableCell>{m.qualifies ? "Yes" : "Not yet"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      ))}
    </div>
  );
}

export type AliasView = {
  id: string;
  payerKey: string;
  alias: string;
  status: "proposed" | "approved" | "retired";
  made: number;
  undone: number;
};

function AliasButtons({ id, status }: { id: string; status: AliasView["status"] }) {
  const [pending, start] = React.useTransition();
  const go = (decision: "approve" | "retire") =>
    start(async () => {
      const res = await decideAlias({ id, decision });
      if (res.ok) toast.success(res.message ?? "Saved.");
      else toast.error(res.error);
    });
  return (
    <div className="flex gap-2">
      {status === "proposed" && (
        <Button size="sm" disabled={pending} onClick={() => go("approve")}>
          Approve
        </Button>
      )}
      {status !== "retired" && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => go("retire")}>
          Retire
        </Button>
      )}
    </div>
  );
}

export function AliasPanel({
  aliases,
  payers,
  canManage,
  canApprove,
}: {
  aliases: AliasView[];
  payers: string[];
  canManage: boolean;
  canApprove: boolean;
}) {
  const proposed = aliases.filter((a) => a.status === "proposed");
  const approved = aliases.filter((a) => a.status === "approved");
  const retired = aliases.filter((a) => a.status === "retired");
  const list = (rows: AliasView[], actions: boolean) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Payer</TableHead>
          <TableHead>Words on the bank statement</TableHead>
          <TableHead className="text-right">Matches made</TableHead>
          <TableHead className="text-right">Taken back</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((a) => (
          <TableRow key={a.id}>
            <TableCell className="font-medium">{a.payerKey}</TableCell>
            <TableCell>{a.alias}</TableCell>
            <TableCell className="text-right tabular-nums">{a.made}</TableCell>
            <TableCell className="text-right tabular-nums">{a.undone}</TableCell>
            <TableCell className="text-right">{actions && canApprove && <AliasButtons id={a.id} status={a.status} />}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        When a person accepts a match, the words on the bank line are proposed as a name for the payer. A name is used
        by the rules only after a Finance Manager approves it.
      </p>
      <section>
        <h3 className="mb-2 font-medium">Waiting for approval ({proposed.length})</h3>
        {proposed.length === 0 ? (
          <EmptyState title="No names waiting" description="Accepted matches propose new names here." />
        ) : (
          list(proposed, true)
        )}
      </section>
      <section>
        <h3 className="mb-2 font-medium">In use ({approved.length})</h3>
        {approved.length === 0 ? (
          <p className="text-muted-foreground text-sm">No approved names yet.</p>
        ) : (
          list(approved, true)
        )}
      </section>
      {canManage && (
        <section className="max-w-lg">
          <h3 className="mb-2 font-medium">Propose a name</h3>
          <ActionForm
            submitLabel="Propose"
            action={(v) => proposeAliasManually({ payerKey: v.payerKey, alias: v.alias })}
          >
            <Field label="Payer" hint="The payer code as it appears in the receipt register or remittance.">
              <Input name="payerKey" list="matching-payers" required maxLength={60} />
              <datalist id="matching-payers">
                {payers.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </Field>
            <Field label="Words on the bank statement" hint="For example the payer's name as the bank writes it.">
              <Input name="alias" required maxLength={120} />
            </Field>
          </ActionForm>
        </section>
      )}
      {retired.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">Retired names ({retired.length})</summary>
          <div className="mt-2">{list(retired, false)}</div>
        </details>
      )}
    </div>
  );
}
