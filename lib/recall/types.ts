/** Recall programme engine: ports, rows and constants. Pure types; no IO. */

export type SendMode = "test" | "live";

export type ProgrammeRow = {
  id: string;
  org_id: string;
  key: string;
  name: string;
  kind: string;
  status: "draft" | "active" | "paused";
  eligibility_view: string | null;
  cron_expression: string | null;
  repeat_policy: "once" | "per_cycle";
  max_per_run: number;
  send_mode_override: string | null;
  requires_marketing_opt_in: boolean;
  requires_clinical_consent: boolean;
  config: Record<string, unknown>;
  last_run_at: string | null;
};

/** One row of an eligibility view. Extra columns vary per view. */
export type EligibleRow = {
  contact_id: string;
  segment_key: string | null;
  cycle_key: string;
  eligible?: boolean | null;
  excluded?: boolean | null;
  last_visit_date?: string | null;
  days_since_last_visit?: number | null;
  appointment_id?: string | null;
  starts_at?: string | null;
  doctor_name?: string | null;
  [k: string]: unknown;
};

export type TemplateMapRow = {
  id: string;
  segment_key: string;
  wa_template_id: string | null;
  legacy_sanoflow_template_id: string | null;
  variables_map: Record<string, string>;
  active: boolean;
};

export type RecallTemplate = {
  id: string;
  name: string;
  status: string;
  category: string;
};

export type RecallContact = {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone_e164: string | null;
  stop_marketing: boolean;
  promotions_opt_in: boolean;
  clinical_messaging_consent: boolean;
  is_test_record: boolean;
};

export type SendStatus =
  | "eligible"
  | "queued"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "skipped_no_template"
  | "skipped_opted_out"
  | "excluded"
  | "cancelled";

export type NewSend = {
  org_id: string;
  programme_id: string;
  contact_id: string;
  cycle_key: string;
  segment_key: string | null;
  template_id: string | null;
  legacy_template_ref: string | null;
  send_mode: SendMode;
  status: SendStatus;
  eligible_at: string;
  sent_to_phone_e164: string | null;
  last_visit_date_at_send: string | null;
  days_since_last_visit_at_send: number | null;
  appointment_id: string | null;
  notes: string | null;
};

export interface RecallStore {
  getProgramme(id: string): Promise<ProgrammeRow | null>;
  /** clinical_settings accessor (approved value only; unsigned defaults only when the org allows them). */
  setting(orgId: string, key: string): Promise<string | null>;
  /** The patient-facing clinical gate: true only for a SIGNED-OFF "true" (unsigned defaults never open it). */
  clinicalMessagingEnabled(orgId: string): Promise<boolean>;
  listEligible(p: ProgrammeRow, limit: number): Promise<EligibleRow[]>;
  templateMap(programmeId: string): Promise<TemplateMapRow[]>;
  template(orgId: string, waTemplateId: string): Promise<RecallTemplate | null>;
  contact(orgId: string, contactId: string): Promise<RecallContact | null>;
  /** Insert-first; returns null when (programme, contact, cycle) already has a row. */
  insertSend(row: NewSend): Promise<{ id: string } | null>;
  updateSend(
    id: string,
    patch: {
      status?: SendStatus;
      message_id?: string | null;
      sent_at?: string | null;
      sent_to_phone_e164?: string | null;
      notes?: string | null;
    },
  ): Promise<void>;
  /** Find-or-create internal test contacts (is_test_record) for these E.164 numbers. */
  testContacts(orgId: string, phones: string[]): Promise<Array<{ id: string; phone_e164: string }>>;
  tagContact(orgId: string, contactId: string, tag: string): Promise<void>;
  touchProgramme(id: string, at: Date): Promise<void>;
}

export interface RecallSender {
  /** Queue a template message to `contactId` through the outbound queue (rate limit + guards apply there). */
  sendTemplate(input: {
    orgId: string;
    contactId: string;
    waTemplateId: string;
    values: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export type RecallDeps = {
  store: RecallStore;
  sender: RecallSender;
  now: () => Date;
  timezone: string;
};

export type RunSummary = {
  programme: string;
  mode: SendMode;
  blocked?: string;
  listed: number;
  queued: number;
  recorded_only: number;
  skipped_no_template: number;
  skipped_opted_out: number;
  excluded: number;
  already_handled: number;
  failed: number;
};

/** Views the engine may read. The eligibility_view column is data; never trust it as a table name. */
export const ALLOWED_VIEWS = new Set(["v_chronic_recall_eligibility", "v_birthday_today"]);

/** Views that list ineligible rows too and expose an `eligible` flag. */
export const ELIGIBLE_FLAG_VIEWS = new Set(["v_chronic_recall_eligibility"]);

export const DEFAULT_TAGS: Record<string, string> = {
  chronic_90d: "chronic_recall_sent",
  birthday: "birthday_sent_{cycle}",
};

export const CLINICAL_KINDS = new Set(["chronic", "screening", "post_visit", "no_show"]);

/** In Test mode only this many messages per run are actually delivered to the internal numbers. */
export const DEFAULT_TEST_SAMPLE = 5;
export const DEFAULT_REPLY_ATTRIBUTION_DAYS = 14;
export const DEFAULT_BOOKING_ATTRIBUTION_DAYS = 30;
