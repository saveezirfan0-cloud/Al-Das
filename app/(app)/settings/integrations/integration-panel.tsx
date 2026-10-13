"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountView } from "@/lib/integrations/types";
import type { FieldDef } from "@/lib/integrations/catalog";
import { HEALTH_LABEL, type HealthState } from "@/lib/integrations/health";

import { saveIntegrationSettings, setIntegrationEnabled, testIntegration } from "./actions";

type Def = {
  title: string;
  providers: Array<{ id: string; label: string; fields: FieldDef[] }>;
  commonFields: FieldDef[];
  confirmWord: string | null;
  consequence: string;
  outbound: boolean;
};

const STATE_VARIANT: Record<
  HealthState,
  "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  off: "outline",
  idle: "secondary",
  ok: "success",
  degraded: "warning",
  down: "destructive",
};

const METRIC_LABEL: Record<string, string> = {
  sent: "Sent",
  segments: "Message parts sent",
  delivered: "Delivered",
  failed: "Failed",
  opted_out: "People who unsubscribed",
  blocked_training: "Blocked (training workspace)",
  blocked_daily_cap: "Blocked (daily limit)",
  links_sent: "Payment links sent",
  create_failed: "Links the gateway refused",
  feed_fetches: "Calendar fetches",
  attributions: "Ad clicks recorded",
  queued: "Queued",
  events_sent: "Events sent to Meta",
  events_failed: "Events Meta refused",
};

function metricLabel(key: string): string {
  if (METRIC_LABEL[key]) return METRIC_LABEL[key];
  if (key.startsWith("skipped_")) return `Not sent: ${key.slice(8).replaceAll("_", " ")}`;
  return key.replaceAll("_", " ");
}

