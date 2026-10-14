"use client";

import { ActionForm, Field, selectClass } from "@/components/finance/forms";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { linkDoctorKey, saveRoomOpenHours, unlinkDoctorKey } from "./actions";

/** One Unite report doctor without a Pulse doctor: pick the doctor and link. */
export function LinkKeyForm({
  doctorKey,
  doctorName,
  specialists,
}: {
  doctorKey: string;
  doctorName: string;
  specialists: { id: string; name: string }[];
}) {
  return (
    <ActionForm
      action={linkDoctorKey}
      submitLabel="Link"
      variant="secondary"
      className="sm:flex-row sm:items-end"
    >
      <input type="hidden" name="doctor_key" value={doctorKey} />
      <Field label={`Pulse doctor for ${doctorName}`} className="sm:min-w-64">
        <select name="specialist_id" className={selectClass} defaultValue="" required>
          <option value="" disabled>
            Choose…
          </option>
          {specialists.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
    </ActionForm>
  );
}

export function UnlinkButton({ doctorKey, label }: { doctorKey: string; label: string }) {
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm">
          Unlink
        </Button>
      }
      title={`Unlink ${label}?`}
      description="Its revenue stops counting for the Pulse doctor until it is linked again."
      confirmLabel="Unlink"
      onConfirm={() => unlinkDoctorKey(doctorKey)}
    />
  );
}

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
