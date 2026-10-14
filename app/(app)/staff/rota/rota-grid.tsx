"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, MapPin, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
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
import { addDays } from "@/lib/documents/expiry";
import {
  findOverlap,
  ROTA_ROLE_LABELS,
  ROTA_ROLES,
  shiftLabel,
  shiftLocalDate,
  shiftRange,
  shiftTimes,
  type RotaRole,
} from "@/lib/organisation/rota";
import type { BranchOption, Option, ShiftRow } from "@/lib/organisation/types";
import { cn } from "@/lib/utils";

import { deleteShiftAction, saveShiftAction } from "./actions";

type Person = { id: string; name: string; title: string | null };

type Draft = {
  id: string | null;
  staffMemberId: string | null;
  date: string;
  start: string;
  end: string;
  roleLabel: RotaRole;
  room: string;
  notes: string;
};

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function RotaGrid({
  branches,
  branchId,
  timezone,
  monday,
  days,
  today,
  shifts,
  people,
  staffOptions,
  canManage,
  canStaff,
  canSettings,
}: {
  branches: BranchOption[];
  branchId: string | null;
  timezone: string;
  monday: string;
  days: string[];
  today: string;
  shifts: ShiftRow[];
  people: Person[];
  staffOptions: Option[];
  canManage: boolean;
  canStaff: boolean;
  /** May open Settings, Appointments, where branches are added: the empty state links there. */
  canSettings: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<Draft | null>(null);

  const go = (patch: { branch?: string | null; week?: string | null }) => {
    const p = new URLSearchParams();
    const b = patch.branch !== undefined ? patch.branch : branchId;
    const w = patch.week !== undefined ? patch.week : monday;
    if (b) p.set("branch", b);
    if (w) p.set("week", w);
    router.push(`/staff/rota?${p.toString()}`);
  };

  const byCell = React.useMemo(() => {
    const m = new Map<string, ShiftRow[]>();
    for (const s of shifts) {
      const key = `${s.staffMemberId}|${shiftLocalDate(s.startsAt, timezone)}`;
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return m;
  }, [shifts, timezone]);

  const openNew = (preset: Partial<Draft> = {}) =>
    setDraft({
      id: null,
      staffMemberId: null,
      date: days.includes(today) ? today : days[0],
      start: "09:00",
      end: "17:00",
      roleLabel: "other",
      room: "",
      notes: "",
      ...preset,
    });

  const openEdit = (s: ShiftRow) => {
    const t = shiftTimes(s, timezone);
    setDraft({
      id: s.id,
      staffMemberId: s.staffMemberId,
      date: t.date,
      start: t.start,
      end: t.end,
      roleLabel: s.roleLabel,
      room: s.room ?? "",
      notes: s.notes ?? "",
    });
  };

  const branchName = branches.find((b) => b.id === branchId)?.name ?? "";
  const weekLabel = `${days[0]} to ${days[6]}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Rota"
        description="Who is on, where and when: one branch, one week. A person cannot have two shifts at the same time."
      >
        {canStaff && (
          <Button asChild variant="outline">
            <Link href="/staff">Staff</Link>
          </Button>
        )}
        {canManage && branchId && (
          <Button onClick={() => openNew()}>
            <Plus aria-hidden /> Add shift
          </Button>
        )}
      </PageHeader>

      {branches.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No branches to show"
          description="The rota is planned per branch. Branches (locations) are added under Settings, Appointments."
          action={
            canSettings && (
              <Button asChild size="sm">
                <Link href="/settings/appointments?tab=locations">Add a branch</Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <OptionSelect
              id="rota-branch"
              className="w-48"
              allowNone={false}
              value={branchId}
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
              onChange={(v) => go({ branch: v })}
            />
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous week"
                onClick={() => go({ week: addDays(monday, -7) })}
              >
                <ChevronLeft aria-hidden />
              </Button>
              <Button variant="outline" onClick={() => go({ week: today })}>
                This week
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next week"
                onClick={() => go({ week: addDays(monday, 7) })}
              >
                <ChevronRight aria-hidden />
              </Button>
            </div>
            <span className="text-muted-foreground text-sm">
              {branchName} · {weekLabel}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-xl border">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <caption className="sr-only">
                Rota for {branchName}, week {weekLabel}
              </caption>
              <thead className="bg-background sticky top-0 z-10">
                <tr className="border-b">
                  <th scope="col" className="w-48 p-2 text-left text-xs font-medium">
                    Person
                  </th>
                  {days.map((d, i) => (
                    <th
                      key={d}
                      scope="col"
                      className={cn(
                        "p-2 text-left text-xs font-medium",
                        d === today && "bg-primary/5",
                      )}
                    >
                      {WEEKDAY[i]} <span className="text-muted-foreground">{d.slice(5)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-muted-foreground p-8 text-center">
                      {canStaff
                        ? "No one has this as their home branch and no shifts are planned this week."
                        : "No shifts are planned this week."}
                    </td>
                  </tr>
                )}
                {people.map((p) => (
                  <tr key={p.id} className="border-b align-top last:border-0">
                    <th scope="row" className="p-2 text-left font-normal">
                      <div className="font-medium">{p.name}</div>
                      {p.title && <div className="text-muted-foreground text-xs">{p.title}</div>}
                    </th>
                    {days.map((d) => {
                      const cell = byCell.get(`${p.id}|${d}`) ?? [];
                      return (
                        <td key={d} className={cn("p-1.5", d === today && "bg-primary/5")}>
                          <div className="flex flex-col gap-1">
                            {cell.map((s) => (
                              <button
                                key={s.id}
                                type="button"
                                disabled={!canManage}
                                onClick={() => openEdit(s)}
                                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-md px-2 py-1 text-left text-xs disabled:cursor-default"
                                aria-label={`${p.name}, ${shiftLabel(s, timezone)}, ${ROTA_ROLE_LABELS[s.roleLabel]}${canManage ? ", edit" : ""}`}
                              >
                                <div className="font-medium">{shiftLabel(s, timezone)}</div>
                                <div className="text-muted-foreground">
                                  {ROTA_ROLE_LABELS[s.roleLabel]}
                                  {s.room ? ` · ${s.room}` : ""}
                                </div>
                              </button>
                            ))}
                            {canManage && (
                              <button
                                type="button"
                                onClick={() => openNew({ staffMemberId: p.id, date: d })}
                                className="text-muted-foreground hover:bg-muted hover:text-foreground flex min-h-7 items-center justify-center rounded-md border border-dashed text-xs"
                                aria-label={`Add a shift for ${p.name} on ${d}`}
                              >
                                <Plus className="size-3" aria-hidden />
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {canManage && branchId && (
        <ShiftDialog
          draft={draft}
          onClose={() => setDraft(null)}
          branchId={branchId}
          timezone={timezone}
          shifts={shifts}
          staffOptions={staffOptions}
          onSaved={() => {
            setDraft(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ShiftDialog({
  draft,
  onClose,
  branchId,
  timezone,
  shifts,
  staffOptions,
  onSaved,
}: {
  draft: Draft | null;
  onClose: () => void;
  branchId: string;
  timezone: string;
  shifts: ShiftRow[];
  staffOptions: Option[];
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<Draft | null>(draft);
  const [pending, startTransition] = React.useTransition();
  React.useEffect(() => setForm(draft), [draft]);
  if (!form) return null;
  const set = (patch: Partial<Draft>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const range = shiftRange(form.date, form.start, form.end, timezone);
  const clash =
    range && form.staffMemberId
      ? findOverlap(shifts, { ...range, id: form.id ?? "", staffMemberId: form.staffMemberId })
      : null;

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form?.staffMemberId) return;
    const payload = { ...form, staffMemberId: form.staffMemberId, locationId: branchId };
    startTransition(async () => {
      const res = await saveShiftAction(payload);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved.");
      onSaved();
    });
  }

  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit shift" : "Add shift"}</DialogTitle>
            <DialogDescription>
              Times are in the branch&apos;s timezone. An end time before the start runs past
              midnight.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="shift-person">Person</Label>
            <OptionSelect
              id="shift-person"
              allowNone={false}
              placeholder="Choose a person"
              value={form.staffMemberId}
              options={staffOptions}
              onChange={(v) => set({ staffMemberId: v })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="shift-date">Date</Label>
              <Input
                id="shift-date"
                type="date"
                required
                value={form.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-start">Start</Label>
              <Input
                id="shift-start"
                type="time"
                required
                value={form.start}
                onChange={(e) => set({ start: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-end">End</Label>
              <Input
                id="shift-end"
                type="time"
                required
                value={form.end}
                onChange={(e) => set({ end: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="shift-role">Role</Label>
              <OptionSelect
                id="shift-role"
                allowNone={false}
                value={form.roleLabel}
                options={ROTA_ROLES.map((r) => ({ value: r, label: ROTA_ROLE_LABELS[r] }))}
                onChange={(v) => set({ roleLabel: (v ?? "other") as RotaRole })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-room">Room</Label>
              <Input
                id="shift-room"
                maxLength={40}
                placeholder="e.g. Room 3"
                value={form.room}
                onChange={(e) => set({ room: e.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="shift-notes">Notes</Label>
            <Input
              id="shift-notes"
              maxLength={300}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </div>
          {clash && (
            <p role="alert" className="text-destructive text-sm">
              This person already has a shift at {shiftLabel(clash, timezone)} that day.
            </p>
          )}
          {!range && (
            <p role="alert" className="text-destructive text-sm">
              Enter a start and an end time (a shift can last at most 24 hours).
            </p>
          )}
          <DialogFooter className="gap-2">
            {form.id && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive mr-auto"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const res = await deleteShiftAction(form.id!);
                    if (!res.ok) return void toast.error(res.error);
                    toast.success(res.message ?? "Removed.");
                    onSaved();
                  })
                }
              >
                <Trash2 aria-hidden /> Remove
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !form.staffMemberId || !range || !!clash}>
              {pending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