export function IntegrationPanel({
  kind,
  def,
  view,
  state,
  problems,
  usage,
  calls24h,
  failed24h,
  canManage,
  webhookUrl,
}: {
  kind: string;
  def: Def;
  view: AccountView;
  state: HealthState;
  problems: string[];
  usage: Record<string, number>;
  calls24h: number;
  failed24h: number;
  canManage: boolean;
  webhookUrl: string | null;
}) {
  const [pending, start] = useTransition();
  const [provider, setProvider] = useState<string | null>(view.provider);
  const fields: FieldDef[] = [
    ...(def.providers.find((p) => p.id === provider)?.fields ?? []),
    ...def.commonFields,
  ];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of [...def.providers.flatMap((p) => p.fields), ...def.commonFields]) {
      if (f.secret) v[f.key] = "";
      else v[f.key] = String(view.config[f.key] ?? f.default ?? "");
    }
    return v;
  });
  const [confirm, setConfirm] = useState("");

  function run(
    fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>,
    after?: () => void,
  ) {
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        after?.();
      } else toast.error(r.error);
    });
  }

  const segmentPrice = Number(view.config.segment_price);
  const showEstimate =
    kind === "sms" && Number.isFinite(segmentPrice) && segmentPrice > 0 && usage.segments;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Status <Badge variant={STATE_VARIANT[state]}>{HEALTH_LABEL[state]}</Badge>
          </CardTitle>
          <CardDescription>
            {view.lastError
              ? `Last problem: ${view.lastError}`
              : view.lastOkAt
                ? `Last success ${new Date(view.lastOkAt).toLocaleString()}`
                : "Nothing has happened yet."}
            {def.outbound &&
              ` Last 24 hours: ${calls24h} call${calls24h === 1 ? "" : "s"}, ${failed24h} failed.`}
            {view.breakerOpenUntil &&
              new Date(view.breakerOpenUntil) > new Date() &&
              ` Calls are paused until ${new Date(view.breakerOpenUntil).toLocaleTimeString()} after repeated failures.`}
          </CardDescription>
        </CardHeader>
        {canManage && (
          <CardContent className="flex flex-col gap-3">
            {!view.enabled && problems.length > 0 && (
              <Alert>
                <AlertTitle>Before it can be switched on</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-5">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {!view.enabled && (
              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground text-sm">{def.consequence}</p>
                {def.confirmWord && (
                  <div className="grid max-w-sm gap-1">
                    <Label htmlFor="confirm-enable">
                      Type <strong>{def.confirmWord}</strong> to switch it on
                    </Label>
                    <Input
                      id="confirm-enable"
                      autoComplete="off"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </div>
                )}
                <div>
                  <Button
                    disabled={
                      pending ||
                      problems.length > 0 ||
                      (!!def.confirmWord && confirm.trim() !== def.confirmWord)
                    }
                    onClick={() =>
                      run(
                        () => setIntegrationEnabled({ kind, enabled: true, confirm }),
                        () => setConfirm(""),
                      )
                    }
                  >
                    {pending && <Loader2 className="animate-spin" />} Switch on
                  </Button>
                </div>
              </div>
            )}
            {view.enabled && (
              <div>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(() => setIntegrationEnabled({ kind, enabled: false, confirm: "" }))
                  }
                >
                  {pending && <Loader2 className="animate-spin" />} Switch off
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {canManage && fields.length + def.providers.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>
              Keys and tokens are stored encrypted and are never shown again. Leave a key blank to
              keep the stored one.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {def.providers.length > 1 && (
              <div className="grid max-w-sm gap-1">
                <Label htmlFor="provider">Provider</Label>
                <select
                  id="provider"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  value={provider ?? ""}
                  onChange={(e) => setProvider(e.target.value || null)}
                >
                  <option value="">Choose…</option>
                  {def.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {fields.map((f) => (
              <div key={f.key} className="grid max-w-md gap-1">
                <Label htmlFor={`f-${f.key}`}>
                  {f.label}
                  {f.required && " *"}
                </Label>
                {f.type === "select" ? (
                  <select
                    id={`f-${f.key}`}
                    className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  >
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`f-${f.key}`}
                    type={
                      f.type === "password"
                        ? "password"
                        : f.type === "number"
                          ? "number"
                          : f.type === "url"
                            ? "url"
                            : "text"
                    }
                    autoComplete="off"
                    placeholder={
                      f.secret && view.secretsStored[f.key]
                        ? "Stored. Type to replace."
                        : f.placeholder
                    }
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
                {f.help && <p className="text-muted-foreground text-xs">{f.help}</p>}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      saveIntegrationSettings({
                        kind,
                        provider,
                        values: Object.fromEntries(fields.map((f) => [f.key, values[f.key] ?? ""])),
                      }),
                    () =>
                      setValues((v) =>
                        Object.fromEntries(
                          Object.entries(v).map(([k, x]) => [
                            k,
                            fields.find((f) => f.key === k)?.secret ? "" : x,
                          ]),
                        ),
                      ),
                  )
                }
              >
                {pending && <Loader2 className="animate-spin" />} Save settings
              </Button>
              {def.outbound && (
                <Button
                  variant="outline"
                  disabled={pending || !view.exists}
                  onClick={() => run(() => testIntegration(kind))}
                >
                  Test connection
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && webhookUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Webhook address</CardTitle>
            <CardDescription>
              Give this address to the provider so it can report results back. Pulse only accepts
              calls signed with the stored secret.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <code className="bg-muted block overflow-x-auto rounded px-2 py-1 text-xs">
              {webhookUrl}
            </code>
          </CardContent>
        </Card>
      )}

      {Object.keys(usage).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Last 30 days</CardTitle>
            {showEstimate ? (
              <CardDescription>
                Estimated spend: {(usage.segments * segmentPrice).toFixed(2)} (message parts × the
                price you entered).
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
              {Object.entries(usage)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 border-b py-1">
                    <dt className="text-muted-foreground">{metricLabel(k)}</dt>
                    <dd className="tabular-nums">{v}</dd>
                  </div>
                ))}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
