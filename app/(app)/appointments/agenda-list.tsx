"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Phone, PhoneOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { localDate } from "@/lib/appointments/slots";
import { cn } from "@/lib/utils";

import { listRange } from "./actions";
import { ConflictIcon } from "./conflict-badge";
import { dayLabel, shiftDate, STATUS_STYLES, timeLabel } from "./format";
import type { ApptRow, SpecialistOption } from "./types";

const DAYS = 7;

/**
 * Appointments as a plain list grouped by day: the phone default, where a week grid is unreadable. Same data
 * and the same drawer as the other views (tap a row to open it).
 */
export function AgendaList({
  timezone,
  locationId,
  specialists,
  date,
  today,
  reloadKey,
  onDateChange,
  onAppointmentClick,
}: {
  timezone: string;
  locationId: string;
  specialists: SpecialistOption[];
  date: string;
  today: string;
  reloadKey: number;
  onDateChange: (date: string) => void;
  onAppointmentClick: (id: string) => void;
}) {
  const [appts, setAppts] = React.useState<ApptRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const to = shiftDate(date, DAYS - 1);

  React.useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    setLoading(true);
    void listRange({ from: date, to, locationId }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok && res.data) setAppts(res.data.appointments);
      else if (!res.ok) toast.error(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [date, to, locationId, reloadKey]);

  const byDay = React.useMemo(() => {
    const map = new Map<string, ApptRow[]>();
    for (let i = 0; i < DAYS; i++) map.set(shiftDate(date, i), []);
    for (const a of appts) {
      const key = localDate(new Date(a.starts_at), timezone);
      map.get(key)?.push(a);
    }
    return [...map.entries()];
  }, [appts, date, timezone]);

  const specialistName = (id: string | null) => specialists.find((s) => s.id === id)?.name ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-busy={loading}>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous week"
          onClick={() => onDateChange(shiftDate(date, -DAYS))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next week"
          onClick={() => onDateChange(shiftDate(date, DAYS))}
        >
          <ChevronRight />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onDateChange(today)}>
          Today
        </Button>
        <span className="text-muted-foreground ml-2 truncate text-xs">
          {date} to {to}
        </span>
      </div>

      <div className={cn("flex flex-col gap-4", loading && "opacity-60 transition-opacity")}>
        {byDay.map(([day, rows]) => (
          <section key={day} aria-label={dayLabel(day)}>
            <h3
              className={cn(
                "bg-background sticky top-0 z-10 flex items-baseline justify-between border-b py-1.5 text-sm font-semibold",
                day === today && "text-primary",
              )}
            >
              <span>
                {dayLabel(day).replace(/ \d{4}$/, "")}
                {day === today && " · today"}
              </span>
              <span className="text-muted-foreground text-xs font-normal">
                {rows.length === 0 ? "free" : `${rows.length} booked`}
              </span>
            </h3>
            {rows.length > 0 && (
              <ul className="divide-y">
                {rows.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onAppointmentClick(a.id)}
                      className="hover:bg-accent/50 flex min-h-14 w-full items-center gap-3 py-2 text-left"
                    >
                      <span className="w-24 shrink-0 text-sm tabular-nums">
                        {timeLabel(a.starts_at, timezone)}
                        <span className="text-muted-foreground">
                          {" "}
                          – {timeLabel(a.ends_at, timezone)}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{a.contact_name}</span>
                        <span className="text-muted-foreground block truncate text-xs">
                          #{a.number}
                          {specialistName(a.specialist_id)
                            ? ` · ${specialistName(a.specialist_id)}`
                            : ""}
                        </span>
                      </span>
                      <ConflictIcon conflict={a.conflict} />
                      {a.reminder === "failed" && (
                        <PhoneOff
                          className="size-4 shrink-0 text-rose-600"
                          aria-label="Reminder failed"
                        />
                      )}
                      {a.reminder === "sent" && (
                        <Phone
                          className="text-muted-foreground size-4 shrink-0"
                          aria-label="Reminder sent"
                        />
                      )}
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1.5 py-0.5 text-[11px] capitalize",
                          STATUS_STYLES[a.status],
                        )}
                      >
                        {a.status.replace("_", " ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
