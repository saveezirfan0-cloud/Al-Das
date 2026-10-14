"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  Clock,
  IdCard,
  Loader2,
  Plus,
  Search,
  Stethoscope,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { DataGrid, type DataGridColumn } from "@/components/data-grid/data-grid";
import { useLocalGrid } from "@/components/data-grid/use-local-grid";
import { ExpiryBadge } from "@/components/organisation/expiry-badge";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { DrawerFooter, useUnsavedGuard } from "@/components/shell/drawer-footer";
import { isDirty } from "@/lib/shell/unsaved";
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
import type { BranchOption, DoctorDetail, DoctorRow } from "@/lib/organisation/types";

import { loadDoctorDetailAction, updateDoctorProfileAction } from "./actions";

type Can = {
  edit: boolean;
  calendar: boolean;
  settings: boolean;
  rota: boolean;
  revenue: boolean;
  revshare: boolean;
};

const ALL = "all";
/** Doctors are added (with branches, services and hours) under Settings, Appointments, which opens on Specialists. */
const ADD_DOCTOR_HREF = "/settings/appointments";

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
        {can.settings && (
          <Button asChild>
            <Link href={ADD_DOCTOR_HREF}>
              <Plus aria-hidden /> Add doctor
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

      {rows.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title="No doctors yet"
          description="Doctors are added under Settings, Appointments, with their branches, services and working hours. They then appear here, in the diary and on the rota."
          action={
            can.settings && (
              <Button asChild>
                <Link href={ADD_DOCTOR_HREF}>
                  <Plus aria-hidden /> Add the first doctor
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <DataGrid
          columns={columns}
          {...grid}
          onRowClick={(r) => setOpen(r.id)}
          emptyText="No doctors match these filters."
        />
      )}

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
  // what was loaded or last saved: the drawer asks before closing on anything else (Phase D)
  const [saved, setSaved] = React.useState<typeof form | null>(null);

  React.useEffect(() => {
    if (!doctor) return;
    const loaded = {
      specialty: doctor.specialty ?? "",
      licence_number: doctor.licenceNumber ?? "",
      licence_authority: doctor.licenceAuthority || "DHA",
      licence_expires_on: doctor.licenceExpiresOn ?? "",
      phone_ext: doctor.phoneExt ?? "",
      bio: doctor.bio ?? "",
    };
    setForm(loaded);
    setSaved(loaded);
  }, [doctor]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const dirty = can.edit && isDirty(form, saved);
  const { confirmClose, guardDialog } = useUnsavedGuard(dirty);
  async function close() {
    if (await confirmClose()) onClose();
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!doctor) return;
    const sent = form;
    startTransition(async () => {
      const res = await updateDoctorProfileAction(doctor.id, sent);
      if (!res.ok) return void toast.error(res.error);
      setSaved(sent);
      toast.success(res.message ?? "Saved.");
      router.refresh();
    });
  }

  return (
    <Sheet open={!!doctor} onOpenChange={(o) => !o && void close()}>
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
                        <Link href="/finance/doctor-performance">Performance</Link>
                      </Button>
                    )}
                    {can.revshare && (
                      <Button asChild size="sm" variant="outline">
                        <Link href="/finance/revenue-share">Revenue share</Link>
                      </Button>
                    )}
                  </div>
                </section>

                <DoctorLinks doctorId={doctor.id} can={can} />

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
                <DrawerFooter onCancel={() => void close()} saving={pending} dirty={dirty} />
              )}
            </form>
          </>
        )}
        {guardDialog}
      </SheetContent>
    </Sheet>
  );
}

/** What the doctor is linked to: the next appointments, this week's shifts and the staff record (loaded on open). */
function DoctorLinks({ doctorId, can }: { doctorId: string; can: Can }) {
  const [detail, setDetail] = React.useState<DoctorDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    void loadDoctorDetailAction(doctorId).then((res) => {
      if (!live) return;
      if (res.ok) setDetail(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [doctorId]);

  if (error) return <p className="text-muted-foreground text-sm">{error}</p>;
  if (!detail)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Loading appointments and rota…
      </p>
    );

  return (
    <>
      {detail.upcoming && (
        <section className="grid gap-2" aria-labelledby="doc-next">
          <h3 id="doc-next" className="text-sm font-semibold">
            Next appointments
          </h3>
          {detail.upcoming.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing booked ahead.</p>
          ) : (
            <ul className="grid gap-1.5 text-sm">
              {detail.upcoming.map((a) => (
                <li key={a.id}>
                  <span className="font-medium">{a.when}</span>
                  {" · "}
                  {[a.patient, a.service, a.branch].filter(Boolean).join(" · ")}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="grid gap-2" aria-labelledby="doc-rota">
        <h3 id="doc-rota" className="text-sm font-semibold">
          Rota this week
        </h3>
        {detail.shifts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No shifts this week.</p>
        ) : (
          <ul className="grid gap-1.5 text-sm">
            {detail.shifts.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{s.day}</span> {s.time}
                {[s.branch, s.role]
                  .filter(Boolean)
                  .map((x) => ` · ${x}`)
                  .join("")}
              </li>
            ))}
          </ul>
        )}
        {can.rota && (
          <Link
            href="/staff/rota"
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            Open the rota
          </Link>
        )}
      </section>

      {detail.staff && (
        <section className="grid gap-2" aria-labelledby="doc-staff">
          <h3 id="doc-staff" className="text-sm font-semibold">
            Staff record
          </h3>
          <p className="flex items-center gap-1.5 text-sm">
            <IdCard aria-hidden className="text-muted-foreground size-4" />
            {detail.staff.jobTitle ?? "No job title"}
          </p>
          <Link
            href={`/staff?staff=${encodeURIComponent(detail.staff.id)}`}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            Open the staff record (duties and shifts)
          </Link>
        </section>
      )}
    </>
  );
}
