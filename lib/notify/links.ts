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
  // The same targets as the push links (lib/notify/push-payload.ts pushUrl): the item itself, not just its list.
  const task = id(p, "task_id");
  if (task) return `/tasks?task=${task}`;
  const appointment = id(p, "appointment_id");
  if (appointment) return `/appointments?appointment=${appointment}`;
  const enquiry = id(p, "enquiry_id");
  if (enquiry) return `/enquiries?enquiry=${enquiry}`;
  if (type === "task.due" || type === "reminder.failed") return "/tasks";
  // A patient-document reminder opens the patient (ids only; the drawer shows the Documents tab).
  const contact = id(p, "contact_id");
  if (contact && type.startsWith("document.")) return `/contacts?contact=${contact}`;
  // A payment voucher opens its drawer on the vouchers page.
  const voucher = id(p, "voucher_id");
  if (voucher && type.startsWith("finance.voucher_")) return `/finance/vouchers?v=${voucher}`;
  // Finance reminders without an id open their page (same targets as the push links).
  if (type === "finance.close_due") return "/finance/close/timetable";
  if (type === "finance.followup_due") return "/finance/followup";
  if (type === "accounting.runs_prepared") return "/accounting/depreciation";
  // Management alerts (M1): the page behind the alert; the band alert opens its month (validated yyyy-mm only).
  if (type === "finance.report_late") return "/finance/upload";
  if (type === "finance.revenue_behind") return "/finance/flash";
  if (type === "finance.band_below") {
    const m =
      typeof p.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) ? p.month : null;
    return m ? `/finance/doctor-performance?month=${m}` : "/finance/doctor-performance";
  }
  return null;
}
