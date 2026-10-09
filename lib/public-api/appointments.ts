import type { Tables } from "@/lib/supabase/types";

/**
 * Public representation of an appointment. Deliberately narrow: times, status and the ids needed to
 * look the rest up. Free-text notes, custom fields and the Unite appointment/clinic identifiers stay
 * inside the platform (notes can hold health information).
 */
export function serializeAppointment(a: Tables<"appointments">) {
  return {
    id: a.id,
    number: a.number,
    contact_id: a.contact_id,
    location_id: a.location_id,
    specialist_id: a.specialist_id,
    service_id: a.service_id,
    department_id: a.department_id,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    status: a.status,
    source: a.source,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}
