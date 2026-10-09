export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
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
          contact_id: string;
          created_at: string;
          org_id: string;
          tag_id: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          created_at?: string;
          org_id: string;
          tag_id: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          org_id?: string;
          tag_id?: string;
        };
        Relationships: [
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
          created_at: string;
          custom: NonNullable<Json>;
          deleted_at: string | null;
          dob: string | null;
          email: string | null;
          external_id: string | null;
          first_name: string;
          gender: string | null;
          id: string;
          language: string | null;
          last_interaction_at: string | null;
          last_name: string;
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
          created_at?: string;
          custom?: NonNullable<Json>;
          deleted_at?: string | null;
          dob?: string | null;
          email?: string | null;
          external_id?: string | null;
          first_name?: string;
          gender?: string | null;
          id?: string;
          language?: string | null;
          last_interaction_at?: string | null;
          last_name?: string;
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
          created_at?: string;
          custom?: NonNullable<Json>;
          deleted_at?: string | null;
          dob?: string | null;
          email?: string | null;
          external_id?: string | null;
          first_name?: string;
          gender?: string | null;
          id?: string;
          language?: string | null;
          last_interaction_at?: string | null;
          last_name?: string;
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
          conversation_id: string;
          created_at: string;
          id: string;
          message_id: string;
          org_id: string;
          read_at: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          conversation_id: string;
          created_at?: string;
          id?: string;
          message_id: string;
          org_id: string;
          read_at?: string | null;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          id?: string;
          message_id?: string;
          org_id?: string;
          read_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "mentions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
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
      tags: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          scope: string;
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
          scope?: string;
          sort?: number;
          updated_at?: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          scope?: string;
          sort?: number;
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
      wa_templates: {
        Row: {
          archived_at: string | null;
          category: string;
          channel_id: string | null;
          components: NonNullable<Json>;
          created_at: string;
          id: string;
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
          components?: NonNullable<Json>;
          created_at?: string;
          id?: string;
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
          components?: NonNullable<Json>;
          created_at?: string;
          id?: string;
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
    };
    Views: {
      [_ in never]: never;
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
      complete_scheduled_job: { Args: { p_id: string }; Returns: undefined };
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
      pgp_armor_headers: { Args: { "": string }; Returns: Record<string, unknown>[] };
      pick_round_robin_assignee: { Args: { p_org_id: string; p_team_id: string }; Returns: string };
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
    };
    Enums: {
      [_ in never]: never;
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
    Enums: {},
  },
} as const;
