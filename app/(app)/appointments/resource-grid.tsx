"use client";

import Link from "next/link";
import * as React from "react";
import { Stethoscope } from "lucide-react";

import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DRAG_THRESHOLD_PX, snapMinute } from "@/lib/appointments/drag-move";
import { isOpenDay, isoWeekday, localMinutesToInstant } from "@/lib/appointments/slots";

import { CheckinBadge } from "./checkin-badge";
import { CONFLICT_TEXT, ConflictIcon } from "./conflict-badge";
import { localMinutes, STATUS_STYLES, timeLabel } from "./format";
import type { ApptRow, BlockRow, SpecialistOption } from "./types";

const PX_PER_MIN = 1.1;
const DEFAULT_START = 8 * 60;
const DEFAULT_END = 20 * 60;

type Props = {
  date: string;
  timezone: string;
  locationId: string | null;
  specialists: SpecialistOption[];
  appointments: ApptRow[];
  blocks: BlockRow[];
  workingWeekdays: number[];
  holidays: string[];
  granularity: number;
  canManage: boolean;
  /** May open Settings, Appointments: the empty state links there. */
  canSettings?: boolean;
  onSlotClick: (specialistId: string, startIso: string) => void;
  onAppointmentClick: (id: string) => void;
  onBlockClick: (block: BlockRow) => void;
  /**
   * Phase E: drag-and-drop move (mouse or pen). Called with the proposed doctor and start; the workspace decides,
   * asks when needed and moves through move_appointment (lock and capacity rule), putting it back on refusal.
   */
  onMove?: (appointment: ApptRow, specialistId: string, startIso: string) => void;
};

/** Can this booking be dragged? Pulse bookings that are still to come and not checked in. */
function draggable(a: ApptRow): boolean {
  return (
    a.source !== "unite" &&
    (a.status === "awaiting" || a.status === "confirmed") &&
    !a.checkin_status
  );
}

type Press = {
  appt: ApptRow;
  pointerId: number;
  x: number;
  y: number;
  /** Minutes between the top of the block and where it was grabbed. */
  grabMin: number;
  durationMin: number;
  dragging: boolean;
};

/**
 * Resource day view: one column per specialist, working hours shaded, appointments and time
 * blocks positioned by their local clock time at the location.
 */
