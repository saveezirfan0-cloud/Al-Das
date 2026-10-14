"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import * as React from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, MapPin, Stethoscope } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dragMoveDecision } from "@/lib/appointments/drag-move";
import { localDate } from "@/lib/appointments/slots";
import { weekDates } from "@/lib/appointments/week";
import { useIsPhone } from "@/lib/hooks/use-media-query";

import { deleteBlock, listRange, moveAppointment } from "./actions";
import { AgendaList } from "./agenda-list";
import { AppointmentDrawer } from "./appointment-drawer";
import { AppointmentsTable } from "./appointments-table";
import { BranchWeek } from "./branch-week";
import { dayLabel, shiftDate } from "./format";
import { NewAppointmentDrawer, type NewAppointmentDefaults } from "./new-appointment-drawer";
import { ResourceGrid } from "./resource-grid";
import type { AppointmentsBootstrap, ApptRow, BlockRow } from "./types";

// FullCalendar (about 100 kB) is only needed on the Specialist calendar tab.
const SpecialistCalendar = dynamic(
  () => import("./specialist-calendar").then((m) => m.SpecialistCalendar),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[34rem] w-full rounded-xl" aria-label="Loading calendar" />
    ),
  },
);

type View = "day" | "week" | "calendar" | "table" | "agenda";

