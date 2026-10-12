"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { categoryLabel } from "@/lib/documents/categories";
import { DOCUMENTS_CONFIRM_PHRASE, type DocumentSettings } from "@/lib/documents/settings";
import type { StorageUsage } from "@/lib/documents/server";
import { formatBytes } from "@/lib/media/limits";

import {
  disableDocuments,
  enableDocuments,
  purgePastRetention,
  saveDocumentOptions,
  saveRetentionPolicy,
  scanPendingFiles,
  type ActionResult,
} from "./actions";

type PolicyRow = {
  category: string;
  label: string;
  retain_days: number | null;
  auto_delete: boolean;
  past: number;
};

type UsageProps = StorageUsage & {
  library_total: { files: number; bytes: number };
  documents_total: { files: number; bytes: number };
};

function useRun() {
  const [pending, start] = useTransition();
  function run(fn: () => Promise<ActionResult>, after?: () => void) {
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message ?? "Done.");
        after?.();
      } else toast.error(r.error);
    });
  }
  return { pending, run };
}

export function DocumentsSettings({
  settings,
  policies,
  usage,
  scanner,
}: {
  settings: DocumentSettings;
  policies: PolicyRow[];
  usage: UsageProps;
  scanner: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SwitchCard settings={settings} />
      <OptionsCard settings={settings} />
      <RetentionCard policies={policies} />
      <UsageCard usage={usage} scanner={scanner} />
    </div>
  );
}

function SwitchCard({ settings }: { settings: DocumentSettings }) {
  const [phrase, setPhrase] = useState("");
  const { pending, run } = useRun();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Patient documents{" "}
          <Badge variant={settings.enabled ? "success" : "outline"}>
            {settings.enabled ? "On" : "Off"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Files are stored in a private Supabase Storage bucket and opened only through links that
          expire after a minute. Every upload, change, delete, view and download is recorded. They
          are patient health data: before switching this on, confirm where the storage region may be
          (the data-residency question in the Phase 16 notes).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {settings.enabled ? (
          <>
            <p className="text-muted-foreground text-sm">
              Confirmed{" "}
              {settings.confirmed_at ? new Date(settings.confirmed_at).toLocaleString() : ""}.
              Switching off stops new uploads; existing documents stay readable and keep their
              reminders.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={pending}
              onClick={() => {
                if (!window.confirm("Stop new patient document uploads?")) return;
                run(() => disableDocuments());
              }}
            >
              Switch off new uploads
            </Button>
          </>
        ) : (
          <form
            className="grid max-w-md gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => enableDocuments(phrase),
                () => setPhrase(""),
              );
            }}
          >
            <Label htmlFor="confirm-phrase">
              Type <code>{DOCUMENTS_CONFIRM_PHRASE}</code> to switch patient documents on
            </Label>
            <Input
              id="confirm-phrase"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
            />
            <Button
              type="submit"
              className="w-fit"
              disabled={pending || phrase.trim() !== DOCUMENTS_CONFIRM_PHRASE}
            >
              {pending && <Loader2 className="animate-spin" />} Switch on
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function OptionsCard({ settings }: { settings: DocumentSettings }) {
  const [days, setDays] = useState(String(settings.expiry_lead_days));
  const [task, setTask] = useState(settings.expiry_task);
  const { pending, run } = useRun();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Insurance card reminders</CardTitle>
        <CardDescription>
          Every night Pulse looks for insurance cards that expire soon (or already have). People
          with the permission to manage patient documents get a notification, which they can tune
          under Settings, Notifications. The message never names the patient.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="lead">Remind this many days before expiry</Label>
          <Input
            id="lead"
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={task} onCheckedChange={setTask} aria-label="Create a follow-up task" />{" "}
          Also create a follow-up task on the patient
        </label>
        <Button
          type="button"
          className="w-fit"
          disabled={pending}
          onClick={() =>
            run(() => saveDocumentOptions({ expiry_lead_days: Number(days), expiry_task: task }))
          }
        >
          {pending && <Loader2 className="animate-spin" />} Save
        </Button>
      </CardContent>
    </Card>
  );
}

function RetentionCard({ policies }: { policies: PolicyRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention</CardTitle>
        <CardDescription>
          How long each kind of document is kept. The clock starts at the upload, or at the expiry
          date when that is later. Leave the period empty to keep documents for ever (the default).
          Documents past their period are only listed here until you switch on automatic deletion
          for that category, or delete them yourself. Check the rules for medical records with the
          clinic&apos;s legal adviser before setting a period.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {policies.map((p) => (
          <PolicyRowEditor key={p.category} policy={p} />
        ))}
      </CardContent>
    </Card>
  );
}

