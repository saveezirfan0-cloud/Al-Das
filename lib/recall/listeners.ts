import "server-only";

import { on } from "@/lib/events/emit";
import { attributeBooking, attributeInboundReply } from "@/lib/recall/attribution";
import { createAdminClient } from "@/lib/supabase/admin";

/** Recall attribution runs on domain events. Two small DB writes; failures are logged by the emitter. */
let registered = false;
export function registerRecallListeners(): void {
  if (registered) return;
  registered = true;
  on("message.received", async (e) => {
    const contactId = e.payload.contact_id as string | undefined;
    const messageId = e.payload.message_id as string | undefined;
    if (!contactId || !messageId) return;
    const admin = createAdminClient();
    const { data: msg } = await admin.from("messages").select("body, kind").eq("id", messageId).maybeSingle();
    await attributeInboundReply(admin, { orgId: e.orgId, contactId, messageId, body: msg?.body ?? null, kind: msg?.kind ?? String(e.payload.kind ?? "text"), at: e.at });
  });
  on("appointment.created", async (e) => {
    const contactId = e.payload.contact_id as string | undefined;
    if (!contactId) return;
    await attributeBooking(createAdminClient(), { orgId: e.orgId, contactId, appointmentId: (e.payload.appointment_id as string | undefined) ?? null, at: e.at });
  });
}
registerRecallListeners();
