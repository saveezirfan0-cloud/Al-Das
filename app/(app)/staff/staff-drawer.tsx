"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { RecordHistorySection } from "@/components/history/record-history";
import { ExpiryBadge } from "@/components/organisation/expiry-badge";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ROTA_ROLE_LABELS, shiftLabel, shiftLocalDate } from "@/lib/organisation/rota";
import {
  DUTY_FREQUENCIES,
  DUTY_FREQUENCY_LABELS,
  EMPLOYMENT_LABELS,
  EMPLOYMENT_TYPES,
  type DutyFrequency,
  type EmploymentType,
} from "@/lib/organisation/staff";
import type { BranchOption, DutyRow, Option, ShiftRow, StaffRow } from "@/lib/organisation/types";

import {
  deleteDutyAction,
  listDutiesAction,
  listStaffShiftsAction,
  saveDutyAction,
  saveStaffAction,
  setStaffArchivedAction,
} from "./actions";
import type { StaffCan } from "./staff-workspace";

type Form = {
  full_name: string;
  job_title: string;
  department_id: string | null;
  home_location_id: string | null;
  manager_staff_id: string | null;
  profile_id: string | null;
  specialist_id: string | null;
  employment_type: EmploymentType;
  start_date: string;
  end_date: string;
  work_email: string;
  work_phone: string;
  visa_expires_on: string;
  licence_number: string;
  licence_expires_on: string;
  notes: string;
};

function blank(defaultBranch: string | null): Form {
  return {
    full_name: "",
    job_title: "",
    department_id: null,
    home_location_id: defaultBranch,
    manager_staff_id: null,
    profile_id: null,
    specialist_id: null,
    employment_type: "full_time",
    start_date: "",
    end_date: "",
    work_email: "",
    work_phone: "",
    visa_expires_on: "",
    licence_number: "",
    licence_expires_on: "",
    notes: "",
  };
}

function toForm(s: StaffRow): Form {
  return {
    full_name: s.fullName,
    job_title: s.jobTitle ?? "",
    department_id: s.departmentId,
    home_location_id: s.homeLocationId,
    manager_staff_id: s.managerStaffId,
    profile_id: s.profileId,
    specialist_id: s.specialistId,
    employment_type: s.employmentType,
    start_date: s.startDate ?? "",
    end_date: s.endDate ?? "",
    work_email: s.workEmail ?? "",
    work_phone: s.workPhone ?? "",
    visa_expires_on: s.visaExpiresOn ?? "",
    licence_number: s.licenceNumber ?? "",
    licence_expires_on: s.licenceExpiresOn ?? "",
    notes: s.notes ?? "",
  };
}

