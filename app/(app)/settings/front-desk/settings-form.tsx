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
import type { FrontDeskSettings } from "@/lib/front-desk/settings";

import { saveFrontDeskSettings } from "./actions";

type TemplateOption = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
};
type ChannelOption = { id: string; name: string; display_phone: string | null };

const NONE = "__none__";

function TemplateSelect({
  value,
  onChange,
  templates,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  templates: TemplateOption[];
}) {
  const options = templates.filter((t) => t.status === "APPROVED" || t.id === value);
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {options.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name} ({t.language}
            {t.status !== "APPROVED" ? `, ${t.status}` : ""})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function FrontDeskSettingsForm({
  initial,
  templates,
  channels,
}: {
  initial: FrontDeskSettings;
  templates: TemplateOption[];
  channels: ChannelOption[];
}) {
  const [s, setS] = useState(initial);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof FrontDeskSettings>(k: K, v: FrontDeskSettings[K]) =>
    setS((p) => ({ ...p, [k]: v }));

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await saveFrontDeskSettings(s);
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Waiting-list offers</CardTitle>
          <CardDescription>
            When an appointment is cancelled or moved, the freed slot is offered to people on the
            waiting list in the order they were added. The first YES inside the time limit books it;
            nobody can take a slot twice. Off until you switch it on.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Switch checked={s.offers_enabled} onCheckedChange={(v) => set("offers_enabled", v)} />
            Offer freed slots to the waiting list
          </label>
          <div className="grid gap-1 sm:col-span-2">
            <Label>Offer template (used when the 24-hour window is closed)</Label>
            <TemplateSelect
              value={s.offer_template_id}
              onChange={(v) => set("offer_template_id", v)}
              templates={templates}
            />
            <p className="text-muted-foreground text-xs">
              An approved utility template with two quick-reply buttons (Yes, book it / No thanks)
              and body variables such as {"{{appointment.specialist}}"} and{" "}
              {"{{appointment.datetime}}"} in its variable map. Without one, only patients who wrote
              in the last 24 hours can be offered a slot.
            </p>
          </div>
          <NumberField
            id="ttl"
            label="Offer stays open (minutes)"
            min={5}
            max={240}
            value={s.offer_ttl_minutes}
            onChange={(n) => set("offer_ttl_minutes", n)}
          />
          <NumberField
            id="batch"
            label="People asked at once"
            hint="1 asks strictly in order. More than 1 asks several at once; the first YES wins."
            min={1}
            max={5}
            value={s.offer_batch_size}
            onChange={(n) => set("offer_batch_size", n)}
          />
          <NumberField
            id="lead"
            label="Do not offer a slot starting within (minutes)"
            min={0}
            max={1440}
            value={s.offer_min_lead_minutes}
            onChange={(n) => set("offer_min_lead_minutes", n)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>One-tap messages</CardTitle>
          <CardDescription>
            Inside the 24-hour window the desk sends plain text (or a map pin). Outside it only an
            approved template may be used; with none chosen, the button explains why it cannot send.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label>&ldquo;Running late&rdquo; template</Label>
            <TemplateSelect
              value={s.running_late_template_id}
              onChange={(v) => set("running_late_template_id", v)}
              templates={templates}
            />
            <p className="text-muted-foreground text-xs">
              Map {"{{delay.minutes}}"} for the number of minutes.
            </p>
          </div>
          <div className="grid gap-1">
            <Label>&ldquo;Send location&rdquo; template</Label>
            <TemplateSelect
              value={s.location_template_id}
              onChange={(v) => set("location_template_id", v)}
              templates={templates}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Board</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="grace"
            label="Flag a patient as late after (minutes)"
            min={5}
            max={120}
            value={s.late_grace_minutes}
            onChange={(n) => set("late_grace_minutes", n)}
          />
          <NumberField
            id="slotlen"
            label="Length used for “next free slots” (minutes)"
            min={10}
            max={120}
            value={s.next_slot_minutes}
            onChange={(n) => set("next_slot_minutes", n)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Desk QR code</CardTitle>
          <CardDescription>
            The QR opens WhatsApp with this message ready to send. It should carry no personal
            details.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <Label>WhatsApp number on the poster</Label>
            <Select
              value={s.desk_channel_id ?? NONE}
              onValueChange={(v) => set("desk_channel_id", v === NONE ? null : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>First active number</SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} {c.display_phone ? `(${c.display_phone})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="reg-en">Message in English</Label>
            <Input
              id="reg-en"
              maxLength={200}
              value={s.registration_message_en}
              onChange={(e) => set("registration_message_en", e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="reg-ar">Message in Arabic</Label>
            <Input
              id="reg-ar"
              dir="rtl"
              maxLength={200}
              value={s.registration_message_ar}
              onChange={(e) => set("registration_message_ar", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Save settings
        </Button>
      </div>
    </form>
  );
}
