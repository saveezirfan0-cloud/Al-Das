"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { RECOVERY_SOURCES } from "@/lib/finance/recovery";
import type { RecoveryRunSummary } from "@/lib/finance/recovery-server";
import { money } from "@/lib/finance/format";

import {
  approveRecoveryTone,
  previewRecovery,
  runRecoveryNow,
  saveRecoverySettings,
  setRecoveryEnabled,
} from "./actions";

export type TemplateChoice = {
  id: string;
  name: string;
  language: string | null;
  variables: string[];
  wording: string;
};
export type RecoveryValues = {
  templateId: string | null;
  map: Record<string, string>;
  minBalance: number;
  minDaysOverdue: number;
  gapDays: number;
  maxReminders: number;
  batchSize: number;
};

export function SettingsForm({
  templates,
  values,
}: {
  templates: TemplateChoice[];
  values: RecoveryValues;
}) {
  const [templateId, setTemplateId] = React.useState(values.templateId ?? "");
  const chosen = templates.find((t) => t.id === templateId);
  return (
    <ActionForm action={saveRecoverySettings} submitLabel="Save settings" variant="secondary">
      <Field
        label="Template"
        hint="Only templates Meta has approved are listed. Changing it switches reminders off and needs a new approval."
      >
        <select
          name="template_id"
          className={selectClass}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">None</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.language ? ` (${t.language})` : ""}
            </option>
          ))}
        </select>
      </Field>
      {chosen && (
        <>
          <p className="bg-muted/40 rounded p-3 text-xs whitespace-pre-wrap">{chosen.wording}</p>
          {chosen.variables.map((v) => (
            <Field key={v} label={`Variable ${v}`}>
              <select
                name={`map.${v}`}
                className={selectClass}
                defaultValue={values.map[v] ?? ""}
                required
              >
                <option value="">Choose a value…</option>
                {RECOVERY_SOURCES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Smallest balance (AED)">
          <Input name="min_balance" inputMode="decimal" defaultValue={values.minBalance} />
        </Field>
        <Field label="Days since invoice">
          <Input name="min_days_overdue" inputMode="numeric" defaultValue={values.minDaysOverdue} />
        </Field>
        <Field label="Days between reminders">
          <Input name="gap_days" inputMode="numeric" defaultValue={values.gapDays} />
        </Field>
        <Field label="Most reminders per invoice">
          <Input name="max_reminders" inputMode="numeric" defaultValue={values.maxReminders} />
        </Field>
        <Field label="Per daily batch">
          <Input name="batch_size" inputMode="numeric" defaultValue={values.batchSize} />
        </Field>
      </div>
    </ActionForm>
  );
}

export function ApproveButton({ approved }: { approved: boolean }) {
  return (
    <RunButton
      variant={approved ? "outline" : "default"}
      size="default"
      confirm="Confirm that you have read this wording and the tone is right for patients with an unpaid balance."
      action={approveRecoveryTone}
    >
      {approved ? "Approve the wording again" : "Approve the wording"}
    </RunButton>
  );
}

export function EnableForm({ enabled, ready }: { enabled: boolean; ready: boolean }) {
  if (enabled)
    return (
      <RunButton
        variant="outline"
        size="default"
        confirm="Switch the reminders off?"
        action={() => setRecoveryEnabled({ enabled: false })}
      >
        Switch reminders off
      </RunButton>
    );
  return (
    <ActionForm
      submitLabel="Switch reminders on"
      disabled={!ready}
      action={async (v) => setRecoveryEnabled({ enabled: true, confirm: v.confirm })}
    >
      <Field
        label="Type START REMINDERS to confirm"
        hint="The daily job then sends them in batches, only to opted-in patients."
      >
        <Input name="confirm" autoComplete="off" disabled={!ready} />
      </Field>
    </ActionForm>
  );
}

export function PreviewPanel({ canRun }: { canRun: boolean }) {
  const [res, setRes] = React.useState<RecoveryRunSummary | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await previewRecovery();
              if (r.ok && r.data) setRes(r.data);
              else if (!r.ok) toast.error(r.error);
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />} Preview the next batch
        </Button>
        {canRun && (
          <RunButton
            variant="default"
            size="default"
            confirm="Queue this batch of reminders now?"
            action={async () => {
              const r = await runRecoveryNow();
              if (r.ok && r.data) setRes(r.data);
              return r.ok ? { ok: true as const, message: r.message } : r;
            }}
          >
            Send this batch now
          </RunButton>
        )}
      </div>
      {res && (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {res.considered} overdue balance(s) looked at, {res.planned} would be reminded
            {res.queued ? `, ${res.queued} queued` : ""}
            {res.failed ? `, ${res.failed} failed` : ""}.
          </p>
          {res.blocked.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-600">
              {res.blocked.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {Object.keys(res.skipped).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(res.skipped).map(([k, n]) => (
                <Badge key={k} variant="secondary">
                  {k.replaceAll("_", " ")}: {n}
                </Badge>
              ))}
            </div>
          )}
          {res.preview.length > 0 && (
            <ul className="text-xs tabular-nums">
              {res.preview.slice(0, 20).map((p) => (
                <li key={p.invoiceNumber}>
                  {p.invoiceNumber}: {money(p.balance)}, reminder {p.sequence}
                  {p.viaGuardian ? ", to the guardian" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
