import "server-only";

import { whatsappDeclined } from "@/lib/front-desk/whatsapp-consent";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Has this contact (the person a message would go to) refused WhatsApp at the desk? A read error counts as "refused"
 * (fail closed): the message is not queued and the caller reports why.
 */
export async function recipientDeclinedWhatsApp(
  admin: AdminClient,
  orgId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("contacts")
    .select("whatsapp_declined_at")
    .eq("id", contactId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return true;
  return whatsappDeclined(data);
}
