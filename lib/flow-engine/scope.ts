import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";

export type RunRow = Tables<"flow_runs">;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function orgTimezone(admin: AdminClient, orgId: string): Promise<string> {
  const { data } = await admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle();
  return data?.timezone ?? "Asia/Dubai";
}

/**
 * What `{contact.…}`, `{enquiry.…}`, `{vars.…}` resolve against. Loaded fresh at every step (a
 * patient may have changed their name since the flow started); only the fields flows are allowed
 * to read are exposed, and objects never render in text (interpolate refuses them).
 */
export async function buildScope(
  admin: AdminClient,
  run: Pick<
    RunRow,
    "org_id" | "contact_id" | "conversation_id" | "context" | "event" | "vars" | "steps"
  >,
): Promise<{ scope: Record<string, unknown>; timezone: string }> {
  const ctx = obj(run.context);
  const event = obj(run.event);
  const enquiryId = typeof ctx.enquiry_id === "string" ? ctx.enquiry_id : null;
  const appointmentId = typeof ctx.appointment_id === "string" ? ctx.appointment_id : null;
  const messageId = typeof ctx.message_id === "string" ? ctx.message_id : null;

  const [timezone, contact, conversation, message, enquiry, appointment] = await Promise.all([
    orgTimezone(admin, run.org_id),
    run.contact_id
      ? admin
          .from("contacts")
          .select(
            "id, first_name, last_name, full_name, email, phone_e164, language, gender, nationality, source, label, promotions_opt_in, stop_marketing",
          )
          .eq("id", run.contact_id)
          .eq("org_id", run.org_id)
          .maybeSingle()
          .then((r) => r.data)
      : null,
    run.conversation_id
      ? admin
          .from("conversations")
          .select("id, status, channel_id")
          .eq("id", run.conversation_id)
          .eq("org_id", run.org_id)
          .maybeSingle()
          .then((r) => r.data)
      : null,
    (messageId
      ? admin
          .from("messages")
          .select("body, kind, at")
          .eq("id", messageId)
          .eq("org_id", run.org_id)
          .maybeSingle()
      : run.conversation_id
        ? admin
            .from("messages")
            .select("body, kind, at")
            .eq("conversation_id", run.conversation_id)
            .eq("org_id", run.org_id)
            .eq("direction", "in")
            .order("at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null })
    ).then((r) => r.data),
    enquiryId
      ? admin
          .from("enquiries")
          .select("id, number, title, status, source, stages(name), pipelines(name)")
          .eq("id", enquiryId)
          .eq("org_id", run.org_id)
          .maybeSingle()
          .then((r) => r.data)
      : null,
    appointmentId
      ? admin
          .from("appointments")
          .select(
            "id, number, status, starts_at, locations(name), specialists(name), services(name)",
          )
          .eq("id", appointmentId)
          .eq("org_id", run.org_id)
          .maybeSingle()
          .then((r) => r.data)
      : null,
  ]);

  const interactive = obj(event.interactive);
  const scope: Record<string, unknown> = {
    contact: contact ?? {},
    conversation: conversation ?? {},
    message: {
      text: message?.body ?? "",
      kind: message?.kind ?? "",
      button_id: interactive.id ?? "",
      button_title: interactive.title ?? "",
    },
    enquiry: enquiry
      ? {
          id: enquiry.id,
          number: enquiry.number,
          title: enquiry.title,
          status: enquiry.status,
          source: enquiry.source ?? "",
          stage: (enquiry.stages as { name?: string } | null)?.name ?? "",
          pipeline: (enquiry.pipelines as { name?: string } | null)?.name ?? "",
        }
      : {},
    appointment: appointment
      ? {
          id: appointment.id,
          number: appointment.number,
          status: appointment.status,
          starts_at: appointment.starts_at,
          location: (appointment.locations as { name?: string } | null)?.name ?? "",
          doctor: (appointment.specialists as { name?: string } | null)?.name ?? "",
          service: (appointment.services as { name?: string } | null)?.name ?? "",
        }
      : {},
    event,
    vars: obj(run.vars),
    steps: obj(run.steps),
  };
  return { scope, timezone };
}
