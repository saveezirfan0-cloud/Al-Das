/** Plain data shapes handed from server code to the enquiry UI (no server-only imports). */
import type { CardFieldKey } from "@/lib/enquiries/columns";
import type { EnquiryStatus } from "@/lib/enquiries/status";

export type EnquiryRow = {
  id: string;
  number: number;
  title: string;
  status: EnquiryStatus;
  lost_reason: string | null;
  pipeline_id: string;
  pipeline_name: string;
  stage_id: string;
  stage_name: string;
  stage_color: string;
  contact_id: string | null;
  patient: string;
  phone: string | null;
  assignee_id: string | null;
  assignee_name: string;
  source: string | null;
  channel_id: string | null;
  channel_name: string;
  location_id: string | null;
  location_name: string;
  department_id: string | null;
  department_name: string;
  specialist_id: string | null;
  specialist_name: string;
  service_id: string | null;
  service_name: string;
  appointment_at: string | null;
  est_value: number | null;
  custom: Record<string, unknown>;
  stage_entered_at: string;
  created_at: string;
  closed_at: string | null;
  created_by_name: string;
};

export type PipelineView = {
  id: string;
  name: string;
  sort: number;
  card_fields: CardFieldKey[];
  default_team_id: string | null;
  archived: boolean;
  stages: Array<{ id: string; name: string; color: string; sort: number }>;
};

export type BoardColumn = { stage_id: string; total: number; rows: EnquiryRow[] };

export type TimelineItem = {
  id: string;
  at: string;
  type: string;
  actor: string;
  detail: string;
};
