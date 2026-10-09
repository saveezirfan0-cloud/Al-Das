"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  rederiveBranches,
  reprocessPendingBatches,
  saveCaptureSettings,
  saveUniteCredentials,
  setCaptureEnabled,
  type ActionResult,
} from "./actions";

function useRun() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message);
        after?.();
      } else toast.error(res.error);
    });
  return { pending, run };
}

export function CredentialsForm({ configured }: { configured: boolean }) {
  const { pending, run } = useRun();
  const field = (name: string, label: string, secret = true) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={secret ? "password" : "text"}
        autoComplete="off"
        placeholder={configured ? "unchanged" : ""}
      />
    </div>
  );
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      action={(fd) => run(() => saveUniteCredentials(fd))}
    >
      {field("authorize_app_id", "Authorize app id", false)}
      {field("authorize_app_key", "Authorize app key")}
      {field("refresh_app_id", "Refresh app id", false)}
      {field("refresh_app_key", "Refresh app key")}
      {field("access_token", "Initial access token (optional)")}
      {field("refresh_token", "Initial refresh token (optional)")}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save credentials
        </Button>
        <span className="text-muted-foreground ml-3 text-xs">
          Write-only. Stored encrypted, never shown again.
        </span>
      </div>
    </form>
  );
}

export function SettingsForm({
  batchSize,
  maxBatches,
  windowFrom,
}: {
  batchSize: number;
  maxBatches: number;
  windowFrom: string;
}) {
  const { pending, run } = useRun();
  return (
    <form className="grid gap-3 sm:grid-cols-3" action={(fd) => run(() => saveCaptureSettings(fd))}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="batch_size">Batch size</Label>
        <Input
          id="batch_size"
          name="batch_size"
          type="number"
          min={1}
          max={500}
          defaultValue={batchSize}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="max_batches_per_run">Batches per run</Label>
        <Input
          id="max_batches_per_run"
          name="max_batches_per_run"
          type="number"
          min={1}
          max={100}
          defaultValue={maxBatches}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="window_from">Pull from (transaction date)</Label>
        <Input id="window_from" name="window_from" type="date" defaultValue={windowFrom} />
      </div>
      <div className="sm:col-span-3">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save settings
        </Button>
      </div>
    </form>
  );
}

export function CaptureToggle({ enabled }: { enabled: boolean }) {
  const { pending, run } = useRun();
  const [confirmation, setConfirmation] = useState("");
  if (enabled)
    return (
      <Button
        variant="destructive"
        disabled={pending}
        onClick={() => run(() => setCaptureEnabled(false, ""))}
      >
        {pending && <Loader2 className="animate-spin" />} Switch capture OFF
      </Button>
    );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm">Type ENABLE to confirm</Label>
        <Input
          id="confirm"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          className="w-40"
          autoComplete="off"
        />
      </div>
      <Button
        disabled={pending || confirmation.trim() !== "ENABLE"}
        onClick={() =>
          run(
            () => setCaptureEnabled(true, confirmation),
            () => setConfirmation(""),
          )
        }
      >
        {pending && <Loader2 className="animate-spin" />} Switch capture ON
      </Button>
    </div>
  );
}

export function MaintenanceButtons() {
  const { pending, run } = useRun();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => run(reprocessPendingBatches)}
      >
        {pending && <Loader2 className="animate-spin" />} Reprocess unprocessed batches
      </Button>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(rederiveBranches)}>
        Re-derive branches
      </Button>
    </div>
  );
}
