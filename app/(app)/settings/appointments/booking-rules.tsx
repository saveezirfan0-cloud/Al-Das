"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

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
import type { AppointmentSettings } from "@/lib/appointments/settings";

import { addExclusion, loadDefaultExclusions, removeExclusion, saveBookingRules } from "./actions";
import { NONE, useRun, WEEKDAYS } from "./shared";

export type TemplateOption = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
};
export type ChannelOption = { id: string; name: string; display_phone: string | null };
export type Exclusion = {
  id: string;
  kind: string;
  match_type: string;
  value: string;
  reason: string | null;
  active: boolean;
};

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

/** minutes ↔ days / hours / minutes inputs */
function Duration({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const set = (nd: number, nh: number, nm: number) =>
    onChange(Math.max(0, nd) * 1440 + Math.max(0, nh) * 60 + Math.max(0, nm));
  const input = (value: number, unit: string, onValue: (v: number) => void) => (
    <span className="flex items-center gap-1">
      <Input
        type="number"
        min={0}
        className="w-16"
        aria-label={unit}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
      />
      <span className="text-muted-foreground text-xs">{unit}</span>
    </span>
  );
  return (
    <div className="flex items-center gap-2">
      {input(d, "d", (v) => set(v, h, m))}
      {input(h, "h", (v) => set(d, v, m))}
      {input(m, "min", (v) => set(d, h, v))}
    </div>
  );
}

function TemplateSelect({
  value,
  onChange,
  templates,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  templates: TemplateOption[];
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger className="w-64">
        <SelectValue placeholder="Not set" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Not set</SelectItem>
        {templates.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name} ({t.language}){t.status !== "APPROVED" ? ` · ${t.status.toLowerCase()}` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function BookingRules({
  initial,
  templates,
  channels,
  exclusions,
}: {
  initial: AppointmentSettings;
  templates: TemplateOption[];
  channels: ChannelOption[];
  exclusions: Exclusion[];
}) {
  const [s, setS] = useState<AppointmentSettings>(initial);
  const [testNumber, setTestNumber] = useState("");
  const [newEx, setNewEx] = useState({
    kind: "doctor" as "doctor" | "placeholder_name",
    match_type: "equals" as "equals" | "contains",
    value: "",
  });
  const { pending, run } = useRun();
  const set = <K extends keyof AppointmentSettings>(k: K, v: AppointmentSettings[K]) =>
    setS((p) => ({ ...p, [k]: v }));

  const approved = templates.filter((t) => t.status === "APPROVED");
  const mapTemplates = (id: string | null) =>
    id && !approved.some((t) => t.id === id) ? templates : approved;

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveBookingRules(s));
        }}
        className="flex flex-col gap-4"
      >
        <Card>
          <CardHeader>
            <CardTitle>Reminders</CardTitle>
            <CardDescription>
              Up to three WhatsApp reminders, each sent a set number of hours before the start. A
              reminder that would already be overdue when the appointment is booked is skipped.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 lg:grid-cols-3">
            {s.reminders.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(c) =>
                      set(
                        "reminders",
                        s.reminders.map((x, j) => (j === i ? { ...x, enabled: c } : x)),
                      )
                    }
                  />
                  Reminder {i + 1}
                </label>
                <span className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={720}
                    className="w-20"
                    aria-label={`Reminder ${i + 1} hours before`}
                    value={r.hours_before}
                    onChange={(e) =>
                      set(
                        "reminders",
                        s.reminders.map((x, j) =>
                          j === i ? { ...x, hours_before: Number(e.target.value) } : x,
                        ),
                      )
                    }
                  />
                  <span className="text-muted-foreground text-xs">h before</span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Booking rules</CardTitle>
            <CardDescription>How far ahead patients can book, change or cancel.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-2">
            <Row label="Lead time" hint="Earliest bookable moment from now.">
              <Duration
                minutes={s.lead_time_minutes}
                onChange={(m) => set("lead_time_minutes", m)}
              />
            </Row>
            <Row label="Slot step" hint="Gap between start times in the slot list.">
              <Select
                value={String(s.slot_granularity_min)}
                onValueChange={(v) => set("slot_granularity_min", Number(v))}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[5, 10, 15, 20, 30, 60].map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Reschedule cut-off" hint="Minutes before the start.">
              <Input
                type="number"
                min={0}
                className="w-24"
                value={s.reschedule_cutoff_minutes}
                onChange={(e) => set("reschedule_cutoff_minutes", Number(e.target.value))}
              />
            </Row>
            <Row
              label="Cancel cut-off"
              hint="A Cancel tap inside this window alerts reception instead of cancelling."
            >
              <Input
                type="number"
                min={0}
                className="w-24"
                value={s.cancel_cutoff_minutes}
                onChange={(e) => set("cancel_cutoff_minutes", Number(e.target.value))}
              />
            </Row>
            <Row label="Auto-confirm" hint="New bookings start as Confirmed instead of Awaiting.">
              <Switch checked={s.auto_confirm} onCheckedChange={(c) => set("auto_confirm", c)} />
            </Row>
            <div className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">Working days</span>
              <span className="text-muted-foreground text-xs">
                Days the clinic is open. Specialist hours only apply on these days.
              </span>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((d) => {
                  const on = s.working_weekdays.includes(d.value);
                  return (
                    <Button
                      key={d.value}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      aria-pressed={on}
                      onClick={() =>
                        set(
                          "working_weekdays",
                          on
                            ? s.working_weekdays.filter((x) => x !== d.value)
                            : [...s.working_weekdays, d.value].sort(),
                        )
                      }
                    >
                      {d.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm lg:col-span-2">
              <Label htmlFor="holidays">Closed dates</Label>
              <span className="text-muted-foreground text-xs">
                One YYYY-MM-DD date per line (public holidays, closures).
              </span>
              <textarea
                id="holidays"
                className="border-input bg-background min-h-20 rounded-md border px-3 py-2 font-mono text-xs"
                value={s.holidays.join("\n")}
                onChange={(e) =>
                  set(
                    "holidays",
                    e.target.value
                      .split(/\s+/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                  )
                }
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Notification templates</CardTitle>
            <CardDescription>
              Approved WhatsApp templates used for reminders and status changes. Body variables
              default to the patient&apos;s first name, the appointment time and the doctor; set a
              template&apos;s variable map to change that.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-2">
            {(
              [
                [
                  "reminder",
                  "Reminder",
                  "Sent by the reminders above. Add Confirm / Reschedule / Cancel quick-reply buttons.",
                ],
                ["confirmed", "Booking confirmed", "Sent when a booking is confirmed."],
                ["cancelled", "Cancelled", "Sent when an appointment is cancelled."],
                ["rescheduled", "Rescheduled", "Sent when an appointment is moved."],
              ] as const
            ).map(([key, label, hint]) => (
              <Row key={key} label={label} hint={hint}>
                <TemplateSelect
                  value={s.templates[key]}
                  templates={mapTemplates(s.templates[key])}
                  onChange={(v) => set("templates", { ...s.templates, [key]: v })}
                />
              </Row>
            ))}
            <Row label="Send from" hint="Defaults to the number that owns the template.">
              <Select
                value={s.channel_id ?? NONE}
                onValueChange={(v) => set("channel_id", v === NONE ? null : v)}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Automatic" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Automatic</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.display_phone ? ` (${c.display_phone})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Test mode</CardTitle>
            <CardDescription>
              While running alongside the old reminder system, only patients whose number is on this
              list receive reminders. Everyone else is logged as excluded.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Row label="Reminder test mode">
              <Switch
                checked={s.reminder_test_mode}
                onCheckedChange={(c) => set("reminder_test_mode", c)}
              />
            </Row>
            <div className="flex flex-wrap items-center gap-2">
              {s.reminder_test_numbers.map((n) => (
                <Badge key={n} variant="secondary" className="gap-1">
                  {n}
                  <button
                    type="button"
                    aria-label={`Remove ${n}`}
                    onClick={() =>
                      set(
                        "reminder_test_numbers",
                        s.reminder_test_numbers.filter((x) => x !== n),
                      )
                    }
                  >
                    ×
                  </button>
                </Badge>
              ))}
              <Input
                className="w-48"
                placeholder="+9715XXXXXXXX"
                value={testNumber}
                onChange={(e) => setTestNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const n = testNumber.trim();
                  if (/^\+[1-9][0-9]{6,14}$/.test(n) && !s.reminder_test_numbers.includes(n)) {
                    set("reminder_test_numbers", [...s.reminder_test_numbers, n]);
                    setTestNumber("");
                  }
                }}
              />
              <span className="text-muted-foreground text-xs">Press Enter to add (E.164).</span>
            </div>
          </CardContent>
        </Card>

        <div>
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save booking rules
          </Button>
        </div>
      </form>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Reminder exclusions</CardTitle>
            <CardDescription>
              Placeholder bookings and doctors that never get a reminder (carried over from the old
              Make filters).
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run(() => loadDefaultExclusions())}
          >
            Load previous defaults
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => addExclusion({ ...newEx, reason: null }),
                () => setNewEx((p) => ({ ...p, value: "" })),
              );
            }}
          >
            <Select
              value={newEx.kind}
              onValueChange={(v) => setNewEx({ ...newEx, kind: v as typeof newEx.kind })}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="doctor">Doctor</SelectItem>
                <SelectItem value="placeholder_name">Patient name</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={newEx.match_type}
              onValueChange={(v) =>
                setNewEx({ ...newEx, match_type: v as typeof newEx.match_type })
              }
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="equals">equals</SelectItem>
                <SelectItem value="contains">contains</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="w-56"
              value={newEx.value}
              placeholder="Value"
              onChange={(e) => setNewEx({ ...newEx, value: e.target.value })}
            />
            <Button type="submit" size="sm" disabled={pending || !newEx.value.trim()}>
              <Plus /> Add
            </Button>
          </form>
          <ul className="divide-y text-sm">
            {exclusions.length === 0 && (
              <li className="text-muted-foreground py-2 text-xs">No exclusions.</li>
            )}
            {exclusions.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-1.5">
                <span>
                  <Badge variant="outline">{x.kind === "doctor" ? "Doctor" : "Patient name"}</Badge>{" "}
                  {x.match_type} <span className="font-medium">{x.value}</span>
                  {x.reason && (
                    <span className="text-muted-foreground block text-xs">{x.reason}</span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${x.value}`}
                  disabled={pending}
                  onClick={() => run(() => removeExclusion(x.id))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
