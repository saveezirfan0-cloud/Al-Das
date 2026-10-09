"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  APPOINTMENT_STATUSES,
  STATUS_LABELS,
  type AppointmentStatus,
} from "@/lib/appointments/status";
import type { UniteConfig } from "@/lib/unite/config";

import {
  resetUniteBreaker,
  saveStatusMap,
  saveUniteSettings,
  syncUniteNow,
  testUniteConnection,
  type ActionResult,
} from "./actions";

const UNMAPPED = "__unmapped__";

type MapRow = {
  code: string;
  status: AppointmentStatus | null;
  label: string | null;
  counts_as_no_show: boolean;
};

function useRun() {
  const [pending, startTransition] = React.useTransition();
  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }
  return { pending, run };
}

function when(iso: string | null, tz: string) {
  return iso
    ? new Date(iso).toLocaleString("en-GB", {
        timeZone: tz,
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "never";
}

export function UniteSettings(props: {
  exists: boolean;
  status: "active" | "paused";
  config: UniteConfig;
  credentialSource: "stored" | "missing";
  envBaseUrl: string | null;
  breakerOpen: boolean;
  failures: number;
  tokenExpiresAt: string | null;
  cursors: Array<{
    entity: string;
    scope: string;
    last_run_at: string | null;
    last_ok_at: string | null;
    error: string | null;
  }>;
  calls: Array<{
    id: number;
    endpoint: string;
    outcome: string;
    http_status: number | null;
    duration_ms: number | null;
    at: string;
  }>;
  locations: Array<{ name: string; external_id: string | null }>;
  statusMap: MapRow[];
  timezone: string;
}) {
  const [status, setStatus] = React.useState(props.status);
  const [cfg, setCfg] = React.useState<UniteConfig>(props.config);
  const [map, setMap] = React.useState<MapRow[]>(props.statusMap);
  const { pending, run } = useRun();
  const setEnabled = (k: keyof UniteConfig["enabled"], v: boolean) =>
    setCfg((c) => ({ ...c, enabled: { ...c.enabled, [k]: v } }));
  const setPath = (k: "patients" | "doctors", v: string) =>
    setCfg((c) => ({ ...c, paths: { ...c.paths, [k]: v.trim() || null } }));

  return (
    <div className="flex flex-col gap-4">
      {props.breakerOpen && (
        <Alert variant="destructive">
          <AlertTitle>Calls to Unite are paused</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            Unite failed {props.failures} times in a row. Calls resume by themselves after a few
            minutes, or you can resume them now.
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(resetUniteBreaker)}
            >
              Resume calls
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Pulse shares one set of Unite credentials and one token with the Finance module. Enter
            or change them under Finance → Capture health. Tokens last about four minutes and are
            refreshed on demand.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <Switch
                checked={status === "active"}
                onCheckedChange={(c) => setStatus(c ? "active" : "paused")}
              />
              Integration active
            </label>
            <Badge variant={props.credentialSource === "missing" ? "destructive" : "secondary"}>
              Credentials: {props.credentialSource === "stored" ? "stored (encrypted)" : "missing"}
            </Badge>
            <span className="text-muted-foreground text-xs">
              Token valid until {when(props.tokenExpiresAt, props.timezone)}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Base URL</Label>
              <Input
                value={cfg.base_url ?? ""}
                placeholder={props.envBaseUrl ?? "https://…/gateway/"}
                onChange={(e) => setCfg({ ...cfg, base_url: e.target.value.trim() || null })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Minimum gap between calls (ms)</Label>
              <Input
                type="number"
                min={100}
                max={10000}
                value={cfg.min_interval_ms}
                onChange={(e) => setCfg({ ...cfg, min_interval_ms: Number(e.target.value) })}
              />
            </div>
          </div>
          {props.credentialSource === "missing" && (
            <p className="text-muted-foreground text-sm">
              No credentials are stored yet. Add them under Finance → Capture health, then come back
              here to switch the sync on.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What to sync</CardTitle>
          <CardDescription>
            Everything is off until you switch it on. Appointments use the documented endpoint;
            patients and doctors need their endpoint from Unite first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
            <label className="flex items-center gap-2">
              <Switch
                checked={cfg.enabled.appointments}
                onCheckedChange={(c) => setEnabled("appointments", c)}
              />
              <span>
                Appointments
                <span className="text-muted-foreground block text-xs">
                  Every 15 minutes in clinic hours and nightly, per location with a Unite clinic id
                  ({props.locations.filter((l) => l.external_id).length} of {props.locations.length}
                  ).
                </span>
              </span>
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => syncUniteNow("appointments"))}
            >
              Sync now
            </Button>
          </div>
          {(["doctors", "patients"] as const).map((k) => (
            <div
              key={k}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <label className="flex items-center gap-2">
                <Switch
                  checked={cfg.enabled[k]}
                  disabled={!cfg.paths[k]}
                  onCheckedChange={(c) => setEnabled(k, c)}
                />
                <span className="capitalize">{k}</span>
              </label>
              <div className="flex items-center gap-2">
                <Input
                  className="w-56"
                  placeholder="Endpoint name"
                  value={cfg.paths[k] ?? ""}
                  onChange={(e) => setPath(k, e.target.value)}
                  aria-label={`${k} endpoint`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !cfg.enabled[k]}
                  onClick={() => run(() => syncUniteNow(k))}
                >
                  Sync now
                </Button>
              </div>
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={cfg.create_missing_patients}
              onCheckedChange={(c) => setCfg({ ...cfg, create_missing_patients: c })}
            />
            Create a contact for Unite patients that are not in Pulse yet (off = send them to Sync
            Review)
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              onClick={() => run(() => saveUniteSettings({ status, config: cfg }))}
            >
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
            <Button
              variant="outline"
              disabled={pending || !props.exists}
              onClick={() => run(testUniteConnection)}
            >
              Test connection
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appointment status codes</CardTitle>
          <CardDescription>
            What each Unite status code means in Pulse. An unmapped code is recorded but never
            changes an appointment&apos;s status, so reports stay honest until the meaning is
            confirmed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {map.map((r, i) => (
            <div key={r.code} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-14 font-mono font-medium">{r.code}</span>
              <Select
                value={r.status ?? UNMAPPED}
                onValueChange={(v) =>
                  setMap(
                    map.map((x, j) =>
                      j === i
                        ? { ...x, status: v === UNMAPPED ? null : (v as AppointmentStatus) }
                        : x,
                    ),
                  )
                }
              >
                <SelectTrigger className="w-40" aria-label={`${r.code} status`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNMAPPED}>Not mapped yet</SelectItem>
                  {APPOINTMENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={r.counts_as_no_show}
                  onCheckedChange={(c) =>
                    setMap(map.map((x, j) => (j === i ? { ...x, counts_as_no_show: c } : x)))
                  }
                />
                Counts as no-show
              </label>
              <span className="text-muted-foreground text-xs">{r.label}</span>
            </div>
          ))}
          <Button
            className="self-start"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => saveStatusMap(map))}
          >
            Save mapping
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>
            Last runs and calls. Calls are logged without any patient data.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <ul className="divide-y text-sm">
            {props.cursors.length === 0 && (
              <li className="text-muted-foreground py-2 text-xs">No sync has run yet.</li>
            )}
            {props.cursors.map((c) => (
              <li key={c.entity + c.scope} className="py-2">
                <span className="font-medium capitalize">{c.entity}</span>
                {c.scope && <span className="text-muted-foreground"> · {c.scope}</span>}
                <span className="text-muted-foreground block text-xs">
                  Last success {when(c.last_ok_at, props.timezone)}
                </span>
                {c.error && <span className="text-destructive block text-xs">{c.error}</span>}
              </li>
            ))}
          </ul>
          <ul className="divide-y text-sm">
            {props.calls.length === 0 && (
              <li className="text-muted-foreground py-2 text-xs">No calls yet.</li>
            )}
            {props.calls.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-1.5">
                <span>
                  <span className="font-mono text-xs">{c.endpoint}</span>
                  <span className="text-muted-foreground block text-xs">
                    {when(c.at, props.timezone)}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs">
                  {c.duration_ms !== null && (
                    <span className="text-muted-foreground">{c.duration_ms} ms</span>
                  )}
                  <Badge variant={c.outcome === "ok" ? "outline" : "destructive"}>
                    {c.outcome}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
