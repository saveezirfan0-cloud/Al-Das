"use client";

import { ActionForm, Field } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import { saveRoomOpenHours } from "./actions";

export function OpenHoursForm({ hours }: { hours: number }) {
  return (
    <ActionForm action={saveRoomOpenHours} submitLabel="Save opening hours" variant="secondary">
      <Field
        label="Room open hours per open day"
        hint="Used for occupancy until branches carry their own opening hours. Open days follow the working week and holidays under Settings, Appointment rules."
        className="max-w-xs"
      >
        <Input name="room_open_hours_per_day" inputMode="decimal" defaultValue={hours} required />
      </Field>
    </ActionForm>
  );
}
