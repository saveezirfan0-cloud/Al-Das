"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ipAllowed, parseClientIp, parseIpRange } from "@/lib/security/client-ip";
import {
  MAX_ALLOWLIST_ENTRIES,
  WEEKDAYS,
  type FinanceAccessSettings,
} from "@/lib/security/finance-access";

import { saveFinanceAccessWindow } from "./actions";

export type FinanceWindowRole = { id: string; name: string; finance: boolean; admin: boolean };

/**
 * Settings, Security: the finance access window. Off by default. Admin is never restricted; the address line under the
 * list shows whether the person saving is inside it, so nobody saves a list that leaves the office out by mistake.
 */
export function FinanceWindowForm({
  initial,
  unreadable,
  roles,
  timezone,
  currentIp,
}: {
  initial: FinanceAccessSettings;
  unreadable: boolean;
  roles: FinanceWindowRole[];
  timezone: string;
  currentIp: string | null;
}) {
  const [s, setS] = React.useState<FinanceAccessSettings>(initial);
  const [ipText, setIpText] = React.useState(initial.ip_allowlist.join("\n"));
  const [pending, startTransition] = React.useTransition();
  const set = (patch: Partial<FinanceAccessSettings>) => setS((cur) => ({ ...cur, ...patch }));

  const entries = ipText
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);
  const problems = entries.map((e) => parseIpRange(e)).flatMap((r) => (r.ok ? [] : [r.error]));
  const parsedCurrent = parseClientIp(currentIp);
  const coversMe =
    parsedCurrent && problems.length === 0 ? ipAllowed(parsedCurrent, entries) : null;
  const financeRoles = roles.filter((r) => r.finance && !r.admin);

  function toggleDay(day: number, on: boolean) {
    set({
      days: on
        ? [...new Set([...s.days, day])].sort((a, b) => a - b)
        : s.days.filter((d) => d !== day),
    });
  }

  function toggleRole(id: string, on: boolean) {
    set({ role_ids: on ? [...new Set([...s.role_ids, id])] : s.role_ids.filter((r) => r !== id) });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveFinanceAccessWindow({ ...s, ip_allowlist: entries });
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Finance access window</CardTitle>
          <CardDescription>
            Limit when, and from which networks, people reach Finance and Accounting. Outside the
            window those pages, downloads and actions are refused and an alert is raised (one per
            person per day). Everything else in Pulse keeps working. Admin is never restricted, so a
            wrong setting can always be put right.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {unreadable && (
            <p
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              The stored window could not be read, so Finance is closed to everyone except Admin.
              Save it again to fix it.
            </p>
          )}
          <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">Restrict finance access</span>
              <span className="text-muted-foreground block text-xs">
                Off by default. Applies from the next page anyone opens.
              </span>
            </span>
            <Switch checked={s.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          </label>

          <fieldset className="grid gap-3" disabled={!s.enabled}>
            <legend className="mb-2 text-sm font-medium">Days and hours</legend>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={s.limit_hours}
                onCheckedChange={(v) => set({ limit_hours: v === true })}
                disabled={!s.enabled}
              />
              Only on these days and hours ({timezone})
            </label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
              {WEEKDAYS.map((d) => (
                <label
                  key={d.day}
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm"
                >
                  <Checkbox
                    aria-label={d.label}
                    checked={s.days.includes(d.day)}
                    disabled={!s.enabled || !s.limit_hours}
                    onCheckedChange={(v) => toggleDay(d.day, v === true)}
                  />
                  {d.short}
                </label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="fw-start">Opens</Label>
                <Input
                  id="fw-start"
                  type="time"
                  value={s.start}
                  disabled={!s.enabled || !s.limit_hours}
                  onChange={(e) => set({ start: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="fw-end">Closes</Label>
                <Input
                  id="fw-end"
                  type="time"
                  value={s.end}
                  disabled={!s.enabled || !s.limit_hours}
                  onChange={(e) => set({ end: e.target.value })}
                />
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              A closing time earlier than the opening time runs past midnight and counts for the day
              it opens. The same time for both means the whole day.
            </p>
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="fw-ips">Approved networks (optional)</Label>
            <Textarea
              id="fw-ips"
              rows={4}
              placeholder={"203.0.113.10\n198.51.100.0/24\n2001:db8:abcd::/48"}
              value={ipText}
              disabled={!s.enabled}
              onChange={(e) => setIpText(e.target.value)}
              aria-invalid={problems.length > 0}
              aria-describedby="fw-ips-hint"
            />
            <div id="fw-ips-hint" className="text-muted-foreground grid gap-1 text-xs">
              <span>
                One IPv4 or IPv6 address or range (CIDR) per line, up to {MAX_ALLOWLIST_ENTRIES}.
                Leave empty to allow any location.
              </span>
              {problems.length > 0 && (
                <span className="text-destructive" role="alert">
                  {problems[0]}
                </span>
              )}
              <span>
                Your address now: <b>{currentIp && parsedCurrent ? currentIp : "unknown"}</b>
                {entries.length > 0 && coversMe !== null && (
                  <>
                    {" "}
                    {coversMe ? (
                      <Badge variant="success">in the list</Badge>
                    ) : (
                      <Badge variant="warning">not in the list</Badge>
                    )}
                  </>
                )}
              </span>
            </div>
          </div>

          <fieldset className="grid gap-2" disabled={!s.enabled}>
            <legend className="mb-1 text-sm font-medium">Who it applies to</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="fw-scope"
                className="accent-primary size-4"
                checked={s.scope === "finance_roles"}
                onChange={() => set({ scope: "finance_roles" })}
              />
              Every role with finance or accounting access ({financeRoles.length})
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="fw-scope"
                className="accent-primary size-4"
                checked={s.scope === "selected_roles"}
                onChange={() => set({ scope: "selected_roles" })}
              />
              Only these roles
            </label>
            {s.scope === "selected_roles" && (
              <ul className="divide-y rounded-md border">
                {roles
                  .filter((r) => r.finance || r.admin)
                  .map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <Checkbox
                        aria-label={r.name}
                        checked={!r.admin && s.role_ids.includes(r.id)}
                        disabled={!s.enabled || r.admin}
                        onCheckedChange={(v) => toggleRole(r.id, v === true)}
                      />
                      {r.name}
                      {r.admin && (
                        <span className="text-muted-foreground text-xs">never restricted</span>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </fieldset>

          <div>
            <Button type="submit" disabled={pending || problems.length > 0}>
              {pending && <Loader2 className="animate-spin" />} Save finance access window
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
