"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SecuritySettings } from "@/lib/security/settings";

import { saveSecuritySettings, setRoleRequireMfa } from "./actions";

type Row = { id: string; name: string; required: boolean; sensitive: boolean; members: number };

export function MfaRoleTable({ rows }: { rows: Row[] }) {
  const [state, setState] = React.useState(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.required])),
  );
  const [busy, setBusy] = React.useState<string | null>(null);

  async function toggle(row: Row, next: boolean) {
    setBusy(row.id);
    const res = await setRoleRequireMfa(row.id, next);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    setState((s) => ({ ...s, [row.id]: next }));
    toast.success(res.message);
  }

  return (
    <ul className="divide-y rounded-md border">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {r.name}
              {r.sensitive && <Badge variant="outline">Sensitive</Badge>}
            </div>
            <div className="text-muted-foreground text-xs">
              {r.members} active member{r.members === 1 ? "" : "s"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy === r.id && <Loader2 className="size-4 animate-spin" />}
            <Switch
              aria-label={`Require two-step verification for ${r.name}`}
              checked={state[r.id] ?? false}
              disabled={busy !== null}
              onCheckedChange={(v) => void toggle(r, v)}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function SecuritySettingsForm({
  initial,
  timezone,
}: {
  initial: SecuritySettings;
  timezone: string;
}) {
  const [s, setS] = React.useState<SecuritySettings>(initial);
  const [pending, startTransition] = React.useTransition();
  const set = (patch: Partial<SecuritySettings>) => setS((cur) => ({ ...cur, ...patch }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveSecuritySettings(s);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Record access log</CardTitle>
          <CardDescription>
            Opening one patient, conversation, claim or file is always logged; list screens are
            sampled.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="retention"
            label="Keep the log for (days)"
            hint="Between 30 and 1,825. Older entries are deleted every night."
            value={s.access_log_retention_days}
            min={30}
            max={1825}
            onChange={(n) => set({ access_log_retention_days: n })}
          />
          <NumberField
            id="sample"
            label="Share of list views logged (0 to 1)"
            hint="0.1 logs about one list view in ten."
            value={s.list_sample_rate}
            min={0}
            max={1}
            step={0.05}
            onChange={(n) => set({ list_sample_rate: n })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>
            Alerts go to everyone with settings access, in the notification bell and under Activity
            log → Alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="bulk-rows"
            label="Large export (rows)"
            value={s.bulk_export_rows}
            min={10}
            max={1000000}
            onChange={(n) => set({ bulk_export_rows: n })}
          />
          <NumberField
            id="bulk-count"
            label="Exports in one hour"
            value={s.bulk_export_count_per_hour}
            min={2}
            max={100}
            onChange={(n) => set({ bulk_export_count_per_hour: n })}
          />
          <NumberField
            id="fail-n"
            label="Failed sign-ins before an alert"
            value={s.failed_login_threshold}
            min={3}
            max={50}
            onChange={(n) => set({ failed_login_threshold: n })}
          />
          <NumberField
            id="fail-min"
            label="…within (minutes)"
            value={s.failed_login_window_minutes}
            min={1}
            max={240}
            onChange={(n) => set({ failed_login_window_minutes: n })}
          />
          <NumberField
            id="api-rows"
            label="API key reads in one hour (rows)"
            value={s.bulk_api_read_rows}
            min={100}
            max={10000000}
            onChange={(n) => set({ bulk_api_read_rows: n })}
          />
          <NumberField
            id="dormant"
            label="Dormant after (days)"
            hint="Used by the access review."
            value={s.dormant_days}
            min={7}
            max={365}
            onChange={(n) => set({ dormant_days: n })}
          />
          <div className="grid gap-3 sm:col-span-2">
            <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>
                <span className="font-medium">
                  Alert on opening patient records outside working hours
                </span>
                <span className="text-muted-foreground block text-xs">
                  Times are in {timezone}. One alert per person per day.
                </span>
              </span>
              <Switch
                checked={s.off_hours.enabled}
                onCheckedChange={(v) => set({ off_hours: { ...s.off_hours, enabled: v } })}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="oh-start">Working day starts</Label>
                <Input
                  id="oh-start"
                  type="time"
                  value={s.off_hours.start}
                  disabled={!s.off_hours.enabled}
                  onChange={(e) => set({ off_hours: { ...s.off_hours, start: e.target.value } })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="oh-end">Working day ends</Label>
                <Input
                  id="oh-end"
                  type="time"
                  value={s.off_hours.end}
                  disabled={!s.off_hours.enabled}
                  onChange={(e) => set({ off_hours: { ...s.off_hours, end: e.target.value } })}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save security settings
        </Button>
      </div>
    </form>
  );
}
