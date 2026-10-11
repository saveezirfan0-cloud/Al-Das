import type { Tables } from "@/lib/supabase/types";

/**
 * Public representation of an enquiry. Deliberately narrow: where it is in the pipeline and who owns
 * it, plus ids to look related records up. The title (often a patient's name), the lost/disqualified
 * reason, notes and custom fields stay inside the platform.
 */
export function serializeEnquiry(e: Tables<"enquiries">) {
  return {
    id: e.id,
    number: e.number,
    pipeline_id: e.pipeline_id,
    stage_id: e.stage_id,
    status: e.status,
    contact_id: e.contact_id,
    channel_id: e.channel_id,
    source: e.source,
    assignee_id: e.assignee_id,
    est_value: e.est_value,
    location_id: e.location_id,
    department_id: e.department_id,
    specialist_id: e.specialist_id,
    service_id: e.service_id,
    appt_date: e.appt_date,
    first_touch_at: e.first_touch_at,
    closed_at: e.closed_at,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}
