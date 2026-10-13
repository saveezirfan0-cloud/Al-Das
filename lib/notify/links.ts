/** Where a notification in the centre should take you. Pure; only validated ids reach the URL. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function id(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
}

export function notificationHref(type: string, payload: unknown): string | null {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const conversation = id(p, "conversation_id");
  if (conversation) return `/inbox?c=${conversation}`;
  const enquiry = id(p, "enquiry_id");
  if (enquiry) return `/enquiries?enquiry=${enquiry}`;
  if (id(p, "task_id") || type === "task.due" || type === "reminder.failed") return "/tasks";
  if (id(p, "appointment_id")) return "/appointments";
  // A patient-document reminder opens the patient (ids only; the drawer shows the Documents tab).
  const contact = id(p, "contact_id");
  if (contact && type.startsWith("document.")) return `/contacts?contact=${contact}`;
  // A payment voucher opens its drawer on the vouchers page.
  const voucher = id(p, "voucher_id");
  if (voucher && type.startsWith("finance.voucher_")) return `/finance/vouchers?v=${voucher}`;
  return null;
}
