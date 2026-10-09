import type { AppointmentSettings } from "@/lib/appointments/settings";
import type { AppointmentStatus } from "@/lib/appointments/status";

export type ReminderSummary = "scheduled" | "sent" | "failed" | "excluded" | "cancelled" | null;

/** One appointment as the UI needs it (joined names, no raw foreign rows). */
export type ApptRow = {
  id: string;
  number: number;
  contact_id: string | null;
  contact_name: string;
  phone: string | null;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  location_id: string | null;
  specialist_id: string | null;
  service_id: string | null;
  department_id: string | null;
  channel_name: string | null;
  source: string;
  external_id: string | null;
  notes: string | null;
  notify_early: boolean;
  created_at: string;
  reminder: ReminderSummary;
};

export type BlockRow = {
  id: string;
  specialist_id: string;
  location_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
};

export type SpecialistOption = {
  id: string;
  name: string;
  title: string | null;
  department_id: string | null;
  location_ids: string[];
  service_ids: string[];
  working_hours: Array<{
    location_id: string;
    weekday: number;
    start_min: number;
    end_min: number;
  }>;
};

export type AppointmentsBootstrap = {
  timezone: string;
  today: string;
  can: { manage: boolean; export: boolean; contacts: boolean };
  locations: Array<{ id: string; name: string; timezone: string }>;
  departments: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string; duration_min: number; department_id: string | null }>;
  specialists: SpecialistOption[];
  rules: Pick<
    AppointmentSettings,
    "working_weekdays" | "holidays" | "auto_confirm" | "slot_granularity_min"
  > & { templates: AppointmentSettings["templates"] };
  gridPrefs: {
    columns: Array<{ id: string; width?: number; hidden?: boolean }>;
    pageSize?: number;
  } | null;
};

export type SlotOption = { start: string; label: string };

export type ListQuery = {
  from?: string; // YYYY-MM-DD (org timezone), inclusive
  to?: string; // YYYY-MM-DD, inclusive
  locationId?: string;
  specialistId?: string;
  serviceId?: string;
  status?: string[];
  source?: string;
  q?: string;
  sort?: { field: "starts_at" | "number" | "status" | "created_at"; dir: "asc" | "desc" };
  page?: number;
  pageSize?: number;
};

export type ApptDetail = {
  appointment: ApptRow;
  reminders: Array<{
    idx: number;
    status: string;
    due_at: string;
    sent_at: string | null;
    exclusion_reason: string | null;
    error: string | null;
  }>;
  history: Array<{ id: string; type: string; at: string; payload: Record<string, unknown> }>;
};
