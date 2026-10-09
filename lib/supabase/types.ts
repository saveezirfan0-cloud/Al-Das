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
        };
        ComputedFields: never;
        Insert: {
          assignee_id?: string | null;
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
        };
        Update: {
          assignee_id?: string | null;
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
          committed_at: string | null;
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
          committed_at?: string | null;
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
          committed_at?: string | null;
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
      ins_claim_activities: {
        Row: {
          activity_start_date: string | null;
          claim_activity_number: string;
          claim_month: number | null;
          claim_status: string | null;
          claim_year: number | null;
          clinician_id: string | null;
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
          match_status: string;
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
          match_status?: string;
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
          match_status?: string;
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
      integration_accounts: {
        Row: {
          config_enc: string;
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
          config_enc: string;
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
          config_enc?: string;
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
            foreignKeyName: "mentions_mentioned_by_fkey";
            columns: ["mentioned_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      sync_reviews: {
        Row: {
          candidates: NonNullable<Json>;
          created_at: string;
          entity: string;
          external_id: string;
          id: string;
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
    };
    Views: {
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
    };
    Functions: {
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
      fin_apply_invoices: {
        Args: { p_batch_id: string; p_invoices: Json; p_org_id: string };
        Returns: Json;
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
      seed_finance_reference: { Args: { p_org_id: string }; Returns: undefined };
      seed_finance_roles: { Args: { p_org_id: string; p_roles: Json }; Returns: number };
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
