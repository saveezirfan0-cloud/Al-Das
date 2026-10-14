"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PUSH_SOURCE_LABELS,
  PUSH_SOURCES,
  type PushSource,
} from "@/lib/accounting/tally/bridge-sources";

import { createPairingCode, retryPush, revokeConnector, saveBridgeSettings } from "./actions";

export type BridgeSettingsView = {
  push_enabled: boolean;
  pull_enabled: boolean;
  push_from: string | null;
  revenue_mode: "daily" | "per_item";
  push_sources: string[];
  cost_category: string;
};

export function BridgeSettingsForm({
  value,
  canEdit,
  modeLocked,
}: {
  value: BridgeSettingsView;
  canEdit: boolean;
  modeLocked: boolean;
}) {
  const router = useRouter();
  const [sources, setSources] = React.useState<Set<string>>(new Set(value.push_sources));
  const toggle = (s: PushSource) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  return (
    <ActionForm action={saveBridgeSettings} onDone={() => router.refresh()} disabled={!canEdit}>
      <input type="hidden" name="push_sources" value={[...sources].sort().join(",")} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="push_enabled"
            value="on"
            defaultChecked={value.push_enabled}
            disabled={!canEdit}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Send Pulse&apos;s items to Tally (push)</span>
            <span className="text-muted-foreground block text-xs">
              Stops by itself from the ledger start. Switch it on only after the Pulse voucher types
              exist in Tally.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="pull_enabled"
            value="on"
            defaultChecked={value.pull_enabled}
            disabled={!canEdit}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Copy what is entered in Tally into Pulse (pull)</span>
            <span className="text-muted-foreground block text-xs">
              Masters and vouchers changed since the last pull, every 15 minutes, and the trial
              balance check once a day.
            </span>
          </span>
        </label>
        <Field
          label="Send items dated from"
          hint="Items dated earlier are never sent: Tally already holds them (entered by hand or imported). Required to push."
        >
          <Input
            type="date"
            name="push_from"
            defaultValue={value.push_from ?? ""}
            disabled={!canEdit}
          />
        </Field>
        <Field
          label="Unite revenue and payments"
          hint={
            modeLocked
              ? "Fixed: revenue was already sent this way."
              : "One voucher per day and branch (recommended, OQ-124) or one per invoice or payment."
          }
        >
          <select
            name="revenue_mode"
            defaultValue={value.revenue_mode}
            className={selectClass}
            disabled={!canEdit || modeLocked}
          >
            <option value="daily">Daily summary per branch</option>
            <option value="per_item">One voucher per invoice or payment</option>
          </select>
          {modeLocked && <input type="hidden" name="revenue_mode" value={value.revenue_mode} />}
        </Field>
        <Field
          label="Tally cost category"
          hint="The category branch and other cost centres are allocated under in Tally."
        >
          <Input
            name="cost_category"
            defaultValue={value.cost_category}
            maxLength={80}
            required
            disabled={!canEdit}
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium">What is sent to Tally</legend>
        <span className="text-muted-foreground mb-1 text-xs">
          Tick only what the team no longer enters in Tally by hand, or it will be there twice.
        </span>
        <div className="grid gap-1 sm:grid-cols-2">
          {PUSH_SOURCES.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sources.has(s)}
                onChange={() => toggle(s)}
                disabled={!canEdit}
              />
              {PUSH_SOURCE_LABELS[s]}
            </label>
          ))}
        </div>
      </fieldset>
    </ActionForm>
  );
}

export function PairingPanel({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [label, setLabel] = React.useState("Accounts PC");
  const [result, setResult] = React.useState<{ code: string; expiresAt: string } | null>(null);
  const [pending, start] = React.useTransition();
  if (!canEdit) return null;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name of the Tally PC">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </Field>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await createPairingCode({ label });
              if (res.ok && res.data) {
                setResult(res.data);
                router.refresh();
              } else if (!res.ok) toast.error(res.error);
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />} Create a pairing code
        </Button>
      </div>
      {result && (
        <div className="rounded-md border p-3">
          <div className="text-muted-foreground text-xs">
            Pairing code (shown once, valid for 30 minutes, single use)
          </div>
          <div className="font-mono text-lg tracking-wider">{result.code}</div>
          <div className="text-muted-foreground mt-2 text-xs">
            On the Tally PC, in the connector&apos;s folder, run:{" "}
            <code className="break-all">
              node bridge.mjs pair --url{" "}
              {typeof window === "undefined" ? "" : window.location.origin} --code {result.code}
            </code>
            . Pairing a new connector revokes the previous one.
          </div>
        </div>
      )}
    </div>
  );
}

export function RevokeButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      action={() => revokeConnector({ id })}
      confirm="Revoke this connector? It can no longer reach Pulse; pair it again to use it."
      onDone={() => router.refresh()}
      variant="ghost"
    >
      Revoke
    </RunButton>
  );
}

export function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton action={() => retryPush({ id })} onDone={() => router.refresh()}>
      Send again
    </RunButton>
  );
}
