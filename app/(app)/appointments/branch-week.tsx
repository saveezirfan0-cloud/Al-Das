"use client";

import * as React from "react";
import { CalendarDays } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { toast } from "sonner";

import { EmptyState } from "@/components/shell/empty-state";
import { weekDates, weekGrid } from "@/lib/appointments/week";
import { cn } from "@/lib/utils";

import { listRange } from "./actions";
import { CheckinBadge } from "./checkin-badge";
import { STATUS_STYLES, timeLabel } from "./format";
import type { ApptRow, SpecialistOption } from "./types";

/**
 * The branch week: every doctor of the branch down the side, Monday to Sunday across, each cell that doctor's bookings
 * that day with their check-in state. Reads through listRange, which keeps to the member's branches (branchView).
 */
export function BranchWeek({
  timezone,
  locationId,
  specialists,
  date,
  today,
  reloadKey,
  onAppointmentClick,
}: {
  timezone: string;
  locationId: string;
  specialists: SpecialistOption[];
  date: string;
  today: string;
  reloadKey: number;
  onAppointmentClick: (id: string) => void;
}) {
  const days = React.useMemo(() => weekDates(date), [date]);
  const [appts, setAppts] = React.useState<ApptRow[] | null>(null);

  React.useEffect(() => {
    if (!locationId || days.length !== 7) return;
    let cancelled = false;
    setAppts(null);
    void listRange({ from: days[0], to: days[6], locationId }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setAppts(res.data.appointments);
      else if (!res.ok) {
        toast.error(res.error);
        setAppts([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locationId, days, reloadKey]);

  const rows = React.useMemo(
    () => (appts ? weekGrid(appts, specialists, days, timezone) : []),
    [appts, specialists, days, timezone],
  );

  if (specialists.length === 0)
    return (
      <EmptyState
        icon={CalendarDays}
        title="No doctors work at this branch yet"
        description="Add doctors and their working hours under Settings, Appointment rules."
      />
    );

  const head = (d: string) => {
    const [y, m, dd] = d.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, dd));
    // A fixed pattern (not toLocaleDateString), so the server and the browser render the same text.
    return { weekday: formatInTimeZone(dt, "UTC", "EEE"), day: dd };
  };

  return (
    <div
      className={cn("overflow-x-auto rounded-xl border", appts === null && "opacity-60")}
      aria-busy={appts === null}
    >
      <table className="w-full min-w-[56rem] table-fixed border-collapse text-sm">
        <caption className="sr-only">
          Appointments for the week of {days[0]}, one row per doctor
        </caption>
        <thead>
          <tr className="bg-muted/40">
            <th scope="col" className="w-40 border-b px-2 py-2 text-left text-xs font-medium">
              Doctor
            </th>
            {days.map((d) => {
              const h = head(d);
              return (
                <th
                  key={d}
                  scope="col"
                  className={cn(
                    "border-b border-l px-2 py-2 text-left text-xs font-medium",
                    d === today && "bg-primary/10",
                  )}
                  aria-current={d === today ? "date" : undefined}
                >
                  {h.weekday} {h.day}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.specialist_id ?? "other"} className="align-top">
              <th scope="row" className="border-b px-2 py-2 text-left text-xs font-medium">
                <span className="block truncate">{r.name}</span>
                <span className="text-muted-foreground font-normal">
                  {r.count} booking{r.count === 1 ? "" : "s"}
                </span>
              </th>
              {r.cells.map((cell, i) => (
                <td
                  key={days[i]}
                  className={cn("border-b border-l p-1", days[i] === today && "bg-primary/5")}
                >
                  <ul className="flex flex-col gap-1">
                    {cell.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => onAppointmentClick(a.id)}
                          className={cn(
                            "flex w-full flex-col rounded border px-1.5 py-1 text-left text-[11px] leading-tight hover:brightness-95",
                            STATUS_STYLES[a.status],
                          )}
                        >
                          <span className="flex items-center justify-between gap-1">
                            <span className="tabular-nums">{timeLabel(a.starts_at, timezone)}</span>
                            <CheckinBadge value={a.checkin_status} short />
                          </span>
                          <span className="truncate font-medium">{a.contact_name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
