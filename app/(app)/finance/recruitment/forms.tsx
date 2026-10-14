"use client";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { CALENDAR_KIND_LABEL, CALENDAR_KINDS, type CalendarEvent } from "@/lib/finance/recruitment";

import { deleteCalendarEvent, deleteScenario, saveCalendarEvent } from "./actions";

export function CalendarEventButton({ event }: { event?: CalendarEvent }) {
  return (
    <FormSheet
      trigger={event ? "Edit" : "Add an event"}
      title={event ? "Edit calendar event" : "Add a calendar event"}
      description="Dated events shown in the recruitment calculator's seasonal note. Tick approximate until the date is announced."
      variant={event ? "ghost" : "outline"}
      size="sm"
    >
      {(close) => (
        <ActionForm action={saveCalendarEvent} onDone={close} submitLabel="Save event">
          {event && <input type="hidden" name="id" value={event.id} />}
          <Field label="Name">
            <Input name="label" defaultValue={event?.label ?? ""} maxLength={80} required />
          </Field>
          <Field label="Kind">
            <select
              name="kind"
              className={selectClass}
              defaultValue={event?.kind ?? "school_holiday"}
            >
              {CALENDAR_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CALENDAR_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First day">
              <Input type="date" name="starts_on" defaultValue={event?.startsOn ?? ""} required />
            </Field>
            <Field label="Last day">
              <Input type="date" name="ends_on" defaultValue={event?.endsOn ?? ""} required />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="approximate"
              defaultChecked={event?.approximate ?? false}
            />{" "}
            Approximate (not yet announced)
          </label>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function DeleteEventButton({ id }: { id: string }) {
  return (
    <RunButton action={() => deleteCalendarEvent(id)} confirm="Delete this event?" variant="ghost">
      Delete
    </RunButton>
  );
}

export function DeleteScenarioButton({ id }: { id: string }) {
  return (
    <RunButton
      action={() => deleteScenario(id)}
      confirm="Delete this scenario? This cannot be undone."
      variant="ghost"
    >
      Delete
    </RunButton>
  );
}