export function AppointmentsWorkspace({
  bootstrap,
  initial,
}: {
  bootstrap: AppointmentsBootstrap;
  initial: {
    view: View;
    viewExplicit: boolean;
    date: string;
    newContact: NewAppointmentDefaults["contact"] | null;
    openId?: string | null;
    /** Phase B: the branch the diary opens on (the switcher's choice, home or only branch). */
    locationId?: string | null;
    /** Phase C: the doctor the calendar view opens on (from the Doctors directory). */
    specialistId?: string | null;
  };
}) {
  const [view, setView] = React.useState<View>(initial.view);
  // Phones open on the agenda list (a week grid is unreadable there) unless a view was asked for in the URL.
  const phone = useIsPhone();
  const appliedPhoneDefault = React.useRef(false);
  React.useEffect(() => {
    if (phone && !initial.viewExplicit && !appliedPhoneDefault.current) {
      appliedPhoneDefault.current = true;
      setView("agenda");
    }
  }, [phone, initial.viewExplicit]);
  const [date, setDate] = React.useState(initial.date);
  const [locationId, setLocationId] = React.useState(
    initial.locationId ?? bootstrap.locations[0]?.id ?? "",
  );
  const [calendarSpecialistId, setCalendarSpecialistId] = React.useState(
    initial.specialistId ?? "",
  );
  const [reloadKey, setReloadKey] = React.useState(0);
  const [openAppt, setOpenAppt] = React.useState<string | null>(initial.openId ?? null);
  const [drawer, setDrawer] = React.useState<{ open: boolean; defaults: NewAppointmentDefaults }>(
    initial.newContact
      ? { open: true, defaults: { contact: initial.newContact, date: initial.date } }
      : { open: false, defaults: {} },
  );
  const [appts, setAppts] = React.useState<ApptRow[]>([]);
  const [blocks, setBlocks] = React.useState<BlockRow[]>([]);
  const [loading, setLoading] = React.useState(false);

  const location = bootstrap.locations.find((l) => l.id === locationId);
  const tz = location?.timezone ?? bootstrap.timezone;
  const specialistsHere = bootstrap.specialists.filter((s) => s.location_ids.includes(locationId));
  const calendarSpecialist =
    specialistsHere.find((s) => s.id === calendarSpecialistId) ?? specialistsHere[0] ?? null;

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);
  const [confirm, confirmDialog] = useConfirm();
  // Phase E: drag-and-drop tells the patient (Rescheduled template) unless switched off; without the template it cannot.
  const canTell = !!bootstrap.rules.templates.rescheduled;
  const [dragNotify, setDragNotify] = React.useState(canTell);

  /**
   * A drop in the day grid or the calendar. Checks what the drop means (lib/appointments/drag-move.ts), asks before
   * moving a confirmed visit whose reminder already went out, then moves through moveAppointment (move_appointment: lock
   * and capacity rule). On refusal the booking goes back where it was and the reason is shown. Resolves true when moved.
   */
  const moveByDrag = React.useCallback(
    async (a: ApptRow, specialistId: string, startIso: string): Promise<boolean> => {
      const notify = canTell && dragNotify;
      const decision = dragMoveDecision(a, { startIso, specialistId }, new Date(), notify);
      if (decision.kind === "same") return false;
      if (decision.kind === "refuse") {
        toast.error(decision.reason);
        return false;
      }
      if (decision.kind === "confirm") {
        const ok = await confirm({
          title: decision.title,
          description: decision.description,
          confirmLabel: "Move appointment",
        });
        if (!ok) return false;
      }
      const duration = new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime();
      const before = a;
      // Shown at the new place straight away; put back if the database refuses.
      setAppts((list) =>
        list.map((x) =>
          x.id === a.id
            ? {
                ...x,
                specialist_id: specialistId,
                starts_at: startIso,
                ends_at: new Date(new Date(startIso).getTime() + duration).toISOString(),
              }
            : x,
        ),
      );
      const res = await moveAppointment({
        id: a.id,
        startsAt: startIso,
        specialistId,
        locationId: a.location_id ?? undefined,
        notify,
      });
      if (!res.ok) {
        setAppts((list) => list.map((x) => (x.id === before.id ? before : x)));
        toast.error(`Not moved: ${res.error}`);
        return false;
      }
      toast.success(res.message ?? "Appointment moved.");
      if (notify && res.data && !res.data.notified && res.data.notifyError)
        toast.warning(`Patient not told: ${res.data.notifyError}`);
      reload();
      return true;
    },
    [canTell, dragNotify, confirm, reload],
  );

  // Resource day data
  React.useEffect(() => {
    if (view !== "day" || !locationId) return;
    let cancelled = false;
    setLoading(true);
    void listRange({ from: date, to: date, locationId }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok && res.data) {
        setAppts(res.data.appointments);
        setBlocks(res.data.blocks);
      } else if (!res.ok) toast.error(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [view, date, locationId, reloadKey]);

  function openNew(defaults: NewAppointmentDefaults) {
    if (!bootstrap.can.manage) return;
    setDrawer({ open: true, defaults: { locationId, date, ...defaults } });
  }

  const today = localDate(new Date(), tz);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Appointments"
        description="Diaries, bookings and reminders for every location."
      >
        {bootstrap.can.manage && (
          <Button onClick={() => openNew({})}>
            <CalendarPlus /> New appointment
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={view}
          onValueChange={(v) => setView(v as View)}
          className="max-w-full overflow-x-auto"
        >
          <TabsList>
            <TabsTrigger value="day">Resource day</TabsTrigger>
            <TabsTrigger value="week">Branch week</TabsTrigger>
            <TabsTrigger value="calendar">Specialist calendar</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="agenda">Agenda</TabsTrigger>
          </TabsList>
        </Tabs>

        {view !== "table" && (
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="w-44" aria-label="Location">
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              {bootstrap.locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {view === "day" && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous day"
              onClick={() => setDate(shiftDate(date, -1))}
            >
              <ChevronLeft />
            </Button>
            <Input
              type="date"
              className="w-40"
              value={date}
              aria-label="Day"
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Next day"
              onClick={() => setDate(shiftDate(date, 1))}
            >
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
              Today
            </Button>
            <span className="text-muted-foreground ml-2 hidden text-sm lg:inline">
              {dayLabel(date)}
            </span>
          </div>
        )}

        {view === "week" && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous week"
              onClick={() => setDate(shiftDate(date, -7))}
            >
              <ChevronLeft />
            </Button>
            <Input
              type="date"
              className="w-40"
              value={date}
              aria-label="A day in the week"
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Next week"
              onClick={() => setDate(shiftDate(date, 7))}
            >
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
              This week
            </Button>
            <span className="text-muted-foreground ml-2 hidden text-sm lg:inline">
              {(() => {
                const w = weekDates(date);
                return w.length ? `${dayLabel(w[0])} to ${dayLabel(w[6])}` : "";
              })()}
            </span>
          </div>
        )}

        {(view === "day" || view === "calendar") && bootstrap.can.manage && (
          <label
            className="text-muted-foreground flex items-center gap-2 text-xs"
            title={
              canTell
                ? "When you drag an appointment to a new time"
                : "Map a Rescheduled template under Settings, Appointments first"
            }
          >
            <Switch
              checked={canTell && dragNotify}
              onCheckedChange={setDragNotify}
              disabled={!canTell}
              aria-label="Tell the patient when an appointment is dragged to a new time"
            />
            Tell the patient when I drag
          </label>
        )}

        {view === "calendar" && specialistsHere.length > 0 && (
          <Select value={calendarSpecialist?.id ?? ""} onValueChange={setCalendarSpecialistId}>
            <SelectTrigger className="w-52" aria-label="Specialist">
              <SelectValue placeholder="Specialist" />
            </SelectTrigger>
            <SelectContent>
              {specialistsHere.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {bootstrap.locations.length === 0 && view !== "table" ? (
        <EmptyState
          icon={MapPin}
          title="No branches to book at yet"
          description="Add the clinic's locations, the services patients can book and the doctors with their hours (Settings, Appointments) to start booking."
          action={
            bootstrap.can.settings && (
              <Button asChild size="sm">
                <Link href="/settings/appointments?tab=locations">Set up appointments</Link>
              </Button>
            )
          }
        />
      ) : view === "day" ? (
        <div className={loading ? "opacity-60 transition-opacity" : undefined}>
          <ResourceGrid
            date={date}
            timezone={tz}
            locationId={locationId}
            specialists={specialistsHere}
            appointments={appts}
            blocks={blocks}
            workingWeekdays={bootstrap.rules.working_weekdays}
            holidays={bootstrap.rules.holidays}
            granularity={bootstrap.rules.slot_granularity_min}
            canManage={bootstrap.can.manage}
            canSettings={bootstrap.can.settings}
            onSlotClick={(specialistId, startIso) => openNew({ specialistId, startIso, date })}
            onAppointmentClick={setOpenAppt}
            onMove={bootstrap.can.manage ? moveByDrag : undefined}
            onBlockClick={async (b) => {
              if (!bootstrap.can.manage) return;
              const ok = await confirm({
                title: `Remove this block${b.reason ? ` (${b.reason})` : ""}?`,
                description: "The time becomes bookable again.",
                confirmLabel: "Remove block",
              });
              if (!ok) return;
              const res = await deleteBlock(b.id);
              if (res.ok) {
                toast.success(res.message);
                reload();
              } else toast.error(res.error);
            }}
          />
        </div>
      ) : view === "week" ? (
        <BranchWeek
          timezone={tz}
          locationId={locationId}
          specialists={specialistsHere}
          date={date}
          today={today}
          reloadKey={reloadKey}
          onAppointmentClick={setOpenAppt}
        />
      ) : view === "agenda" ? (
        <AgendaList
          timezone={tz}
          locationId={locationId}
          specialists={bootstrap.specialists}
          date={date}
          today={today}
          reloadKey={reloadKey}
          onDateChange={setDate}
          onAppointmentClick={setOpenAppt}
        />
      ) : view === "calendar" ? (
        calendarSpecialist ? (
          <SpecialistCalendar
            key={calendarSpecialist.id + locationId}
            timezone={tz}
            locationId={locationId}
            specialist={calendarSpecialist}
            initialDate={date}
            reloadKey={reloadKey}
            canManage={bootstrap.can.manage}
            onSlotClick={(specialistId, startIso) =>
              openNew({ specialistId, startIso, date: localDate(new Date(startIso), tz) })
            }
            onAppointmentClick={setOpenAppt}
            onMove={bootstrap.can.manage ? moveByDrag : undefined}
          />
        ) : (
          <EmptyState
            icon={Stethoscope}
            title="No doctors work at this location yet"
            description="A doctor appears here once they are set to work at this branch."
            action={
              bootstrap.can.settings && (
                <Button asChild size="sm">
                  <Link href="/settings/appointments?tab=doctors">Add doctors and hours</Link>
                </Button>
              )
            }
          />
        )
      ) : (
        <AppointmentsTable bootstrap={bootstrap} reloadKey={reloadKey} onRowClick={setOpenAppt} />
      )}

      {confirmDialog}
      <AppointmentDrawer
        id={openAppt}
        bootstrap={bootstrap}
        onClose={() => setOpenAppt(null)}
        onChanged={reload}
      />
      <NewAppointmentDrawer
        open={drawer.open}
        onOpenChange={(o) => setDrawer((d) => ({ ...d, open: o }))}
        bootstrap={bootstrap}
        defaults={drawer.defaults}
        onDone={reload}
      />
    </div>
  );
}