export function StaffDrawer({
  open,
  staff,
  onClose,
  onCreated,
  rows,
  branches,
  departments,
  members,
  specialists,
  today,
  leadDays,
  can,
}: {
  open: boolean;
  staff: StaffRow | null;
  onClose: () => void;
  onCreated: (id: string) => void;
  rows: StaffRow[];
  branches: BranchOption[];
  departments: Option[];
  members: Option[];
  specialists: Option[];
  today: string;
  leadDays: number;
  can: StaffCan;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<Form>(() => blank(null));
  const [tab, setTab] = React.useState("profile");
  const [pending, startTransition] = React.useTransition();
  const editing = staff;
  const readOnly = !can.manage || !!staff?.archived;

  React.useEffect(() => {
    if (!open) return;
    setForm(staff ? toForm(staff) : blank(branches.length === 1 ? branches[0].id : null));
    setTab("profile");
  }, [open, staff, branches]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveStaffAction(editing?.id ?? null, form);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved.");
      router.refresh();
      if (!editing) onCreated(res.data.id);
    });
  }

  const managerOptions = rows
    .filter((r) => !r.archived && r.id !== editing?.id)
    .map((r) => ({ value: r.id, label: r.fullName }));
  // A linked user who is no longer a member still shows by name, read-only.
  const memberOptions =
    editing?.profileId && !members.some((m) => m.value === editing.profileId)
      ? [...members, { value: editing.profileId, label: editing.profileLabel ?? "Linked user" }]
      : members;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            {editing ? editing.fullName : "New staff member"}
            {editing?.archived && <Badge variant="outline">Archived</Badge>}
          </SheetTitle>
          <SheetDescription>
            {editing
              ? [editing.jobTitle, editing.homeLocationName].filter(Boolean).join(" · ") ||
                "Staff member"
              : "Name, job and home branch are enough to start. Pay is kept in Finance, not here."}
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          {editing && (
            <div className="border-b px-4 py-2">
              <TabsList>
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="duties">Duties</TabsTrigger>
                <TabsTrigger value="rota">Rota</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
            </div>
          )}

          <TabsContent value="profile" className="flex min-h-0 flex-col">
            <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
              <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4">
                {editing && (
                  <div className="flex flex-wrap gap-1">
                    <ExpiryBadge
                      label="Visa"
                      date={editing.visaExpiresOn}
                      today={today}
                      leadDays={leadDays}
                      showValid
                    />
                    <ExpiryBadge
                      label="Licence"
                      date={editing.licenceExpiresOn}
                      today={today}
                      leadDays={leadDays}
                      showValid
                    />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="s-name">Full name</Label>
                  <Input
                    id="s-name"
                    required
                    maxLength={120}
                    disabled={readOnly}
                    value={form.full_name}
                    onChange={(e) => set({ full_name: e.target.value })}
                    autoFocus={!editing}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-title">Job title</Label>
                    <Input
                      id="s-title"
                      maxLength={100}
                      disabled={readOnly}
                      value={form.job_title}
                      onChange={(e) => set({ job_title: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-type">Employment</Label>
                    <OptionSelect
                      id="s-type"
                      allowNone={false}
                      disabled={readOnly}
                      value={form.employment_type}
                      options={EMPLOYMENT_TYPES.map((t) => ({
                        value: t,
                        label: EMPLOYMENT_LABELS[t],
                      }))}
                      onChange={(v) =>
                        set({ employment_type: (v ?? "full_time") as EmploymentType })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-dept">Department</Label>
                    <OptionSelect
                      id="s-dept"
                      noneLabel="None"
                      disabled={readOnly}
                      value={form.department_id}
                      options={departments}
                      onChange={(v) => set({ department_id: v })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-branch">Home branch</Label>
                    <OptionSelect
                      id="s-branch"
                      noneLabel="None"
                      disabled={readOnly}
                      value={form.home_location_id}
                      options={branches.map((b) => ({ value: b.id, label: b.name }))}
                      onChange={(v) => set({ home_location_id: v })}
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="s-manager">Manager</Label>
                  <OptionSelect
                    id="s-manager"
                    noneLabel="None"
                    disabled={readOnly}
                    value={form.manager_staff_id}
                    options={managerOptions}
                    onChange={(v) => set({ manager_staff_id: v })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-user">Pulse user</Label>
                    <OptionSelect
                      id="s-user"
                      noneLabel="Not linked"
                      disabled={readOnly || members.length === 0}
                      value={form.profile_id}
                      options={memberOptions}
                      onChange={(v) => set({ profile_id: v })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-doctor">Doctor record</Label>
                    <OptionSelect
                      id="s-doctor"
                      noneLabel="Not a doctor"
                      disabled={readOnly}
                      value={form.specialist_id}
                      options={specialists}
                      onChange={(v) => set({ specialist_id: v })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-start">Start date</Label>
                    <Input
                      id="s-start"
                      type="date"
                      disabled={readOnly}
                      value={form.start_date}
                      onChange={(e) => set({ start_date: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-end">End date</Label>
                    <Input
                      id="s-end"
                      type="date"
                      disabled={readOnly}
                      value={form.end_date}
                      onChange={(e) => set({ end_date: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-email">Work e-mail</Label>
                    <Input
                      id="s-email"
                      type="email"
                      maxLength={254}
                      disabled={readOnly}
                      value={form.work_email}
                      onChange={(e) => set({ work_email: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-phone">Work phone</Label>
                    <Input
                      id="s-phone"
                      type="tel"
                      maxLength={40}
                      disabled={readOnly}
                      value={form.work_phone}
                      onChange={(e) => set({ work_phone: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-visa">Visa expires</Label>
                    <Input
                      id="s-visa"
                      type="date"
                      disabled={readOnly}
                      value={form.visa_expires_on}
                      onChange={(e) => set({ visa_expires_on: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-licence">Licence number</Label>
                    <Input
                      id="s-licence"
                      maxLength={60}
                      disabled={readOnly}
                      value={form.licence_number}
                      onChange={(e) => set({ licence_number: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="s-licence-exp">Licence expires</Label>
                    <Input
                      id="s-licence-exp"
                      type="date"
                      disabled={readOnly}
                      value={form.licence_expires_on}
                      onChange={(e) => set({ licence_expires_on: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="s-notes">Notes</Label>
                  <Textarea
                    id="s-notes"
                    rows={3}
                    maxLength={2000}
                    disabled={readOnly}
                    value={form.notes}
                    onChange={(e) => set({ notes: e.target.value })}
                  />
                  <p className="text-muted-foreground text-xs">
                    Work notes only. Do not write pay, medical or patient details here.
                  </p>
                </div>
              </div>
              {can.manage && (
                <div className="flex items-center gap-2 border-t p-4">
                  {editing &&
                    (editing.archived ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const res = await setStaffArchivedAction(editing.id, false);
                            if (!res.ok) return void toast.error(res.error);
                            toast.success(res.message ?? "Restored.");
                            router.refresh();
                          })
                        }
                      >
                        <ArchiveRestore aria-hidden /> Restore
                      </Button>
                    ) : (
                      <ConfirmDialog
                        trigger={
                          <Button type="button" variant="ghost" className="text-destructive">
                            <Archive aria-hidden /> Archive
                          </Button>
                        }
                        title="Archive this staff member?"
                        description="They disappear from the directory, the rota and the reminders. Their record, duties and past shifts are kept, and you can restore them from Show archived."
                        confirmLabel="Archive"
                        destructive
                        onConfirm={async () => {
                          const res = await setStaffArchivedAction(editing.id, true);
                          if (!res.ok) return res;
                          toast.success(res.message ?? "Archived.");
                          router.refresh();
                          onClose();
                          return res;
                        }}
                      />
                    ))}
                  <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
                    Cancel
                  </Button>
                  {!editing?.archived && (
                    <Button type="submit" disabled={pending || !form.full_name.trim()}>
                      {pending ? <Loader2 className="animate-spin" /> : <Save />}{" "}
                      {editing ? "Save" : "Add staff member"}
                    </Button>
                  )}
                </div>
              )}
            </form>
          </TabsContent>

          {editing && (
            <>
              <TabsContent value="duties" className="overflow-y-auto p-4">
                <DutiesTab
                  staffId={editing.id}
                  branches={branches}
                  manage={can.manage && !editing.archived}
                />
              </TabsContent>
              <TabsContent value="rota" className="overflow-y-auto p-4">
                <RotaTab staffId={editing.id} branches={branches} rotaLink={can.rota} />
              </TabsContent>
              <TabsContent value="history" className="overflow-y-auto p-4">
                <RecordHistorySection table="staff_members" recordId={editing.id} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function DutiesTab({
  staffId,
  branches,
  manage,
}: {
  staffId: string;
  branches: BranchOption[];
  manage: boolean;
}) {
  const [duties, setDuties] = React.useState<DutyRow[] | null>(null);
  const [reload, setReload] = React.useState(0);
  const [title, setTitle] = React.useState("");
  const [frequency, setFrequency] = React.useState<DutyFrequency>("daily");
  const [branch, setBranch] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    let live = true;
    void listDutiesAction(staffId).then((res) => {
      if (!live) return;
      if (res.ok) setDuties(res.data);
      else toast.error(res.error);
    });
    return () => {
      live = false;
    };
  }, [staffId, reload]);

  const branchName = (id: string | null) => branches.find((b) => b.id === id)?.name ?? null;

  function add(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveDutyAction(staffId, null, {
        title,
        frequency,
        location_id: branch,
        active: true,
      });
      if (!res.ok) return void toast.error(res.error);
      setTitle("");
      setReload((n) => n + 1);
    });
  }

  if (!duties)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading duties…
      </p>
    );

  return (
    <div className="grid gap-4">
      {duties.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No duties yet.{manage ? " Add what this person is responsible for below." : ""}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {duties.map((d) => (
            <li key={d.id} className="flex items-center gap-3 p-3 text-sm">
              <input
                type="checkbox"
                className="size-4"
                aria-label={`Active: ${d.title}`}
                checked={d.active}
                disabled={!manage || pending}
                onChange={(e) =>
                  startTransition(async () => {
                    const res = await saveDutyAction(staffId, d.id, {
                      title: d.title,
                      frequency: d.frequency,
                      location_id: d.locationId,
                      active: e.target.checked,
                    });
                    if (!res.ok) return void toast.error(res.error);
                    setReload((n) => n + 1);
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <div className={d.active ? "" : "text-muted-foreground line-through"}>
                  {d.title}
                </div>
                <div className="text-muted-foreground text-xs">
                  {DUTY_FREQUENCY_LABELS[d.frequency]}
                  {branchName(d.locationId) ? ` · ${branchName(d.locationId)}` : ""}
                </div>
              </div>
              {manage && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove duty: ${d.title}`}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await deleteDutyAction(staffId, d.id);
                      if (!res.ok) return void toast.error(res.error);
                      setReload((n) => n + 1);
                    })
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <form onSubmit={add} className="grid gap-3 rounded-lg border p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="duty-title">New duty</Label>
            <Input
              id="duty-title"
              maxLength={200}
              placeholder="e.g. Open the front desk and check the day's list"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="duty-frequency">How often</Label>
              <OptionSelect
                id="duty-frequency"
                allowNone={false}
                value={frequency}
                options={DUTY_FREQUENCIES.map((f) => ({
                  value: f,
                  label: DUTY_FREQUENCY_LABELS[f],
                }))}
                onChange={(v) => setFrequency((v ?? "daily") as DutyFrequency)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="duty-branch">Branch</Label>
              <OptionSelect
                id="duty-branch"
                noneLabel="Any branch"
                value={branch}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
                onChange={setBranch}
              />
            </div>
          </div>
          <Button type="submit" className="justify-self-start" disabled={pending || !title.trim()}>
            <Plus aria-hidden /> Add duty
          </Button>
        </form>
      )}
    </div>
  );
}

function RotaTab({
  staffId,
  branches,
  rotaLink,
}: {
  staffId: string;
  branches: BranchOption[];
  rotaLink: boolean;
}) {
  const [shifts, setShifts] = React.useState<ShiftRow[] | null>(null);
  React.useEffect(() => {
    let live = true;
    void listStaffShiftsAction(staffId).then((res) => {
      if (!live) return;
      if (res.ok) setShifts(res.data);
      else toast.error(res.error);
    });
    return () => {
      live = false;
    };
  }, [staffId]);

  if (!shifts)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading shifts…
      </p>
    );
  const branch = (id: string) => branches.find((b) => b.id === id);
  return (
    <div className="grid gap-3">
      {shifts.length === 0 ? (
        <p className="text-muted-foreground text-sm">No shifts in the next four weeks.</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {shifts.map((s) => {
            const b = branch(s.locationId);
            const tz = b?.timezone ?? "Asia/Dubai";
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                <span className="font-medium">{shiftLocalDate(s.startsAt, tz)}</span>
                <span>{shiftLabel(s, tz)}</span>
                <span className="text-muted-foreground">
                  {ROTA_ROLE_LABELS[s.roleLabel]}
                  {b ? ` · ${b.name}` : ""}
                  {s.room ? ` · ${s.room}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rotaLink && (
        <Link
          href="/staff/rota"
          className="text-primary text-sm underline-offset-4 hover:underline"
        >
          Open the rota to add or change shifts
        </Link>
      )}
    </div>
  );
}
