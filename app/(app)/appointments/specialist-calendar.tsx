"use client";

import * as React from "react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { EventContentArg, EventDropArg, EventInput } from "@fullcalendar/core";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { toast } from "sonner";

import { listRange } from "./actions";
import { CheckinBadge } from "./checkin-badge";
import { STATUS_STYLES } from "./format";
import { minutesToTime } from "../settings/appointments/shared";
import type { ApptRow, SpecialistOption } from "./types";

const WALL = "yyyy-MM-dd'T'HH:mm:ss";

type Props = {
  timezone: string;
  locationId: string;
  specialist: SpecialistOption;
  initialDate: string;
  reloadKey: number;
  canManage: boolean;
  onSlotClick: (specialistId: string, startIso: string) => void;
  onAppointmentClick: (id: string) => void;
  /**
   * Phase E: a dropped appointment. Resolves true when it moved; false puts it back where it was (refused, cancelled
   * at the confirmation, or the slot was taken).
   */
  onMove?: (appointment: ApptRow, specialistId: string, startIso: string) => Promise<boolean>;
};

/** Pulse bookings still to come and not checked in can be dragged; Unite rows and closed visits cannot. */
function movable(a: ApptRow): boolean {
  return (
    a.source !== "unite" &&
    (a.status === "awaiting" || a.status === "confirmed") &&
    !a.checkin_status
  );
}

/**
 * Specialist day / week / month view on free FullCalendar plugins. Named timezones need an extra
 * date adapter, so events are fed as wall-clock times at the location and the calendar runs in
 * "UTC" mode; clicks are converted back to real instants with the location timezone.
 */
export function SpecialistCalendar(props: Props) {
  const { timezone, locationId, specialist } = props;
  const ref = React.useRef<FullCalendar>(null);

  React.useEffect(() => {
    ref.current?.getApi().refetchEvents();
  }, [specialist.id, locationId, props.reloadKey]);

  const businessHours = specialist.working_hours
    .filter((h) => h.location_id === locationId)
    .map((h) => ({
      daysOfWeek: [h.weekday % 7],
      startTime: minutesToTime(h.start_min),
      endTime: minutesToTime(h.end_min),
    }));

  const wallToInstant = (d: Date) =>
    fromZonedTime(d.toISOString().slice(0, 19), timezone).toISOString();

  async function drop(info: EventDropArg) {
    const appt = info.event.extendedProps.appt as ApptRow | undefined;
    if (!appt || !info.event.start || !props.onMove) {
      info.revert();
      return;
    }
    const moved = await props.onMove(appt, specialist.id, wallToInstant(info.event.start));
    if (!moved) info.revert();
    else ref.current?.getApi().refetchEvents();
  }

  function content(arg: EventContentArg) {
    if (arg.event.extendedProps.kind !== "appointment") return true;
    const appt = arg.event.extendedProps.appt as ApptRow;
    return (
      <div className="flex min-w-0 flex-col overflow-hidden px-0.5 text-[11px] leading-tight">
        <span className="flex items-center gap-1">
          <span className="tabular-nums">{arg.timeText}</span>
          <CheckinBadge value={appt.checkin_status} short />
        </span>
        <span className="truncate font-medium">{arg.event.title}</span>
      </div>
    );
  }

  return (
    <div className="bg-background rounded-xl border p-3 [&_.fc]:text-sm">
      <FullCalendar
        ref={ref}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        timeZone="UTC"
        initialView="timeGridWeek"
        initialDate={props.initialDate}
        firstDay={1}
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "dayGridMonth,timeGridWeek,timeGridDay",
        }}
        buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day" }}
        height="auto"
        nowIndicator
        allDaySlot={false}
        slotMinTime="07:00:00"
        slotMaxTime="21:00:00"
        slotDuration="00:30:00"
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        businessHours={businessHours}
        selectable={false}
        // Phase E: drag a booking to another time; the move goes through move_appointment and is put back if refused.
        editable={props.canManage && !!props.onMove}
        eventDurationEditable={false}
        eventContent={content}
        eventDrop={(info) => void drop(info)}
        events={async (info, success, failure) => {
          const from = info.start.toISOString().slice(0, 10);
          const to = new Date(info.end.getTime() - 1).toISOString().slice(0, 10);
          const res = await listRange({
            from,
            to,
            specialistId: specialist.id,
            tzLocationId: locationId,
          });
          if (!res.ok || !res.data) {
            toast.error(res.ok ? "Could not load appointments." : res.error);
            failure(new Error("load failed"));
            return;
          }
          const events: EventInput[] = [
            ...res.data.appointments.map((a) => ({
              id: a.id,
              title: a.contact_name,
              start: formatInTimeZone(new Date(a.starts_at), timezone, WALL),
              end: formatInTimeZone(new Date(a.ends_at), timezone, WALL),
              classNames: ["border", ...STATUS_STYLES[a.status].split(" ")],
              startEditable: props.canManage && movable(a),
              extendedProps: { kind: "appointment", appt: a },
            })),
            ...res.data.blocks.map((b) => ({
              id: `block-${b.id}`,
              title: b.reason || "Blocked",
              start: formatInTimeZone(new Date(b.starts_at), timezone, WALL),
              end: formatInTimeZone(new Date(b.ends_at), timezone, WALL),
              display: "background" as const,
              color: "#a1a1aa",
              editable: false,
            })),
          ];
          success(events);
        }}
        eventClick={(arg) => {
          if (arg.event.extendedProps.kind === "appointment")
            props.onAppointmentClick(arg.event.id);
        }}
        dateClick={(arg) => {
          if (!props.canManage) return;
          const api = ref.current?.getApi();
          if (arg.view.type === "dayGridMonth") {
            api?.changeView("timeGridDay", arg.date);
            return;
          }
          props.onSlotClick(specialist.id, wallToInstant(arg.date));
        }}
      />
    </div>
  );
}
