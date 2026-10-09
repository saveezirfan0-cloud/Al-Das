export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      appointments: {
        Row: {
          channel_id: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          department_id: string | null;
          ends_at: string;
          external_id: string | null;
          external_status: string | null;
          id: string;
          location_id: string | null;
          notes: string | null;
          notify_early: boolean;
          number: number;
          org_id: string;
          service_id: string | null;
          source: string;
          specialist_id: string | null;
          starts_at: string;
          status: string;
          unite_clinic_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          department_id?: string | null;
          ends_at: string;
          external_id?: string | null;
          external_status?: string | null;
          id?: string;
          location_id?: string | null;
          notes?: string | null;
          notify_early?: boolean;
          number?: number;
          org_id: string;
          service_id?: string | null;
          source?: string;
          specialist_id?: string | null;
          starts_at: string;
          status?: string;
          unite_clinic_id?: string | null;
          updated_at?: string;
        };
        Update: {
          channel_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          department_id?: string | null;
          ends_at?: string;
          external_id?: string | null;
          external_status?: string | null;
          id?: string;
          location_id?: string | null;
          notes?: string | null;
          notify_early?: boolean;
          number?: number;
          org_id?: string;
          service_id?: string | null;
          source?: string;
          specialist_id?: string | null;
          starts_at?: string;
          status?: string;
          unite_clinic_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointments_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_department_id_fkey";
            columns: ["department_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      appointment_reminders: {
        Row: {
          appointment_id: string;
          created_at: string;
          dedupe_key: string | null;
          due_at: string;
          error: string | null;
          exclusion_reason: string | null;
          id: string;
          idx: number;
          message_id: string | null;
          org_id: string;
          sent_at: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id: string;
          created_at?: string;
          dedupe_key?: string | null;
          due_at: string;
          error?: string | null;
          exclusion_reason?: string | null;
          id?: string;
          idx: number;
          message_id?: string | null;
          org_id: string;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          appointment_id?: string;
          created_at?: string;
          dedupe_key?: string | null;
          due_at?: string;
          error?: string | null;
          exclusion_reason?: string | null;
          id?: string;
          idx?: number;
          message_id?: string | null;
          org_id?: string;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_reminders_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_reminders_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointment_reminders_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      appointment_counters: {
        Row: {
          last_number: number;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          last_number?: number;
          org_id: string;
        };
        Update: {
          last_number?: number;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "appointment_counters_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_log: {
        Row: {
          action: string;
          at: string;
          diff: Json | null;
          entity: string;
          entity_id: string | null;
          id: number;
          org_id: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          at?: string;
          diff?: Json | null;
          entity: string;
          entity_id?: string | null;
          id?: never;
          org_id: string;
          user_id?: string | null;
        };
        Update: {
          action?: string;
          at?: string;
          diff?: Json | null;
          entity?: string;
          entity_id?: string | null;
          id?: never;
          org_id?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_secrets: {
        Row: {
          access_token_enc: string;
          channel_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          access_token_enc: string;
          channel_id: string;
          updated_at?: string;
        };
        Update: {
          access_token_enc?: string;
          channel_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_secrets_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: true;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_send_slots: {
        Row: {
          channel_id: string;
          slot: string;
          used: number;
        };
        ComputedFields: never;
        Insert: {
          channel_id: string;
          slot: string;
          used?: number;
        };
        Update: {
          channel_id?: string;
          slot?: string;
          used?: number;
        };
        Relationships: [
          {
            foreignKeyName: "channel_send_slots_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      channels: {
        Row: {
          business_id: string | null;
          business_profile: NonNullable<Json>;
          catalog_id: string | null;
          created_at: string;
          display_phone: string | null;
          id: string;
          is_coexistence: boolean;
          last_synced_at: string | null;
          messaging_limit_tier: string | null;
          meta: NonNullable<Json>;
          name: string;
          name_status: string | null;
          org_id: string;
          phone_number_id: string;
          quality_rating: string | null;
          send_rate_per_sec: number;
          status: string;
          type: string;
          updated_at: string;
          verified_name: string | null;
          waba_id: string;
        };
        ComputedFields: never;
        Insert: {
          business_id?: string | null;
          business_profile?: NonNullable<Json>;
          catalog_id?: string | null;
          created_at?: string;
          display_phone?: string | null;
          id?: string;
          is_coexistence?: boolean;
          last_synced_at?: string | null;
          messaging_limit_tier?: string | null;
          meta?: NonNullable<Json>;
          name: string;
          name_status?: string | null;
          org_id: string;
          phone_number_id: string;
          quality_rating?: string | null;
          send_rate_per_sec?: number;
          status?: string;
          type?: string;
          updated_at?: string;
          verified_name?: string | null;
          waba_id: string;
        };
        Update: {
          business_id?: string | null;
          business_profile?: NonNullable<Json>;
          catalog_id?: string | null;
          created_at?: string;
          display_phone?: string | null;
          id?: string;
          is_coexistence?: boolean;
          last_synced_at?: string | null;
          messaging_limit_tier?: string | null;
          meta?: NonNullable<Json>;
          name?: string;
          name_status?: string | null;
          org_id?: string;
          phone_number_id?: string;
          quality_rating?: string | null;
          send_rate_per_sec?: number;
          status?: string;
          type?: string;
          updated_at?: string;
          verified_name?: string | null;
          waba_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channels_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      clinical_settings_history: {
        Row: {
          changed_at: string;
          changed_by: string | null;
          id: number;
          new_row: Json | null;
          old_row: Json | null;
          org_id: string;
          setting_key: string;
        };
        ComputedFields: never;
        Insert: {
          changed_at?: string;
          changed_by?: string | null;
          id?: number;
          new_row?: Json | null;
          old_row?: Json | null;
          org_id: string;
          setting_key: string;
        };
        Update: {
          changed_at?: string;
          changed_by?: string | null;
          id?: number;
          new_row?: Json | null;
          old_row?: Json | null;
          org_id?: string;
          setting_key?: string;
        };
        Relationships: [];
      };
      clinical_settings: {
        Row: {
          airtable_record_id: string | null;
          approved_value: string | null;
          category: Database["public"]["Enums"]["clinical_setting_category"];
          created_at: string;
          id: string;
          key: string;
          label: string;
          live_value: string | null;
          notes: string | null;
          org_id: string;
          owner: string | null;
          proposed_value: string | null;
          sign_off_status: Database["public"]["Enums"]["sign_off_status"];
          signed_at: string | null;
          signed_by: string | null;
          source: string;
          updated_at: string;
          value_type: Database["public"]["Enums"]["setting_value_type"];
        };
        ComputedFields: never;
        Insert: {
          airtable_record_id?: string | null;
          approved_value?: string | null;
          category: Database["public"]["Enums"]["clinical_setting_category"];
          created_at?: string;
          id?: string;
          key: string;
          label: string;
          live_value?: string | null;
          notes?: string | null;
          org_id: string;
          owner?: string | null;
          proposed_value?: string | null;
          sign_off_status?: Database["public"]["Enums"]["sign_off_status"];
          signed_at?: string | null;
          signed_by?: string | null;
          source?: string;
          updated_at?: string;
          value_type?: Database["public"]["Enums"]["setting_value_type"];
        };
        Update: {
          airtable_record_id?: string | null;
          approved_value?: string | null;
          category?: Database["public"]["Enums"]["clinical_setting_category"];
          created_at?: string;
          id?: string;
          key?: string;
          label?: string;
          live_value?: string | null;
          notes?: string | null;
          org_id?: string;
          owner?: string | null;
          proposed_value?: string | null;
          sign_off_status?: Database["public"]["Enums"]["sign_off_status"];
          signed_at?: string | null;
          signed_by?: string | null;
          source?: string;
          updated_at?: string;
          value_type?: Database["public"]["Enums"]["setting_value_type"];
        };
        Relationships: [
          {
            foreignKeyName: "clinical_settings_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      clinical_message_log: {
        Row: {
          block_reason: string | null;
          contact_id: string | null;
          created_at: string;
          delivered_at: string | null;
          error_code: string | null;
          followup_id: string | null;
          id: string;
          idempotency_key: string;
          is_test_record: boolean;
          message_id: string | null;
          org_id: string;
          prescription_id: string | null;
          read_at: string | null;
          ref: string | null;
          replied_at: string | null;
          reply_message_id: string | null;
          reply_parsed_score: number | null;
          reply_text: string | null;
          scheduled_at: string | null;
          send_mode: string;
          sent_at: string | null;
          status: Database["public"]["Enums"]["clinical_send_status"];
          template_key: string;
          trigger_category: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at: string;
          visit_id: string | null;
          wa_template_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          block_reason?: string | null;
          contact_id?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          error_code?: string | null;
          followup_id?: string | null;
          id?: string;
          idempotency_key: string;
          is_test_record?: boolean;
          message_id?: string | null;
          org_id: string;
          prescription_id?: string | null;
          read_at?: string | null;
          ref?: string | null;
          replied_at?: string | null;
          reply_message_id?: string | null;
          reply_parsed_score?: number | null;
          reply_text?: string | null;
          scheduled_at?: string | null;
          send_mode?: string;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["clinical_send_status"];
          template_key: string;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
          visit_id?: string | null;
          wa_template_id?: string | null;
        };
        Update: {
          block_reason?: string | null;
          contact_id?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          error_code?: string | null;
          followup_id?: string | null;
          id?: string;
          idempotency_key?: string;
          is_test_record?: boolean;
          message_id?: string | null;
          org_id?: string;
          prescription_id?: string | null;
          read_at?: string | null;
          ref?: string | null;
          replied_at?: string | null;
          reply_message_id?: string | null;
          reply_parsed_score?: number | null;
          reply_text?: string | null;
          scheduled_at?: string | null;
          send_mode?: string;
          sent_at?: string | null;
          status?: Database["public"]["Enums"]["clinical_send_status"];
          template_key?: string;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
          visit_id?: string | null;
          wa_template_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "clinical_message_log_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_followup_id_fkey";
            columns: ["followup_id"];
            isOneToOne: false;
            referencedRelation: "clinical_followups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_followup_id_fkey";
            columns: ["followup_id"];
            isOneToOne: false;
            referencedRelation: "v_followup_queue";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_prescription_id_fkey";
            columns: ["prescription_id"];
            isOneToOne: false;
            referencedRelation: "prescriptions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_reply_message_id_fkey";
            columns: ["reply_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "clinical_message_log_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_message_log_wa_template_id_fkey";
            columns: ["wa_template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      clinical_followups: {
        Row: {
          assigned_team_id: string | null;
          assigned_user_id: string | null;
          call_status: Database["public"]["Enums"]["call_status"];
          closed_at: string | null;
          closed_reason: string | null;
          contact_id: string | null;
          created_at: string;
          dedupe_key: string | null;
          doctor_alert_required: boolean;
          doctor_notified_at: string | null;
          doctor_response_notes: string | null;
          due_date: string | null;
          escalation_status: Database["public"]["Enums"]["escalation_status"];
          id: string;
          is_test_record: boolean;
          notes: string | null;
          org_id: string;
          outcome: Database["public"]["Enums"]["followup_outcome"] | null;
          prescription_id: string | null;
          priority: Database["public"]["Enums"]["followup_priority"];
          ref: string | null;
          rule_evaluation_id: string | null;
          source: string;
          trigger_category: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at: string;
          visit_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          assigned_team_id?: string | null;
          assigned_user_id?: string | null;
          call_status?: Database["public"]["Enums"]["call_status"];
          closed_at?: string | null;
          closed_reason?: string | null;
          contact_id?: string | null;
          created_at?: string;
          dedupe_key?: string | null;
          doctor_alert_required?: boolean;
          doctor_notified_at?: string | null;
          doctor_response_notes?: string | null;
          due_date?: string | null;
          escalation_status?: Database["public"]["Enums"]["escalation_status"];
          id?: string;
          is_test_record?: boolean;
          notes?: string | null;
          org_id: string;
          outcome?: Database["public"]["Enums"]["followup_outcome"] | null;
          prescription_id?: string | null;
          priority?: Database["public"]["Enums"]["followup_priority"];
          ref?: string | null;
          rule_evaluation_id?: string | null;
          source?: string;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
          visit_id?: string | null;
        };
        Update: {
          assigned_team_id?: string | null;
          assigned_user_id?: string | null;
          call_status?: Database["public"]["Enums"]["call_status"];
          closed_at?: string | null;
          closed_reason?: string | null;
          contact_id?: string | null;
          created_at?: string;
          dedupe_key?: string | null;
          doctor_alert_required?: boolean;
          doctor_notified_at?: string | null;
          doctor_response_notes?: string | null;
          due_date?: string | null;
          escalation_status?: Database["public"]["Enums"]["escalation_status"];
          id?: string;
          is_test_record?: boolean;
          notes?: string | null;
          org_id?: string;
          outcome?: Database["public"]["Enums"]["followup_outcome"] | null;
          prescription_id?: string | null;
          priority?: Database["public"]["Enums"]["followup_priority"];
          ref?: string | null;
          rule_evaluation_id?: string | null;
          source?: string;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
          visit_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "clinical_followups_assigned_team_id_fkey";
            columns: ["assigned_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_assigned_user_id_fkey";
            columns: ["assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_prescription_id_fkey";
            columns: ["prescription_id"];
            isOneToOne: false;
            referencedRelation: "prescriptions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_rule_evaluation_id_fkey";
            columns: ["rule_evaluation_id"];
            isOneToOne: false;
            referencedRelation: "visit_rule_evaluations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "clinical_followups_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
            referencedColumns: ["id"];
          },
        ];
      };
      clinical_feedback: {
        Row: {
          contact_id: string | null;
          coordinator_notified_at: string | null;
          created_at: string;
          doctor_notified_at: string | null;
          id: string;
          is_test_record: boolean;
          needs_doctor_review: boolean;
          org_id: string;
          prescription_id: string | null;
          red_flag_threshold_used: number | null;
          ref: string | null;
          reply_text: string | null;
          score: number | null;
          side_effects_flagged: boolean;
          source_message_id: string | null;
          stage: Database["public"]["Enums"]["feedback_stage"];
          symptoms_improved: boolean | null;
          symptoms_reported: string | null;
          updated_at: string;
          visit_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          coordinator_notified_at?: string | null;
          created_at?: string;
          doctor_notified_at?: string | null;
          id?: string;
          is_test_record?: boolean;
          needs_doctor_review?: boolean;
          org_id: string;
          prescription_id?: string | null;
          red_flag_threshold_used?: number | null;
          ref?: string | null;
          reply_text?: string | null;
          score?: number | null;
          side_effects_flagged?: boolean;
          source_message_id?: string | null;
          stage: Database["public"]["Enums"]["feedback_stage"];
          symptoms_improved?: boolean | null;
          symptoms_reported?: string | null;
          updated_at?: string;
          visit_id?: string | null;
        };
        Update: {
          contact_id?: string | null;
          coordinator_notified_at?: string | null;
          created_at?: string;
          doctor_notified_at?: string | null;
          id?: string;
          is_test_record?: boolean;
          needs_doctor_review?: boolean;
          org_id?: string;
          prescription_id?: string | null;
          red_flag_threshold_used?: number | null;
          ref?: string | null;
          reply_text?: string | null;
          score?: number | null;
          side_effects_flagged?: boolean;
          source_message_id?: string | null;
          stage?: Database["public"]["Enums"]["feedback_stage"];
          symptoms_improved?: boolean | null;
          symptoms_reported?: string | null;
          updated_at?: string;
          visit_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "clinical_feedback_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_feedback_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_feedback_prescription_id_fkey";
            columns: ["prescription_id"];
            isOneToOne: false;
            referencedRelation: "prescriptions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_feedback_source_message_id_fkey";
            columns: ["source_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_feedback_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "clinical_feedback_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
            referencedColumns: ["id"];
          },
        ];
      };
      clinical_call_scripts: {
        Row: {
          clinical_approval: string;
          created_at: string;
          id: string;
          key: string;
          notes: string | null;
          org_id: string;
          phase: number | null;
          purpose: string | null;
          script: string;
          trigger_category: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          clinical_approval?: string;
          created_at?: string;
          id?: string;
          key: string;
          notes?: string | null;
          org_id: string;
          phase?: number | null;
          purpose?: string | null;
          script: string;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
        };
        Update: {
          clinical_approval?: string;
          created_at?: string;
          id?: string;
          key?: string;
          notes?: string | null;
          org_id?: string;
          phase?: number | null;
          purpose?: string | null;
          script?: string;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "clinical_call_scripts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_phones: {
        Row: {
          contact_id: string;
          created_at: string;
          id: string;
          label: string | null;
          org_id: string;
          phone_e164: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          created_at?: string;
          id?: string;
          label?: string | null;
          org_id: string;
          phone_e164: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          id?: string;
          label?: string | null;
          org_id?: string;
          phone_e164?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_phones_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_phones_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_tags: {
        Row: {
          added_at: string;
          added_by: string | null;
          contact_id: string;
          org_id: string;
          tag_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          added_by?: string | null;
          contact_id: string;
          org_id: string;
          tag_id: string;
        };
        Update: {
          added_at?: string;
          added_by?: string | null;
          contact_id?: string;
          org_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_tags_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_tags_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_tags_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      contacts: {
        Row: {
          assignee_id: string | null;
          clinical_messaging_consent: boolean;
          country: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          deleted_at: string | null;
          dob: string | null;
          email: string | null;
          external_id: string | null;
          first_name: string;
          full_name: string | null;
          gender: string | null;
          id: string;
          is_test_record: boolean;
          label: string | null;
          language: string | null;
          last_interaction_at: string | null;
          last_name: string;
          merged_into_id: string | null;
          nationality: string | null;
          org_id: string;
          owner_id: string | null;
          phone_e164: string | null;
          promotions_opt_in: boolean;
          source: string;
          stop_marketing: boolean;
          updated_at: string;
          wa_bsuid: string | null;
          wa_profile_name: string | null;
        };
        ComputedFields: never;
        Insert: {
          assignee_id?: string | null;
          clinical_messaging_consent?: boolean;
          country?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          deleted_at?: string | null;
          dob?: string | null;
          email?: string | null;
          external_id?: string | null;
          first_name?: string;
          full_name?: never;
          gender?: string | null;
          id?: string;
          is_test_record?: boolean;
          label?: string | null;
          language?: string | null;
          last_interaction_at?: string | null;
          last_name?: string;
          merged_into_id?: string | null;
          nationality?: string | null;
          org_id: string;
          owner_id?: string | null;
          phone_e164?: string | null;
          promotions_opt_in?: boolean;
          source?: string;
          stop_marketing?: boolean;
          updated_at?: string;
          wa_bsuid?: string | null;
          wa_profile_name?: string | null;
        };
        Update: {
          assignee_id?: string | null;
          clinical_messaging_consent?: boolean;
          country?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          deleted_at?: string | null;
          dob?: string | null;
          email?: string | null;
          external_id?: string | null;
          first_name?: string;
          full_name?: never;
          gender?: string | null;
          id?: string;
          is_test_record?: boolean;
          label?: string | null;
          language?: string | null;
          last_interaction_at?: string | null;
          last_name?: string;
          merged_into_id?: string | null;
          nationality?: string | null;
          org_id?: string;
          owner_id?: string | null;
          phone_e164?: string | null;
          promotions_opt_in?: boolean;
          source?: string;
          stop_marketing?: boolean;
          updated_at?: string;
          wa_bsuid?: string | null;
          wa_profile_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_merged_into_id_fkey";
            columns: ["merged_into_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      conv_categories: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          sort: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
          sort?: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          sort?: number;
        };
        Relationships: [
          {
            foreignKeyName: "conv_categories_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_labels: {
        Row: {
          added_at: string;
          added_by: string | null;
          conversation_id: string;
          org_id: string;
          tag_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          added_by?: string | null;
          conversation_id: string;
          org_id: string;
          tag_id: string;
        };
        Update: {
          added_at?: string;
          added_by?: string | null;
          conversation_id?: string;
          org_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_labels_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_labels_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_labels_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_labels_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      conversations: {
        Row: {
          ad_referral: Json | null;
          ai_tags: string[];
          assignee_team_id: string | null;
          assignee_user_id: string | null;
          bot_active: boolean;
          category_id: string | null;
          channel_id: string;
          closed_at: string | null;
          closed_by: string | null;
          contact_id: string;
          created_at: string;
          flow_run_id: string | null;
          id: string;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_direction: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          opened_at: string;
          org_id: string;
          status: string;
          summary: string | null;
          unread_alerted_at: string | null;
          unread_count: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          ad_referral?: Json | null;
          ai_tags?: string[];
          assignee_team_id?: string | null;
          assignee_user_id?: string | null;
          bot_active?: boolean;
          category_id?: string | null;
          channel_id: string;
          closed_at?: string | null;
          closed_by?: string | null;
          contact_id: string;
          created_at?: string;
          flow_run_id?: string | null;
          id?: string;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_direction?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          opened_at?: string;
          org_id: string;
          status?: string;
          summary?: string | null;
          unread_alerted_at?: string | null;
          unread_count?: number;
          updated_at?: string;
        };
        Update: {
          ad_referral?: Json | null;
          ai_tags?: string[];
          assignee_team_id?: string | null;
          assignee_user_id?: string | null;
          bot_active?: boolean;
          category_id?: string | null;
          channel_id?: string;
          closed_at?: string | null;
          closed_by?: string | null;
          contact_id?: string;
          created_at?: string;
          flow_run_id?: string | null;
          id?: string;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_direction?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          opened_at?: string;
          org_id?: string;
          status?: string;
          summary?: string | null;
          unread_alerted_at?: string | null;
          unread_count?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_assignee_team_id_fkey";
            columns: ["assignee_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_assignee_user_id_fkey";
            columns: ["assignee_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "conv_categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_closed_by_fkey";
            columns: ["closed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      custom_fields: {
        Row: {
          created_at: string;
          entity: string;
          id: string;
          key: string;
          label: string;
          options: NonNullable<Json>;
          org_id: string;
          required: boolean;
          sort: number;
          type: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          entity?: string;
          id?: string;
          key: string;
          label: string;
          options?: NonNullable<Json>;
          org_id: string;
          required?: boolean;
          sort?: number;
          type: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          entity?: string;
          id?: string;
          key?: string;
          label?: string;
          options?: NonNullable<Json>;
          org_id?: string;
          required?: boolean;
          sort?: number;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "custom_fields_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      dead_letters: {
        Row: {
          attempts: number;
          created_at: string;
          error: string | null;
          id: number;
          msg_id: number | null;
          payload: NonNullable<Json>;
          queue: string;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          scheduled_job_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          created_at?: string;
          error?: string | null;
          id?: never;
          msg_id?: number | null;
          payload: NonNullable<Json>;
          queue: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          scheduled_job_id?: string | null;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          error?: string | null;
          id?: never;
          msg_id?: number | null;
          payload?: NonNullable<Json>;
          queue?: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          scheduled_job_id?: string | null;
        };
        Relationships: [];
      };
      departments: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "departments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      external_refs: {
        Row: {
          created_at: string;
          entity: string;
          external_id: string;
          id: string;
          local_id: string;
          local_table: string;
          meta: NonNullable<Json>;
          org_id: string;
          source: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          entity: string;
          external_id: string;
          id?: string;
          local_id: string;
          local_table: string;
          meta?: NonNullable<Json>;
          org_id: string;
          source: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          entity?: string;
          external_id?: string;
          id?: string;
          local_id?: string;
          local_table?: string;
          meta?: NonNullable<Json>;
          org_id?: string;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "external_refs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      inbox_views: {
        Row: {
          created_at: string;
          filter: NonNullable<Json>;
          id: string;
          name: string;
          org_id: string;
          owner_id: string;
          shared_all: boolean;
          shared_team_ids: string[];
          sort: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          filter?: NonNullable<Json>;
          id?: string;
          name: string;
          org_id: string;
          owner_id: string;
          shared_all?: boolean;
          shared_team_ids?: string[];
          sort?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          filter?: NonNullable<Json>;
          id?: string;
          name?: string;
          org_id?: string;
          owner_id?: string;
          shared_all?: boolean;
          shared_team_ids?: string[];
          sort?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "inbox_views_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inbox_views_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_accounts: {
        Row: {
          breaker_open_until: string | null;
          config: NonNullable<Json>;
          config_enc: string | null;
          consecutive_failures: number;
          created_at: string;
          id: string;
          kind: string;
          org_id: string;
          refresh_lock_until: string | null;
          status: string;
          token_enc: string | null;
          token_expires_at: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          breaker_open_until?: string | null;
          config?: NonNullable<Json>;
          config_enc?: string | null;
          consecutive_failures?: number;
          created_at?: string;
          id?: string;
          kind: string;
          org_id: string;
          refresh_lock_until?: string | null;
          status?: string;
          token_enc?: string | null;
          token_expires_at?: string | null;
          updated_at?: string;
        };
        Update: {
          breaker_open_until?: string | null;
          config?: NonNullable<Json>;
          config_enc?: string | null;
          consecutive_failures?: number;
          created_at?: string;
          id?: string;
          kind?: string;
          org_id?: string;
          refresh_lock_until?: string | null;
          status?: string;
          token_enc?: string | null;
          token_expires_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_accounts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      invites: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          org_id: string;
          revoked_at: string | null;
          role_id: string;
          team_ids: string[];
          token_hash: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email: string;
          expires_at: string;
          id?: string;
          invited_by?: string | null;
          org_id: string;
          revoked_at?: string | null;
          role_id: string;
          team_ids?: string[];
          token_hash: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          org_id?: string;
          revoked_at?: string | null;
          role_id?: string;
          team_ids?: string[];
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invites_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invites_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
        ];
      };
      job_runs: {
        Row: {
          error: string | null;
          failed: number;
          finished_at: string | null;
          handler: string | null;
          id: number;
          meta: NonNullable<Json>;
          processed: number;
          queue: string;
          started_at: string;
        };
        ComputedFields: never;
        Insert: {
          error?: string | null;
          failed?: number;
          finished_at?: string | null;
          handler?: string | null;
          id?: never;
          meta?: NonNullable<Json>;
          processed?: number;
          queue: string;
          started_at?: string;
        };
        Update: {
          error?: string | null;
          failed?: number;
          finished_at?: string | null;
          handler?: string | null;
          id?: never;
          meta?: NonNullable<Json>;
          processed?: number;
          queue?: string;
          started_at?: string;
        };
        Relationships: [];
      };
      locations: {
        Row: {
          active: boolean;
          address: string | null;
          created_at: string;
          external_id: string | null;
          id: string;
          name: string;
          org_id: string;
          photo_path: string | null;
          timezone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          address?: string | null;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          name: string;
          org_id: string;
          photo_path?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          address?: string | null;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          name?: string;
          org_id?: string;
          photo_path?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "locations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      memberships: {
        Row: {
          created_at: string;
          id: string;
          org_id: string;
          presence: string;
          presence_at: string | null;
          role_id: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          org_id: string;
          presence?: string;
          presence_at?: string | null;
          role_id: string;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          org_id?: string;
          presence?: string;
          presence_at?: string | null;
          role_id?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "memberships_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "memberships_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      mentions: {
        Row: {
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          id: string;
          mentioned_by: string | null;
          message_id: string | null;
          org_id: string;
          read_at: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          mentioned_by?: string | null;
          message_id?: string | null;
          org_id: string;
          read_at?: string | null;
          user_id: string;
        };
        Update: {
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          mentioned_by?: string | null;
          message_id?: string | null;
          org_id?: string;
          read_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mentions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mentions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mentions_mentioned_by_fkey";
            columns: ["mentioned_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mentions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mentions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mentions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          at: string;
          body: string | null;
          campaign_recipient_id: string | null;
          conversation_id: string;
          created_at: string;
          direction: string;
          error_code: number | null;
          error_message: string | null;
          flow_run_id: string | null;
          id: string;
          kind: string;
          media_filename: string | null;
          media_meta_id: string | null;
          media_mime: string | null;
          media_path: string | null;
          org_id: string;
          payload: NonNullable<Json>;
          reply_to_wa_message_id: string | null;
          sent_by_user_id: string | null;
          status: string;
          updated_at: string;
          wa_message_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          body?: string | null;
          campaign_recipient_id?: string | null;
          conversation_id: string;
          created_at?: string;
          direction: string;
          error_code?: number | null;
          error_message?: string | null;
          flow_run_id?: string | null;
          id?: string;
          kind: string;
          media_filename?: string | null;
          media_meta_id?: string | null;
          media_mime?: string | null;
          media_path?: string | null;
          org_id: string;
          payload?: NonNullable<Json>;
          reply_to_wa_message_id?: string | null;
          sent_by_user_id?: string | null;
          status?: string;
          updated_at?: string;
          wa_message_id?: string | null;
        };
        Update: {
          at?: string;
          body?: string | null;
          campaign_recipient_id?: string | null;
          conversation_id?: string;
          created_at?: string;
          direction?: string;
          error_code?: number | null;
          error_message?: string | null;
          flow_run_id?: string | null;
          id?: string;
          kind?: string;
          media_filename?: string | null;
          media_meta_id?: string | null;
          media_mime?: string | null;
          media_path?: string | null;
          org_id?: string;
          payload?: NonNullable<Json>;
          reply_to_wa_message_id?: string | null;
          sent_by_user_id?: string | null;
          status?: string;
          updated_at?: string;
          wa_message_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_sent_by_user_id_fkey";
            columns: ["sent_by_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          body: string | null;
          created_at: string;
          id: string;
          org_id: string;
          payload: NonNullable<Json>;
          read_at: string | null;
          title: string;
          type: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          body?: string | null;
          created_at?: string;
          id?: string;
          org_id: string;
          payload?: NonNullable<Json>;
          read_at?: string | null;
          title: string;
          type: string;
          user_id: string;
        };
        Update: {
          body?: string | null;
          created_at?: string;
          id?: string;
          org_id?: string;
          payload?: NonNullable<Json>;
          read_at?: string | null;
          title?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      orgs: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          settings: NonNullable<Json>;
          slug: string;
          timezone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          settings?: NonNullable<Json>;
          slug: string;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          settings?: NonNullable<Json>;
          slug?: string;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      prescriptions: {
        Row: {
          class: Database["public"]["Enums"]["medication_class"];
          contact_id: string | null;
          created_at: string;
          dosage_instruction: string | null;
          duration_days: number | null;
          external_key: string;
          id: string;
          is_test_record: boolean;
          medication_code: string | null;
          medication_name: string | null;
          org_id: string;
          position: number | null;
          source: string;
          start_date: string | null;
          total_quantity: number | null;
          updated_at: string;
          visit_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          class?: Database["public"]["Enums"]["medication_class"];
          contact_id?: string | null;
          created_at?: string;
          dosage_instruction?: string | null;
          duration_days?: number | null;
          external_key: string;
          id?: string;
          is_test_record?: boolean;
          medication_code?: string | null;
          medication_name?: string | null;
          org_id: string;
          position?: number | null;
          source?: string;
          start_date?: string | null;
          total_quantity?: number | null;
          updated_at?: string;
          visit_id?: string | null;
        };
        Update: {
          class?: Database["public"]["Enums"]["medication_class"];
          contact_id?: string | null;
          created_at?: string;
          dosage_instruction?: string | null;
          duration_days?: number | null;
          external_key?: string;
          id?: string;
          is_test_record?: boolean;
          medication_code?: string | null;
          medication_name?: string | null;
          org_id?: string;
          position?: number | null;
          source?: string;
          start_date?: string | null;
          total_quantity?: number | null;
          updated_at?: string;
          visit_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "prescriptions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prescriptions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prescriptions_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "prescriptions_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
            referencedColumns: ["id"];
          },
        ];
      };
      prescription_sequences: {
        Row: {
          antibiotic_end_date: string | null;
          created_at: string;
          day3_check_date: string | null;
          day3_offset_days: number | null;
          day3_score: number | null;
          halted_at: string | null;
          halted_reason: string | null;
          id: string;
          org_id: string;
          outcome_score: number | null;
          outcome_symptoms: string | null;
          prescription_id: string;
          probiotic_duration_days: number | null;
          probiotic_end_date: string | null;
          probiotic_start_date: string | null;
          requires_probiotics: boolean;
          status: Database["public"]["Enums"]["sequence_status"];
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          antibiotic_end_date?: string | null;
          created_at?: string;
          day3_check_date?: string | null;
          day3_offset_days?: number | null;
          day3_score?: number | null;
          halted_at?: string | null;
          halted_reason?: string | null;
          id?: string;
          org_id: string;
          outcome_score?: number | null;
          outcome_symptoms?: string | null;
          prescription_id: string;
          probiotic_duration_days?: number | null;
          probiotic_end_date?: string | null;
          probiotic_start_date?: string | null;
          requires_probiotics?: boolean;
          status?: Database["public"]["Enums"]["sequence_status"];
          updated_at?: string;
        };
        Update: {
          antibiotic_end_date?: string | null;
          created_at?: string;
          day3_check_date?: string | null;
          day3_offset_days?: number | null;
          day3_score?: number | null;
          halted_at?: string | null;
          halted_reason?: string | null;
          id?: string;
          org_id?: string;
          outcome_score?: number | null;
          outcome_symptoms?: string | null;
          prescription_id?: string;
          probiotic_duration_days?: number | null;
          probiotic_end_date?: string | null;
          probiotic_start_date?: string | null;
          requires_probiotics?: boolean;
          status?: Database["public"]["Enums"]["sequence_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prescription_sequences_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "prescription_sequences_prescription_id_fkey";
            columns: ["prescription_id"];
            isOneToOne: false;
            referencedRelation: "prescriptions";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_path: string | null;
          created_at: string;
          designation: string | null;
          email: string | null;
          first_name: string;
          id: string;
          language: string;
          last_name: string;
          timezone: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          avatar_path?: string | null;
          created_at?: string;
          designation?: string | null;
          email?: string | null;
          first_name?: string;
          id: string;
          language?: string;
          last_name?: string;
          timezone?: string | null;
          updated_at?: string;
        };
        Update: {
          avatar_path?: string | null;
          created_at?: string;
          designation?: string | null;
          email?: string | null;
          first_name?: string;
          id?: string;
          language?: string;
          last_name?: string;
          timezone?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      quick_replies: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          org_id: string;
          shortcut: string;
          text: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          org_id: string;
          shortcut: string;
          text: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          org_id?: string;
          shortcut?: string;
          text?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "quick_replies_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quick_replies_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ref_medication_classes: {
        Row: {
          class: Database["public"]["Enums"]["medication_class"];
          classified_at: string | null;
          classified_by: string | null;
          created_at: string;
          id: string;
          medication_name: string | null;
          notes: string | null;
          org_id: string;
          requires_probiotics_default: boolean;
          unite_local_code: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          class?: Database["public"]["Enums"]["medication_class"];
          classified_at?: string | null;
          classified_by?: string | null;
          created_at?: string;
          id?: string;
          medication_name?: string | null;
          notes?: string | null;
          org_id: string;
          requires_probiotics_default?: boolean;
          unite_local_code: string;
          updated_at?: string;
        };
        Update: {
          class?: Database["public"]["Enums"]["medication_class"];
          classified_at?: string | null;
          classified_by?: string | null;
          created_at?: string;
          id?: string;
          medication_name?: string | null;
          notes?: string | null;
          org_id?: string;
          requires_probiotics_default?: boolean;
          unite_local_code?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ref_medication_classes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      reminder_exclusions: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          kind: string;
          match_type: string;
          org_id: string;
          reason: string | null;
          updated_at: string;
          value: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kind: string;
          match_type?: string;
          org_id: string;
          reason?: string | null;
          updated_at?: string;
          value: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          kind?: string;
          match_type?: string;
          org_id?: string;
          reason?: string | null;
          updated_at?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reminder_exclusions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      roles: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          is_system: boolean;
          name: string;
          org_id: string;
          permissions: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_system?: boolean;
          name: string;
          org_id: string;
          permissions?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          is_system?: boolean;
          name?: string;
          org_id?: string;
          permissions?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "roles_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      scheduled_jobs: {
        Row: {
          attempts: number;
          created_at: string;
          dedupe_key: string | null;
          done_at: string | null;
          id: string;
          kind: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          org_id: string | null;
          payload: NonNullable<Json>;
          run_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          created_at?: string;
          dedupe_key?: string | null;
          done_at?: string | null;
          id?: string;
          kind: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          org_id?: string | null;
          payload?: NonNullable<Json>;
          run_at?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          dedupe_key?: string | null;
          done_at?: string | null;
          id?: string;
          kind?: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          org_id?: string | null;
          payload?: NonNullable<Json>;
          run_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "scheduled_jobs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      segment_members: {
        Row: {
          added_at: string;
          added_by: string | null;
          contact_id: string;
          org_id: string;
          segment_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          added_by?: string | null;
          contact_id: string;
          org_id: string;
          segment_id: string;
        };
        Update: {
          added_at?: string;
          added_by?: string | null;
          contact_id?: string;
          org_id?: string;
          segment_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "segment_members_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "segment_members_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "segment_members_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "segment_members_segment_id_fkey";
            columns: ["segment_id"];
            isOneToOne: false;
            referencedRelation: "segments";
            referencedColumns: ["id"];
          },
        ];
      };
      segments: {
        Row: {
          count_refreshed_at: string | null;
          created_at: string;
          created_by: string | null;
          drip_flow_id: string | null;
          filter: Json | null;
          id: string;
          kind: string;
          member_count: number;
          name: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          count_refreshed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          drip_flow_id?: string | null;
          filter?: Json | null;
          id?: string;
          kind: string;
          member_count?: number;
          name: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          count_refreshed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          drip_flow_id?: string | null;
          filter?: Json | null;
          id?: string;
          kind?: string;
          member_count?: number;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "segments_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "segments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      specialists: {
        Row: {
          active: boolean;
          created_at: string;
          department_id: string | null;
          external_id: string | null;
          id: string;
          name: string;
          org_id: string;
          photo_path: string | null;
          title: string | null;
          updated_at: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          department_id?: string | null;
          external_id?: string | null;
          id?: string;
          name: string;
          org_id: string;
          photo_path?: string | null;
          title?: string | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          department_id?: string | null;
          external_id?: string | null;
          id?: string;
          name?: string;
          org_id?: string;
          photo_path?: string | null;
          title?: string | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "specialists_department_id_fkey";
            columns: ["department_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialists_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialists_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      specialist_services: {
        Row: {
          org_id: string;
          service_id: string;
          specialist_id: string;
        };
        ComputedFields: never;
        Insert: {
          org_id: string;
          service_id: string;
          specialist_id: string;
        };
        Update: {
          org_id?: string;
          service_id?: string;
          specialist_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "specialist_services_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialist_services_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialist_services_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      specialist_locations: {
        Row: {
          location_id: string;
          org_id: string;
          specialist_id: string;
        };
        ComputedFields: never;
        Insert: {
          location_id: string;
          org_id: string;
          specialist_id: string;
        };
        Update: {
          location_id?: string;
          org_id?: string;
          specialist_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "specialist_locations_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialist_locations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialist_locations_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      services: {
        Row: {
          active: boolean;
          created_at: string;
          department_id: string | null;
          duration_min: number;
          id: string;
          name: string;
          org_id: string;
          price: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          department_id?: string | null;
          duration_min?: number;
          id?: string;
          name: string;
          org_id: string;
          price?: number | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          department_id?: string | null;
          duration_min?: number;
          id?: string;
          name?: string;
          org_id?: string;
          price?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "services_department_id_fkey";
            columns: ["department_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "services_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      sync_cursors: {
        Row: {
          created_at: string;
          cursor: NonNullable<Json>;
          entity: string;
          error: string | null;
          id: string;
          last_ok_at: string | null;
          last_run_at: string | null;
          org_id: string;
          scope: string;
          source: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          cursor?: NonNullable<Json>;
          entity: string;
          error?: string | null;
          id?: string;
          last_ok_at?: string | null;
          last_run_at?: string | null;
          org_id: string;
          scope?: string;
          source: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          cursor?: NonNullable<Json>;
          entity?: string;
          error?: string | null;
          id?: string;
          last_ok_at?: string | null;
          last_run_at?: string | null;
          org_id?: string;
          scope?: string;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sync_cursors_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      sync_reviews: {
        Row: {
          candidates: NonNullable<Json>;
          created_at: string;
          entity: string;
          external_id: string;
          id: string;
          incoming: NonNullable<Json>;
          org_id: string;
          reason: string;
          resolved_at: string | null;
          resolved_by: string | null;
          resolved_contact_id: string | null;
          source: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          candidates?: NonNullable<Json>;
          created_at?: string;
          entity: string;
          external_id: string;
          id?: string;
          incoming?: NonNullable<Json>;
          org_id: string;
          reason: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          resolved_contact_id?: string | null;
          source: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          candidates?: NonNullable<Json>;
          created_at?: string;
          entity?: string;
          external_id?: string;
          id?: string;
          incoming?: NonNullable<Json>;
          org_id?: string;
          reason?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          resolved_contact_id?: string | null;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sync_reviews_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sync_reviews_resolved_by_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sync_reviews_resolved_contact_id_fkey";
            columns: ["resolved_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      tags: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          scope: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          color?: string;
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
          scope?: string;
          updated_at?: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          scope?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tags_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      team_members: {
        Row: {
          created_at: string;
          last_assigned_at: string | null;
          org_id: string;
          rr_weight: number;
          team_id: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          last_assigned_at?: string | null;
          org_id: string;
          rr_weight?: number;
          team_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          last_assigned_at?: string | null;
          org_id?: string;
          rr_weight?: number;
          team_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "team_members_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_members_team_id_fkey";
            columns: ["team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "team_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      teams: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          org_id: string;
          round_robin: boolean;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          org_id: string;
          round_robin?: boolean;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          org_id?: string;
          round_robin?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "teams_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      time_blocks: {
        Row: {
          created_at: string;
          created_by: string | null;
          ends_at: string;
          id: string;
          location_id: string | null;
          org_id: string;
          reason: string | null;
          specialist_id: string;
          starts_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          ends_at: string;
          id?: string;
          location_id?: string | null;
          org_id: string;
          reason?: string | null;
          specialist_id: string;
          starts_at: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          ends_at?: string;
          id?: string;
          location_id?: string | null;
          org_id?: string;
          reason?: string | null;
          specialist_id?: string;
          starts_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "time_blocks_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_blocks_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_blocks_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_blocks_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      timeline_events: {
        Row: {
          actor_id: string | null;
          actor_type: string;
          at: string;
          contact_id: string;
          enquiry_id: string | null;
          id: string;
          org_id: string;
          payload: NonNullable<Json>;
          type: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          actor_type?: string;
          at?: string;
          contact_id: string;
          enquiry_id?: string | null;
          id?: string;
          org_id: string;
          payload?: NonNullable<Json>;
          type: string;
        };
        Update: {
          actor_id?: string | null;
          actor_type?: string;
          at?: string;
          contact_id?: string;
          enquiry_id?: string | null;
          id?: string;
          org_id?: string;
          payload?: NonNullable<Json>;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "timeline_events_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timeline_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      unite_api_calls: {
        Row: {
          at: string;
          batch_id: string | null;
          duration_ms: number | null;
          endpoint: string;
          http_status: number | null;
          id: number;
          org_id: string;
          outcome: string;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          batch_id?: string | null;
          duration_ms?: number | null;
          endpoint: string;
          http_status?: number | null;
          id?: number;
          org_id: string;
          outcome: string;
        };
        Update: {
          at?: string;
          batch_id?: string | null;
          duration_ms?: number | null;
          endpoint?: string;
          http_status?: number | null;
          id?: number;
          org_id?: string;
          outcome?: string;
        };
        Relationships: [
          {
            foreignKeyName: "unite_api_calls_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      unite_appointment_status_map: {
        Row: {
          code: string;
          counts_as_no_show: boolean;
          label: string | null;
          org_id: string;
          status: string | null;
        };
        ComputedFields: never;
        Insert: {
          code: string;
          counts_as_no_show?: boolean;
          label?: string | null;
          org_id: string;
          status?: string | null;
        };
        Update: {
          code?: string;
          counts_as_no_show?: boolean;
          label?: string | null;
          org_id?: string;
          status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "unite_appointment_status_map_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      user_grid_prefs: {
        Row: {
          grid_key: string;
          org_id: string;
          prefs: NonNullable<Json>;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          grid_key: string;
          org_id: string;
          prefs?: NonNullable<Json>;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          grid_key?: string;
          org_id?: string;
          prefs?: NonNullable<Json>;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_grid_prefs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_grid_prefs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      visits: {
        Row: {
          bp_diastolic: number | null;
          bp_systolic: number | null;
          complaints: string | null;
          contact_id: string | null;
          created_at: string;
          department_mapped: Database["public"]["Enums"]["department_mapped"] | null;
          department_raw: string | null;
          description: string | null;
          doctor_name: string | null;
          doctor_notes: string | null;
          external_id: string;
          height_cm: number | null;
          hpi: string | null;
          id: string;
          investigation_count: number | null;
          investigations_ordered: string | null;
          is_test_record: boolean;
          location_id: string | null;
          nurse_notes: string | null;
          observation_notes_raw: string | null;
          observation_notes_scrubbed: string | null;
          org_id: string;
          pap_result: Database["public"]["Enums"]["pap_result"] | null;
          physical_exam_notes: string | null;
          plan_of_treatment: string | null;
          primary_diagnosis_code: string | null;
          primary_diagnosis_text: string | null;
          procedure_notes: string | null;
          pulse: number | null;
          review_of_systems: string | null;
          scrub_version: number | null;
          secondary_diagnosis_codes: string | null;
          source: string;
          specialist_id: string | null;
          spo2: number | null;
          symptomatic: boolean | null;
          temp_c: number | null;
          therapy_notes: string | null;
          updated_at: string;
          visit_date: string;
          vitals_raw: NonNullable<Json>;
          weight_kg: number | null;
        };
        ComputedFields: never;
        Insert: {
          bp_diastolic?: number | null;
          bp_systolic?: number | null;
          complaints?: string | null;
          contact_id?: string | null;
          created_at?: string;
          department_mapped?: Database["public"]["Enums"]["department_mapped"] | null;
          department_raw?: string | null;
          description?: string | null;
          doctor_name?: string | null;
          doctor_notes?: string | null;
          external_id: string;
          height_cm?: number | null;
          hpi?: string | null;
          id?: string;
          investigation_count?: number | null;
          investigations_ordered?: string | null;
          is_test_record?: boolean;
          location_id?: string | null;
          nurse_notes?: string | null;
          observation_notes_raw?: string | null;
          observation_notes_scrubbed?: string | null;
          org_id: string;
          pap_result?: Database["public"]["Enums"]["pap_result"] | null;
          physical_exam_notes?: string | null;
          plan_of_treatment?: string | null;
          primary_diagnosis_code?: string | null;
          primary_diagnosis_text?: string | null;
          procedure_notes?: string | null;
          pulse?: number | null;
          review_of_systems?: string | null;
          scrub_version?: number | null;
          secondary_diagnosis_codes?: string | null;
          source?: string;
          specialist_id?: string | null;
          spo2?: number | null;
          symptomatic?: boolean | null;
          temp_c?: number | null;
          therapy_notes?: string | null;
          updated_at?: string;
          visit_date: string;
          vitals_raw?: NonNullable<Json>;
          weight_kg?: number | null;
        };
        Update: {
          bp_diastolic?: number | null;
          bp_systolic?: number | null;
          complaints?: string | null;
          contact_id?: string | null;
          created_at?: string;
          department_mapped?: Database["public"]["Enums"]["department_mapped"] | null;
          department_raw?: string | null;
          description?: string | null;
          doctor_name?: string | null;
          doctor_notes?: string | null;
          external_id?: string;
          height_cm?: number | null;
          hpi?: string | null;
          id?: string;
          investigation_count?: number | null;
          investigations_ordered?: string | null;
          is_test_record?: boolean;
          location_id?: string | null;
          nurse_notes?: string | null;
          observation_notes_raw?: string | null;
          observation_notes_scrubbed?: string | null;
          org_id?: string;
          pap_result?: Database["public"]["Enums"]["pap_result"] | null;
          physical_exam_notes?: string | null;
          plan_of_treatment?: string | null;
          primary_diagnosis_code?: string | null;
          primary_diagnosis_text?: string | null;
          procedure_notes?: string | null;
          pulse?: number | null;
          review_of_systems?: string | null;
          scrub_version?: number | null;
          secondary_diagnosis_codes?: string | null;
          source?: string;
          specialist_id?: string | null;
          spo2?: number | null;
          symptomatic?: boolean | null;
          temp_c?: number | null;
          therapy_notes?: string | null;
          updated_at?: string;
          visit_date?: string;
          vitals_raw?: NonNullable<Json>;
          weight_kg?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visits_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visits_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visits_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      visit_rule_evaluations: {
        Row: {
          age_at_visit: number | null;
          created_at: string;
          dedupe_key: string | null;
          department_effective: Database["public"]["Enums"]["department_mapped"] | null;
          engine_version: string;
          evaluated_at: string;
          follow_up_due_date: string | null;
          id: string;
          inputs_hash: string | null;
          is_current: boolean;
          missing_settings: string[];
          org_id: string;
          rules_fired: string[];
          settings_snapshot: NonNullable<Json>;
          trigger_category: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at: string;
          visit_id: string;
          vitals_complete: boolean | null;
        };
        ComputedFields: never;
        Insert: {
          age_at_visit?: number | null;
          created_at?: string;
          dedupe_key?: string | null;
          department_effective?: Database["public"]["Enums"]["department_mapped"] | null;
          engine_version: string;
          evaluated_at?: string;
          follow_up_due_date?: string | null;
          id?: string;
          inputs_hash?: string | null;
          is_current?: boolean;
          missing_settings?: string[];
          org_id: string;
          rules_fired?: string[];
          settings_snapshot?: NonNullable<Json>;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
          visit_id: string;
          vitals_complete?: boolean | null;
        };
        Update: {
          age_at_visit?: number | null;
          created_at?: string;
          dedupe_key?: string | null;
          department_effective?: Database["public"]["Enums"]["department_mapped"] | null;
          engine_version?: string;
          evaluated_at?: string;
          follow_up_due_date?: string | null;
          id?: string;
          inputs_hash?: string | null;
          is_current?: boolean;
          missing_settings?: string[];
          org_id?: string;
          rules_fired?: string[];
          settings_snapshot?: NonNullable<Json>;
          trigger_category?: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at?: string;
          visit_id?: string;
          vitals_complete?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "visit_rule_evaluations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visit_rule_evaluations_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "visit_rule_evaluations_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
            referencedColumns: ["id"];
          },
        ];
      };
      wa_templates: {
        Row: {
          archived_at: string | null;
          category: string;
          channel_id: string | null;
          clinical_approval: string;
          components: NonNullable<Json>;
          created_at: string;
          id: string;
          internal_key: string | null;
          language: string;
          last_synced_at: string | null;
          meta_template_id: string | null;
          name: string;
          org_id: string;
          parameter_format: string;
          quality: string | null;
          rejected_reason: string | null;
          retry_on_fail: boolean;
          status: string;
          type: string;
          updated_at: string;
          variable_map: NonNullable<Json>;
          waba_id: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          category?: string;
          channel_id?: string | null;
          clinical_approval?: string;
          components?: NonNullable<Json>;
          created_at?: string;
          id?: string;
          internal_key?: string | null;
          language: string;
          last_synced_at?: string | null;
          meta_template_id?: string | null;
          name: string;
          org_id: string;
          parameter_format?: string;
          quality?: string | null;
          rejected_reason?: string | null;
          retry_on_fail?: boolean;
          status?: string;
          type?: string;
          updated_at?: string;
          variable_map?: NonNullable<Json>;
          waba_id: string;
        };
        Update: {
          archived_at?: string | null;
          category?: string;
          channel_id?: string | null;
          clinical_approval?: string;
          components?: NonNullable<Json>;
          created_at?: string;
          id?: string;
          internal_key?: string | null;
          language?: string;
          last_synced_at?: string | null;
          meta_template_id?: string | null;
          name?: string;
          org_id?: string;
          parameter_format?: string;
          quality?: string | null;
          rejected_reason?: string | null;
          retry_on_fail?: boolean;
          status?: string;
          type?: string;
          updated_at?: string;
          variable_map?: NonNullable<Json>;
          waba_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "wa_templates_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "wa_templates_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      webhook_events_in: {
        Row: {
          attempts: number;
          error: string | null;
          id: string;
          payload: NonNullable<Json>;
          processed_at: string | null;
          received_at: string;
          source: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          error?: string | null;
          id?: string;
          payload: NonNullable<Json>;
          processed_at?: string | null;
          received_at?: string;
          source?: string;
        };
        Update: {
          attempts?: number;
          error?: string | null;
          id?: string;
          payload?: NonNullable<Json>;
          processed_at?: string | null;
          received_at?: string;
          source?: string;
        };
        Relationships: [];
      };
      working_hours: {
        Row: {
          created_at: string;
          end_min: number;
          id: string;
          location_id: string;
          org_id: string;
          specialist_id: string;
          start_min: number;
          updated_at: string;
          weekday: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          end_min: number;
          id?: string;
          location_id: string;
          org_id: string;
          specialist_id: string;
          start_min: number;
          updated_at?: string;
          weekday: number;
        };
        Update: {
          created_at?: string;
          end_min?: number;
          id?: string;
          location_id?: string;
          org_id?: string;
          specialist_id?: string;
          start_min?: number;
          updated_at?: string;
          weekday?: number;
        };
        Relationships: [
          {
            foreignKeyName: "working_hours_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "working_hours_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "working_hours_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      v_appointment_reminder_stats: {
        Row: {
          external_status: string | null;
          location_id: string | null;
          org_id: string | null;
          patients_contacted: number | null;
          reminders_excluded: number | null;
          reminders_failed: number | null;
          reminders_sent: number | null;
          sent_day: string | null;
          specialist_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "appointments_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      v_visit_data_quality: {
        Row: {
          contact_id: string | null;
          external_id: string | null;
          missing_bp: boolean | null;
          missing_pulse: boolean | null;
          missing_spo2: boolean | null;
          missing_temp: boolean | null;
          org_id: string | null;
          unmatched_patient: boolean | null;
          visit_date: string | null;
          visit_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          external_id?: string | null;
          missing_bp?: never;
          missing_pulse?: never;
          missing_spo2?: never;
          missing_temp?: never;
          org_id?: string | null;
          unmatched_patient?: never;
          visit_date?: string | null;
          visit_id?: string | null;
        };
        Update: {
          contact_id?: string | null;
          external_id?: string | null;
          missing_bp?: never;
          missing_pulse?: never;
          missing_spo2?: never;
          missing_temp?: never;
          org_id?: string | null;
          unmatched_patient?: never;
          visit_date?: string | null;
          visit_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visits_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_unclassified_medications: {
        Row: {
          first_seen: string | null;
          last_seen: string | null;
          medication_code: string | null;
          medication_name: string | null;
          org_id: string | null;
          prescription_count: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "prescriptions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_followup_queue: {
        Row: {
          age_at_visit: number | null;
          assigned_team_id: string | null;
          assigned_user_id: string | null;
          call_status: Database["public"]["Enums"]["call_status"] | null;
          closed_at: string | null;
          closed_reason: string | null;
          contact_id: string | null;
          created_at: string | null;
          dedupe_key: string | null;
          department_effective: Database["public"]["Enums"]["department_mapped"] | null;
          doctor_alert_required: boolean | null;
          doctor_name: string | null;
          doctor_notified_at: string | null;
          doctor_response_notes: string | null;
          due_date: string | null;
          escalation_status: Database["public"]["Enums"]["escalation_status"] | null;
          id: string | null;
          is_test_record: boolean | null;
          notes: string | null;
          org_id: string | null;
          outcome: Database["public"]["Enums"]["followup_outcome"] | null;
          prescription_id: string | null;
          priority: Database["public"]["Enums"]["followup_priority"] | null;
          ref: string | null;
          rule_evaluation_id: string | null;
          rules_fired: string[] | null;
          source: string | null;
          trigger_category: Database["public"]["Enums"]["trigger_category"] | null;
          updated_at: string | null;
          visit_date: string | null;
          visit_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "clinical_followups_assigned_team_id_fkey";
            columns: ["assigned_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_assigned_user_id_fkey";
            columns: ["assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_prescription_id_fkey";
            columns: ["prescription_id"];
            isOneToOne: false;
            referencedRelation: "prescriptions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_rule_evaluation_id_fkey";
            columns: ["rule_evaluation_id"];
            isOneToOne: false;
            referencedRelation: "visit_rule_evaluations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinical_followups_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "clinical_followups_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      apply_message_status: {
        Args: {
          p_at: string;
          p_error_code?: number;
          p_error_message?: string;
          p_status: string;
          p_wa_message_id: string;
        };
        Returns: boolean;
      };
      claim_scheduled_jobs: {
        Args: { p_limit?: number; p_lock_ttl?: string; p_worker?: string };
        Returns: {
          attempts: number;
          created_at: string;
          dedupe_key: string | null;
          done_at: string | null;
          id: string;
          kind: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          org_id: string | null;
          payload: NonNullable<Json>;
          run_at: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "scheduled_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_send_slot: {
        Args: { p_at?: string; p_channel_id: string; p_limit: number };
        Returns: boolean;
      };
      clinical_setting_num: {
        Args: { p_key: string; p_org: string };
        Returns: number;
      };
      clinical_setting_bool: {
        Args: { p_key: string; p_org: string };
        Returns: boolean;
      };
      clinical_setting: {
        Args: { p_key: string; p_org: string };
        Returns: string;
      };
      complete_scheduled_job: { Args: { p_id: string }; Returns: undefined };
      contact_duplicate_candidates: {
        Args: { p_limit?: number; p_org_id: string };
        Returns: {
          a_id: string;
          b_id: string;
          reason: string;
        }[];
      };
      contacts_count: {
        Args: { p_org_id: string; p_params: Json; p_where: string };
        Returns: number;
      };
      contacts_ids: {
        Args: { p_limit?: number; p_org_id: string; p_params: Json; p_where: string };
        Returns: string[];
      };
      contacts_search: {
        Args: {
          p_limit?: number;
          p_offset?: number;
          p_order_by?: string;
          p_org_id: string;
          p_params: Json;
          p_where: string;
        };
        Returns: {
          id: string;
          total: number;
        }[];
      };
      create_org: {
        Args: { p_name: string; p_owner_id?: string; p_roles: Json; p_slug: string };
        Returns: string;
      };
      dearmor: { Args: { "": string }; Returns: string };
      fail_scheduled_job: {
        Args: { p_error: string; p_id: string; p_retry_in?: string };
        Returns: undefined;
      };
      gen_random_uuid: { Args: Record<PropertyKey, never>; Returns: string };
      gen_salt: { Args: { "": string }; Returns: string };
      is_reminder_excluded: {
        Args: { p_doctor_name: string; p_org: string; p_patient_name: string };
        Returns: boolean;
      };
      job_archive: { Args: { p_msg_ids: number[]; p_queue: string }; Returns: number };
      job_cron_status: {
        Args: Record<PropertyKey, never>;
        Returns: {
          active: boolean;
          jobname: string;
          last_end: string;
          last_start: string;
          last_status: string;
          schedule: string;
        }[];
      };
      job_dead_letter: {
        Args: {
          p_attempts: number;
          p_error: string;
          p_msg_id: number;
          p_payload: Json;
          p_queue: string;
        };
        Returns: number;
      };
      job_enqueue: {
        Args: { p_delay?: number; p_payload: Json; p_queue: string };
        Returns: number;
      };
      job_queue_metrics: {
        Args: Record<PropertyKey, never>;
        Returns: {
          newest_msg_age_sec: number;
          oldest_msg_age_sec: number;
          queue_length: number;
          queue_name: string;
          scrape_time: string;
          total_messages: number;
        }[];
      };
      job_read: {
        Args: { p_qty?: number; p_queue: string; p_vt?: number };
        Returns: {
          enqueued_at: string;
          message: Json;
          msg_id: number;
          read_ct: number;
          vt: string;
        }[];
      };
      job_retry_dead_letter: { Args: { p_id: number; p_user_id?: string }; Returns: number };
      mark_all_notifications_read: { Args: { p_org_id: string }; Returns: number };
      merge_contacts: {
        Args: {
          p_fields?: Json;
          p_org_id: string;
          p_primary_id: string;
          p_secondary_id: string;
          p_user_id?: string;
        };
        Returns: undefined;
      };
      pgp_armor_headers: { Args: { "": string }; Returns: Record<string, unknown>[] };
      pick_round_robin_assignee: { Args: { p_org_id: string; p_team_id: string }; Returns: string };
      seed_unite_appointment_status_map: {
        Args: { p_org: string };
        Returns: undefined;
      };
      seed_clinical_settings: { Args: { p_org: string }; Returns: undefined };
      seed_reminder_exclusions: { Args: { p_org: string }; Returns: undefined };
      set_presence: { Args: { p_org_id: string; p_presence: string }; Returns: undefined };
      show_limit: { Args: Record<PropertyKey, never>; Returns: number };
      show_trgm: { Args: { "": string }; Returns: string[] };
      unite_claim_token_refresh: {
        Args: { p_org: string; p_ttl_seconds?: number };
        Returns: boolean;
      };
      uuid_generate_v1: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_generate_v1mc: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_generate_v3: { Args: { name: string; namespace: string }; Returns: string };
      uuid_generate_v4: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_generate_v5: { Args: { name: string; namespace: string }; Returns: string };
      uuid_nil: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_ns_dns: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_ns_oid: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_ns_url: { Args: Record<PropertyKey, never>; Returns: string };
      uuid_ns_x500: { Args: Record<PropertyKey, never>; Returns: string };
    };
    Enums: {
      call_status: "pending" | "completed" | "escalated" | "no_answer";
      clinical_send_status:
        | "scheduled"
        | "suppressed_gate"
        | "suppressed_test_record"
        | "blocked"
        | "sent"
        | "delivered"
        | "read"
        | "failed"
        | "cancelled";
      clinical_setting_category:
        | "paediatrics"
        | "gp_adults"
        | "gynaecology"
        | "medication_sequence"
        | "escalation"
        | "operational"
        | "recall"
        | "engine";
      department_mapped: "paediatrics" | "gp" | "gynaecology" | "dermatology" | "other";
      escalation_status: "none" | "open" | "escalated" | "resolved";
      feedback_stage:
        "day3_antibiotics" | "after_antibiotics" | "after_probiotics" | "post_procedure";
      followup_outcome: "improving" | "same" | "worse";
      followup_priority: "high" | "medium";
      medication_class:
        "antibiotic" | "steroid" | "probiotic" | "supplement" | "enzyme" | "other" | "unclassified";
      pap_result: "positive" | "negative" | "pending" | "not_available";
      sequence_status:
        | "not_started"
        | "day3_sent"
        | "awaiting_day3_reply"
        | "awaiting_clarification"
        | "awaiting_probiotic"
        | "probiotic_sent"
        | "outcome_sent"
        | "complete"
        | "halted_clinical";
      setting_value_type: "text" | "number" | "boolean" | "json" | "list";
      sign_off_status: "blocking" | "awaiting" | "confirm_exclusion" | "approved";
      trigger_category:
        | "paediatric_high_concern"
        | "bleeding"
        | "vitals"
        | "infection_labs"
        | "post_procedure"
        | "clinical_check";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      call_status: ["pending", "completed", "escalated", "no_answer"],
      clinical_send_status: [
        "scheduled",
        "suppressed_gate",
        "suppressed_test_record",
        "blocked",
        "sent",
        "delivered",
        "read",
        "failed",
        "cancelled",
      ],
      clinical_setting_category: [
        "paediatrics",
        "gp_adults",
        "gynaecology",
        "medication_sequence",
        "escalation",
        "operational",
        "recall",
        "engine",
      ],
      department_mapped: ["paediatrics", "gp", "gynaecology", "dermatology", "other"],
      escalation_status: ["none", "open", "escalated", "resolved"],
      feedback_stage: [
        "day3_antibiotics",
        "after_antibiotics",
        "after_probiotics",
        "post_procedure",
      ],
      followup_outcome: ["improving", "same", "worse"],
      followup_priority: ["high", "medium"],
      medication_class: [
        "antibiotic",
        "steroid",
        "probiotic",
        "supplement",
        "enzyme",
        "other",
        "unclassified",
      ],
      pap_result: ["positive", "negative", "pending", "not_available"],
      sequence_status: [
        "not_started",
        "day3_sent",
        "awaiting_day3_reply",
        "awaiting_clarification",
        "awaiting_probiotic",
        "probiotic_sent",
        "outcome_sent",
        "complete",
        "halted_clinical",
      ],
      setting_value_type: ["text", "number", "boolean", "json", "list"],
      sign_off_status: ["blocking", "awaiting", "confirm_exclusion", "approved"],
      trigger_category: [
        "paediatric_high_concern",
        "bleeding",
        "vitals",
        "infection_labs",
        "post_procedure",
        "clinical_check",
      ],
    },
  },
} as const;
