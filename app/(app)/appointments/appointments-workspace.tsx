"use client";

import * as React from "react";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { localDate } from "@/lib/appointments/slots";

import { deleteBlock, listRange } from "./actions";
import { AppointmentDrawer } from "./appointment-drawer";
import { AppointmentsTable } from "./appointments-table";
import { dayLabel, shiftDate } from "./format";
import { NewAppointmentDrawer, type NewAppointmentDefaults } from "./new-appointment-drawer";
import { ResourceGrid } from "./resource-grid";
import { SpecialistCalendar } from "./specialist-calendar";
import type { AppointmentsBootstrap, ApptRow, BlockRow } from "./types";

type View = "day" | "calendar" | "table";

export function AppointmentsWorkspace({
  bootstrap,
  initial,
}: {
  bootstrap: AppointmentsBootstrap;
  initial: { view: View; date: string; newContact: NewAppointmentDefaults["contact"] | null };
}) {
  const [view, setView] = React.useState<View>(initial.view);
  const [date, setDate] = React.useState(initial.date);
  const [locationId, setLocationId] = React.useState(bootstrap.locations[0]?.id ?? "");
  const [calendarSpecialistId, setCalendarSpecialistId] = React.useState("");
  const [reloadKey, setReloadKey] = React.useState(0);
  const [openAppt, setOpenAppt] = React.useState<string | null>(null);
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
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="day">Resource day</TabsTrigger>
            <TabsTrigger value="calendar">Specialist calendar</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
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
        <div className="text-muted-foreground rounded-xl border p-8 text-center text-sm">
          Set up locations, services and specialists in Settings → Appointments to start booking.
        </div>
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
            onSlotClick={(specialistId, startIso) => openNew({ specialistId, startIso, date })}
            onAppointmentClick={setOpenAppt}
            onBlockClick={(b) => {
              if (!bootstrap.can.manage) return;
              if (confirm(`Remove this block${b.reason ? ` (${b.reason})` : ""}?`))
                void deleteBlock(b.id).then((res) => {
                  if (res.ok) {
                    toast.success(res.message);
                    reload();
                  } else toast.error(res.error);
                });
            }}
          />
        </div>
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
          />
        ) : (
          <div className="text-muted-foreground rounded-xl border p-8 text-center text-sm">
            No specialists work at this location yet.
          </div>
        )
      ) : (
        <AppointmentsTable bootstrap={bootstrap} reloadKey={reloadKey} onRowClick={setOpenAppt} />
      )}

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
