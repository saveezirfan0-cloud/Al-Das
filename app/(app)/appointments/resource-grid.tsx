"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { isOpenDay, isoWeekday, localMinutesToInstant } from "@/lib/appointments/slots";

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
  onSlotClick: (specialistId: string, startIso: string) => void;
  onAppointmentClick: (id: string) => void;
  onBlockClick: (block: BlockRow) => void;
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

  function clickColumn(e: React.MouseEvent<HTMLDivElement>, s: SpecialistOption) {
    if (!canManage) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = axisStart + (e.clientY - rect.top) / PX_PER_MIN;
    const minute = Math.floor(raw / granularity) * granularity;
    props.onSlotClick(s.id, localMinutesToInstant(date, minute, timezone).toISOString());
  }

  if (specialists.length === 0)
    return (
      <div className="text-muted-foreground rounded-xl border p-8 text-center text-sm">
        No specialists work at this location. Add them in Settings → Appointments.
      </div>
    );

  return (
    <div className="overflow-auto rounded-xl border">
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
                      className="absolute inset-x-1 overflow-hidden rounded border border-dashed border-zinc-400 bg-zinc-200/80 px-1.5 py-0.5 text-left text-[11px] text-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200"
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
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onAppointmentClick(a.id);
                      }}
                      className={cn(
                        "absolute inset-x-1 overflow-hidden rounded border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm hover:brightness-95",
                        STATUS_STYLES[a.status],
                      )}
                      style={{ top: (top - axisStart) * PX_PER_MIN, height: h }}
                      title={`${a.contact_name} · ${timeLabel(a.starts_at, timezone)}–${timeLabel(a.ends_at, timezone)}`}
                    >
                      <span className="block truncate font-medium">{a.contact_name}</span>
                      {h > 30 && (
                        <span className="block truncate opacity-80">
                          {timeLabel(a.starts_at, timezone)}–{timeLabel(a.ends_at, timezone)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