function PolicyRowEditor({ policy }: { policy: PolicyRow }) {
  const [days, setDays] = useState(policy.retain_days === null ? "" : String(policy.retain_days));
  const [auto, setAuto] = useState(policy.auto_delete);
  const { pending, run } = useRun();
  const value = days.trim() === "" ? null : Number(days);
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[10rem_1fr_auto] sm:items-center">
      <div>
        <p className="text-sm font-medium">{categoryLabel(policy.category)}</p>
        {policy.past > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-300">{policy.past} past retention</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="number"
          min={30}
          max={36500}
          placeholder="Keep for ever"
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            if (e.target.value.trim() === "") setAuto(false);
          }}
          className="w-36"
          aria-label={`Retention days for ${categoryLabel(policy.category)}`}
        />
        <span className="text-muted-foreground text-xs">days</span>
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={auto}
            disabled={value === null}
            onCheckedChange={setAuto}
            aria-label={`Delete ${categoryLabel(policy.category)} automatically`}
          />
          Delete automatically
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || (value !== null && !Number.isInteger(value))}
          onClick={() =>
            run(() =>
              saveRetentionPolicy({
                category: policy.category as never,
                retain_days: value,
                auto_delete: auto,
              }),
            )
          }
        >
          {pending && <Loader2 className="animate-spin" />} Save
        </Button>
        {policy.past > 0 && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm(
                  `Delete ${policy.past} ${categoryLabel(policy.category)} document(s) past their retention period? This cannot be undone.`,
                )
              )
                return;
              run(() => purgePastRetention(policy.category));
            }}
          >
            Delete {policy.past} now
          </Button>
        )}
      </div>
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bg-muted h-2 w-full overflow-hidden rounded" aria-hidden>
      <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
    </div>
  );
}

function UsageCard({ usage, scanner }: { usage: UsageProps; scanner: string }) {
  const { pending, run } = useRun();
  const maxCat = Math.max(0, ...Object.values(usage.documents).map((v) => v.bytes));
  const maxKind = Math.max(0, ...Object.values(usage.library).map((v) => v.bytes));
  const maxMonth = Math.max(0, ...usage.documents_by_month.map((m) => m.bytes));
  const unscanned = usage.library_unscanned + usage.documents_unscanned;
  const blocked = usage.library_blocked + usage.documents_blocked;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          Media Library: {usage.library_total.files} file
          {usage.library_total.files === 1 ? "" : "s"}, {formatBytes(usage.library_total.bytes)}.
          Patient documents: {usage.documents_total.files} file
          {usage.documents_total.files === 1 ? "" : "s"}, {formatBytes(usage.documents_total.bytes)}
          . Pictures and files patients send over WhatsApp are kept separately and are not counted
          here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <section aria-label="Patient documents by category" className="grid gap-2">
            <h3 className="text-sm font-medium">Documents by category</h3>
            {Object.keys(usage.documents).length === 0 && (
              <p className="text-muted-foreground text-sm">No documents yet.</p>
            )}
            {Object.entries(usage.documents).map(([cat, v]) => (
              <div key={cat} className="grid gap-1 text-sm">
                <div className="flex justify-between">
                  <span>{categoryLabel(cat)}</span>
                  <span className="text-muted-foreground">
                    {v.files} · {formatBytes(v.bytes)}
                  </span>
                </div>
                <Bar value={v.bytes} max={maxCat} />
              </div>
            ))}
          </section>
          <section aria-label="Media Library by type" className="grid gap-2">
            <h3 className="text-sm font-medium">Library by type</h3>
            {Object.keys(usage.library).length === 0 && (
              <p className="text-muted-foreground text-sm">No library files yet.</p>
            )}
            {Object.entries(usage.library).map(([kind, v]) => (
              <div key={kind} className="grid gap-1 text-sm">
                <div className="flex justify-between">
                  <span className="capitalize">{kind}s</span>
                  <span className="text-muted-foreground">
                    {v.files} · {formatBytes(v.bytes)}
                  </span>
                </div>
                <Bar value={v.bytes} max={maxKind} />
              </div>
            ))}
          </section>
        </div>
        {usage.documents_by_month.length > 0 && (
          <section aria-label="Documents added per month" className="grid gap-2">
            <h3 className="text-sm font-medium">Documents added, last 12 months</h3>
            {usage.documents_by_month.map((m) => (
              <div
                key={m.month}
                className="grid grid-cols-[5rem_1fr_9rem] items-center gap-2 text-sm"
              >
                <span>{m.month}</span>
                <Bar value={m.bytes} max={maxMonth} />
                <span className="text-muted-foreground text-right">
                  {m.files} · {formatBytes(m.bytes)}
                </span>
              </div>
            ))}
          </section>
        )}
        <section aria-label="Scanning and upkeep" className="grid gap-2 text-sm">
          <h3 className="text-sm font-medium">Malware scanning and upkeep</h3>
          <p>
            Scanner: <b>{scanner}</b>.{" "}
            {scanner === "No scanner configured"
              ? "Until a provider is configured, every file is stored as “not scanned” and flagged in the screens that show it."
              : ""}
          </p>
          <p>
            {unscanned} file{unscanned === 1 ? "" : "s"} not scanned · {blocked} blocked ·{" "}
            {usage.pending_uploads} unfinished upload
            {usage.pending_uploads === 1 ? "" : "s"} (cleaned up nightly) ·{" "}
            {usage.cards_expiring_30d} insurance card
            {usage.cards_expiring_30d === 1 ? "" : "s"} expiring within 30 days ·{" "}
            {usage.cards_expired} expired.
          </p>
          {unscanned > 0 && scanner !== "No scanner configured" && (
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={pending}
              onClick={() => run(() => scanPendingFiles())}
            >
              {pending && <Loader2 className="animate-spin" />} Scan the files that are waiting
            </Button>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
