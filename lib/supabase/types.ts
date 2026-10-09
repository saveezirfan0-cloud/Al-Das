export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      ai_usage: {
        Row: {
          conversation_id: string | null;
          created_at: string;
          feature: string;
          id: string;
          input_tokens: number;
          latency_ms: number;
          model: string;
          org_id: string;
          output_tokens: number;
          status: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          conversation_id?: string | null;
          created_at?: string;
          feature: string;
          id?: string;
          input_tokens?: number;
          latency_ms?: number;
          model: string;
          org_id: string;
          output_tokens?: number;
          status?: string;
          user_id?: string | null;
        };
        Update: {
          conversation_id?: string | null;
          created_at?: string;
          feature?: string;
          id?: string;
          input_tokens?: number;
          latency_ms?: number;
          model?: string;
          org_id?: string;
          output_tokens?: number;
          status?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_usage_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_usage_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_usage_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_usage_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_usage_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      api_idempotency: {
        Row: {
          api_key_id: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          org_id: string;
          request_hash: string;
          response: Json | null;
          response_status: number | null;
        };
        ComputedFields: never;
        Insert: {
          api_key_id: string;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          org_id: string;
          request_hash: string;
          response?: Json | null;
          response_status?: number | null;
        };
        Update: {
          api_key_id?: string;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          org_id?: string;
          request_hash?: string;
          response?: Json | null;
          response_status?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "api_idempotency_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "api_idempotency_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      api_keys: {
        Row: {
          created_at: string;
          created_by: string | null;
          expires_at: string | null;
          id: string;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          name: string;
          org_id: string;
          revoked_at: string | null;
          scopes: string[];
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          name: string;
          org_id: string;
          revoked_at?: string | null;
          scopes?: string[];
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          expires_at?: string | null;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          name?: string;
          org_id?: string;
          revoked_at?: string | null;
          scopes?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "api_keys_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "api_keys_org_id_fkey";
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
            isOneToOne: true;
            referencedRelation: "orgs";
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
            foreignKeyName: "appointment_reminders_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
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
            foreignKeyName: "appointments_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "appointments_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      campaign_recipients: {
        Row: {
          attempts: number;
          campaign_id: string;
          contact_id: string;
          created_at: string;
          csv_data: NonNullable<Json>;
          delivered_at: string | null;
          dispatched_at: string | null;
          error_code: number | null;
          error_message: string | null;
          failed_at: string | null;
          id: string;
          message_id: string | null;
          org_id: string;
          read_at: string | null;
          replied_at: string | null;
          round: number;
          sent_at: string | null;
          skip_reason: string | null;
          status: string;
          updated_at: string;
          vars: NonNullable<Json>;
          wa_message_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          campaign_id: string;
          contact_id: string;
          created_at?: string;
          csv_data?: NonNullable<Json>;
          delivered_at?: string | null;
          dispatched_at?: string | null;
          error_code?: number | null;
          error_message?: string | null;
          failed_at?: string | null;
          id?: string;
          message_id?: string | null;
          org_id: string;
          read_at?: string | null;
          replied_at?: string | null;
          round?: number;
          sent_at?: string | null;
          skip_reason?: string | null;
          status?: string;
          updated_at?: string;
          vars?: NonNullable<Json>;
          wa_message_id?: string | null;
        };
        Update: {
          attempts?: number;
          campaign_id?: string;
          contact_id?: string;
          created_at?: string;
          csv_data?: NonNullable<Json>;
          delivered_at?: string | null;
          dispatched_at?: string | null;
          error_code?: number | null;
          error_message?: string | null;
          failed_at?: string | null;
          id?: string;
          message_id?: string | null;
          org_id?: string;
          read_at?: string | null;
          replied_at?: string | null;
          round?: number;
          sent_at?: string | null;
          skip_reason?: string | null;
          status?: string;
          updated_at?: string;
          vars?: NonNullable<Json>;
          wa_message_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "v_campaign_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "campaign_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "campaign_recipients_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recipients_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: {
          audience_type: string;
          cancelled_at: string | null;
          channel_id: string;
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          csv_opt_in_confirmed: boolean;
          error: string | null;
          fallbacks: NonNullable<Json>;
          guard_since: string | null;
          guardrails: NonNullable<Json>;
          id: string;
          name: string;
          next_retry_at: string | null;
          org_id: string;
          paused_at: string | null;
          paused_reason: string | null;
          quality_at_start: string | null;
          retry_delay_minutes: number;
          retry_round: number;
          retry_rounds: number;
          scheduled_at: string | null;
          segment_id: string | null;
          started_at: string | null;
          stats: NonNullable<Json>;
          stats_refreshed_at: string | null;
          status: string;
          template_id: string;
          updated_at: string;
          variable_map: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          audience_type: string;
          cancelled_at?: string | null;
          channel_id: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          csv_opt_in_confirmed?: boolean;
          error?: string | null;
          fallbacks?: NonNullable<Json>;
          guard_since?: string | null;
          guardrails?: NonNullable<Json>;
          id?: string;
          name: string;
          next_retry_at?: string | null;
          org_id: string;
          paused_at?: string | null;
          paused_reason?: string | null;
          quality_at_start?: string | null;
          retry_delay_minutes?: number;
          retry_round?: number;
          retry_rounds?: number;
          scheduled_at?: string | null;
          segment_id?: string | null;
          started_at?: string | null;
          stats?: NonNullable<Json>;
          stats_refreshed_at?: string | null;
          status?: string;
          template_id: string;
          updated_at?: string;
          variable_map?: NonNullable<Json>;
        };
        Update: {
          audience_type?: string;
          cancelled_at?: string | null;
          channel_id?: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          csv_opt_in_confirmed?: boolean;
          error?: string | null;
          fallbacks?: NonNullable<Json>;
          guard_since?: string | null;
          guardrails?: NonNullable<Json>;
          id?: string;
          name?: string;
          next_retry_at?: string | null;
          org_id?: string;
          paused_at?: string | null;
          paused_reason?: string | null;
          quality_at_start?: string | null;
          retry_delay_minutes?: number;
          retry_round?: number;
          retry_rounds?: number;
          scheduled_at?: string | null;
          segment_id?: string | null;
          started_at?: string | null;
          stats?: NonNullable<Json>;
          stats_refreshed_at?: string | null;
          status?: string;
          template_id?: string;
          updated_at?: string;
          variable_map?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_segment_id_fkey";
            columns: ["segment_id"];
            isOneToOne: false;
            referencedRelation: "segments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
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
      channel_send_cursor: {
        Row: {
          channel_id: string;
          next_slot: string;
        };
        ComputedFields: never;
        Insert: {
          channel_id: string;
          next_slot: string;
        };
        Update: {
          channel_id?: string;
          next_slot?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_send_cursor_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: true;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_send_slots: {
        Row: {
          booked: number;
          channel_id: string;
          slot: string;
          used: number;
        };
        ComputedFields: never;
        Insert: {
          booked?: number;
          channel_id: string;
          slot: string;
          used?: number;
        };
        Update: {
          booked?: number;
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
      clinic_calendar: {
        Row: {
          created_at: string;
          holidays: string[];
          id: string;
          location_id: string | null;
          org_id: string;
          updated_at: string;
          working_weekdays: number[];
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          holidays?: string[];
          id?: string;
          location_id?: string | null;
          org_id: string;
          updated_at?: string;
          working_weekdays?: number[];
        };
        Update: {
          created_at?: string;
          holidays?: string[];
          id?: string;
          location_id?: string | null;
          org_id?: string;
          updated_at?: string;
          working_weekdays?: number[];
        };
        Relationships: [
          {
            foreignKeyName: "clinic_calendar_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clinic_calendar_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
            foreignKeyName: "clinical_feedback_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "clinical_feedback_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
            foreignKeyName: "clinical_followups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "clinical_followups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
            foreignKeyName: "clinical_message_log_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "clinical_message_log_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      contact_chronic_conditions: {
        Row: {
          contact_id: string;
          noted_at: string | null;
          org_id: string;
          ref_diagnosis_id: string;
          source: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          noted_at?: string | null;
          org_id: string;
          ref_diagnosis_id: string;
          source?: string;
        };
        Update: {
          contact_id?: string;
          noted_at?: string | null;
          org_id?: string;
          ref_diagnosis_id?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_chronic_conditions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_chronic_conditions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contact_chronic_conditions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contact_chronic_conditions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_chronic_conditions_ref_diagnosis_id_fkey";
            columns: ["ref_diagnosis_id"];
            isOneToOne: false;
            referencedRelation: "ref_diagnoses";
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
            foreignKeyName: "contact_phones_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contact_phones_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
            foreignKeyName: "contact_tags_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contact_tags_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
            foreignKeyName: "contacts_merged_into_id_fkey";
            columns: ["merged_into_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contacts_merged_into_id_fkey";
            columns: ["merged_into_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
            foreignKeyName: "conversation_labels_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_labels_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
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
          campaign_only: boolean;
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
          campaign_only?: boolean;
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
          campaign_only?: boolean;
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
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "conversations_flow_run_fk";
            columns: ["flow_run_id"];
            isOneToOne: false;
            referencedRelation: "flow_runs";
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
      enquiries: {
        Row: {
          appt_date: string | null;
          assignee_id: string | null;
          channel_id: string | null;
          closed_at: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          deleted_at: string | null;
          department_id: string | null;
          est_value: number | null;
          first_touch_at: string | null;
          id: string;
          location_id: string | null;
          lost_reason: string | null;
          number: number;
          org_id: string;
          pipeline_id: string;
          service_id: string | null;
          sla_breached_at: string | null;
          sla_due_at: string | null;
          source: string | null;
          specialist_id: string | null;
          stage_entered_at: string;
          stage_id: string;
          status: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appt_date?: string | null;
          assignee_id?: string | null;
          channel_id?: string | null;
          closed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          deleted_at?: string | null;
          department_id?: string | null;
          est_value?: number | null;
          first_touch_at?: string | null;
          id?: string;
          location_id?: string | null;
          lost_reason?: string | null;
          number?: number;
          org_id: string;
          pipeline_id: string;
          service_id?: string | null;
          sla_breached_at?: string | null;
          sla_due_at?: string | null;
          source?: string | null;
          specialist_id?: string | null;
          stage_entered_at?: string;
          stage_id: string;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          appt_date?: string | null;
          assignee_id?: string | null;
          channel_id?: string | null;
          closed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          deleted_at?: string | null;
          department_id?: string | null;
          est_value?: number | null;
          first_touch_at?: string | null;
          id?: string;
          location_id?: string | null;
          lost_reason?: string | null;
          number?: number;
          org_id?: string;
          pipeline_id?: string;
          service_id?: string | null;
          sla_breached_at?: string | null;
          sla_due_at?: string | null;
          source?: string | null;
          specialist_id?: string | null;
          stage_entered_at?: string;
          stage_id?: string;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "enquiries_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "enquiries_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "enquiries_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_department_id_fkey";
            columns: ["department_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id"];
          },
        ];
      };
      enquiry_assignment_rules: {
        Row: {
          action: NonNullable<Json>;
          conditions: NonNullable<Json>;
          created_at: string;
          enabled: boolean;
          id: string;
          name: string;
          org_id: string;
          sort: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          action: NonNullable<Json>;
          conditions?: NonNullable<Json>;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          name: string;
          org_id: string;
          sort?: number;
          updated_at?: string;
        };
        Update: {
          action?: NonNullable<Json>;
          conditions?: NonNullable<Json>;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          name?: string;
          org_id?: string;
          sort?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "enquiry_assignment_rules_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      enquiry_counters: {
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
            foreignKeyName: "enquiry_counters_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      enquiry_views: {
        Row: {
          columns: NonNullable<Json>;
          created_at: string;
          filter: NonNullable<Json>;
          id: string;
          mode: string;
          name: string;
          org_id: string;
          owner_id: string;
          pipeline_id: string | null;
          shared_all: boolean;
          shared_team_ids: string[];
          sort: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          columns?: NonNullable<Json>;
          created_at?: string;
          filter?: NonNullable<Json>;
          id?: string;
          mode?: string;
          name: string;
          org_id: string;
          owner_id: string;
          pipeline_id?: string | null;
          shared_all?: boolean;
          shared_team_ids?: string[];
          sort?: number;
          updated_at?: string;
        };
        Update: {
          columns?: NonNullable<Json>;
          created_at?: string;
          filter?: NonNullable<Json>;
          id?: string;
          mode?: string;
          name?: string;
          org_id?: string;
          owner_id?: string;
          pipeline_id?: string | null;
          shared_all?: boolean;
          shared_team_ids?: string[];
          sort?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "enquiry_views_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiry_views_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiry_views_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
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
      fin_alert_state: {
        Row: {
          alert_key: string;
          cleared_at: string | null;
          first_seen_at: string;
          last_notified_at: string | null;
          org_id: string;
          severity: string;
        };
        ComputedFields: never;
        Insert: {
          alert_key: string;
          cleared_at?: string | null;
          first_seen_at?: string;
          last_notified_at?: string | null;
          org_id: string;
          severity: string;
        };
        Update: {
          alert_key?: string;
          cleared_at?: string | null;
          first_seen_at?: string;
          last_notified_at?: string | null;
          org_id?: string;
          severity?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_alert_state_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_capture_lease: {
        Row: {
          holder: string;
          leased_until: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          holder: string;
          leased_until: string;
          org_id: string;
        };
        Update: {
          holder?: string;
          leased_until?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_capture_lease_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_capture_settings: {
        Row: {
          batch_size: number;
          created_at: string;
          digest_enabled: boolean;
          enabled: boolean;
          max_batches_per_run: number;
          org_id: string;
          updated_at: string;
          updated_by: string | null;
          window_from: string;
        };
        ComputedFields: never;
        Insert: {
          batch_size?: number;
          created_at?: string;
          digest_enabled?: boolean;
          enabled?: boolean;
          max_batches_per_run?: number;
          org_id: string;
          updated_at?: string;
          updated_by?: string | null;
          window_from?: string;
        };
        Update: {
          batch_size?: number;
          created_at?: string;
          digest_enabled?: boolean;
          enabled?: boolean;
          max_batches_per_run?: number;
          org_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          window_from?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_capture_settings_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_capture_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_invoice_lines: {
        Row: {
          actual_cost_price: number | null;
          cpt_code: string | null;
          created_at: string;
          id: string;
          invoice_id: string;
          is_current: boolean;
          is_package_item: boolean;
          item_code: string | null;
          item_short_desc: string | null;
          item_type: string | null;
          line_discount: number | null;
          line_gross: number | null;
          line_key: string;
          line_net: number | null;
          line_price: number | null;
          line_remarks: string | null;
          org_id: string;
          position: number;
          qty: number | null;
          total: number | null;
          updated_at: string;
          vat: number | null;
          vat_applicable: boolean | null;
        };
        ComputedFields: never;
        Insert: {
          actual_cost_price?: number | null;
          cpt_code?: string | null;
          created_at?: string;
          id?: string;
          invoice_id: string;
          is_current?: boolean;
          is_package_item?: boolean;
          item_code?: string | null;
          item_short_desc?: string | null;
          item_type?: string | null;
          line_discount?: number | null;
          line_gross?: number | null;
          line_key: string;
          line_net?: number | null;
          line_price?: number | null;
          line_remarks?: string | null;
          org_id: string;
          position: number;
          qty?: number | null;
          total?: number | null;
          updated_at?: string;
          vat?: number | null;
          vat_applicable?: boolean | null;
        };
        Update: {
          actual_cost_price?: number | null;
          cpt_code?: string | null;
          created_at?: string;
          id?: string;
          invoice_id?: string;
          is_current?: boolean;
          is_package_item?: boolean;
          item_code?: string | null;
          item_short_desc?: string | null;
          item_type?: string | null;
          line_discount?: number | null;
          line_gross?: number | null;
          line_key?: string;
          line_net?: number | null;
          line_price?: number | null;
          line_remarks?: string | null;
          org_id?: string;
          position?: number;
          qty?: number | null;
          total?: number | null;
          updated_at?: string;
          vat?: number | null;
          vat_applicable?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_invoice_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_invoice_versions: {
        Row: {
          batch_id: string | null;
          id: string;
          invoice_id: string;
          org_id: string;
          received_at: string;
          record: NonNullable<Json>;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          batch_id?: string | null;
          id?: string;
          invoice_id: string;
          org_id: string;
          received_at?: string;
          record: NonNullable<Json>;
          version: number;
        };
        Update: {
          batch_id?: string | null;
          id?: string;
          invoice_id?: string;
          org_id?: string;
          received_at?: string;
          record?: NonNullable<Json>;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_invoice_versions_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_unite_batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_versions_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_versions_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_versions_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_invoice_versions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_invoices: {
        Row: {
          appointment_id: string | null;
          branch_code: string | null;
          created_at: string;
          created_by: string | null;
          credit_note: number | null;
          department: string | null;
          discount: number | null;
          doctor_dha_id: string | null;
          doctor_name: string | null;
          first_received_at: string;
          gross: number | null;
          id: string;
          inv_display_number: string;
          inv_key: string | null;
          inv_type: string | null;
          is_deleted: boolean;
          is_package: boolean;
          last_batch_id: string | null;
          last_received_at: string;
          modified_by: string | null;
          net: number | null;
          org_id: string;
          patient_pin: string | null;
          record_hash: string;
          ref_type: string | null;
          referral_clinic: string | null;
          referral_clinic_id: string | null;
          referral_doctor: string | null;
          referral_doctor_id: string | null;
          specialty: string | null;
          total: number | null;
          transaction_date: string | null;
          unite_bu_short_name: string | null;
          unite_clinic_long_name: string | null;
          updated_at: string;
          vat: number | null;
          vat_applicable: boolean | null;
          version: number;
          write_off: number | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          branch_code?: string | null;
          created_at?: string;
          created_by?: string | null;
          credit_note?: number | null;
          department?: string | null;
          discount?: number | null;
          doctor_dha_id?: string | null;
          doctor_name?: string | null;
          first_received_at?: string;
          gross?: number | null;
          id?: string;
          inv_display_number: string;
          inv_key?: never;
          inv_type?: string | null;
          is_deleted?: boolean;
          is_package?: boolean;
          last_batch_id?: string | null;
          last_received_at?: string;
          modified_by?: string | null;
          net?: number | null;
          org_id: string;
          patient_pin?: string | null;
          record_hash: string;
          ref_type?: string | null;
          referral_clinic?: string | null;
          referral_clinic_id?: string | null;
          referral_doctor?: string | null;
          referral_doctor_id?: string | null;
          specialty?: string | null;
          total?: number | null;
          transaction_date?: string | null;
          unite_bu_short_name?: string | null;
          unite_clinic_long_name?: string | null;
          updated_at?: string;
          vat?: number | null;
          vat_applicable?: boolean | null;
          version?: number;
          write_off?: number | null;
        };
        Update: {
          appointment_id?: string | null;
          branch_code?: string | null;
          created_at?: string;
          created_by?: string | null;
          credit_note?: number | null;
          department?: string | null;
          discount?: number | null;
          doctor_dha_id?: string | null;
          doctor_name?: string | null;
          first_received_at?: string;
          gross?: number | null;
          id?: string;
          inv_display_number?: string;
          inv_key?: never;
          inv_type?: string | null;
          is_deleted?: boolean;
          is_package?: boolean;
          last_batch_id?: string | null;
          last_received_at?: string;
          modified_by?: string | null;
          net?: number | null;
          org_id?: string;
          patient_pin?: string | null;
          record_hash?: string;
          ref_type?: string | null;
          referral_clinic?: string | null;
          referral_clinic_id?: string | null;
          referral_doctor?: string | null;
          referral_doctor_id?: string | null;
          specialty?: string | null;
          total?: number | null;
          transaction_date?: string | null;
          unite_bu_short_name?: string | null;
          unite_clinic_long_name?: string | null;
          updated_at?: string;
          vat?: number | null;
          vat_applicable?: boolean | null;
          version?: number;
          write_off?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_invoices_last_batch_id_fkey";
            columns: ["last_batch_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_unite_batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_payments: {
        Row: {
          advance_added: number | null;
          card_type: string | null;
          collected: number | null;
          created_at: string;
          id: string;
          instalment: string | null;
          invoice_id: string;
          is_current: boolean;
          org_id: string;
          paid: number | null;
          paid_date: string | null;
          payment_key: string;
          payment_mode: string | null;
          receipt_number: string | null;
          refund: number | null;
          refund_date: string | null;
          remarks: string | null;
          returned: number | null;
          surcharge: number | null;
          txn_ref_name: string | null;
          txn_ref_no: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          advance_added?: number | null;
          card_type?: string | null;
          collected?: number | null;
          created_at?: string;
          id?: string;
          instalment?: string | null;
          invoice_id: string;
          is_current?: boolean;
          org_id: string;
          paid?: number | null;
          paid_date?: string | null;
          payment_key: string;
          payment_mode?: string | null;
          receipt_number?: string | null;
          refund?: number | null;
          refund_date?: string | null;
          remarks?: string | null;
          returned?: number | null;
          surcharge?: number | null;
          txn_ref_name?: string | null;
          txn_ref_no?: string | null;
          updated_at?: string;
        };
        Update: {
          advance_added?: number | null;
          card_type?: string | null;
          collected?: number | null;
          created_at?: string;
          id?: string;
          instalment?: string | null;
          invoice_id?: string;
          is_current?: boolean;
          org_id?: string;
          paid?: number | null;
          paid_date?: string | null;
          payment_key?: string;
          payment_mode?: string | null;
          receipt_number?: string | null;
          refund?: number | null;
          refund_date?: string | null;
          remarks?: string | null;
          returned?: number | null;
          surcharge?: number | null;
          txn_ref_name?: string | null;
          txn_ref_no?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_payments_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payments_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payments_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_payments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_raw_diligence_files: {
        Row: {
          commit_summary: NonNullable<Json>;
          committed_at: string | null;
          committed_by: string | null;
          errors: NonNullable<Json>;
          file_name: string | null;
          file_sha256: string;
          header_check: NonNullable<Json>;
          id: string;
          org_id: string;
          row_count: number | null;
          status: string;
          storage_path: string;
          sum_net: number | null;
          sum_rejected: number | null;
          sum_remitted: number | null;
          uploaded_at: string;
          uploaded_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          commit_summary?: NonNullable<Json>;
          committed_at?: string | null;
          committed_by?: string | null;
          errors?: NonNullable<Json>;
          file_name?: string | null;
          file_sha256: string;
          header_check?: NonNullable<Json>;
          id?: string;
          org_id: string;
          row_count?: number | null;
          status?: string;
          storage_path: string;
          sum_net?: number | null;
          sum_rejected?: number | null;
          sum_remitted?: number | null;
          uploaded_at?: string;
          uploaded_by?: string | null;
        };
        Update: {
          commit_summary?: NonNullable<Json>;
          committed_at?: string | null;
          committed_by?: string | null;
          errors?: NonNullable<Json>;
          file_name?: string | null;
          file_sha256?: string;
          header_check?: NonNullable<Json>;
          id?: string;
          org_id?: string;
          row_count?: number | null;
          status?: string;
          storage_path?: string;
          sum_net?: number | null;
          sum_rejected?: number | null;
          sum_remitted?: number | null;
          uploaded_at?: string;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_raw_diligence_files_committed_by_fkey";
            columns: ["committed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_raw_diligence_files_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_raw_diligence_files_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_raw_unite_batches: {
        Row: {
          balance_in_range: number | null;
          balance_overall: number | null;
          count_requested: number;
          created_at: string;
          detail_message: string | null;
          error: string | null;
          from_date: string;
          http_status: number | null;
          id: string;
          message_status: string | null;
          org_id: string;
          payload: Json | null;
          payload_sha256: string | null;
          payload_stripped_at: string | null;
          process_counts: NonNullable<Json>;
          process_status: string;
          processed_at: string | null;
          record_count: number | null;
          requested_at: string;
          to_date: string;
        };
        ComputedFields: never;
        Insert: {
          balance_in_range?: number | null;
          balance_overall?: number | null;
          count_requested: number;
          created_at?: string;
          detail_message?: string | null;
          error?: string | null;
          from_date: string;
          http_status?: number | null;
          id?: string;
          message_status?: string | null;
          org_id: string;
          payload?: Json | null;
          payload_sha256?: string | null;
          payload_stripped_at?: string | null;
          process_counts?: NonNullable<Json>;
          process_status?: string;
          processed_at?: string | null;
          record_count?: number | null;
          requested_at?: string;
          to_date: string;
        };
        Update: {
          balance_in_range?: number | null;
          balance_overall?: number | null;
          count_requested?: number;
          created_at?: string;
          detail_message?: string | null;
          error?: string | null;
          from_date?: string;
          http_status?: number | null;
          id?: string;
          message_status?: string | null;
          org_id?: string;
          payload?: Json | null;
          payload_sha256?: string | null;
          payload_stripped_at?: string | null;
          process_counts?: NonNullable<Json>;
          process_status?: string;
          processed_at?: string | null;
          record_count?: number | null;
          requested_at?: string;
          to_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_raw_unite_batches_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_branches: {
        Row: {
          active: boolean;
          code: string;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          unite_clinic_long_name: string | null;
          unite_clinic_short_name: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          code: string;
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
          unite_clinic_long_name?: string | null;
          unite_clinic_short_name?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          code?: string;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          unite_clinic_long_name?: string | null;
          unite_clinic_short_name?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_branches_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_doctors: {
        Row: {
          active: boolean;
          created_at: string;
          department: string | null;
          dha_id: string;
          name: string | null;
          org_id: string;
          specialty: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          department?: string | null;
          dha_id: string;
          name?: string | null;
          org_id: string;
          specialty?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          department?: string | null;
          dha_id?: string;
          name?: string | null;
          org_id?: string;
          specialty?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_doctors_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_exception_rules: {
        Row: {
          active: boolean;
          created_at: string;
          description: string;
          due_days: number;
          org_id: string;
          owner_role: string;
          rule_code: string;
          threshold_days: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          description: string;
          due_days?: number;
          org_id: string;
          owner_role: string;
          rule_code: string;
          threshold_days?: number | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          description?: string;
          due_days?: number;
          org_id?: string;
          owner_role?: string;
          rule_code?: string;
          threshold_days?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_exception_rules_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_payers: {
        Row: {
          created_at: string;
          org_id: string;
          payer_id: string;
          payer_name: string | null;
          receiver_id: string | null;
          receiver_name: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          org_id: string;
          payer_id: string;
          payer_name?: string | null;
          receiver_id?: string | null;
          receiver_name?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          org_id?: string;
          payer_id?: string;
          payer_name?: string | null;
          receiver_id?: string | null;
          receiver_name?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_payers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_services: {
        Row: {
          cpt_code: string | null;
          created_at: string;
          description: string | null;
          item_code: string;
          item_type: string | null;
          org_id: string;
          service_category: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          cpt_code?: string | null;
          created_at?: string;
          description?: string | null;
          item_code: string;
          item_type?: string | null;
          org_id: string;
          service_category?: string;
          updated_at?: string;
        };
        Update: {
          cpt_code?: string | null;
          created_at?: string;
          description?: string | null;
          item_code?: string;
          item_type?: string | null;
          org_id?: string;
          service_category?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_services_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      flow_locks: {
        Row: {
          expires_at: string;
          key: string;
          owner: string;
        };
        ComputedFields: never;
        Insert: {
          expires_at: string;
          key: string;
          owner: string;
        };
        Update: {
          expires_at?: string;
          key?: string;
          owner?: string;
        };
        Relationships: [];
      };
      flow_run_steps: {
        Row: {
          at: string;
          error: string | null;
          finished_at: string | null;
          id: string;
          input: Json | null;
          node_id: string;
          node_type: string;
          org_id: string;
          output: Json | null;
          run_id: string;
          seq: number;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json | null;
          node_id: string;
          node_type: string;
          org_id: string;
          output?: Json | null;
          run_id: string;
          seq: number;
          status?: string;
        };
        Update: {
          at?: string;
          error?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json | null;
          node_id?: string;
          node_type?: string;
          org_id?: string;
          output?: Json | null;
          run_id?: string;
          seq?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flow_run_steps_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_run_steps_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "flow_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      flow_runs: {
        Row: {
          contact_id: string | null;
          context: NonNullable<Json>;
          conversation_id: string | null;
          created_at: string;
          current_node_id: string | null;
          ended_at: string | null;
          enquiry_id: string | null;
          error: string | null;
          flow_id: string;
          flow_version: number;
          id: string;
          org_id: string;
          parent_run_id: string | null;
          started_at: string;
          started_by: string | null;
          status: string;
          step_count: number;
          updated_at: string;
          waiting_for: Json | null;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          context?: NonNullable<Json>;
          conversation_id?: string | null;
          created_at?: string;
          current_node_id?: string | null;
          ended_at?: string | null;
          enquiry_id?: string | null;
          error?: string | null;
          flow_id: string;
          flow_version: number;
          id?: string;
          org_id: string;
          parent_run_id?: string | null;
          started_at?: string;
          started_by?: string | null;
          status?: string;
          step_count?: number;
          updated_at?: string;
          waiting_for?: Json | null;
        };
        Update: {
          contact_id?: string | null;
          context?: NonNullable<Json>;
          conversation_id?: string | null;
          created_at?: string;
          current_node_id?: string | null;
          ended_at?: string | null;
          enquiry_id?: string | null;
          error?: string | null;
          flow_id?: string;
          flow_version?: number;
          id?: string;
          org_id?: string;
          parent_run_id?: string | null;
          started_at?: string;
          started_by?: string | null;
          status?: string;
          step_count?: number;
          updated_at?: string;
          waiting_for?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "flow_runs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_runs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "flow_runs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "flow_runs_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_runs_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "flow_runs_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "flow_runs_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "flows";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_runs_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "v_flow_run_counts";
            referencedColumns: ["flow_id"];
          },
          {
            foreignKeyName: "flow_runs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_runs_parent_run_id_fkey";
            columns: ["parent_run_id"];
            isOneToOne: false;
            referencedRelation: "flow_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_runs_started_by_fkey";
            columns: ["started_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      flow_variables: {
        Row: {
          created_at: string;
          enabled: boolean;
          id: string;
          key: string;
          org_id: string;
          updated_at: string;
          value: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          enabled?: boolean;
          id?: string;
          key: string;
          org_id: string;
          updated_at?: string;
          value?: string;
        };
        Update: {
          created_at?: string;
          enabled?: boolean;
          id?: string;
          key?: string;
          org_id?: string;
          updated_at?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "flow_variables_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      flow_versions: {
        Row: {
          flow_id: string;
          graph: NonNullable<Json>;
          org_id: string;
          published_at: string;
          published_by: string | null;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          flow_id: string;
          graph: NonNullable<Json>;
          org_id: string;
          published_at?: string;
          published_by?: string | null;
          version: number;
        };
        Update: {
          flow_id?: string;
          graph?: NonNullable<Json>;
          org_id?: string;
          published_at?: string;
          published_by?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "flow_versions_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "flows";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_versions_flow_id_fkey";
            columns: ["flow_id"];
            isOneToOne: false;
            referencedRelation: "v_flow_run_counts";
            referencedColumns: ["flow_id"];
          },
          {
            foreignKeyName: "flow_versions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flow_versions_published_by_fkey";
            columns: ["published_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      flows: {
        Row: {
          channel_id: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          graph: NonNullable<Json>;
          id: string;
          last_triggered_at: string | null;
          name: string;
          org_id: string;
          pipeline_id: string | null;
          published_at: string | null;
          published_graph: Json | null;
          status: string;
          trigger_config: NonNullable<Json>;
          trigger_type: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          channel_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          graph?: NonNullable<Json>;
          id?: string;
          last_triggered_at?: string | null;
          name: string;
          org_id: string;
          pipeline_id?: string | null;
          published_at?: string | null;
          published_graph?: Json | null;
          status?: string;
          trigger_config?: NonNullable<Json>;
          trigger_type?: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          channel_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          graph?: NonNullable<Json>;
          id?: string;
          last_triggered_at?: string | null;
          name?: string;
          org_id?: string;
          pipeline_id?: string | null;
          published_at?: string | null;
          published_graph?: Json | null;
          status?: string;
          trigger_config?: NonNullable<Json>;
          trigger_type?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "flows_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flows_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "flows_org_id_fkey";
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
      ins_claim_activities: {
        Row: {
          activity_start_date: string | null;
          claim_activity_number: string;
          claim_month: number | null;
          claim_status: string | null;
          claim_year: number | null;
          clinician_id: string | null;
          clinician_mismatch: boolean;
          cpt_category: string | null;
          cpt_code: string | null;
          cpt_type: string | null;
          created_at: string;
          denial_category: string | null;
          denial_comment: string | null;
          denial_type: string | null;
          diagnosis_text: string | null;
          encounter_type: string | null;
          first_remittance_date: string | null;
          first_seen_file_id: string | null;
          id: string;
          initial_denial_code: string | null;
          initial_denial_type: string | null;
          initial_net: number | null;
          initial_rejected: number | null;
          invoice_no: string | null;
          last_denial_code: string | null;
          last_remittance_date: string | null;
          last_remitted: number | null;
          last_resubmission_date: string | null;
          last_seen_file_id: string | null;
          match_reason: string | null;
          match_status: string;
          matched_at: string | null;
          matched_invoice_id: string | null;
          matched_line_id: string | null;
          net: number | null;
          ordering_clinician_id: string | null;
          org_id: string;
          payer_id: string | null;
          payment_reference: string | null;
          payment_status: string | null;
          principal_diagnosis: string | null;
          prior_auth_id: string | null;
          quantity: number | null;
          receipt_status: string | null;
          receiver_id: string | null;
          rejected: number | null;
          remittance_count: number | null;
          remitted: number | null;
          resubmission_count: number | null;
          settled: boolean | null;
          transaction_date: string | null;
          unprocessed: number | null;
          updated_at: string;
          write_off: number | null;
          write_off_status: string | null;
        };
        ComputedFields: never;
        Insert: {
          activity_start_date?: string | null;
          claim_activity_number: string;
          claim_month?: number | null;
          claim_status?: string | null;
          claim_year?: number | null;
          clinician_id?: string | null;
          clinician_mismatch?: boolean;
          cpt_category?: string | null;
          cpt_code?: string | null;
          cpt_type?: string | null;
          created_at?: string;
          denial_category?: string | null;
          denial_comment?: string | null;
          denial_type?: string | null;
          diagnosis_text?: string | null;
          encounter_type?: string | null;
          first_remittance_date?: string | null;
          first_seen_file_id?: string | null;
          id?: string;
          initial_denial_code?: string | null;
          initial_denial_type?: string | null;
          initial_net?: number | null;
          initial_rejected?: number | null;
          invoice_no?: string | null;
          last_denial_code?: string | null;
          last_remittance_date?: string | null;
          last_remitted?: number | null;
          last_resubmission_date?: string | null;
          last_seen_file_id?: string | null;
          match_reason?: string | null;
          match_status?: string;
          matched_at?: string | null;
          matched_invoice_id?: string | null;
          matched_line_id?: string | null;
          net?: number | null;
          ordering_clinician_id?: string | null;
          org_id: string;
          payer_id?: string | null;
          payment_reference?: string | null;
          payment_status?: string | null;
          principal_diagnosis?: string | null;
          prior_auth_id?: string | null;
          quantity?: number | null;
          receipt_status?: string | null;
          receiver_id?: string | null;
          rejected?: number | null;
          remittance_count?: number | null;
          remitted?: number | null;
          resubmission_count?: number | null;
          settled?: boolean | null;
          transaction_date?: string | null;
          unprocessed?: number | null;
          updated_at?: string;
          write_off?: number | null;
          write_off_status?: string | null;
        };
        Update: {
          activity_start_date?: string | null;
          claim_activity_number?: string;
          claim_month?: number | null;
          claim_status?: string | null;
          claim_year?: number | null;
          clinician_id?: string | null;
          clinician_mismatch?: boolean;
          cpt_category?: string | null;
          cpt_code?: string | null;
          cpt_type?: string | null;
          created_at?: string;
          denial_category?: string | null;
          denial_comment?: string | null;
          denial_type?: string | null;
          diagnosis_text?: string | null;
          encounter_type?: string | null;
          first_remittance_date?: string | null;
          first_seen_file_id?: string | null;
          id?: string;
          initial_denial_code?: string | null;
          initial_denial_type?: string | null;
          initial_net?: number | null;
          initial_rejected?: number | null;
          invoice_no?: string | null;
          last_denial_code?: string | null;
          last_remittance_date?: string | null;
          last_remitted?: number | null;
          last_resubmission_date?: string | null;
          last_seen_file_id?: string | null;
          match_reason?: string | null;
          match_status?: string;
          matched_at?: string | null;
          matched_invoice_id?: string | null;
          matched_line_id?: string | null;
          net?: number | null;
          ordering_clinician_id?: string | null;
          org_id?: string;
          payer_id?: string | null;
          payment_reference?: string | null;
          payment_status?: string | null;
          principal_diagnosis?: string | null;
          prior_auth_id?: string | null;
          quantity?: number | null;
          receipt_status?: string | null;
          receiver_id?: string | null;
          rejected?: number | null;
          remittance_count?: number | null;
          remitted?: number | null;
          resubmission_count?: number | null;
          settled?: boolean | null;
          transaction_date?: string | null;
          unprocessed?: number | null;
          updated_at?: string;
          write_off?: number | null;
          write_off_status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ins_claim_activities_first_seen_file_id_fkey";
            columns: ["first_seen_file_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_diligence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activities_last_seen_file_id_fkey";
            columns: ["last_seen_file_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_diligence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activities_matched_invoice_id_fkey";
            columns: ["matched_invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activities_matched_invoice_id_fkey";
            columns: ["matched_invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activities_matched_invoice_id_fkey";
            columns: ["matched_invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "ins_claim_activities_matched_line_id_fkey";
            columns: ["matched_line_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoice_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activities_matched_line_id_fkey";
            columns: ["matched_line_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_line_match";
            referencedColumns: ["line_id"];
          },
          {
            foreignKeyName: "ins_claim_activities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_claim_activity_events: {
        Row: {
          changed_fields: NonNullable<Json>;
          claim_activity_id: string;
          file_id: string | null;
          id: string;
          observed_at: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          changed_fields: NonNullable<Json>;
          claim_activity_id: string;
          file_id?: string | null;
          id?: string;
          observed_at?: string;
          org_id: string;
        };
        Update: {
          changed_fields?: NonNullable<Json>;
          claim_activity_id?: string;
          file_id?: string | null;
          id?: string;
          observed_at?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ins_claim_activity_events_claim_activity_id_fkey";
            columns: ["claim_activity_id"];
            isOneToOne: false;
            referencedRelation: "ins_claim_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activity_events_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_diligence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_activity_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_staged_activities: {
        Row: {
          claim_activity_number: string;
          created_at: string;
          data: NonNullable<Json>;
          file_id: string;
          id: string;
          org_id: string;
          row_no: number;
        };
        ComputedFields: never;
        Insert: {
          claim_activity_number: string;
          created_at?: string;
          data: NonNullable<Json>;
          file_id: string;
          id?: string;
          org_id: string;
          row_no: number;
        };
        Update: {
          claim_activity_number?: string;
          created_at?: string;
          data?: NonNullable<Json>;
          file_id?: string;
          id?: string;
          org_id?: string;
          row_no?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ins_staged_activities_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_diligence_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_staged_activities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_accounts: {
        Row: {
          breaker_open_until: string | null;
          config: NonNullable<Json>;
          config_enc: string;
          consecutive_failures: number;
          created_at: string;
          id: string;
          kind: string;
          last_error: string | null;
          org_id: string;
          status: string;
          token_expires_at: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          breaker_open_until?: string | null;
          config?: NonNullable<Json>;
          config_enc: string;
          consecutive_failures?: number;
          created_at?: string;
          id?: string;
          kind: string;
          last_error?: string | null;
          org_id: string;
          status?: string;
          token_expires_at?: string | null;
          updated_at?: string;
        };
        Update: {
          breaker_open_until?: string | null;
          config?: NonNullable<Json>;
          config_enc?: string;
          consecutive_failures?: number;
          created_at?: string;
          id?: string;
          kind?: string;
          last_error?: string | null;
          org_id?: string;
          status?: string;
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
      kb_chunks: {
        Row: {
          content: string;
          created_at: string;
          embedding: string;
          id: string;
          ord: number;
          org_id: string;
          source_id: string;
        };
        ComputedFields: never;
        Insert: {
          content: string;
          created_at?: string;
          embedding: string;
          id?: string;
          ord: number;
          org_id: string;
          source_id: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          embedding?: string;
          id?: string;
          ord?: number;
          org_id?: string;
          source_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "kb_chunks_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_chunks_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "kb_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_feedback: {
        Row: {
          ai_usage_id: string | null;
          chunk_ids: string[];
          conversation_id: string | null;
          created_at: string;
          feature: string;
          id: string;
          note: string | null;
          org_id: string;
          positive: boolean;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          ai_usage_id?: string | null;
          chunk_ids?: string[];
          conversation_id?: string | null;
          created_at?: string;
          feature: string;
          id?: string;
          note?: string | null;
          org_id: string;
          positive: boolean;
          user_id?: string | null;
        };
        Update: {
          ai_usage_id?: string | null;
          chunk_ids?: string[];
          conversation_id?: string | null;
          created_at?: string;
          feature?: string;
          id?: string;
          note?: string | null;
          org_id?: string;
          positive?: boolean;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "kb_feedback_ai_usage_id_fkey";
            columns: ["ai_usage_id"];
            isOneToOne: false;
            referencedRelation: "ai_usage";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_feedback_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_feedback_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "kb_feedback_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "kb_feedback_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_feedback_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_groups: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "kb_groups_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      kb_sources: {
        Row: {
          chunk_count: number;
          content_hash: string | null;
          created_at: string;
          created_by: string | null;
          error: string | null;
          group_id: string | null;
          id: string;
          kind: string;
          last_ingested_at: string | null;
          mime_type: string | null;
          name: string;
          org_id: string;
          status: string;
          storage_path: string | null;
          updated_at: string;
          url: string | null;
        };
        ComputedFields: never;
        Insert: {
          chunk_count?: number;
          content_hash?: string | null;
          created_at?: string;
          created_by?: string | null;
          error?: string | null;
          group_id?: string | null;
          id?: string;
          kind: string;
          last_ingested_at?: string | null;
          mime_type?: string | null;
          name: string;
          org_id: string;
          status?: string;
          storage_path?: string | null;
          updated_at?: string;
          url?: string | null;
        };
        Update: {
          chunk_count?: number;
          content_hash?: string | null;
          created_at?: string;
          created_by?: string | null;
          error?: string | null;
          group_id?: string | null;
          id?: string;
          kind?: string;
          last_ingested_at?: string | null;
          mime_type?: string | null;
          name?: string;
          org_id?: string;
          status?: string;
          storage_path?: string | null;
          updated_at?: string;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "kb_sources_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_sources_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "kb_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "kb_sources_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
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
            foreignKeyName: "mentions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "mentions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "mentions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "mentions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "mentions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
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
            foreignKeyName: "messages_campaign_recipient_id_fkey";
            columns: ["campaign_recipient_id"];
            isOneToOne: false;
            referencedRelation: "campaign_recipients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "messages_flow_run_fk";
            columns: ["flow_run_id"];
            isOneToOne: false;
            referencedRelation: "flow_runs";
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
      ops_exception_comments: {
        Row: {
          comment: string;
          created_at: string;
          exception_id: string;
          id: string;
          org_id: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          comment: string;
          created_at?: string;
          exception_id: string;
          id?: string;
          org_id: string;
          user_id?: string | null;
        };
        Update: {
          comment?: string;
          created_at?: string;
          exception_id?: string;
          id?: string;
          org_id?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ops_exception_comments_exception_id_fkey";
            columns: ["exception_id"];
            isOneToOne: false;
            referencedRelation: "ops_exceptions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ops_exception_comments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ops_exception_comments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      ops_exceptions: {
        Row: {
          assignee_user_id: string | null;
          branch_code: string | null;
          closed_at: string | null;
          closed_by: string | null;
          closure_note: string | null;
          created_at: string;
          detail: NonNullable<Json>;
          due_date: string | null;
          entity_key: string;
          entity_type: string;
          id: string;
          opened_at: string;
          org_id: string;
          owner_role: string;
          rule_code: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          assignee_user_id?: string | null;
          branch_code?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          closure_note?: string | null;
          created_at?: string;
          detail?: NonNullable<Json>;
          due_date?: string | null;
          entity_key: string;
          entity_type: string;
          id?: string;
          opened_at?: string;
          org_id: string;
          owner_role: string;
          rule_code: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          assignee_user_id?: string | null;
          branch_code?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          closure_note?: string | null;
          created_at?: string;
          detail?: NonNullable<Json>;
          due_date?: string | null;
          entity_key?: string;
          entity_type?: string;
          id?: string;
          opened_at?: string;
          org_id?: string;
          owner_role?: string;
          rule_code?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ops_exceptions_assignee_user_id_fkey";
            columns: ["assignee_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ops_exceptions_closed_by_fkey";
            columns: ["closed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ops_exceptions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ops_exceptions_org_id_rule_code_fkey";
            columns: ["org_id", "rule_code"];
            isOneToOne: false;
            referencedRelation: "fin_ref_exception_rules";
            referencedColumns: ["org_id", "rule_code"];
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
      parallel_run_diffs: {
        Row: {
          computed_at: string;
          explained: boolean;
          make_count: number;
          native_count: number;
          only_in_make: string[];
          only_in_native: string[];
          org_id: string;
          reason: string | null;
          run_date: string;
          scenario_key: string;
        };
        ComputedFields: never;
        Insert: {
          computed_at?: string;
          explained?: boolean;
          make_count: number;
          native_count: number;
          only_in_make?: string[];
          only_in_native?: string[];
          org_id: string;
          reason?: string | null;
          run_date: string;
          scenario_key: string;
        };
        Update: {
          computed_at?: string;
          explained?: boolean;
          make_count?: number;
          native_count?: number;
          only_in_make?: string[];
          only_in_native?: string[];
          org_id?: string;
          reason?: string | null;
          run_date?: string;
          scenario_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: "parallel_run_diffs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      parallel_run_make_outputs: {
        Row: {
          org_id: string;
          ref_hash: string;
          run_date: string;
          scenario_key: string;
        };
        ComputedFields: never;
        Insert: {
          org_id: string;
          ref_hash: string;
          run_date: string;
          scenario_key: string;
        };
        Update: {
          org_id?: string;
          ref_hash?: string;
          run_date?: string;
          scenario_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: "parallel_run_make_outputs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      parallel_run_scenarios: {
        Row: {
          blocked_reason: string | null;
          diffs_explained: boolean;
          make_off: boolean;
          make_scenario_id: string | null;
          name: string;
          native_built: boolean;
          notes: string | null;
          org_id: string;
          parallel_started_on: string | null;
          scenario_key: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          blocked_reason?: string | null;
          diffs_explained?: boolean;
          make_off?: boolean;
          make_scenario_id?: string | null;
          name: string;
          native_built?: boolean;
          notes?: string | null;
          org_id: string;
          parallel_started_on?: string | null;
          scenario_key: string;
          updated_at?: string;
        };
        Update: {
          blocked_reason?: string | null;
          diffs_explained?: boolean;
          make_off?: boolean;
          make_scenario_id?: string | null;
          name?: string;
          native_built?: boolean;
          notes?: string | null;
          org_id?: string;
          parallel_started_on?: string | null;
          scenario_key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "parallel_run_scenarios_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      pipelines: {
        Row: {
          archived_at: string | null;
          card_fields: string[];
          created_at: string;
          id: string;
          is_default: boolean;
          name: string;
          org_id: string;
          sla_minutes: number | null;
          sort: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          card_fields?: string[];
          created_at?: string;
          id?: string;
          is_default?: boolean;
          name: string;
          org_id: string;
          sla_minutes?: number | null;
          sort?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          card_fields?: string[];
          created_at?: string;
          id?: string;
          is_default?: boolean;
          name?: string;
          org_id?: string;
          sla_minutes?: number | null;
          sort?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pipelines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_attachments: {
        Row: {
          content_type: string | null;
          created_at: string;
          file_name: string;
          id: string;
          object_key: string;
          org_id: string;
          path: string;
          record_id: string;
          size_bytes: number | null;
          uploaded_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          content_type?: string | null;
          created_at?: string;
          file_name: string;
          id?: string;
          object_key: string;
          org_id: string;
          path: string;
          record_id: string;
          size_bytes?: number | null;
          uploaded_by?: string | null;
        };
        Update: {
          content_type?: string | null;
          created_at?: string;
          file_name?: string;
          id?: string;
          object_key?: string;
          org_id?: string;
          path?: string;
          record_id?: string;
          size_bytes?: number | null;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portal_attachments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_attachments_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_comments: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          mentioned_user_ids: string[];
          object_key: string;
          org_id: string;
          record_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          mentioned_user_ids?: string[];
          object_key: string;
          org_id: string;
          record_id: string;
          updated_at?: string;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          mentioned_user_ids?: string[];
          object_key?: string;
          org_id?: string;
          record_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "portal_comments_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_comments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_objects: {
        Row: {
          config: NonNullable<Json>;
          created_at: string;
          enabled: boolean;
          icon: string | null;
          id: string;
          key: string;
          label: string;
          org_id: string;
          read_perm: string;
          sort: number;
          source_airtable_table: string | null;
          table_name: string;
          updated_at: string;
          write_perm: string | null;
        };
        ComputedFields: never;
        Insert: {
          config?: NonNullable<Json>;
          created_at?: string;
          enabled?: boolean;
          icon?: string | null;
          id?: string;
          key: string;
          label: string;
          org_id: string;
          read_perm: string;
          sort?: number;
          source_airtable_table?: string | null;
          table_name: string;
          updated_at?: string;
          write_perm?: string | null;
        };
        Update: {
          config?: NonNullable<Json>;
          created_at?: string;
          enabled?: boolean;
          icon?: string | null;
          id?: string;
          key?: string;
          label?: string;
          org_id?: string;
          read_perm?: string;
          sort?: number;
          source_airtable_table?: string | null;
          table_name?: string;
          updated_at?: string;
          write_perm?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portal_objects_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_record_events: {
        Row: {
          actor_id: string | null;
          created_at: string;
          id: number;
          object_key: string;
          org_id: string;
          payload: NonNullable<Json>;
          record_id: string;
          type: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          created_at?: string;
          id?: number;
          object_key: string;
          org_id: string;
          payload?: NonNullable<Json>;
          record_id: string;
          type: string;
        };
        Update: {
          actor_id?: string | null;
          created_at?: string;
          id?: number;
          object_key?: string;
          org_id?: string;
          payload?: NonNullable<Json>;
          record_id?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "portal_record_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_record_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
            isOneToOne: true;
            referencedRelation: "prescriptions";
            referencedColumns: ["id"];
          },
        ];
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
            foreignKeyName: "prescriptions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "prescriptions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      rate_limit_hits: {
        Row: {
          hits: number;
          key: string;
          window_start: string;
        };
        ComputedFields: never;
        Insert: {
          hits?: number;
          key: string;
          window_start: string;
        };
        Update: {
          hits?: number;
          key?: string;
          window_start?: string;
        };
        Relationships: [];
      };
      recall_programme_templates: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          legacy_sanoflow_template_id: string | null;
          org_id: string;
          programme_id: string;
          segment_key: string;
          updated_at: string;
          variables_map: NonNullable<Json>;
          wa_template_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          legacy_sanoflow_template_id?: string | null;
          org_id: string;
          programme_id: string;
          segment_key: string;
          updated_at?: string;
          variables_map?: NonNullable<Json>;
          wa_template_id?: string | null;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          legacy_sanoflow_template_id?: string | null;
          org_id?: string;
          programme_id?: string;
          segment_key?: string;
          updated_at?: string;
          variables_map?: NonNullable<Json>;
          wa_template_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "recall_programme_templates_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_programme_templates_programme_id_fkey";
            columns: ["programme_id"];
            isOneToOne: false;
            referencedRelation: "recall_programmes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_programme_templates_wa_template_id_fkey";
            columns: ["wa_template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      recall_programmes: {
        Row: {
          config: NonNullable<Json>;
          created_at: string;
          cron_expression: string | null;
          eligibility_view: string | null;
          id: string;
          key: string;
          kind: Database["public"]["Enums"]["recall_kind"];
          last_run_at: string | null;
          max_per_run: number;
          min_days_since_visit: number | null;
          name: string;
          org_id: string;
          repeat_policy: Database["public"]["Enums"]["recall_repeat_policy"];
          requires_clinical_consent: boolean;
          requires_marketing_opt_in: boolean;
          send_mode_override: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          config?: NonNullable<Json>;
          created_at?: string;
          cron_expression?: string | null;
          eligibility_view?: string | null;
          id?: string;
          key: string;
          kind: Database["public"]["Enums"]["recall_kind"];
          last_run_at?: string | null;
          max_per_run?: number;
          min_days_since_visit?: number | null;
          name: string;
          org_id: string;
          repeat_policy?: Database["public"]["Enums"]["recall_repeat_policy"];
          requires_clinical_consent?: boolean;
          requires_marketing_opt_in?: boolean;
          send_mode_override?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          config?: NonNullable<Json>;
          created_at?: string;
          cron_expression?: string | null;
          eligibility_view?: string | null;
          id?: string;
          key?: string;
          kind?: Database["public"]["Enums"]["recall_kind"];
          last_run_at?: string | null;
          max_per_run?: number;
          min_days_since_visit?: number | null;
          name?: string;
          org_id?: string;
          repeat_policy?: Database["public"]["Enums"]["recall_repeat_policy"];
          requires_clinical_consent?: boolean;
          requires_marketing_opt_in?: boolean;
          send_mode_override?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "recall_programmes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      recall_sends: {
        Row: {
          appointment_id: string | null;
          assigned_user_id: string | null;
          booked_at: string | null;
          contact_id: string;
          created_at: string;
          cycle_key: string;
          days_since_last_visit_at_send: number | null;
          eligible_at: string | null;
          follow_up_status: Database["public"]["Enums"]["recall_follow_up_status"] | null;
          id: string;
          last_visit_date_at_send: string | null;
          legacy_template_ref: string | null;
          message_id: string | null;
          notes: string | null;
          org_id: string;
          outcome: string | null;
          programme_id: string;
          replied_at: string | null;
          reply_message_id: string | null;
          segment_key: string | null;
          send_mode: string;
          sent_at: string | null;
          sent_to_phone_e164: string | null;
          source: string;
          status: Database["public"]["Enums"]["recall_send_status"];
          template_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          assigned_user_id?: string | null;
          booked_at?: string | null;
          contact_id: string;
          created_at?: string;
          cycle_key: string;
          days_since_last_visit_at_send?: number | null;
          eligible_at?: string | null;
          follow_up_status?: Database["public"]["Enums"]["recall_follow_up_status"] | null;
          id?: string;
          last_visit_date_at_send?: string | null;
          legacy_template_ref?: string | null;
          message_id?: string | null;
          notes?: string | null;
          org_id: string;
          outcome?: string | null;
          programme_id: string;
          replied_at?: string | null;
          reply_message_id?: string | null;
          segment_key?: string | null;
          send_mode?: string;
          sent_at?: string | null;
          sent_to_phone_e164?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["recall_send_status"];
          template_id?: string | null;
          updated_at?: string;
        };
        Update: {
          appointment_id?: string | null;
          assigned_user_id?: string | null;
          booked_at?: string | null;
          contact_id?: string;
          created_at?: string;
          cycle_key?: string;
          days_since_last_visit_at_send?: number | null;
          eligible_at?: string | null;
          follow_up_status?: Database["public"]["Enums"]["recall_follow_up_status"] | null;
          id?: string;
          last_visit_date_at_send?: string | null;
          legacy_template_ref?: string | null;
          message_id?: string | null;
          notes?: string | null;
          org_id?: string;
          outcome?: string | null;
          programme_id?: string;
          replied_at?: string | null;
          reply_message_id?: string | null;
          segment_key?: string | null;
          send_mode?: string;
          sent_at?: string | null;
          sent_to_phone_e164?: string | null;
          source?: string;
          status?: Database["public"]["Enums"]["recall_send_status"];
          template_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "recall_sends_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_assigned_user_id_fkey";
            columns: ["assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "recall_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "recall_sends_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_programme_id_fkey";
            columns: ["programme_id"];
            isOneToOne: false;
            referencedRelation: "recall_programmes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_reply_message_id_fkey";
            columns: ["reply_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "recall_programme_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      ref_condition_groups: {
        Row: {
          created_at: string;
          follow_up_interval_days: number | null;
          id: string;
          key: string;
          messageable: boolean;
          monitoring_labs_cpt: string | null;
          monitoring_procedures_cpt: string | null;
          name: string;
          org_id: string;
          regular_medication_examples: string | null;
          sort: number;
          typical_visit_cpt: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          follow_up_interval_days?: number | null;
          id?: string;
          key: string;
          messageable?: boolean;
          monitoring_labs_cpt?: string | null;
          monitoring_procedures_cpt?: string | null;
          name: string;
          org_id: string;
          regular_medication_examples?: string | null;
          sort?: number;
          typical_visit_cpt?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          follow_up_interval_days?: number | null;
          id?: string;
          key?: string;
          messageable?: boolean;
          monitoring_labs_cpt?: string | null;
          monitoring_procedures_cpt?: string | null;
          name?: string;
          org_id?: string;
          regular_medication_examples?: string | null;
          sort?: number;
          typical_visit_cpt?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ref_condition_groups_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ref_diagnoses: {
        Row: {
          chronic: boolean;
          code: string;
          condition_group_id: string | null;
          created_at: string;
          id: string;
          long_description: string | null;
          not_found_in_unite: boolean;
          org_id: string;
          short_description: string | null;
          top30: boolean;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          chronic?: boolean;
          code: string;
          condition_group_id?: string | null;
          created_at?: string;
          id?: string;
          long_description?: string | null;
          not_found_in_unite?: boolean;
          org_id: string;
          short_description?: string | null;
          top30?: boolean;
          updated_at?: string;
        };
        Update: {
          chronic?: boolean;
          code?: string;
          condition_group_id?: string | null;
          created_at?: string;
          id?: string;
          long_description?: string | null;
          not_found_in_unite?: boolean;
          org_id?: string;
          short_description?: string | null;
          top30?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ref_diagnoses_condition_group_id_fkey";
            columns: ["condition_group_id"];
            isOneToOne: false;
            referencedRelation: "ref_condition_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ref_diagnoses_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ref_items: {
        Row: {
          code: string;
          created_at: string;
          description: string | null;
          doctor_verified: boolean;
          id: string;
          item_type: string | null;
          org_id: string;
          patient_message_group: string | null;
          test_category: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          code: string;
          created_at?: string;
          description?: string | null;
          doctor_verified?: boolean;
          id?: string;
          item_type?: string | null;
          org_id: string;
          patient_message_group?: string | null;
          test_category?: string | null;
          updated_at?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          description?: string | null;
          doctor_verified?: boolean;
          id?: string;
          item_type?: string | null;
          org_id?: string;
          patient_message_group?: string | null;
          test_category?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ref_items_org_id_fkey";
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
      ref_medications: {
        Row: {
          all_medicine_types: string[] | null;
          created_at: string;
          ddc_code: string;
          dosage_form: string | null;
          granular_unit: string | null;
          icd_codes: string | null;
          id: string;
          is_ebp: boolean | null;
          medicine_type: string | null;
          org_id: string;
          package_price: number | null;
          registered_owner: string | null;
          route: string | null;
          scientific_code: string | null;
          scientific_name: string | null;
          source: string | null;
          source_updated_on: string | null;
          status: string | null;
          strength: string | null;
          trade_name: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          all_medicine_types?: string[] | null;
          created_at?: string;
          ddc_code: string;
          dosage_form?: string | null;
          granular_unit?: string | null;
          icd_codes?: string | null;
          id?: string;
          is_ebp?: boolean | null;
          medicine_type?: string | null;
          org_id: string;
          package_price?: number | null;
          registered_owner?: string | null;
          route?: string | null;
          scientific_code?: string | null;
          scientific_name?: string | null;
          source?: string | null;
          source_updated_on?: string | null;
          status?: string | null;
          strength?: string | null;
          trade_name?: string | null;
          updated_at?: string;
        };
        Update: {
          all_medicine_types?: string[] | null;
          created_at?: string;
          ddc_code?: string;
          dosage_form?: string | null;
          granular_unit?: string | null;
          icd_codes?: string | null;
          id?: string;
          is_ebp?: boolean | null;
          medicine_type?: string | null;
          org_id?: string;
          package_price?: number | null;
          registered_owner?: string | null;
          route?: string | null;
          scientific_code?: string | null;
          scientific_name?: string | null;
          source?: string | null;
          source_updated_on?: string | null;
          status?: string | null;
          strength?: string | null;
          trade_name?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ref_medications_org_id_fkey";
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
      saved_views: {
        Row: {
          columns: NonNullable<Json>;
          created_at: string;
          filter: NonNullable<Json>;
          id: string;
          name: string;
          object_key: string;
          org_id: string;
          owner_id: string;
          shared_all: boolean;
          shared_team_ids: string[];
          sort: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          columns?: NonNullable<Json>;
          created_at?: string;
          filter?: NonNullable<Json>;
          id?: string;
          name: string;
          object_key: string;
          org_id: string;
          owner_id: string;
          shared_all?: boolean;
          shared_team_ids?: string[];
          sort?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          columns?: NonNullable<Json>;
          created_at?: string;
          filter?: NonNullable<Json>;
          id?: string;
          name?: string;
          object_key?: string;
          org_id?: string;
          owner_id?: string;
          shared_all?: boolean;
          shared_team_ids?: string[];
          sort?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "saved_views_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_views_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
            foreignKeyName: "segment_members_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "segment_members_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
            foreignKeyName: "segments_drip_flow_fk";
            columns: ["drip_flow_id"];
            isOneToOne: false;
            referencedRelation: "flows";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "segments_drip_flow_fk";
            columns: ["drip_flow_id"];
            isOneToOne: false;
            referencedRelation: "v_flow_run_counts";
            referencedColumns: ["flow_id"];
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
      stages: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          pipeline_id: string;
          sort: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          color?: string;
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
          pipeline_id: string;
          sort?: number;
          updated_at?: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          pipeline_id?: string;
          sort?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stages_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stages_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
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
          {
            foreignKeyName: "sync_reviews_resolved_contact_id_fkey";
            columns: ["resolved_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "sync_reviews_resolved_contact_id_fkey";
            columns: ["resolved_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      tasks: {
        Row: {
          appointment_id: string | null;
          assignee_id: string | null;
          completed_by: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          done: boolean;
          done_at: string | null;
          due_at: string;
          due_notified_for: string | null;
          enquiry_id: string | null;
          id: string;
          notes: string | null;
          org_id: string;
          subject: string;
          type: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          assignee_id?: string | null;
          completed_by?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          done?: boolean;
          done_at?: string | null;
          due_at: string;
          due_notified_for?: string | null;
          enquiry_id?: string | null;
          id?: string;
          notes?: string | null;
          org_id: string;
          subject: string;
          type?: string;
          updated_at?: string;
        };
        Update: {
          appointment_id?: string | null;
          assignee_id?: string | null;
          completed_by?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          done?: boolean;
          done_at?: string | null;
          due_at?: string;
          due_notified_for?: string | null;
          enquiry_id?: string | null;
          id?: string;
          notes?: string | null;
          org_id?: string;
          subject?: string;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_completed_by_fkey";
            columns: ["completed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "tasks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "tasks_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_enquiry_id_fkey";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "enquiries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_enquiry_id_fkey";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "v_enquiry_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_org_id_fkey";
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
          contact_id: string | null;
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
          contact_id?: string | null;
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
          contact_id?: string | null;
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
            foreignKeyName: "timeline_events_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "timeline_events_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "timeline_events_enquiry_fk";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "enquiries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timeline_events_enquiry_fk";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "v_enquiry_facts";
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
          unite_status: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          batch_id?: string | null;
          duration_ms?: number | null;
          endpoint: string;
          http_status?: number | null;
          id?: never;
          org_id: string;
          unite_status?: string | null;
        };
        Update: {
          at?: string;
          batch_id?: string | null;
          duration_ms?: number | null;
          endpoint?: string;
          http_status?: number | null;
          id?: never;
          org_id?: string;
          unite_status?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "unite_api_calls_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_unite_batches";
            referencedColumns: ["id"];
          },
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
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      wa_templates: {
        Row: {
          archived_at: string | null;
          category: string;
          channel_id: string | null;
          clinical_approval: string;
          components: NonNullable<Json>;
          created_at: string;
          created_by: string | null;
          gallery_key: string | null;
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
          submitted_at: string | null;
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
          created_by?: string | null;
          gallery_key?: string | null;
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
          submitted_at?: string | null;
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
          created_by?: string | null;
          gallery_key?: string | null;
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
          submitted_at?: string | null;
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
            foreignKeyName: "wa_templates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      webhook_deliveries: {
        Row: {
          attempts: number;
          created_at: string;
          delivered_at: string | null;
          error: string | null;
          event: string;
          event_id: string;
          id: string;
          next_attempt_at: string | null;
          org_id: string;
          payload: NonNullable<Json>;
          response_code: number | null;
          status: string;
          subscription_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          created_at?: string;
          delivered_at?: string | null;
          error?: string | null;
          event: string;
          event_id: string;
          id?: string;
          next_attempt_at?: string | null;
          org_id: string;
          payload: NonNullable<Json>;
          response_code?: number | null;
          status?: string;
          subscription_id: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          delivered_at?: string | null;
          error?: string | null;
          event?: string;
          event_id?: string;
          id?: string;
          next_attempt_at?: string | null;
          org_id?: string;
          payload?: NonNullable<Json>;
          response_code?: number | null;
          status?: string;
          subscription_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_deliveries_subscription_id_fkey";
            columns: ["subscription_id"];
            isOneToOne: false;
            referencedRelation: "webhook_subscriptions";
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
      webhook_secrets: {
        Row: {
          secret_enc: string;
          subscription_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          secret_enc: string;
          subscription_id: string;
          updated_at?: string;
        };
        Update: {
          secret_enc?: string;
          subscription_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "webhook_secrets_subscription_id_fkey";
            columns: ["subscription_id"];
            isOneToOne: true;
            referencedRelation: "webhook_subscriptions";
            referencedColumns: ["id"];
          },
        ];
      };
      webhook_subscriptions: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          description: string | null;
          events: string[];
          id: string;
          org_id: string;
          updated_at: string;
          url: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          events: string[];
          id?: string;
          org_id: string;
          updated_at?: string;
          url: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          events?: string[];
          id?: string;
          org_id?: string;
          updated_at?: string;
          url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "webhook_subscriptions_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "webhook_subscriptions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      website_entry_points: {
        Row: {
          channel_id: string | null;
          channel_phone: string | null;
          created_at: string;
          id: string;
          is_dynamic: boolean;
          org_id: string;
          prefill_message: string | null;
          priority_key: string | null;
          route_team_id: string | null;
          route_to: string | null;
          section: string;
          source_key: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          channel_id?: string | null;
          channel_phone?: string | null;
          created_at?: string;
          id?: string;
          is_dynamic?: boolean;
          org_id: string;
          prefill_message?: string | null;
          priority_key?: string | null;
          route_team_id?: string | null;
          route_to?: string | null;
          section: string;
          source_key: string;
          updated_at?: string;
        };
        Update: {
          channel_id?: string | null;
          channel_phone?: string | null;
          created_at?: string;
          id?: string;
          is_dynamic?: boolean;
          org_id?: string;
          prefill_message?: string | null;
          priority_key?: string | null;
          route_team_id?: string | null;
          route_to?: string | null;
          section?: string;
          source_key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "website_entry_points_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_entry_points_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_entry_points_route_team_id_fkey";
            columns: ["route_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
        ];
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
      mv_agent_performance: {
        Row: {
          conversations_closed: number | null;
          conversations_handled: number | null;
          day: string | null;
          first_response_count: number | null;
          first_response_seconds_sum: number | null;
          messages_sent: number | null;
          org_id: string | null;
          resolution_seconds_sum: number | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      mv_conversation_facts: {
        Row: {
          assignee_team_id: string | null;
          assignee_user_id: string | null;
          channel_id: string | null;
          closed_at: string | null;
          closed_by: string | null;
          contact_id: string | null;
          conversation_id: string | null;
          first_inbound_at: string | null;
          first_response_at: string | null;
          first_response_by: string | null;
          first_response_seconds: number | null;
          inbound_count: number | null;
          is_returning: boolean | null;
          opened_at: string | null;
          opened_day: string | null;
          org_id: string | null;
          outbound_count: number | null;
          resolution_seconds: number | null;
          status: string | null;
        };
        ComputedFields: never;
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
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "conversations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "conversations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_sent_by_user_id_fkey";
            columns: ["first_response_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      mv_daily_conversations: {
        Row: {
          channel_id: string | null;
          closed: number | null;
          day: string | null;
          inbound_messages: number | null;
          opened: number | null;
          org_id: string | null;
          outbound_messages: number | null;
          returning_contacts: number | null;
          unique_contacts: number | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      mv_hourly_conversations: {
        Row: {
          channel_id: string | null;
          day: string | null;
          hour: number | null;
          inbound_messages: number | null;
          org_id: string | null;
          outbound_messages: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "conversations_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      mv_message_usage_daily: {
        Row: {
          category: string | null;
          channel_id: string | null;
          day: string | null;
          messages: number | null;
          org_id: string | null;
          status: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "conversations_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_agent_workload_now: {
        Row: {
          open_conversations: number | null;
          org_id: string | null;
          presence: string | null;
          presence_at: string | null;
          unread_conversations: number | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
      v_appointment_facts: {
        Row: {
          day: string | null;
          external_status: string | null;
          id: string | null;
          location_id: string | null;
          location_name: string | null;
          org_id: string | null;
          source: string | null;
          specialist_id: string | null;
          specialist_name: string | null;
          status: string | null;
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
      v_birthday_today: {
        Row: {
          age_today: number | null;
          contact_id: string | null;
          cycle_key: string | null;
          gender: string | null;
          org_id: string | null;
          segment_key: string | null;
        };
        ComputedFields: never;
        Insert: {
          age_today?: never;
          contact_id?: string | null;
          cycle_key?: never;
          gender?: string | null;
          org_id?: string | null;
          segment_key?: never;
        };
        Update: {
          age_today?: never;
          contact_id?: string | null;
          cycle_key?: never;
          gender?: string | null;
          org_id?: string | null;
          segment_key?: never;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_campaign_facts: {
        Row: {
          channel_id: string | null;
          channel_name: string | null;
          created_at: string | null;
          day: string | null;
          id: string | null;
          name: string | null;
          org_id: string | null;
          placed_at: string | null;
          started_at: string | null;
          status: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "campaigns_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_chronic_recall_eligibility: {
        Row: {
          contact_id: string | null;
          cycle_key: string | null;
          days_since_last_visit: number | null;
          eligible: boolean | null;
          last_visit_date: string | null;
          messageable_groups: string[] | null;
          min_days: number | null;
          org_id: string | null;
          primary_condition_group: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "contacts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_contact_visit_stats: {
        Row: {
          contact_id: string | null;
          days_since_last_visit: number | null;
          first_visit_date: string | null;
          last_visit_date: string | null;
          org_id: string | null;
          visit_count: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      v_enquiry_facts: {
        Row: {
          assignee_id: string | null;
          closed_at: string | null;
          closed_day: string | null;
          created_at: string | null;
          created_day: string | null;
          est_value: number | null;
          id: string | null;
          org_id: string | null;
          pipeline_id: string | null;
          pipeline_name: string | null;
          pipeline_sort: number | null;
          stage_id: string | null;
          stage_name: string | null;
          stage_sort: number | null;
          status: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "enquiries_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiries_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "stages";
            referencedColumns: ["id"];
          },
        ];
      };
      v_enquiry_stage_entries: {
        Row: {
          at: string | null;
          enquiry_id: string | null;
          org_id: string | null;
          stage_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string | null;
          enquiry_id?: string | null;
          org_id?: string | null;
          stage_id?: never;
        };
        Update: {
          at?: string | null;
          enquiry_id?: string | null;
          org_id?: string | null;
          stage_id?: never;
        };
        Relationships: [
          {
            foreignKeyName: "timeline_events_enquiry_fk";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "enquiries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "timeline_events_enquiry_fk";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "v_enquiry_facts";
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
      v_fin_adjustments_daily: {
        Row: {
          branch_code: string | null;
          credit_note: number | null;
          date: string | null;
          inv_type: string | null;
          org_id: string | null;
          write_off: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "fin_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_claims_status: {
        Row: {
          accepted: number | null;
          branch_code: string | null;
          claim_month: number | null;
          claim_year: number | null;
          net: number | null;
          org_id: string | null;
          payer_id: string | null;
          pending: number | null;
          rejected: number | null;
          rejected_amount: number | null;
          remitted: number | null;
          resubmitted: number | null;
          submitted: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "ins_claim_activities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_collections_daily: {
        Row: {
          branch_code: string | null;
          date: string | null;
          org_id: string | null;
          paid: number | null;
          payment_mode: string | null;
          refunds: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "fin_payments_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_denials: {
        Row: {
          claim_activities: number | null;
          denial_type: string | null;
          doctor_dha_id: string | null;
          last_denial_code: string | null;
          org_id: string | null;
          payer_id: string | null;
          rejected_amount: number | null;
          service_category: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "ins_claim_activities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_invoice_list: {
        Row: {
          appointment_id: string | null;
          branch_code: string | null;
          claim_count: number | null;
          claimed: number | null;
          department: string | null;
          doctor_dha_id: string | null;
          doctor_name: string | null;
          id: string | null;
          inv_display_number: string | null;
          inv_type: string | null;
          is_deleted: boolean | null;
          net: number | null;
          org_id: string | null;
          paid: number | null;
          patient_pin: string | null;
          rejected: number | null;
          remitted: number | null;
          total: number | null;
          transaction_date: string | null;
          version: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "fin_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_monthly_summary: {
        Row: {
          branch_code: string | null;
          claimed: number | null;
          generated: number | null;
          month: string | null;
          org_id: string | null;
          outstanding: number | null;
          rejected: number | null;
          remitted: number | null;
          self_pay_collected: number | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      v_fin_receivables_ageing: {
        Row: {
          branch_code: string | null;
          bucket: string | null;
          claim_activities: number | null;
          org_id: string | null;
          outstanding: number | null;
          payer_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "ins_claim_activities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_revenue_daily: {
        Row: {
          branch_code: string | null;
          date: string | null;
          department: string | null;
          discount: number | null;
          doctor_dha_id: string | null;
          doctor_name: string | null;
          gross: number | null;
          inv_type: string | null;
          net: number | null;
          org_id: string | null;
          service_category: string | null;
          vat: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "fin_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_fin_revenue_monthly: {
        Row: {
          branch_code: string | null;
          department: string | null;
          discount: number | null;
          doctor_dha_id: string | null;
          doctor_name: string | null;
          gross: number | null;
          inv_type: string | null;
          month: string | null;
          net: number | null;
          org_id: string | null;
          service_category: string | null;
          vat: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "fin_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_flow_run_counts: {
        Row: {
          completed: number | null;
          failed: number | null;
          flow_id: string | null;
          org_id: string | null;
          pending: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "flows_org_id_fkey";
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
            foreignKeyName: "clinical_followups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "clinical_followups_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      v_ins_invoice_line_match: {
        Row: {
          cpt_code: string | null;
          invoice_id: string | null;
          item_code: string | null;
          line_id: string | null;
          line_key: string | null;
          line_net: number | null;
          org_id: string | null;
          position: number | null;
          qty: number | null;
        };
        ComputedFields: never;
        Insert: {
          cpt_code?: string | null;
          invoice_id?: string | null;
          item_code?: string | null;
          line_id?: string | null;
          line_key?: string | null;
          line_net?: number | null;
          org_id?: string | null;
          position?: number | null;
          qty?: number | null;
        };
        Update: {
          cpt_code?: string | null;
          invoice_id?: string | null;
          item_code?: string | null;
          line_id?: string | null;
          line_key?: string | null;
          line_net?: number | null;
          org_id?: string | null;
          position?: number | null;
          qty?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_invoice_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_ins_invoice_match: {
        Row: {
          branch_code: string | null;
          doctor_dha_id: string | null;
          inv_display_number: string | null;
          inv_key: string | null;
          inv_type: string | null;
          invoice_id: string | null;
          is_deleted: boolean | null;
          net: number | null;
          org_id: string | null;
          total: number | null;
          transaction_date: string | null;
        };
        ComputedFields: never;
        Insert: {
          branch_code?: string | null;
          doctor_dha_id?: string | null;
          inv_display_number?: string | null;
          inv_key?: string | null;
          inv_type?: string | null;
          invoice_id?: string | null;
          is_deleted?: boolean | null;
          net?: number | null;
          org_id?: string | null;
          total?: number | null;
          transaction_date?: string | null;
        };
        Update: {
          branch_code?: string | null;
          doctor_dha_id?: string | null;
          inv_display_number?: string | null;
          inv_key?: string | null;
          inv_type?: string | null;
          invoice_id?: string | null;
          is_deleted?: boolean | null;
          net?: number | null;
          org_id?: string | null;
          total?: number | null;
          transaction_date?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_recall_call_list: {
        Row: {
          assigned_user_id: string | null;
          call_now: boolean | null;
          contact_id: string | null;
          days_since_last_visit_at_send: number | null;
          days_waiting: number | null;
          follow_up_status: Database["public"]["Enums"]["recall_follow_up_status"] | null;
          last_visit_date_at_send: string | null;
          org_id: string | null;
          overdue: boolean | null;
          programme_id: string | null;
          recall_send_id: string | null;
          segment_key: string | null;
          sent_at: string | null;
          workdays_waiting: number | null;
        };
        ComputedFields: never;
        Insert: {
          assigned_user_id?: string | null;
          call_now?: never;
          contact_id?: string | null;
          days_since_last_visit_at_send?: number | null;
          days_waiting?: never;
          follow_up_status?: Database["public"]["Enums"]["recall_follow_up_status"] | null;
          last_visit_date_at_send?: string | null;
          org_id?: string | null;
          overdue?: never;
          programme_id?: string | null;
          recall_send_id?: string | null;
          segment_key?: string | null;
          sent_at?: string | null;
          workdays_waiting?: never;
        };
        Update: {
          assigned_user_id?: string | null;
          call_now?: never;
          contact_id?: string | null;
          days_since_last_visit_at_send?: number | null;
          days_waiting?: never;
          follow_up_status?: Database["public"]["Enums"]["recall_follow_up_status"] | null;
          last_visit_date_at_send?: string | null;
          org_id?: string | null;
          overdue?: never;
          programme_id?: string | null;
          recall_send_id?: string | null;
          segment_key?: string | null;
          sent_at?: string | null;
          workdays_waiting?: never;
        };
        Relationships: [
          {
            foreignKeyName: "recall_sends_assigned_user_id_fkey";
            columns: ["assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "recall_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "recall_sends_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_programme_id_fkey";
            columns: ["programme_id"];
            isOneToOne: false;
            referencedRelation: "recall_programmes";
            referencedColumns: ["id"];
          },
        ];
      };
      v_recall_weekly: {
        Row: {
          avg_days_since_last_visit: number | null;
          booked: number | null;
          failed: number | null;
          org_id: string | null;
          over_threshold: number | null;
          programme_id: string | null;
          replied: number | null;
          send_mode: string | null;
          sent: number | null;
          unique_contacts: number | null;
          week_start: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "recall_sends_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recall_sends_programme_id_fkey";
            columns: ["programme_id"];
            isOneToOne: false;
            referencedRelation: "recall_programmes";
            referencedColumns: ["id"];
          },
        ];
      };
      v_sla_breaches_now: {
        Row: {
          assignee_team_id: string | null;
          assignee_user_id: string | null;
          conversation_id: string | null;
          last_inbound_at: string | null;
          org_id: string | null;
          waiting_minutes: number | null;
        };
        ComputedFields: never;
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
            foreignKeyName: "conversations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      v_team_queue_now: {
        Row: {
          assignee_team_id: string | null;
          open_count: number | null;
          org_id: string | null;
          unassigned_count: number | null;
          unread_count: number | null;
          waiting_count: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "conversations_assignee_team_id_fkey";
            columns: ["assignee_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
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
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "visits_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
      campaign_add_csv_rows: {
        Args: {
          p_campaign_id: string;
          p_confirmed: boolean;
          p_dry?: boolean;
          p_marketing: boolean;
          p_org_id: string;
          p_rows: Json;
          p_user: string;
        };
        Returns: Json;
      };
      campaign_dispatch: {
        Args: { p_campaign_id: string; p_items: Json };
        Returns: {
          message_id: string;
          recipient_id: string;
        }[];
      };
      campaign_funnel: { Args: { p_campaign_id: string }; Returns: Json };
      campaign_requeue_failed: {
        Args: { p_campaign_id: string; p_codes: number[] };
        Returns: number;
      };
      campaign_snapshot_segment: {
        Args: {
          p_campaign_id: string;
          p_dry?: boolean;
          p_limit: number;
          p_marketing: boolean;
          p_org_id: string;
          p_params: Json;
          p_where: string;
        };
        Returns: Json;
      };
      claim_flow_lock: {
        Args: { p_key: string; p_owner: string; p_ttl_seconds?: number };
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
      clinical_setting: { Args: { p_key: string; p_org: string }; Returns: string };
      clinical_setting_bool: { Args: { p_key: string; p_org: string }; Returns: boolean };
      clinical_setting_num: { Args: { p_key: string; p_org: string }; Returns: number };
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
      enquiries_count: {
        Args: { p_org_id: string; p_params: Json; p_q?: string; p_where: string };
        Returns: number;
      };
      enquiries_ids: {
        Args: { p_limit?: number; p_org_id: string; p_params: Json; p_q?: string; p_where: string };
        Returns: string[];
      };
      enquiries_search: {
        Args: {
          p_limit?: number;
          p_offset?: number;
          p_order_by?: string;
          p_org_id: string;
          p_params: Json;
          p_q?: string;
          p_stage_id?: string;
          p_where: string;
        };
        Returns: {
          id: string;
          total: number;
        }[];
      };
      enquiries_stage_counts: {
        Args: { p_org_id: string; p_params: Json; p_q?: string; p_where: string };
        Returns: {
          stage_id: string;
          total: number;
        }[];
      };
      fail_scheduled_job: {
        Args: { p_error: string; p_id: string; p_retry_in?: string };
        Returns: undefined;
      };
      fin_alerts_enqueue: { Args: Record<PropertyKey, never>; Returns: number };
      fin_apply_invoices: {
        Args: { p_batch_id: string; p_duplicates?: number; p_invoices: Json; p_org_id: string };
        Returns: Json;
      };
      fin_appointment_resolution: {
        Args: { p_days?: number; p_org_id: string };
        Returns: {
          resolved: number;
          with_id: number;
        }[];
      };
      fin_auto_close_exceptions: {
        Args: { p_entity_key: string; p_org_id: string; p_rule_code: string };
        Returns: number;
      };
      fin_batch_mark_failed: { Args: { p_batch_id: string; p_error: string }; Returns: undefined };
      fin_capture_enqueue_ticks: { Args: Record<PropertyKey, never>; Returns: number };
      fin_capture_release_lease: {
        Args: { p_holder: string; p_org_id: string };
        Returns: undefined;
      };
      fin_capture_try_lease: {
        Args: { p_holder: string; p_org_id: string; p_ttl_seconds?: number };
        Returns: boolean;
      };
      fin_invoice_number_gaps: {
        Args: { p_from?: string; p_org_id: string };
        Returns: {
          missing_count: number;
          missing_from: number;
          missing_to: number;
          series: string;
        }[];
      };
      fin_is_insurance_type: { Args: { p_inv_type: string }; Returns: boolean };
      fin_maintenance_enqueue: { Args: Record<PropertyKey, never>; Returns: number };
      fin_open_exception: {
        Args: {
          p_branch_code?: string;
          p_detail?: Json;
          p_entity_key: string;
          p_entity_type: string;
          p_org_id: string;
          p_rule_code: string;
        };
        Returns: string;
      };
      fin_rederive_branches: { Args: { p_org_id: string }; Returns: number };
      fin_rules_context: {
        Args: { p_org_id: string };
        Returns: {
          appointments_from: string;
          capture_drained: boolean;
          claims_fresh: boolean;
        }[];
      };
      fin_run_exception_rules: { Args: { p_org_id: string }; Returns: Json };
      gen_random_uuid: { Args: Record<PropertyKey, never>; Returns: string };
      gen_salt: { Args: { "": string }; Returns: string };
      ins_apply_matches: { Args: { p_matches: Json; p_org_id: string }; Returns: number };
      ins_commit_import: {
        Args: {
          p_events: Json;
          p_file_id: string;
          p_missing: string[];
          p_org_id: string;
          p_raise_missing?: boolean;
          p_rows: Json;
          p_seen: string[];
          p_user_id: string;
        };
        Returns: Json;
      };
      ins_discard_import: {
        Args: { p_file_id: string; p_org_id: string; p_reason?: string };
        Returns: undefined;
      };
      ins_purge_stale_staging: { Args: Record<PropertyKey, never>; Returns: number };
      is_reminder_excluded: {
        Args: { p_doctor_name: string; p_org: string; p_patient_name: string };
        Returns: boolean;
      };
      is_working_day: {
        Args: { p_day: string; p_location?: string; p_org: string };
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
      job_enqueue_batch: {
        Args: { p_delay?: number; p_payloads: Json[]; p_queue: string };
        Returns: number[];
      };
      job_next_due: { Args: { p_queue: string }; Returns: number };
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
      kb_match: {
        Args: { p_embedding: string; p_group_ids?: string[]; p_limit?: number; p_org_id: string };
        Returns: {
          chunk_id: string;
          content: string;
          similarity: number;
          source_id: string;
          source_name: string;
        }[];
      };
      kb_replace_chunks: {
        Args: { p_chunks: Json; p_content_hash: string; p_org_id: string; p_source_id: string };
        Returns: number;
      };
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
      portal_count: {
        Args: { p_object_key: string; p_org_id: string; p_params: Json; p_where: string };
        Returns: number;
      };
      portal_ids: {
        Args: {
          p_limit?: number;
          p_object_key: string;
          p_org_id: string;
          p_params: Json;
          p_where: string;
        };
        Returns: string[];
      };
      portal_search: {
        Args: {
          p_limit?: number;
          p_object_key: string;
          p_offset?: number;
          p_order_by: string;
          p_org_id: string;
          p_params: Json;
          p_where: string;
        };
        Returns: {
          row_data: Json;
          total: number;
        }[];
      };
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number };
        Returns: {
          allowed: boolean;
          hits: number;
          retry_after: number;
        }[];
      };
      recall_clinical_messaging_enabled: { Args: { p_org: string }; Returns: boolean };
      reconcile_snapshot: { Args: { p_org_id: string }; Returns: Json };
      refresh_metrics: { Args: { p_name?: string }; Returns: string[] };
      release_flow_lock: { Args: { p_key: string; p_owner: string }; Returns: undefined };
      report_agents: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          avg_first_response_seconds: number;
          avg_resolution_seconds: number;
          conversations_closed: number;
          first_responses: number;
          messages_sent: number;
          name: string;
          user_id: string;
        }[];
      };
      report_appointments_by_day: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          awaiting: number;
          cancelled: number;
          completed: number;
          confirmed: number;
          day: string;
          no_show: number;
        }[];
      };
      report_appointments_by_location: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          cancelled: number;
          completed: number;
          location_id: string;
          location_name: string;
          no_show: number;
          total: number;
        }[];
      };
      report_appointments_by_specialist: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          cancelled: number;
          completed: number;
          no_show: number;
          specialist_id: string;
          specialist_name: string;
          total: number;
        }[];
      };
      report_appointments_summary: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          awaiting: number;
          cancelled: number;
          completed: number;
          confirmed: number;
          no_show: number;
          total: number;
        }[];
      };
      report_campaigns: {
        Args: { p_channels?: string[]; p_from: string; p_org: string; p_to: string };
        Returns: {
          campaign_id: string;
          channel_name: string;
          delivered: number;
          eligible: number;
          failed: number;
          name: string;
          read_count: number;
          replied: number;
          sent: number;
          skipped: number;
          started_at: string;
          status: string;
          total: number;
        }[];
      };
      report_conversations_by_channel: {
        Args: {
          p_channels?: string[];
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
        };
        Returns: {
          channel_id: string;
          channel_name: string;
          conversations: number;
        }[];
      };
      report_conversations_by_day: {
        Args: {
          p_channels?: string[];
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
        };
        Returns: {
          closed: number;
          day: string;
          inbound_messages: number;
          opened: number;
          outbound_messages: number;
        }[];
      };
      report_conversations_summary: {
        Args: {
          p_channels?: string[];
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
        };
        Returns: {
          closed: number;
          conversations: number;
          inbound_messages: number;
          outbound_messages: number;
          returning_contacts: number;
          still_open: number;
          unique_contacts: number;
        }[];
      };
      report_enquiries_by_day: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          created: number;
          day: string;
          disqualified: number;
          lost: number;
          won: number;
        }[];
      };
      report_enquiries_summary: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          created: number;
          disqualified: number;
          lost: number;
          open_now: number;
          won: number;
          won_value: number;
        }[];
      };
      report_enquiry_booking_conversion: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          booked: number;
          created: number;
        }[];
      };
      report_enquiry_funnel: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          disqualified_here: number;
          entered: number;
          lost_here: number;
          open_now: number;
          pipeline_id: string;
          pipeline_name: string;
          stage_id: string;
          stage_name: string;
          won_here: number;
        }[];
      };
      report_enquiry_stage_times: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          avg_seconds: number;
          median_seconds: number;
          pipeline_id: string;
          pipeline_name: string;
          stage_id: string;
          stage_name: string;
          stays: number;
        }[];
      };
      report_heatmap: {
        Args: { p_channels?: string[]; p_from: string; p_org: string; p_to: string };
        Returns: {
          dow: number;
          hour: number;
          inbound_messages: number;
        }[];
      };
      report_response_summary: {
        Args: {
          p_channels?: string[];
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
        };
        Returns: {
          answered: number;
          conversations: number;
          fr_avg_seconds: number;
          fr_median_seconds: number;
          fr_p90_seconds: number;
          over_4h: number;
          res_avg_seconds: number;
          res_median_seconds: number;
          resolved: number;
          unanswered: number;
          within_15m: number;
          within_1h: number;
          within_4h: number;
          within_5m: number;
        }[];
      };
      report_sources_available: { Args: Record<PropertyKey, never>; Returns: string[] };
      report_unite_appointments_by_day: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          appointments: number;
          day: string;
          unmapped: number;
        }[];
      };
      report_unite_status_codes: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          appointments: number;
          code: string;
          mapped_status: string;
        }[];
      };
      report_usage_by_day: {
        Args: { p_channels?: string[]; p_from: string; p_org: string; p_to: string };
        Returns: {
          day: string;
          failed: number;
          free_form: number;
          template: number;
        }[];
      };
      report_usage_totals: {
        Args: { p_channels?: string[]; p_from: string; p_org: string; p_to: string };
        Returns: {
          category: string;
          messages: number;
          status: string;
        }[];
      };
      reserve_send_slot: { Args: { p_cap: number; p_channel_id: string }; Returns: number };
      seed_clinical_settings: { Args: { p_org: string }; Returns: undefined };
      seed_condition_groups: { Args: { p_org: string }; Returns: undefined };
      seed_finance_reference: { Args: { p_org_id: string }; Returns: undefined };
      seed_finance_roles: { Args: { p_org_id: string; p_roles: Json }; Returns: number };
      seed_parallel_run_scenarios: { Args: { p_org: string }; Returns: undefined };
      seed_phase8_defaults: { Args: { p_org: string }; Returns: undefined };
      seed_portal_objects: { Args: { p_org: string }; Returns: undefined };
      seed_recall_programmes: { Args: { p_org: string }; Returns: undefined };
      seed_reminder_exclusions: { Args: { p_org: string }; Returns: undefined };
      seed_unite_appointment_status_map: { Args: { p_org: string }; Returns: undefined };
      set_presence: { Args: { p_org_id: string; p_presence: string }; Returns: undefined };
      show_limit: { Args: Record<PropertyKey, never>; Returns: number };
      show_trgm: { Args: { "": string }; Returns: string[] };
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
      workdays_between: {
        Args: { p_from: string; p_location?: string; p_org: string; p_to: string };
        Returns: number;
      };
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
      recall_follow_up_status: "called" | "no_response" | "booked";
      recall_kind: "chronic" | "birthday" | "screening" | "dormant" | "post_visit" | "no_show";
      recall_repeat_policy: "once" | "per_cycle";
      recall_send_status:
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
      recall_follow_up_status: ["called", "no_response", "booked"],
      recall_kind: ["chronic", "birthday", "screening", "dormant", "post_visit", "no_show"],
      recall_repeat_policy: ["once", "per_cycle"],
      recall_send_status: [
        "eligible",
        "queued",
        "sent",
        "delivered",
        "read",
        "failed",
        "skipped_no_template",
        "skipped_opted_out",
        "excluded",
        "cancelled",
      ],
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
