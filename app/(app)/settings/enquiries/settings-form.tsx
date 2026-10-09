"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SLA_HOUR_OPTIONS, type EnquirySettings } from "@/lib/enquiries/settings";

import { saveEnquirySettings } from "./actions";

const NONE = "none";

const NOTIFICATIONS: Array<{
  key: keyof EnquirySettings["notifications"];
  label: string;
  hint: string;
}> = [
  {
    key: "on_assigned",
    label: "Enquiry assigned to someone",
    hint: "They get an in-app notification when another person assigns an enquiry to them.",
  },
  {
    key: "on_stage_change",
    label: "Stage changed by someone else",
    hint: "The assignee is told when a colleague moves their enquiry to another stage.",
  },
  {
    key: "on_sla_breach",
    label: "SLA breached",
    hint: "The assignee (or everyone who manages enquiries, if nobody owns it) is told once per stage visit.",
  },
  {
    key: "on_new_unassigned",
    label: "New unassigned enquiry",
    hint: "Everyone who manages enquiries is told when a new enquiry has no owner.",
  },
];

export function EnquirySettingsForm({ initial }: { initial: EnquirySettings }) {
  const [s, setS] = useState(initial);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  function save() {
    start(async () => {
      const r = await saveEnquirySettings(s);
      if (r.ok) toast.success(r.message ?? "Saved.");
      else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service level and rules</CardTitle>
        <CardDescription>Applies to every pipeline in this workspace.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Open-enquiry SLA</Label>
            <Select
              value={s.sla_hours === null ? NONE : String(s.sla_hours)}
              onValueChange={(v) => setS({ ...s, sla_hours: v === NONE ? null : Number(v) })}
            >
              <SelectTrigger className="w-full" aria-label="Open-enquiry SLA">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {SLA_HOUR_OPTIONS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {h} {h === 1 ? "hour" : "hours"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              How long an open enquiry may stay in one stage before it is flagged on the board and
              its owner is alerted.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>New enquiries go to</Label>
            <Select
              value={s.assignment.mode}
              onValueChange={(v) =>
                setS({ ...s, assignment: { mode: v as EnquirySettings["assignment"]["mode"] } })
              }
            >
              <SelectTrigger className="w-full" aria-label="Assignment rule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Nobody (assign by hand)</SelectItem>
                <SelectItem value="creator">Whoever creates them</SelectItem>
                <SelectItem value="round_robin">The pipeline&apos;s team, in rotation</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Rotation uses each pipeline&apos;s default team (set below) and skips members who are
              away or offline.
            </p>
          </div>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Notify</legend>
          {NOTIFICATIONS.map((n) => (
            <div key={n.key} className="flex items-start gap-3">
              <Switch
                id={`notif-${n.key}`}
                checked={s.notifications[n.key]}
                onCheckedChange={(v) =>
                  setS({ ...s, notifications: { ...s.notifications, [n.key]: v } })
                }
              />
              <div>
                <Label htmlFor={`notif-${n.key}`}>{n.label}</Label>
                <p className="text-muted-foreground text-xs">{n.hint}</p>
              </div>
            </div>
          ))}
        </fieldset>

        <div>
          <Button onClick={save} disabled={!dirty || pending}>
            {pending && <Loader2 className="animate-spin" />} Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
