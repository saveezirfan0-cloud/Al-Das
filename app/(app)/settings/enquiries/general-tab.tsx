"use client";

import * as React from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Switch } from "@/components/ui/switch";
import type { EnquiryNotifyEvent } from "@/lib/enquiries/constants";
import type { OrgUser, TeamInfo } from "@/lib/enquiries/server";
import {
  SLA_OPTIONS_MINUTES,
  type EnquirySettings,
  type NotificationRule,
} from "@/lib/enquiries/settings";

import { saveEnquirySettings } from "./actions";

const EVENT_LABELS: Record<EnquiryNotifyEvent, string> = {
  created: "A new enquiry is created",
  assigned: "An enquiry is assigned",
  stage_changed: "An enquiry changes stage",
  status_changed: "An enquiry changes status",
  sla_breached: "An enquiry breaches its SLA",
};

const LEAD_OPTIONS = [0, 15, 30, 60, 120, 1440];

function minutesLabel(m: number): string {
  if (m < 60) return `${m} minutes`;
  if (m === 60) return "1 hour";
  if (m < 1440) return `${m / 60} hours`;
  return "1 day";
}

export function GeneralTab({
  settings,
  teams,
  users,
}: {
  settings: EnquirySettings;
  teams: TeamInfo[];
  users: OrgUser[];
}) {
  const [sla, setSla] = React.useState<number | null>(settings.sla_default_minutes);
  const [lead, setLead] = React.useState(settings.task_reminder_lead_minutes);
  const [sources, setSources] = React.useState<string[]>(settings.sources);
  const [newSource, setNewSource] = React.useState("");
  const [rules, setRules] = React.useState<NotificationRule[]>(settings.notification_rules);
  const [pending, startTransition] = React.useTransition();

  const slaOptions = [...new Set<number>([...SLA_OPTIONS_MINUTES, ...(sla ? [sla] : [])])].sort(
    (a, b) => a - b,
  );

  function patchRule(id: string, patch: Partial<NotificationRule>) {
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function save() {
    startTransition(async () => {
      const res = await saveEnquirySettings({
        sla_default_minutes: sla,
        task_reminder_lead_minutes: lead,
        sources,
        notification_rules: rules,
      });
      if (res.ok) toast.success(res.message ?? "Saved.");
      else toast.error(res.error);
    });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Response SLA</CardTitle>
          <CardDescription>
            How long a new enquiry may wait for its first touch (an assignment by a person, a stage
            or status change, or a reply) before it counts as breached. A pipeline can override
            this.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="sla">Default SLA</Label>
            <OptionSelect
              id="sla"
              noneLabel="No SLA"
              value={sla === null ? null : String(sla)}
              options={slaOptions.map((m) => ({ value: String(m), label: minutesLabel(m) }))}
              onChange={(v) => setSla(v === null ? null : Number(v))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lead">Remind about tasks</Label>
            <OptionSelect
              id="lead"
              allowNone={false}
              value={String(lead)}
              options={LEAD_OPTIONS.map((m) => ({
                value: String(m),
                label: m === 0 ? "At the due time" : `${minutesLabel(m)} before`,
              }))}
              onChange={(v) => setLead(Number(v ?? 0))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
          <CardDescription>The choices offered for “Source” on an enquiry.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => (
              <span
                key={s}
                className="bg-muted flex items-center gap-1 rounded-full py-1 pr-1 pl-3 text-sm"
              >
                {s}
                <button
                  type="button"
                  aria-label={`Remove ${s}`}
                  className="hover:bg-background rounded-full p-1"
                  onClick={() => setSources((cur) => cur.filter((x) => x !== s))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = newSource.trim();
              if (v && !sources.some((s) => s.toLowerCase() === v.toLowerCase()))
                setSources((cur) => [...cur, v]);
              setNewSource("");
            }}
          >
            <Input
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              maxLength={60}
              placeholder="Add a source"
              aria-label="New source"
              className="max-w-xs"
            />
            <Button type="submit" variant="outline" disabled={!newSource.trim()}>
              <Plus /> Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notification rules</CardTitle>
          <CardDescription>
            Who hears about what. The person who made a change is never notified about it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rules.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No rules. Nobody is notified about enquiries.
            </p>
          )}
          {rules.map((r) => (
            <div key={r.id} className="grid gap-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <Switch
                  checked={r.enabled}
                  onCheckedChange={(c) => patchRule(r.id, { enabled: c })}
                  aria-label="Rule enabled"
                />
                <span className="text-sm font-medium">When</span>
                <div className="w-64">
                  <OptionSelect
                    allowNone={false}
                    value={r.event}
                    options={(Object.keys(EVENT_LABELS) as EnquiryNotifyEvent[]).map((e) => ({
                      value: e,
                      label: EVENT_LABELS[e],
                    }))}
                    onChange={(v) => v && patchRule(r.id, { event: v as EnquiryNotifyEvent })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive ml-auto"
                  aria-label="Delete rule"
                  onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={r.assignee}
                    onCheckedChange={(c) => patchRule(r.id, { assignee: c === true })}
                  />{" "}
                  Notify the assignee
                </label>
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-xs">Also notify people</Label>
                  <MultiSelect
                    options={users.map((u) => ({ value: u.id, label: u.label }))}
                    value={r.user_ids}
                    onChange={(ids) => patchRule(r.id, { user_ids: ids })}
                    placeholder="Choose people…"
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-xs">Also notify a team</Label>
                  <OptionSelect
                    noneLabel="No team"
                    value={r.team_id}
                    options={teams.map((t) => ({ value: t.id, label: t.name }))}
                    onChange={(v) => patchRule(r.id, { team_id: v })}
                  />
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={r.in_app}
                      onCheckedChange={(c) => patchRule(r.id, { in_app: c === true })}
                    />{" "}
                    In the app
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={r.email}
                      onCheckedChange={(c) => patchRule(r.id, { email: c === true })}
                    />{" "}
                    By email
                  </label>
                </div>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            className="w-fit"
            disabled={rules.length >= 50}
            onClick={() =>
              setRules((rs) => [
                ...rs,
                {
                  id: crypto.randomUUID(),
                  enabled: true,
                  event: "created",
                  assignee: true,
                  user_ids: [],
                  team_id: null,
                  in_app: true,
                  email: false,
                },
              ])
            }
          >
            <Plus /> Add a rule
          </Button>
        </CardContent>
      </Card>

      <div>
        <Button disabled={pending} onClick={save}>
          {pending && <Loader2 className="animate-spin" />} Save changes
        </Button>
      </div>
    </div>
  );
}
