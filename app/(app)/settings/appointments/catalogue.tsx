"use client";

import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  deleteDepartment,
  deleteLocation,
  deleteService,
  saveDepartment,
  saveLocation,
  saveService,
} from "./actions";
import { NONE, timezoneOptions, useRun } from "./shared";

export type Location = {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  external_id: string | null;
  active: boolean;
};
export type Department = { id: string; name: string; active: boolean };
export type Service = {
  id: string;
  name: string;
  department_id: string | null;
  duration_min: number;
  price: number | null;
  active: boolean;
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

function ListCard({
  title,
  description,
  onAdd,
  addLabel,
  empty,
  children,
  hasItems,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  addLabel: string;
  empty: string;
  children: React.ReactNode;
  hasItems: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button size="sm" onClick={onAdd}>
          <Plus /> {addLabel}
        </Button>
      </CardHeader>
      <CardContent>
        {hasItems ? (
          <ul className="divide-y text-sm">{children}</ul>
        ) : (
          <p className="text-muted-foreground text-sm">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

function RowActions({
  onEdit,
  onDelete,
  pending,
  label,
}: {
  onEdit: () => void;
  onDelete: () => void;
  pending: boolean;
  label: string;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${label}`} onClick={onEdit}>
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${label}`}
        disabled={pending}
        onClick={() => {
          if (confirm(`Delete "${label}"? Appointments keep their history but lose this link.`))
            onDelete();
        }}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  pending,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  onSubmit: () => void;
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

export function Locations({
  items,
  defaultTimezone,
}: {
  items: Location[];
  defaultTimezone: string;
}) {
  const blank = {
    id: null as string | null,
    name: "",
    timezone: defaultTimezone,
    address: "",
    external_id: "",
    active: true,
  };
  const [form, setForm] = useState<typeof blank | null>(null);
  const { pending, run } = useRun();
  const zones = timezoneOptions();
  return (
    <>
      <ListCard
        title="Locations"
        description="Branches. The Unite clinic id (DHA licence) links synced appointments to a branch."
        onAdd={() => setForm(blank)}
        addLabel="Add location"
        empty="No locations yet."
        hasItems={items.length > 0}
      >
        {items.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="font-medium">{l.name}</span>{" "}
              {!l.active && <Badge variant="outline">Inactive</Badge>}
              <span className="text-muted-foreground block truncate text-xs">
                {l.timezone}
                {l.external_id ? ` · Unite ${l.external_id}` : ""}
                {l.address ? ` · ${l.address}` : ""}
              </span>
            </span>
            <RowActions
              label={l.name}
              pending={pending}
              onEdit={() =>
                setForm({
                  id: l.id,
                  name: l.name,
                  timezone: l.timezone,
                  address: l.address ?? "",
                  external_id: l.external_id ?? "",
                  active: l.active,
                })
              }
              onDelete={() => run(() => deleteLocation(l.id))}
            />
          </li>
        ))}
      </ListCard>
      <FormDialog
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={form?.id ? "Edit location" : "New location"}
        pending={pending}
        onSubmit={() =>
          form &&
          run(
            () => saveLocation(form),
            () => setForm(null),
          )
        }
      >
        {form && (
          <>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <Field label="Timezone" hint="Working hours and reminders use this clock.">
              <Select
                value={form.timezone}
                onValueChange={(v) => setForm({ ...form, timezone: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {(zones.includes(form.timezone) ? zones : [form.timezone, ...zones]).map((z) => (
                    <SelectItem key={z} value={z}>
                      {z}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Address">
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </Field>
            <Field label="Unite clinic id" hint="DHA licence of the branch, e.g. DHA-F-0000000.">
              <Input
                value={form.external_id}
                onChange={(e) => setForm({ ...form, external_id: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.active}
                onCheckedChange={(c) => setForm({ ...form, active: c })}
              />
              Active
            </label>
          </>
        )}
      </FormDialog>
    </>
  );
}

export function Departments({ items }: { items: Department[] }) {
  const [form, setForm] = useState<{ id: string | null; name: string; active: boolean } | null>(
    null,
  );
  const { pending, run } = useRun();
  return (
    <>
      <ListCard
        title="Departments"
        description="Group services and specialists, and drive reports."
        onAdd={() => setForm({ id: null, name: "", active: true })}
        addLabel="Add department"
        empty="No departments yet."
        hasItems={items.length > 0}
      >
        {items.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 py-2">
            <span>
              <span className="font-medium">{d.name}</span>{" "}
              {!d.active && <Badge variant="outline">Inactive</Badge>}
            </span>
            <RowActions
              label={d.name}
              pending={pending}
              onEdit={() => setForm({ id: d.id, name: d.name, active: d.active })}
              onDelete={() => run(() => deleteDepartment(d.id))}
            />
          </li>
        ))}
      </ListCard>
      <FormDialog
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={form?.id ? "Edit department" : "New department"}
        pending={pending}
        onSubmit={() =>
          form &&
          run(
            () => saveDepartment(form),
            () => setForm(null),
          )
        }
      >
        {form && (
          <>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.active}
                onCheckedChange={(c) => setForm({ ...form, active: c })}
              />
              Active
            </label>
          </>
        )}
      </FormDialog>
    </>
  );
}

export function Services({ items, departments }: { items: Service[]; departments: Department[] }) {
  const blank = {
    id: null as string | null,
    name: "",
    department_id: null as string | null,
    duration_min: 30,
    price: null as number | null,
    active: true,
  };
  const [form, setForm] = useState<typeof blank | null>(null);
  const { pending, run } = useRun();
  const deptName = (id: string | null) => departments.find((d) => d.id === id)?.name;
  return (
    <>
      <ListCard
        title="Services"
        description="What patients book. The duration decides how long a slot lasts."
        onAdd={() => setForm(blank)}
        addLabel="Add service"
        empty="No services yet."
        hasItems={items.length > 0}
      >
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="font-medium">{s.name}</span>{" "}
              {!s.active && <Badge variant="outline">Inactive</Badge>}
              <span className="text-muted-foreground block text-xs">
                {s.duration_min} min
                {deptName(s.department_id) ? ` · ${deptName(s.department_id)}` : ""}
                {s.price !== null ? ` · ${s.price}` : ""}
              </span>
            </span>
            <RowActions
              label={s.name}
              pending={pending}
              onEdit={() => setForm({ ...s })}
              onDelete={() => run(() => deleteService(s.id))}
            />
          </li>
        ))}
      </ListCard>
      <FormDialog
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={form?.id ? "Edit service" : "New service"}
        pending={pending}
        onSubmit={() =>
          form &&
          run(
            () => saveService(form),
            () => setForm(null),
          )
        }
      >
        {form && (
          <>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <Field label="Department">
              <Select
                value={form.department_id ?? NONE}
                onValueChange={(v) => setForm({ ...form, department_id: v === NONE ? null : v })}
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
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Duration (minutes)">
                <Input
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  value={form.duration_min}
                  onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })}
                />
              </Field>
              <Field label="Price">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      price: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.active}
                onCheckedChange={(c) => setForm({ ...form, active: c })}
              />
              Active
            </label>
          </>
        )}
      </FormDialog>
    </>
  );
}
