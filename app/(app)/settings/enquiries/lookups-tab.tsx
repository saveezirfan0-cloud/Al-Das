"use client";

import * as React from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OrgUser } from "@/lib/enquiries/server";

import { deleteLookup, saveLookup, type LookupKind } from "./actions";
import type { SettingsLookups } from "./tabs";

export type LocationRow = {
  id: string;
  name: string;
  timezone: string | null;
  address: string | null;
};
export type ServiceRow = {
  id: string;
  name: string;
  department_id: string | null;
  duration_min: number | null;
  price: number | null;
};
export type SpecialistRow = {
  id: string;
  name: string;
  title: string | null;
  department_id: string | null;
  user_id: string | null;
};

type Field =
  | { key: string; label: string; kind: "text"; placeholder?: string }
  | { key: string; label: string; kind: "number"; step?: string }
  | { key: string; label: string; kind: "department" }
  | { key: string; label: string; kind: "user" };

type Section<R extends { id: string; name: string }> = {
  kind: LookupKind;
  title: string;
  singular: string;
  rows: R[];
  fields: Field[];
  describe: (r: R) => string;
};

export function LookupsTab({
  lookups,
  users,
  orgTimezone,
}: {
  lookups: SettingsLookups;
  users: OrgUser[];
  orgTimezone: string;
}) {
  const dep = (id: string | null) => lookups.departments.find((d) => d.id === id)?.name;
  const sections: Array<Section<{ id: string; name: string }>> = [
    {
      kind: "locations",
      title: "Locations",
      singular: "location",
      rows: lookups.locations,
      fields: [
        {
          key: "timezone",
          label: `Timezone (blank = ${orgTimezone})`,
          kind: "text",
          placeholder: "Asia/Dubai",
        },
        { key: "address", label: "Address", kind: "text" },
      ],
      describe: (r) =>
        [(r as LocationRow).address, (r as LocationRow).timezone].filter(Boolean).join(" · "),
    },
    {
      kind: "departments",
      title: "Departments",
      singular: "department",
      rows: lookups.departments,
      fields: [],
      describe: () => "",
    },
    {
      kind: "services",
      title: "Services",
      singular: "service",
      rows: lookups.services,
      fields: [
        { key: "department_id", label: "Department", kind: "department" },
        { key: "duration_min", label: "Duration (minutes)", kind: "number" },
        { key: "price", label: "Price", kind: "number", step: "0.01" },
      ],
      describe: (r) => {
        const s = r as ServiceRow;
        return [
          dep(s.department_id),
          s.duration_min ? `${s.duration_min} min` : null,
          s.price !== null ? String(s.price) : null,
        ]
          .filter(Boolean)
          .join(" · ");
      },
    },
    {
      kind: "specialists",
      title: "Specialists",
      singular: "specialist",
      rows: lookups.specialists,
      fields: [
        { key: "title", label: "Title", kind: "text", placeholder: "Consultant cardiologist" },
        { key: "department_id", label: "Department", kind: "department" },
        { key: "user_id", label: "Linked user (optional)", kind: "user" },
      ],
      describe: (r) => {
        const s = r as SpecialistRow;
        return [s.title, dep(s.department_id)].filter(Boolean).join(" · ");
      },
    },
  ];
  return (
    <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
      <p className="text-muted-foreground text-sm lg:col-span-2">
        These lists feed the location, department, specialist and service pickers on enquiries.
        Appointments (Phase 6) build on the same lists.
      </p>
      {sections.map((s) => (
        <LookupCard key={s.kind} section={s} departments={lookups.departments} users={users} />
      ))}
    </div>
  );
}

function LookupCard({
  section,
  departments,
  users,
}: {
  section: Section<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  users: OrgUser[];
}) {
  const [editing, setEditing] = React.useState<{
    id: string | null;
    values: Record<string, string>;
  } | null>(null);
  const [pending, startTransition] = React.useTransition();

  function open(row: (typeof section.rows)[number] | null) {
    const values: Record<string, string> = { name: row?.name ?? "" };
    for (const f of section.fields)
      values[f.key] = String((row as unknown as Record<string, unknown> | null)?.[f.key] ?? "");
    setEditing({ id: row?.id ?? null, values });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{section.title}</CardTitle>
        <Button variant="outline" size="sm" onClick={() => open(null)}>
          <Plus /> Add
        </Button>
      </CardHeader>
      <CardContent>
        {section.rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet.</p>
        ) : (
          <ul className="divide-y">
            {section.rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  {section.describe(r) && (
                    <p className="text-muted-foreground truncate text-xs">{section.describe(r)}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${r.name}`}
                  onClick={() => open(r)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  aria-label={`Delete ${r.name}`}
                  disabled={pending}
                  onClick={() =>
                    confirm(`Delete the ${section.singular} “${r.name}”?`) &&
                    startTransition(async () => {
                      const res = await deleteLookup(section.kind, r.id);
                      if (res.ok) toast.success(res.message ?? "Deleted.");
                      else toast.error(res.error);
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editing.id ? "Edit" : "New"} {section.singular}
              </DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  const res = await saveLookup(section.kind, editing.id, editing.values);
                  if (!res.ok) return void toast.error(res.error);
                  toast.success(res.message ?? "Saved.");
                  setEditing(null);
                });
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="lk-name">Name</Label>
                <Input
                  id="lk-name"
                  required
                  maxLength={80}
                  autoFocus
                  value={editing.values.name}
                  onChange={(e) =>
                    setEditing({ ...editing, values: { ...editing.values, name: e.target.value } })
                  }
                />
              </div>
              {section.fields.map((f) => (
                <div key={f.key} className="grid gap-1.5">
                  <Label htmlFor={`lk-${f.key}`}>{f.label}</Label>
                  {f.kind === "department" || f.kind === "user" ? (
                    <OptionSelect
                      id={`lk-${f.key}`}
                      value={editing.values[f.key] || null}
                      options={
                        f.kind === "department"
                          ? departments.map((d) => ({ value: d.id, label: d.name }))
                          : users.map((u) => ({ value: u.id, label: u.label }))
                      }
                      onChange={(v) =>
                        setEditing({ ...editing, values: { ...editing.values, [f.key]: v ?? "" } })
                      }
                    />
                  ) : (
                    <Input
                      id={`lk-${f.key}`}
                      type={f.kind === "number" ? "number" : "text"}
                      step={f.kind === "number" ? f.step : undefined}
                      min={f.kind === "number" ? 0 : undefined}
                      placeholder={f.kind === "text" ? f.placeholder : undefined}
                      value={editing.values[f.key]}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          values: { ...editing.values, [f.key]: e.target.value },
                        })
                      }
                    />
                  )}
                </div>
              ))}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !editing.values.name.trim()}>
                  {pending && <Loader2 className="animate-spin" />} Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
