"use client";

import { Label } from "@/components/ui/label";
import { pickable } from "@/lib/enquiries/lookups";
import type { Lookups } from "@/lib/enquiries/server";

import { OptionSelect } from "./option-select";

export type ClinicValues = {
  location_id: string | null;
  department_id: string | null;
  specialist_id: string | null;
  service_id: string | null;
};

/**
 * Location / department / specialist / service, edited together. Choosing a department
 * narrows specialists and services; changing it clears a specialist or service that no longer fits.
 */
export function ClinicFields({
  value,
  onChange,
  lookups,
  disabled,
  idPrefix,
}: {
  value: ClinicValues;
  onChange: (next: ClinicValues) => void;
  lookups: Lookups;
  disabled?: boolean;
  idPrefix: string;
}) {
  const dep = value.department_id;
  const inDepartment = <T extends { department_id: string | null }>(l: T) =>
    !dep || !l.department_id || l.department_id === dep;
  const specialists = pickable(lookups.specialists, value.specialist_id).filter(
    (s) => s.id === value.specialist_id || inDepartment(s),
  );
  const services = pickable(lookups.services, value.service_id).filter(
    (s) => s.id === value.service_id || inDepartment(s),
  );
  const locations = pickable(lookups.locations, value.location_id);
  const departments = pickable(lookups.departments, value.department_id);
  const opts = (l: Array<{ id: string; name: string }>) =>
    l.map((x) => ({ value: x.id, label: x.name }));
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-location`}>Location</Label>
        <OptionSelect
          id={`${idPrefix}-location`}
          disabled={disabled}
          value={value.location_id}
          options={opts(locations)}
          onChange={(v) => onChange({ ...value, location_id: v })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-department`}>Department</Label>
        <OptionSelect
          id={`${idPrefix}-department`}
          disabled={disabled}
          value={value.department_id}
          options={opts(departments)}
          onChange={(v) => {
            const keepSpecialist = lookups.specialists.find((s) => s.id === value.specialist_id);
            const keepService = lookups.services.find((s) => s.id === value.service_id);
            onChange({
              ...value,
              department_id: v,
              specialist_id:
                v && keepSpecialist?.department_id && keepSpecialist.department_id !== v
                  ? null
                  : value.specialist_id,
              service_id:
                v && keepService?.department_id && keepService.department_id !== v
                  ? null
                  : value.service_id,
            });
          }}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-specialist`}>Specialist</Label>
        <OptionSelect
          id={`${idPrefix}-specialist`}
          disabled={disabled}
          value={value.specialist_id}
          options={opts(specialists)}
          onChange={(v) => onChange({ ...value, specialist_id: v })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-service`}>Service</Label>
        <OptionSelect
          id={`${idPrefix}-service`}
          disabled={disabled}
          value={value.service_id}
          options={opts(services)}
          onChange={(v) => onChange({ ...value, service_id: v })}
        />
      </div>
    </>
  );
}
