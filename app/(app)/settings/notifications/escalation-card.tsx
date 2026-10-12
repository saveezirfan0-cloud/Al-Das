"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { EscalationSettings } from "@/lib/notify/escalation";

import { saveEscalation, setTeamLead } from "./actions";

const NONE = "__none__";

export function EscalationCard({
  initial,
  people,
  teams,
}: {
  initial: EscalationSettings;
  people: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string; leadId: string | null; memberIds: string[] }>;
}) {
  const [pending, startTransition] = useTransition();
  const [s, setS] = useState(initial);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "Unknown";

  function save() {
    startTransition(async () => {
      const res = await saveEscalation(s);
      if (res.ok) toast.success(res.message ?? "Saved.");
      else toast.error(res.error);
    });
  }
  function lead(teamId: string, userId: string | null) {
    startTransition(async () => {
      const res = await setTeamLead({ team_id: teamId, user_id: userId });
      if (res.ok) toast.success(res.message ?? "Saved.");
      else toast.error(res.error);
    });
  }
  const num = (v: string, fallback: number) =>
    Number.isFinite(Number(v)) && v !== "" ? Math.round(Number(v)) : fallback;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Escalation for conversations nobody owns</CardTitle>
        <CardDescription>
          When a patient writes and no one has taken the conversation, tell the team lead first,
          then whoever is on call. The first person to take the conversation stops the ladder.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <span className="font-medium">Escalate unowned conversations</span>
          <Switch
            checked={s.enabled}
            onCheckedChange={(v) => setS({ ...s, enabled: v })}
            aria-label="Escalate unowned conversations"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            Tell the team lead after (minutes)
            <Input
              type="number"
              min={1}
              max={1440}
              value={s.lead_after_minutes}
              onChange={(e) =>
                setS({ ...s, lead_after_minutes: num(e.target.value, s.lead_after_minutes) })
              }
            />
          </label>
          <label className="grid gap-1 text-sm">
            Tell the on-call people after (minutes)
            <Input
              type="number"
              min={1}
              max={2880}
              value={s.on_call_after_minutes}
              onChange={(e) =>
                setS({ ...s, on_call_after_minutes: num(e.target.value, s.on_call_after_minutes) })
              }
            />
          </label>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">On call</legend>
          <p className="text-muted-foreground text-xs">
            Everyone ticked here is told at the second step. If nobody is ticked, administrators are
            told instead. Update the list when the rota changes.
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {people.map((p) => (
              <label key={p.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={s.on_call_user_ids.includes(p.id)}
                  onChange={(e) =>
                    setS({
                      ...s,
                      on_call_user_ids: e.target.checked
                        ? [...s.on_call_user_ids, p.id]
                        : s.on_call_user_ids.filter((id) => id !== p.id),
                    })
                  }
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save escalation settings
          </Button>
        </div>

        <fieldset className="flex flex-col gap-2 border-t pt-4">
          <legend className="text-sm font-medium">Team leads</legend>
          {teams.length === 0 && (
            <p className="text-muted-foreground text-sm">Create a team first (Settings, Teams).</p>
          )}
          {teams.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{t.name}</span>
              <Select
                value={t.leadId ?? NONE}
                onValueChange={(v) => lead(t.id, v === NONE ? null : v)}
                disabled={pending}
              >
                <SelectTrigger className="w-56" aria-label={`Lead of ${t.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No lead</SelectItem>
                  {t.memberIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {nameOf(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </fieldset>
      </CardContent>
    </Card>
  );
}
