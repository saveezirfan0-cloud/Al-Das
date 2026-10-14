"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Clock, Loader2, Save, Search, Users } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { DataGrid, type DataGridColumn } from "@/components/data-grid/data-grid";
import { useLocalGrid } from "@/components/data-grid/use-local-grid";
import { ExpiryBadge } from "@/components/organisation/expiry-badge";
import { PageHeader } from "@/components/shell/page-header";
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
import { Textarea } from "@/components/ui/textarea";
import { doctorCalendarHref } from "@/lib/organisation/doctors";
import type { BranchOption, DoctorRow } from "@/lib/organisation/types";

import { updateDoctorProfileAction } from "./actions";

type Can = {
  edit: boolean;
  calendar: boolean;
  settings: boolean;
  rota: boolean;
  revenue: boolean;
  revshare: boolean;
};

const ALL = "all";

export function DoctorsWorkspace({
  rows,
  branches,
  today,
  leadDays,
  initialBranch,
  openId,
  can,
}: {
  rows: DoctorRow[];
  branches: BranchOption[];
  today: string;
  leadDays: number;
  initialBranch: string | null;
  openId: string | null;
  can: Can;
}) {
  const [search, setSearch] = React.useState("");
  const [branch, setBranch] = React.useState<string>(initialBranch ?? ALL);
  const [showInactive, setShowInactive] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(openId);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (showInactive || r.active) &&
        (branch === ALL || r.locationIds.includes(branch)) &&
        (!term ||
          r.name.toLowerCase().includes(term) ||
          (r.specialty ?? "").toLowerCase().includes(term) ||
          (r.departmentName ?? "").toLowerCase().includes(term)),
    );
  }, [rows, search, branch, showInactive]);

  const sortBy = React.useMemo(
    () => ({
      name: (r: DoctorRow) => r.name,
      specialty: (r: DoctorRow) => r.specialty ?? r.departmentName,
      branches: (r: DoctorRow) => r.locationNames.join(", "),
      services: (r: DoctorRow) => r.servicesCount,
      licence: (r: DoctorRow) => r.licenceExpiresOn,
      user: (r: DoctorRow) => r.userLabel,
      today: (r: DoctorRow) => r.todayCount,
    }),
    [],
  );
  const grid = useLocalGrid(filtered, sortBy, [{ id: "name", desc: false }]);

  const columns = React.useMemo<DataGridColumn<DoctorRow>[]>(
    () => [
      {
        id: "name",
        label: "Doctor",
        header: "Doctor",
        sortKey: "name",
        locked: true,
        size: 240,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {row.original.name}
              {!row.original.active && (
                <Badge variant="outline" className="ml-2">
                  Inactive
                </Badge>
              )}
            </div>
            {row.original.title && (
              <div className="text-muted-foreground truncate text-xs">{row.original.title}</div>
            )}
          </div>
        ),
      },
      {
        id: "specialty",
        label: "Specialty",
        header: "Specialty",
        sortKey: "specialty",
        cell: ({ row }) => row.original.specialty ?? row.original.departmentName ?? "—",
      },
      {
        id: "branches",
        label: "Branches",
        header: "Branches",
        sortKey: "branches",
        size: 200,
        cell: ({ row }) => row.original.locationNames.join(", ") || "—",
      },
      {
        id: "services",
        label: "Services",
        header: "Services",
        sortKey: "services",
        size: 100,
        cell: ({ row }) => row.original.servicesCount,
      },
      {
        id: "licence",
        label: "Licence expiry",
        header: "Licence expiry",
        sortKey: "licence",
        size: 220,
        cell: ({ row }) =>
          row.original.licenceExpiresOn ? (
            <span className="flex flex-wrap items-center gap-1">
              <span>{row.original.licenceExpiresOn}</span>
              <ExpiryBadge
                label="Licence"
                date={row.original.licenceExpiresOn}
                today={today}
                leadDays={leadDays}
              />
            </span>
          ) : (
            <span className="text-muted-foreground">Not recorded</span>
          ),
      },
      {
        id: "user",
        label: "Pulse user",
        header: "Pulse user",
        sortKey: "user",
        cell: ({ row }) => row.original.userLabel ?? "—",
      },
      {
        id: "today",
        label: "Today",
        header: "Today",
        sortKey: "today",
        size: 90,
        cell: ({ row }) => row.original.todayCount,
      },
    ],
    [today, leadDays],
  );

  const current = rows.find((r) => r.id === open) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Doctors"
        description="Who works where, their services, licences and today's list. Working hours are set under Settings, Appointments."
      >
        {can.rota && (
          <Button asChild variant="outline">
            <Link href="/staff/rota">
              <Clock aria-hidden /> Rota
            </Link>
          </Button>
        )}
        {can.calendar && (
          <Button asChild variant="outline">
            <Link href="/appointments?view=calendar">
              <CalendarDays aria-hidden /> Diary
            </Link>
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            aria-hidden
            className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            aria-label="Search doctors"
            placeholder="Search name or specialty"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {branches.length > 1 && (
          <OptionSelect
            id="doctor-branch"
            className="w-48"
            allowNone={false}
            value={branch}
            options={[
              { value: ALL, label: "All my branches" },
              ...branches.map((b) => ({ value: b.id, label: b.name })),
            ]}
            onChange={(v) => setBranch(v ?? ALL)}
          />
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      <DataGrid
        columns={columns}
        {...grid}
        onRowClick={(r) => setOpen(r.id)}
        emptyText="No doctors here yet. Doctors are added under Settings, Appointments."
      />

      <DoctorDrawer
        doctor={current}
        onClose={() => setOpen(null)}
        today={today}
        leadDays={leadDays}
        can={can}
      />
    </div>
  );
}

function DoctorDrawer({
  doctor,
  onClose,
  today,
  leadDays,
  can,
}: {
  doctor: DoctorRow | null;
  onClose: () => void;
  today: string;
  leadDays: number;
  can: Can;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState({
    specialty: "",
    licence_number: "",
    licence_authority: "DHA",
    licence_expires_on: "",
    phone_ext: "",
    bio: "",
  });

  React.useEffect(() => {
    if (!doctor) return;
    setForm({
      specialty: doctor.specialty ?? "",
      licence_number: doctor.licenceNumber ?? "",
      licence_authority: doctor.licenceAuthority || "DHA",
      licence_expires_on: doctor.licenceExpiresOn ?? "",
      phone_ext: doctor.phoneExt ?? "",
      bio: doctor.bio ?? "",
    });
  }, [doctor]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!doctor) return;
    startTransition(async () => {
      const res = await updateDoctorProfileAction(doctor.id, form);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved.");
      router.refresh();
    });
  }

  return (
    <Sheet open={!!doctor} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        {doctor && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle>{doctor.name}</SheetTitle>
              <SheetDescription>
                {[doctor.title, doctor.specialty ?? doctor.departmentName]
                  .filter(Boolean)
                  .join(" · ") || "Doctor"}
              </SheetDescription>
            </SheetHeader>
            <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
              <div className="grid flex-1 content-start gap-5 overflow-y-auto p-4">
                <section className="grid gap-2" aria-labelledby="doc-today">
                  <h3 id="doc-today" className="text-sm font-semibold">
                    Today
                  </h3>
                  <p className="text-sm">
                    {doctor.todayCount === 1
                      ? "1 appointment today"
                      : `${doctor.todayCount} appointments today`}
                    {doctor.locationNames.length > 0 && ` · ${doctor.locationNames.join(", ")}`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {can.calendar && (
                      <Button asChild size="sm" variant="outline">
                        <Link href={doctorCalendarHref(doctor.id)}>
                          <CalendarDays aria-hidden /> Open calendar
                        </Link>
                      </Button>
                    )}
                    {can.revenue && (
                      <Button asChild size="sm" variant="outline">
                        <Link href="/finance/doctors">Performance</Link>
                      </Button>
                    )}
                    {can.revshare && (
                      <Button asChild size="sm" variant="outline">
                        <Link href="/finance/revenue-share">Revenue share</Link>
                      </Button>
                    )}
                  </div>
                </section>

                <section className="grid gap-2" aria-labelledby="doc-hours">
                  <h3 id="doc-hours" className="text-sm font-semibold">
                    Working hours
                  </h3>
                  {doctor.hours.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No working hours set.</p>
                  ) : (
                    <ul className="grid gap-1.5 text-sm">
                      {doctor.hours.map((h) => (
                        <li key={h.locationId}>
                          <span className="font-medium">{h.locationName}:</span> {h.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  {can.settings && (
                    <Link
                      href="/settings/appointments"
                      className="text-primary text-sm underline-offset-4 hover:underline"
                    >
                      Change hours, services and branches in Settings, Appointments
                    </Link>
                  )}
                </section>

                {doctor.timeOff.length > 0 && (
                  <section className="grid gap-2" aria-labelledby="doc-off">
                    <h3 id="doc-off" className="text-sm font-semibold">
                      Coming up: time off and blocks
                    </h3>
                    <ul className="grid gap-1 text-sm">
                      {doctor.timeOff.map((b) => (
                        <li key={b.id}>
                          {new Date(b.startsAt).toLocaleString()} –{" "}
                          {new Date(b.endsAt).toLocaleString()}
                          {b.reason ? ` · ${b.reason}` : ""}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="grid gap-3" aria-labelledby="doc-profile">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id="doc-profile" className="text-sm font-semibold">
                      Profile and licence
                    </h3>
                    <ExpiryBadge
                      label="Licence"
                      date={doctor.licenceExpiresOn}
                      today={today}
                      leadDays={leadDays}
                      showValid
                    />
                  </div>
                  <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                    <Users aria-hidden className="size-4" /> Pulse user:{" "}
                    {doctor.userLabel ?? "not linked"}
                  </p>
                  <div className="grid gap-1.5">
                    <Label htmlFor="doc-specialty">Specialty</Label>
                    <Input
                      id="doc-specialty"
                      maxLength={100}
                      disabled={!can.edit}
                      value={form.specialty}
                      onChange={(e) => set({ specialty: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="doc-licence">Licence number</Label>
                      <Input
                        id="doc-licence"
                        maxLength={60}
                        disabled={!can.edit}
                        value={form.licence_number}
                        onChange={(e) => set({ licence_number: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="doc-authority">Authority</Label>
                      <Input
                        id="doc-authority"
                        maxLength={20}
                        disabled={!can.edit}
                        value={form.licence_authority}
                        onChange={(e) => set({ licence_authority: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="doc-expiry">Licence expires</Label>
                      <Input
                        id="doc-expiry"
                        type="date"
                        disabled={!can.edit}
                        value={form.licence_expires_on}
                        onChange={(e) => set({ licence_expires_on: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="doc-ext">Phone extension</Label>
                      <Input
                        id="doc-ext"
                        inputMode="numeric"
                        maxLength={6}
                        disabled={!can.edit}
                        value={form.phone_ext}
                        onChange={(e) => set({ phone_ext: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="doc-bio">Short bio</Label>
                    <Textarea
                      id="doc-bio"
                      rows={3}
                      maxLength={500}
                      disabled={!can.edit}
                      value={form.bio}
                      onChange={(e) => set({ bio: e.target.value })}
                    />
                  </div>
                </section>
              </div>
              {can.edit && (
                <div className="flex items-center gap-2 border-t p-4">
                  <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={pending}>
                    {pending ? <Loader2 className="animate-spin" /> : <Save />} Save
                  </Button>
                </div>
              )}
            </form>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
