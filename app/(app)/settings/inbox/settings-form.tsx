"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import type { InboxSettings } from "@/lib/inbox/settings";

import { saveInboxSettings } from "./actions";

const NONE = "__none__";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function HoursInput({
  value,
  onChange,
  max,
  unit = "h",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  max: number;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={value !== null}
        onCheckedChange={(c) => onChange(c ? (unit === "min" ? 30 : 24) : null)}
      />
      <Input
        type="number"
        min={unit === "min" ? 15 : 1}
        max={max}
        className="w-20"
        value={value ?? ""}
        disabled={value === null}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      <span className="text-muted-foreground text-xs">{unit}</span>
    </div>
  );
}

export function InboxSettingsForm({
  initial,
  teams,
}: {
  initial: InboxSettings;
  teams: Array<{ id: string; name: string; round_robin: boolean }>;
}) {
  const [s, setS] = useState<InboxSettings>(initial);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof InboxSettings>(k: K, v: InboxSettings[K]) =>
    setS((p) => ({ ...p, [k]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveInboxSettings(s);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  const team = teams.find((t) => t.id === s.default_team_id);

  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Workspace inbox settings</CardTitle>
          <CardDescription>Apply to every WhatsApp number in this workspace.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          <Row
            label="Route new conversations to"
            hint="New conversations are assigned to this team."
          >
            <Select
              value={s.default_team_id ?? NONE}
              onValueChange={(v) => set("default_team_id", v === NONE ? null : v)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Leave unassigned</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.round_robin ? " (round-robin)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row
            label="Round-robin auto-assign"
            hint={
              team && !team.round_robin
                ? "Enable round-robin on the team in Settings → Teams."
                : "Hands each new conversation to the next online member."
            }
          >
            <Switch
              checked={s.auto_assign === "round_robin"}
              onCheckedChange={(c) => set("auto_assign", c ? "round_robin" : "none")}
            />
          </Row>
          <Row label="Require a category on close">
            <Switch
              checked={s.require_category_on_close}
              onCheckedChange={(c) => set("require_category_on_close", c)}
            />
          </Row>
          <Row label="Require a summary on close">
            <Switch
              checked={s.require_summary_on_close}
              onCheckedChange={(c) => set("require_summary_on_close", c)}
            />
          </Row>
          <Row
            label="Auto-close idle conversations"
            hint="Open conversations with no messages for this long are closed."
          >
            <HoursInput
              value={s.auto_close_hours}
              onChange={(v) => set("auto_close_hours", v)}
              max={24 * 90}
            />
          </Row>
          <Row
            label="Auto-remove labels"
            hint="Labels are dropped this long after they were added."
          >
            <HoursInput
              value={s.auto_remove_labels_hours}
              onChange={(v) => set("auto_remove_labels_hours", v)}
              max={24 * 90}
            />
          </Row>
          <Row
            label="Email alert for unread assigned conversations"
            hint="15 min – 3 h after the last patient message."
          >
            <HoursInput
              value={s.unread_alert_minutes}
              onChange={(v) => set("unread_alert_minutes", v)}
              max={180}
              unit="min"
            />
          </Row>
          <Row
            label="Show agent name in messages"
            hint="Prefixes replies with the agent's first name."
          >
            <Switch
              checked={s.show_agent_name}
              onCheckedChange={(c) => set("show_agent_name", c)}
            />
          </Row>
          <Row
            label="Move to Waiting after a reply"
            hint="Replies move the conversation to the Waiting folder until the patient answers."
          >
            <Switch
              checked={s.waiting_on_reply}
              onCheckedChange={(c) => set("waiting_on_reply", c)}
            />
          </Row>
          <div className="flex items-end justify-end">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save settings
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

export { Label };
