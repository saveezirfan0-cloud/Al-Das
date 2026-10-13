export const TRIGGER_LABELS: Record<string, string> = {
  conversation_opened: "Conversation opened",
  conversation_closed: "Conversation closed",
  conversation_waiting: "Conversation waiting",
  template_button: "Template button reply",
  shortcut: "Shortcut (manual, from the inbox)",
  enquiry_added: "Enquiry added",
  enquiry_stage_updated: "Enquiry stage updated",
  enquiry_status_updated: "Enquiry status updated",
  webhook: "Incoming webhook",
  recurring: "Recurring schedule",
  appointment_created: "Appointment created",
  appointment_updated: "Appointment updated",
  appointment_status_changed: "Appointment status changed",
  conversation_ai_tagged: "AI tag added to a conversation (needs clinical sign-off)",
  message_received: "Message received (conversation already open)",
  window_closing: "24-hour window about to close",
  wa_flow_completed: "WhatsApp Flow form submitted",
  segment_joined: "Contact added to a segment (drip)",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