export function ResourceGrid(props: Props) {
  const {
    date,
    timezone,
    locationId,
    specialists,
    appointments,
    blocks,
    workingWeekdays,
    holidays,
    granularity,
    canManage,
    onMove,
  } = props;
  const open = isOpenDay(date, workingWeekdays, holidays);
  const weekday = isoWeekday(date);

  const hoursFor = (s: SpecialistOption) =>
    s.working_hours.filter(
      (h) => h.weekday === weekday && (!locationId || h.location_id === locationId),
    );

  // Time axis spans the earliest/latest working hour or booking that day, snapped to whole hours.
  const { axisStart, axisEnd } = React.useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    if (open)
      for (const s of specialists)
        for (const h of hoursFor(s)) {
          lo = Math.min(lo, h.start_min);
          hi = Math.max(hi, h.end_min);
        }
    for (const a of appointments) {
      lo = Math.min(lo, localMinutes(a.starts_at, timezone));
      hi = Math.max(hi, localMinutes(a.ends_at, timezone) || 1440);
    }
    if (!Number.isFinite(lo)) return { axisStart: DEFAULT_START, axisEnd: DEFAULT_END };
    return {
      axisStart: Math.floor(lo / 60) * 60,
      axisEnd: Math.min(1440, Math.ceil(hi / 60) * 60),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specialists, appointments, open, weekday, locationId, timezone]);

  const height = (axisEnd - axisStart) * PX_PER_MIN;
  const hourMarks: number[] = [];
  for (let m = axisStart; m < axisEnd; m += 60) hourMarks.push(m);

  // Phase E: drag-and-drop. A press becomes a drag after a few pixels; the drop proposes the doctor under the pointer
  // and the time snapped to the slot length. The click that ends a drag never opens the appointment.
  const press = React.useRef<Press | null>(null);
  const swallowClick = React.useRef(false);
  const [ghost, setGhost] = React.useState<{
    id: string;
    specialistId: string;
    minute: number;
    durationMin: number;
  } | null>(null);

  React.useEffect(() => {
    function locate(clientX: number, clientY: number, p: Press) {
      const col = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-specialist-col]");
      if (!col?.dataset.specialistCol) return null;
      const rect = col.getBoundingClientRect();
      const raw = axisStart + (clientY - rect.top) / PX_PER_MIN - p.grabMin;
      return {
        specialistId: col.dataset.specialistCol,
        minute: snapMinute(raw, granularity, axisStart, axisEnd, p.durationMin),
      };
    }
    function move(e: PointerEvent) {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      p.dragging = true;
      const at = locate(e.clientX, e.clientY, p);
      setGhost(at ? { id: p.appt.id, ...at, durationMin: p.durationMin } : null);
    }
    function up(e: PointerEvent) {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      press.current = null;
      setGhost(null);
      if (!p.dragging) return;
      swallowClick.current = true;
      // The click that follows a drag (if any) is swallowed once; clear it soon in case none comes.
      window.setTimeout(() => (swallowClick.current = false), 300);
      const at = locate(e.clientX, e.clientY, p);
      if (at && onMove)
        onMove(
          p.appt,
          at.specialistId,
          localMinutesToInstant(date, at.minute, timezone).toISOString(),
        );
    }
    function cancel() {
      press.current = null;
      setGhost(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [axisStart, axisEnd, granularity, date, timezone, onMove]);

  const canDrag = (a: ApptRow) => canManage && !!onMove && draggable(a);

  function startPress(e: React.PointerEvent<HTMLButtonElement>, a: ApptRow) {
    // Touch keeps scrolling the grid; the drawer's Reschedule is the way to move on a phone or with the keyboard.
    if (!canDrag(a) || e.button !== 0 || e.pointerType === "touch") return;
    const rect = e.currentTarget.getBoundingClientRect();
    press.current = {
      appt: a,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      grabMin: (e.clientY - rect.top) / PX_PER_MIN,
      durationMin: Math.max(
        granularity,
        Math.round((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60_000),
      ),
      dragging: false,
    };
  }

  function clickColumn(e: React.MouseEvent<HTMLDivElement>, s: SpecialistOption) {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (!canManage) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = axisStart + (e.clientY - rect.top) / PX_PER_MIN;
    const minute = Math.floor(raw / granularity) * granularity;
    props.onSlotClick(s.id, localMinutesToInstant(date, minute, timezone).toISOString());
  }

  if (specialists.length === 0)
    return (
      <EmptyState
        icon={Stethoscope}
        title="No doctors work at this location yet"
        description="A doctor appears here once they are set to work at this branch (Settings, Appointments, Doctors and hours)."
        action={
          props.canSettings && (
            <Button asChild size="sm">
              <Link href="/settings/appointments?tab=doctors">Add doctors and hours</Link>
            </Button>
          )
        }
      />
    );

  return (
    <div className={cn("overflow-auto rounded-xl border", ghost && "select-none")}>
      {!open && (
        <div className="bg-muted text-muted-foreground border-b px-3 py-2 text-xs">
          The clinic is closed on this day (working week or holiday settings).
        </div>
      )}
      <div className="flex min-w-fit">
        <div className="bg-background sticky left-0 z-20 w-14 shrink-0 border-r">
          <div className="h-12 border-b" />
          <div className="relative" style={{ height }}>
            {hourMarks.map((m) => (
              <div
                key={m}
                className="text-muted-foreground absolute right-1 -translate-y-1/2 text-[11px] tabular-nums"
                style={{ top: (m - axisStart) * PX_PER_MIN }}
              >
                {String(m / 60).padStart(2, "0")}:00
              </div>
            ))}
          </div>
        </div>
        {specialists.map((s) => {
          const mine = appointments.filter((a) => a.specialist_id === s.id);
          const myBlocks = blocks.filter((b) => b.specialist_id === s.id);
          const windows = open ? hoursFor(s) : [];
          return (
            <div key={s.id} className="min-w-44 flex-1 border-r last:border-r-0">
              <div className="bg-background sticky top-0 z-10 flex h-12 flex-col justify-center border-b px-2">
                <span className="truncate text-sm font-medium">{s.name}</span>
                {s.title && (
                  <span className="text-muted-foreground truncate text-[11px]">{s.title}</span>
                )}
              </div>
              <div
                className={cn("relative", canManage && "cursor-cell")}
                style={{ height }}
                onClick={(e) => clickColumn(e, s)}
                role="presentation"
                data-specialist-col={s.id}
              >
                {/* off-hours background; working windows punched out below */}
                <div className="bg-muted/60 absolute inset-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgba(0,0,0,0.04)_6px_12px)]" />
                {windows.map((h, i) => (
                  <div
                    key={i}
                    className="bg-background absolute inset-x-0"
                    style={{
                      top: (Math.max(h.start_min, axisStart) - axisStart) * PX_PER_MIN,
                      height:
                        (Math.min(h.end_min, axisEnd) - Math.max(h.start_min, axisStart)) *
                        PX_PER_MIN,
                    }}
                  />
                ))}
                {hourMarks.map((m) => (
                  <div
                    key={m}
                    className="border-border/60 absolute inset-x-0 border-t"
                    style={{ top: (m - axisStart) * PX_PER_MIN }}
                  />
                ))}
                {myBlocks.map((b) => {
                  const top = Math.max(localMinutes(b.starts_at, timezone), axisStart);
                  const end = Math.min(localMinutes(b.ends_at, timezone) || 1440, axisEnd);
                  if (end <= top) return null;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onBlockClick(b);
                      }}
                      className="absolute inset-x-1 overflow-hidden rounded border border-dashed border-zinc-400 bg-zinc-200/80 px-1.5 py-0.5 text-left text-[11px] text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800/80 dark:text-zinc-200"
                      style={{
                        top: (top - axisStart) * PX_PER_MIN,
                        height: (end - top) * PX_PER_MIN - 1,
                      }}
                    >
                      {b.reason || "Blocked"}
                    </button>
                  );
                })}
                {mine.map((a) => {
                  const top = Math.max(localMinutes(a.starts_at, timezone), axisStart);
                  const end = Math.min(localMinutes(a.ends_at, timezone) || 1440, axisEnd);
                  if (end <= top) return null;
                  const h = (end - top) * PX_PER_MIN - 1;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onPointerDown={(e) => startPress(e, a)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (swallowClick.current) {
                          swallowClick.current = false;
                          return;
                        }
                        props.onAppointmentClick(a.id);
                      }}
                      className={cn(
                        "absolute inset-x-1 overflow-hidden rounded border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm hover:brightness-95",
                        STATUS_STYLES[a.status],
                        canDrag(a) && "cursor-grab active:cursor-grabbing",
                        ghost?.id === a.id && "opacity-50",
                      )}
                      style={{ top: (top - axisStart) * PX_PER_MIN, height: h }}
                      title={`${a.contact_name} · ${timeLabel(a.starts_at, timezone)}–${timeLabel(a.ends_at, timezone)}${a.conflict ? ` · ${CONFLICT_TEXT[a.conflict]}` : ""}${canDrag(a) ? " · drag to move" : ""}`}
                    >
                      <span className="flex items-center gap-1">
                        <ConflictIcon conflict={a.conflict} className="[&_svg]:size-3" />
                        <span className="block truncate font-medium">{a.contact_name}</span>
                      </span>
                      {h > 30 && (
                        <span className="block truncate opacity-80">
                          {timeLabel(a.starts_at, timezone)}–{timeLabel(a.ends_at, timezone)}
                        </span>
                      )}
                      {a.checkin_status && (
                        <CheckinBadge
                          value={a.checkin_status}
                          short={h <= 30}
                          className={h <= 30 ? "absolute top-0.5 right-0.5" : "mt-0.5"}
                        />
                      )}
                    </button>
                  );
                })}
                {ghost && ghost.specialistId === s.id && (
                  <div
                    aria-hidden
                    className="border-primary bg-primary/10 text-foreground pointer-events-none absolute inset-x-1 z-10 rounded border-2 border-dashed px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
                    style={{
                      top: (ghost.minute - axisStart) * PX_PER_MIN,
                      height: ghost.durationMin * PX_PER_MIN - 1,
                    }}
                  >
                    {String(Math.floor(ghost.minute / 60)).padStart(2, "0")}:
                    {String(ghost.minute % 60).padStart(2, "0")}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
