"use client";

import { useState } from "react";
import { Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { deleteSpecialist, saveSpecialist } from "./actions";
import type { Department, Location, Service } from "./catalogue";
import { minutesToTime, NONE, timeToMinutes, useRun, WEEKDAYS } from "./shared";

type Hours = { location_id: string; weekday: number; start_min: number; end_min: number };

export type SpecialistRow = {
  id: string;
  name: string;
  title: string | null;
  department_id: string | null;
  external_id: string | null;
  user_id: string | null;
  active: boolean;
  location_ids: string[];
  service_ids: string[];
  working_hours: Hours[];
};

type Form = {
  id: string | null;
  name: string;
  title: string;
  department_id: string | null;
  external_id: string;
  user_id: string | null;
  active: boolean;
  location_ids: string[];
  service_ids: string[];
  working_hours: Hours[];
};

const blank: Form = {
  id: null,
  name: "",
  title: "",
  department_id: null,
  external_id: "",
  user_id: null,
  active: true,
  location_ids: [],
  service_ids: [],
  working_hours: [],
};

function HoursEditor({
  location,
  hours,
  onChange,
}: {
  location: Location;
  hours: Hours[];
  onChange: (next: Hours[]) => void;
}) {
  const mine = hours.filter((h) => h.location_id === location.id);
  const others = hours.filter((h) => h.location_id !== location.id);
  const set = (next: Hours[]) => onChange([...others, ...next]);

  function update(target: Hours, patch: Partial<Hours>) {
    set(mine.map((h) => (h === target ? { ...h, ...patch } : h)));
  }
  function copyMondayToWeekdays() {
    const monday = mine.filter((h) => h.weekday === 1);
    const rest = mine.filter((h) => h.weekday === 1 || h.weekday > 5);
    set([...rest, ...[2, 3, 4, 5].flatMap((weekday) => monday.map((h) => ({ ...h, weekday })))]);
  }

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{location.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copyMondayToWeekdays}
          disabled={!mine.some((h) => h.weekday === 1)}
        >
          <Copy /> Copy Mon to Tue–Fri
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {WEEKDAYS.map((d) => {
          const rows = mine.filter((h) => h.weekday === d.value);
          return (
            <div key={d.value} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-10 font-medium">{d.label}</span>
              {rows.length === 0 && <span className="text-muted-foreground text-xs">Off</span>}
              {rows.map((h, i) => (
                <span key={i} className="flex items-center gap-1">
                  <Input
                    type="time"
                    className="w-28"
                    aria-label={`${d.label} start`}
                    value={minutesToTime(h.start_min)}
                    onChange={(e) => update(h, { start_min: timeToMinutes(e.target.value) })}
                  />
                  –
                  <Input
                    type="time"
                    className="w-28"
                    aria-label={`${d.label} end`}
                    value={minutesToTime(h.end_min === 1440 ? 1439 : h.end_min)}
                    onChange={(e) => update(h, { end_min: timeToMinutes(e.target.value, true) })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${d.label} hours`}
                    onClick={() => set(mine.filter((x) => x !== h))}
                  >
                    <Trash2 />
                  </Button>
                </span>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Add ${d.label} hours`}
                onClick={() =>
                  set([
                    ...mine,
                    {
                      location_id: location.id,
                      weekday: d.value,
                      start_min: rows.length ? rows[rows.length - 1].end_min : 9 * 60,
                      end_min: Math.min(
                        (rows.length ? rows[rows.length - 1].end_min : 9 * 60) + 8 * 60,
                        1439,
                      ),
                    },
                  ])
                }
              >
                <Plus />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Specialists({
  specialists,
  locations,
  departments,
  services,
  users,
}: {
  specialists: SpecialistRow[];
  locations: Location[];
  departments: Department[];
  services: Service[];
  users: Array<{ id: string; name: string }>;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const { pending, run } = useRun();
  const locName = (id: string) => locations.find((l) => l.id === id)?.name ?? "?";

  function submit() {
    if (!form) return;
    run(
      () =>
        saveSpecialist({
          ...form,
          title: form.title || null,
          external_id: form.external_id || null,
        }),
      () => setForm(null),
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Specialists</CardTitle>
            <CardDescription>
              Doctors and other bookable staff. The Unite doctor id links synced appointments to
              them.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setForm(blank)}>
            <Plus /> Add specialist
          </Button>
        </CardHeader>
        <CardContent>
          {specialists.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No specialists yet. Add locations and services first, then add the doctors.
            </p>
          ) : (
            <ul className="divide-y text-sm">
              {specialists.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{s.name}</span>
                    {s.title && <span className="text-muted-foreground"> · {s.title}</span>}{" "}
                    {!s.active && <Badge variant="outline">Inactive</Badge>}
                    <span className="text-muted-foreground block truncate text-xs">
                      {s.location_ids.map(locName).join(", ") || "No locations"}
                      {s.external_id ? ` · Unite ${s.external_id}` : ""}
                      {` · ${s.working_hours.length} working-hour block${s.working_hours.length === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${s.name}`}
                      onClick={() =>
                        setForm({
                          ...s,
                          title: s.title ?? "",
                          external_id: s.external_id ?? "",
                        })
                      }
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${s.name}`}
                      disabled={pending}
                      onClick={() => {
                        if (
                          confirm(
                            `Delete ${s.name}? Their appointments are kept without a specialist.`,
                          )
                        )
                          run(() => deleteSpecialist(s.id));
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          {form && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <DialogHeader>
                <DialogTitle>{form.id ? "Edit specialist" : "New specialist"}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Name</Label>
                  <Input
                    value={form.name}
                    required
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Title</Label>
                  <Input
                    value={form.title}
                    placeholder="e.g. Consultant Paediatrician"
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Department</Label>
                  <Select
                    value={form.department_id ?? NONE}
                    onValueChange={(v) =>
                      setForm({ ...form, department_id: v === NONE ? null : v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {departments.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Unite doctor id</Label>
                  <Input
                    value={form.external_id}
                    onChange={(e) => setForm({ ...form, external_id: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Linked user</Label>
                  <Select
                    value={form.user_id ?? NONE}
                    onValueChange={(v) => setForm({ ...form, user_id: v === NONE ? null : v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <Switch
                    checked={form.active}
                    onCheckedChange={(c) => setForm({ ...form, active: c })}
                  />
                  Active
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Works at</Label>
                  <MultiSelect
                    options={locations.map((l) => ({ value: l.id, label: l.name }))}
                    value={form.location_ids}
                    onChange={(ids) =>
                      setForm({
                        ...form,
                        location_ids: ids,
                        working_hours: form.working_hours.filter((h) =>
                          ids.includes(h.location_id),
                        ),
                      })
                    }
                    placeholder="Choose locations"
                    emptyText="Add a location first"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Offers</Label>
                  <MultiSelect
                    options={services.map((s) => ({ value: s.id, label: s.name }))}
                    value={form.service_ids}
                    onChange={(ids) => setForm({ ...form, service_ids: ids })}
                    placeholder="Choose services"
                    emptyText="Add a service first"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label>Working hours (location time)</Label>
                {form.location_ids.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    Choose at least one location to set working hours.
                  </p>
                )}
                {locations
                  .filter((l) => form.location_ids.includes(l.id))
                  .map((l) => (
                    <HoursEditor
                      key={l.id}
                      location={l}
                      hours={form.working_hours}
                      onChange={(working_hours) => setForm({ ...form, working_hours })}
                    />
                  ))}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />} Save
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
