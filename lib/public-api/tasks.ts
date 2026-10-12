import type { Tables } from "@/lib/supabase/types";

/**
 * Public representation of a task. Deliberately narrow: type, due date, owner and the ids it links
 * to. The subject and notes are free text staff write about patients, so they stay inside the platform.
 */
export function serializeTask(t: Tables<"tasks">) {
  return {
    id: t.id,
    type: t.type,
    due_at: t.due_at,
    done: t.done,
    done_at: t.done_at,
    assignee_id: t.assignee_id,
    contact_id: t.contact_id,
    enquiry_id: t.enquiry_id,
    appointment_id: t.appointment_id,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}
