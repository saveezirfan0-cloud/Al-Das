"use client";

import * as React from "react";
import dayGridPlugin from "@fullcalendar/daygrid";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { toast } from "sonner";

import { listTasks, type ListTasksInput, type TaskRow } from "./actions";

const WALL = "yyyy-MM-dd'T'HH:mm:ss";

/**
 * Tasks by due date (Phase F) on the free FullCalendar plugins, loaded on demand. Like the diary, events are fed as
 * wall-clock times in the workspace timezone and the calendar runs in "UTC" mode. Up to 200 tasks per visible range.
 */
export function TaskCalendar({
  timezone,
  filters,
  reloadKey,
  onOpen,
}: {
  timezone: string;
  filters: Omit<ListTasksInput, "from" | "to" | "page" | "pageSize" | "sort" | "dir" | "state">;
  reloadKey: number;
  onOpen: (t: TaskRow) => void;
}) {
  const ref = React.useRef<FullCalendar>(null);
  const rowsById = React.useRef(new Map<string, TaskRow>());
  const filterKey = JSON.stringify(filters);

  React.useEffect(() => {
    ref.current?.getApi().refetchEvents();
  }, [filterKey, reloadKey]);

  return (
    <div className="bg-background rounded-xl border p-3 [&_.fc]:text-sm">
      <FullCalendar
        ref={ref}
        plugins={[dayGridPlugin, timeGridPlugin]}
        timeZone="UTC"
        initialView="dayGridMonth"
        firstDay={1}
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "dayGridMonth,timeGridWeek",
        }}
        buttonText={{ today: "Today", month: "Month", week: "Week" }}
        height="auto"
        dayMaxEvents={4}
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        events={async (info, success, failure) => {
          // The visible range in wall-clock time → real instants in the workspace timezone.
          const from = fromZonedTime(info.start.toISOString().slice(0, 19), timezone).toISOString();
          const to = fromZonedTime(info.end.toISOString().slice(0, 19), timezone).toISOString();
          const r = await listTasks({ ...filters, state: "all", from, to, page: 1, pageSize: 200 });
          if (!r.ok) {
            toast.error(r.error);
            failure(new Error(r.error));
            return;
          }
          rowsById.current = new Map(r.data.rows.map((t) => [t.id, t]));
          if (r.data.total > r.data.rows.length)
            toast.info(
              `Showing the first ${r.data.rows.length} of ${r.data.total} tasks in this range.`,
            );
          success(
            r.data.rows.map((t) => ({
              id: t.id,
              title: t.subject,
              start: `${formatInTimeZone(new Date(t.due_at), timezone, WALL)}Z`,
              allDay: false,
              classNames: [t.done ? "opacity-50 line-through" : ""],
              // Urgent work stands out (white on #b42318 passes AA); everything else keeps the theme colour.
              backgroundColor: t.priority === "urgent" ? "#b42318" : undefined,
              borderColor: t.priority === "urgent" ? "#b42318" : undefined,
            })),
          );
        }}
        eventClick={(arg) => {
          const t = rowsById.current.get(arg.event.id);
          if (t) onOpen(t);
        }}
      />
    </div>
  );
}
