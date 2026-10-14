export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      acc_accounts: {
        Row: {
          affects_gross_profit: boolean;
          allow_manual: boolean;
          cash_flow_class: string | null;
          code: string;
          control: string | null;
          created_at: string;
          created_by: string | null;
          ct_treatment: string | null;
          currency: string | null;
          description: string | null;
          entity_id: string | null;
          id: string;
          is_active: boolean;
          is_group: boolean;
          is_system: boolean;
          name: string;
          nature: string;
          org_id: string;
          parent_id: string | null;
          requires_branch: boolean;
          requires_cost_centre: boolean;
          sort_order: number;
          tally_alter_id: number | null;
          tally_group: string | null;
          tally_guid: string | null;
          tally_name: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          affects_gross_profit?: boolean;
          allow_manual?: boolean;
          cash_flow_class?: string | null;
          code: string;
          control?: string | null;
          created_at?: string;
          created_by?: string | null;
          ct_treatment?: string | null;
          currency?: string | null;
          description?: string | null;
          entity_id?: string | null;
          id?: string;
          is_active?: boolean;
          is_group?: boolean;
          is_system?: boolean;
          name: string;
          nature: string;
          org_id: string;
          parent_id?: string | null;
          requires_branch?: boolean;
          requires_cost_centre?: boolean;
          sort_order?: number;
          tally_alter_id?: number | null;
          tally_group?: string | null;
          tally_guid?: string | null;
          tally_name?: string | null;
          updated_at?: string;
        };
        Update: {
          affects_gross_profit?: boolean;
          allow_manual?: boolean;
          cash_flow_class?: string | null;
          code?: string;
          control?: string | null;
          created_at?: string;
          created_by?: string | null;
          ct_treatment?: string | null;
          currency?: string | null;
          description?: string | null;
          entity_id?: string | null;
          id?: string;
          is_active?: boolean;
          is_group?: boolean;
          is_system?: boolean;
          name?: string;
          nature?: string;
          org_id?: string;
          parent_id?: string | null;
          requires_branch?: boolean;
          requires_cost_centre?: boolean;
          sort_order?: number;
          tally_alter_id?: number | null;
          tally_group?: string | null;
          tally_guid?: string | null;
          tally_name?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_accounts_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_accounts_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_accounts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_accounts_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_allocations: {
        Row: {
          allocated_by: string | null;
          amount: number;
          created_at: string;
          id: string;
          invoice_id: string;
          org_id: string;
          receipt_id: string;
        };
        ComputedFields: never;
        Insert: {
          allocated_by?: string | null;
          amount: number;
          created_at?: string;
          id?: string;
          invoice_id: string;
          org_id: string;
          receipt_id: string;
        };
        Update: {
          allocated_by?: string | null;
          amount?: number;
          created_at?: string;
          id?: string;
          invoice_id?: string;
          org_id?: string;
          receipt_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_allocations_allocated_by_fkey";
            columns: ["allocated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_allocations_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "acc_sales_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_allocations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_allocations_receipt_id_fkey";
            columns: ["receipt_id"];
            isOneToOne: false;
            referencedRelation: "acc_receipts";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_ar_number_series: {
        Row: {
          created_at: string;
          doc_kind: string;
          entity_id: string;
          fiscal_year_id: string;
          id: string;
          next_number: number;
          org_id: string;
          prefix: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          doc_kind: string;
          entity_id: string;
          fiscal_year_id: string;
          id?: string;
          next_number?: number;
          org_id: string;
          prefix: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          doc_kind?: string;
          entity_id?: string;
          fiscal_year_id?: string;
          id?: string;
          next_number?: number;
          org_id?: string;
          prefix?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_ar_number_series_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_ar_number_series_fiscal_year_id_fkey";
            columns: ["fiscal_year_id"];
            isOneToOne: false;
            referencedRelation: "acc_fiscal_years";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_ar_number_series_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_ar_settings: {
        Row: {
          created_at: string;
          credit_note_days: number;
          credit_note_prefix: string;
          invoice_prefix: string;
          issue_approval_threshold: number;
          org_id: string;
          payment_instructions: string | null;
          receipt_prefix: string;
          seller_address: string | null;
          simplified_invoice_limit: number;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          credit_note_days?: number;
          credit_note_prefix?: string;
          invoice_prefix?: string;
          issue_approval_threshold?: number;
          org_id: string;
          payment_instructions?: string | null;
          receipt_prefix?: string;
          seller_address?: string | null;
          simplified_invoice_limit?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          credit_note_days?: number;
          credit_note_prefix?: string;
          invoice_prefix?: string;
          issue_approval_threshold?: number;
          org_id?: string;
          payment_instructions?: string | null;
          receipt_prefix?: string;
          seller_address?: string | null;
          simplified_invoice_limit?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_ar_settings_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_ar_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_asset_classes: {
        Row: {
          accum_account_id: string;
          active: boolean;
          code: string;
          cost_account_id: string;
          created_at: string;
          disposal_account_id: string;
          expense_account_id: string;
          id: string;
          life_months: number;
          method: string;
          name: string;
          org_id: string;
          residual_pct: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          accum_account_id: string;
          active?: boolean;
          code: string;
          cost_account_id: string;
          created_at?: string;
          disposal_account_id: string;
          expense_account_id: string;
          id?: string;
          life_months: number;
          method?: string;
          name: string;
          org_id: string;
          residual_pct?: number;
          updated_at?: string;
        };
        Update: {
          accum_account_id?: string;
          active?: boolean;
          code?: string;
          cost_account_id?: string;
          created_at?: string;
          disposal_account_id?: string;
          expense_account_id?: string;
          id?: string;
          life_months?: number;
          method?: string;
          name?: string;
          org_id?: string;
          residual_pct?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_asset_classes_accum_account_id_fkey";
            columns: ["accum_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_classes_cost_account_id_fkey";
            columns: ["cost_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_classes_disposal_account_id_fkey";
            columns: ["disposal_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_classes_expense_account_id_fkey";
            columns: ["expense_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_classes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_asset_run_lines: {
        Row: {
          amount: number;
          asset_id: string | null;
          branch_code: string | null;
          created_at: string;
          credit_account_id: string;
          debit_account_id: string;
          department: string | null;
          id: string;
          org_id: string;
          run_id: string;
          schedule_id: string | null;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          asset_id?: string | null;
          branch_code?: string | null;
          created_at?: string;
          credit_account_id: string;
          debit_account_id: string;
          department?: string | null;
          id?: string;
          org_id: string;
          run_id: string;
          schedule_id?: string | null;
          version: number;
        };
        Update: {
          amount?: number;
          asset_id?: string | null;
          branch_code?: string | null;
          created_at?: string;
          credit_account_id?: string;
          debit_account_id?: string;
          department?: string | null;
          id?: string;
          org_id?: string;
          run_id?: string;
          schedule_id?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_asset_run_lines_asset_id_fkey";
            columns: ["asset_id"];
            isOneToOne: false;
            referencedRelation: "acc_assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_run_lines_credit_account_id_fkey";
            columns: ["credit_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_run_lines_debit_account_id_fkey";
            columns: ["debit_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_run_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_run_lines_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "acc_depreciation_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_asset_run_lines_schedule_id_fkey";
            columns: ["schedule_id"];
            isOneToOne: false;
            referencedRelation: "acc_schedules";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_assets: {
        Row: {
          acquisition_date: string;
          branch_code: string | null;
          class_id: string;
          code: string;
          cost: number;
          created_at: string;
          created_by: string | null;
          department: string | null;
          description: string;
          disposal_account_id: string | null;
          disposal_accumulated: number | null;
          disposal_date: string | null;
          disposal_journal_id: string | null;
          disposal_posted_accum: number | null;
          disposal_posted_at: string | null;
          disposal_posted_by: string | null;
          disposal_prepared_at: string | null;
          disposal_prepared_by: string | null;
          disposal_proceeds: number | null;
          disposal_sha256: string | null;
          disposal_status: string | null;
          entity_id: string;
          id: string;
          in_service_date: string;
          life_months: number;
          method: string;
          opening_accumulated: number;
          org_id: string;
          residual: number;
          status: string;
          supplier_invoice_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          acquisition_date: string;
          branch_code?: string | null;
          class_id: string;
          code: string;
          cost: number;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          description: string;
          disposal_account_id?: string | null;
          disposal_accumulated?: number | null;
          disposal_date?: string | null;
          disposal_journal_id?: string | null;
          disposal_posted_accum?: number | null;
          disposal_posted_at?: string | null;
          disposal_posted_by?: string | null;
          disposal_prepared_at?: string | null;
          disposal_prepared_by?: string | null;
          disposal_proceeds?: number | null;
          disposal_sha256?: string | null;
          disposal_status?: string | null;
          entity_id: string;
          id?: string;
          in_service_date: string;
          life_months: number;
          method: string;
          opening_accumulated?: number;
          org_id: string;
          residual?: number;
          status?: string;
          supplier_invoice_id?: string | null;
          updated_at?: string;
        };
        Update: {
          acquisition_date?: string;
          branch_code?: string | null;
          class_id?: string;
          code?: string;
          cost?: number;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          description?: string;
          disposal_account_id?: string | null;
          disposal_accumulated?: number | null;
          disposal_date?: string | null;
          disposal_journal_id?: string | null;
          disposal_posted_accum?: number | null;
          disposal_posted_at?: string | null;
          disposal_posted_by?: string | null;
          disposal_prepared_at?: string | null;
          disposal_prepared_by?: string | null;
          disposal_proceeds?: number | null;
          disposal_sha256?: string | null;
          disposal_status?: string | null;
          entity_id?: string;
          id?: string;
          in_service_date?: string;
          life_months?: number;
          method?: string;
          opening_accumulated?: number;
          org_id?: string;
          residual?: number;
          status?: string;
          supplier_invoice_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_assets_class_id_fkey";
            columns: ["class_id"];
            isOneToOne: false;
            referencedRelation: "acc_asset_classes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_disposal_account_id_fkey";
            columns: ["disposal_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_disposal_journal_id_fkey";
            columns: ["disposal_journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_disposal_posted_by_fkey";
            columns: ["disposal_posted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_disposal_prepared_by_fkey";
            columns: ["disposal_prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_assets_supplier_invoice_id_fkey";
            columns: ["supplier_invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_supplier_invoices";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_bank_entries: {
        Row: {
          account_id: string;
          amount: number;
          bank_account_id: string;
          bank_line_id: string | null;
          branch_code: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          cheque_id: string | null;
          created_at: string;
          created_by: string | null;
          entry_date: string;
          id: string;
          journal_id: string | null;
          kind: string;
          narration: string;
          org_id: string;
          reference: string | null;
          status: string;
          tax_code_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          amount: number;
          bank_account_id: string;
          bank_line_id?: string | null;
          branch_code?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cheque_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          entry_date: string;
          id?: string;
          journal_id?: string | null;
          kind: string;
          narration: string;
          org_id: string;
          reference?: string | null;
          status?: string;
          tax_code_id?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          amount?: number;
          bank_account_id?: string;
          bank_line_id?: string | null;
          branch_code?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          cheque_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          entry_date?: string;
          id?: string;
          journal_id?: string | null;
          kind?: string;
          narration?: string;
          org_id?: string;
          reference?: string | null;
          status?: string;
          tax_code_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_bank_entries_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_bank_account_id_fkey";
            columns: ["bank_account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_bank_line_id_fkey";
            columns: ["bank_line_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_cheque_fk";
            columns: ["cheque_id"];
            isOneToOne: false;
            referencedRelation: "acc_cheques";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_entries_tax_code_id_fkey";
            columns: ["tax_code_id"];
            isOneToOne: false;
            referencedRelation: "acc_tax_codes";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_bank_statement_balances: {
        Row: {
          as_of: string;
          balance: number;
          bank_account_id: string;
          created_at: string;
          entered_by: string | null;
          id: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          as_of: string;
          balance: number;
          bank_account_id: string;
          created_at?: string;
          entered_by?: string | null;
          id?: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          as_of?: string;
          balance?: number;
          bank_account_id?: string;
          created_at?: string;
          entered_by?: string | null;
          id?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_bank_statement_balances_bank_account_id_fkey";
            columns: ["bank_account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_statement_balances_entered_by_fkey";
            columns: ["entered_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_statement_balances_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_bank_transfers: {
        Row: {
          amount: number;
          branch_code: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          float_id: string | null;
          from_account_id: string;
          id: string;
          journal_id: string | null;
          kind: string;
          narration: string;
          org_id: string;
          reference: string | null;
          status: string;
          to_account_id: string;
          transfer_date: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          branch_code?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          float_id?: string | null;
          from_account_id: string;
          id?: string;
          journal_id?: string | null;
          kind: string;
          narration: string;
          org_id: string;
          reference?: string | null;
          status?: string;
          to_account_id: string;
          transfer_date: string;
          updated_at?: string;
        };
        Update: {
          amount?: number;
          branch_code?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          float_id?: string | null;
          from_account_id?: string;
          id?: string;
          journal_id?: string | null;
          kind?: string;
          narration?: string;
          org_id?: string;
          reference?: string | null;
          status?: string;
          to_account_id?: string;
          transfer_date?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_bank_transfers_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_transfers_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_transfers_float_id_fkey";
            columns: ["float_id"];
            isOneToOne: false;
            referencedRelation: "acc_petty_cash_floats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_transfers_from_account_id_fkey";
            columns: ["from_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_transfers_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_transfers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_bank_transfers_to_account_id_fkey";
            columns: ["to_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_budget_lines: {
        Row: {
          account_id: string;
          amount: number;
          branch_code: string | null;
          budget_id: string;
          created_at: string;
          department: string | null;
          id: string;
          month: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          amount: number;
          branch_code?: string | null;
          budget_id: string;
          created_at?: string;
          department?: string | null;
          id?: string;
          month: string;
          org_id: string;
        };
        Update: {
          account_id?: string;
          amount?: number;
          branch_code?: string | null;
          budget_id?: string;
          created_at?: string;
          department?: string | null;
          id?: string;
          month?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_budget_lines_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_budget_lines_budget_id_fkey";
            columns: ["budget_id"];
            isOneToOne: false;
            referencedRelation: "acc_budgets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_budget_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_budgets: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          approved_sha256: string | null;
          created_at: string;
          entity_id: string;
          fy_start: string;
          id: string;
          name: string;
          org_id: string;
          prepared_at: string | null;
          prepared_by: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          approved_sha256?: string | null;
          created_at?: string;
          entity_id: string;
          fy_start: string;
          id?: string;
          name: string;
          org_id: string;
          prepared_at?: string | null;
          prepared_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          approved_sha256?: string | null;
          created_at?: string;
          entity_id?: string;
          fy_start?: string;
          id?: string;
          name?: string;
          org_id?: string;
          prepared_at?: string | null;
          prepared_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_budgets_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_budgets_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_budgets_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_budgets_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_cheque_books: {
        Row: {
          active: boolean;
          bank_account_id: string;
          created_at: string;
          created_by: string | null;
          first_number: number;
          id: string;
          last_number: number;
          next_number: number;
          org_id: string;
          updated_at: string;
          width: number;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          bank_account_id: string;
          created_at?: string;
          created_by?: string | null;
          first_number: number;
          id?: string;
          last_number: number;
          next_number: number;
          org_id: string;
          updated_at?: string;
          width?: number;
        };
        Update: {
          active?: boolean;
          bank_account_id?: string;
          created_at?: string;
          created_by?: string | null;
          first_number?: number;
          id?: string;
          last_number?: number;
          next_number?: number;
          org_id?: string;
          updated_at?: string;
          width?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_cheque_books_bank_account_id_fkey";
            columns: ["bank_account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheque_books_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheque_books_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_cheques: {
        Row: {
          amount: number;
          bank_account_id: string;
          bounced_on: string | null;
          cancelled_on: string | null;
          charge_entry_id: string | null;
          cheque_book_id: string | null;
          cheque_date: string;
          cheque_no: string;
          cleared_on: string | null;
          counter_account_id: string;
          created_at: string;
          created_by: string | null;
          direction: string;
          id: string;
          journal_id: string | null;
          narration: string | null;
          org_id: string;
          party_kind: string;
          party_name: string | null;
          party_ref: string | null;
          post_dated: boolean | null;
          posting: string;
          presented_on: string | null;
          recorded_on: string;
          stale_on: string | null;
          status: string;
          status_reason: string | null;
          updated_at: string;
          updated_by: string | null;
          voucher_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          bank_account_id: string;
          bounced_on?: string | null;
          cancelled_on?: string | null;
          charge_entry_id?: string | null;
          cheque_book_id?: string | null;
          cheque_date: string;
          cheque_no: string;
          cleared_on?: string | null;
          counter_account_id: string;
          created_at?: string;
          created_by?: string | null;
          direction: string;
          id?: string;
          journal_id?: string | null;
          narration?: string | null;
          org_id: string;
          party_kind: string;
          party_name?: string | null;
          party_ref?: string | null;
          post_dated?: never;
          posting?: string;
          presented_on?: string | null;
          recorded_on: string;
          stale_on?: string | null;
          status: string;
          status_reason?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          voucher_id?: string | null;
        };
        Update: {
          amount?: number;
          bank_account_id?: string;
          bounced_on?: string | null;
          cancelled_on?: string | null;
          charge_entry_id?: string | null;
          cheque_book_id?: string | null;
          cheque_date?: string;
          cheque_no?: string;
          cleared_on?: string | null;
          counter_account_id?: string;
          created_at?: string;
          created_by?: string | null;
          direction?: string;
          id?: string;
          journal_id?: string | null;
          narration?: string | null;
          org_id?: string;
          party_kind?: string;
          party_name?: string | null;
          party_ref?: string | null;
          post_dated?: never;
          posting?: string;
          presented_on?: string | null;
          recorded_on?: string;
          stale_on?: string | null;
          status?: string;
          status_reason?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          voucher_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_cheques_bank_account_id_fkey";
            columns: ["bank_account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_charge_entry_id_fkey";
            columns: ["charge_entry_id"];
            isOneToOne: false;
            referencedRelation: "acc_bank_entries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_cheque_book_id_fkey";
            columns: ["cheque_book_id"];
            isOneToOne: false;
            referencedRelation: "acc_cheque_books";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_counter_account_id_fkey";
            columns: ["counter_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_cheques_voucher_id_fkey";
            columns: ["voucher_id"];
            isOneToOne: false;
            referencedRelation: "fin_payment_vouchers";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_cost_centres: {
        Row: {
          active: boolean;
          code: string;
          created_at: string;
          id: string;
          name: string;
          org_id: string;
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
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          code?: string;
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_cost_centres_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_customers: {
        Row: {
          active: boolean;
          address_line1: string | null;
          address_line2: string | null;
          city: string | null;
          connected_person: boolean;
          country: string;
          created_at: string;
          created_by: string | null;
          credit_terms_days: number;
          email: string | null;
          emirate: string | null;
          id: string;
          kind: string;
          name: string;
          org_id: string;
          payer_id: string | null;
          receivable_account_id: string | null;
          trn: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          address_line1?: string | null;
          address_line2?: string | null;
          city?: string | null;
          connected_person?: boolean;
          country?: string;
          created_at?: string;
          created_by?: string | null;
          credit_terms_days?: number;
          email?: string | null;
          emirate?: string | null;
          id?: string;
          kind: string;
          name: string;
          org_id: string;
          payer_id?: string | null;
          receivable_account_id?: string | null;
          trn?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          address_line1?: string | null;
          address_line2?: string | null;
          city?: string | null;
          connected_person?: boolean;
          country?: string;
          created_at?: string;
          created_by?: string | null;
          credit_terms_days?: number;
          email?: string | null;
          emirate?: string | null;
          id?: string;
          kind?: string;
          name?: string;
          org_id?: string;
          payer_id?: string | null;
          receivable_account_id?: string | null;
          trn?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_customers_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_customers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_customers_receivable_account_id_fkey";
            columns: ["receivable_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_depreciation_runs: {
        Row: {
          created_at: string;
          entity_id: string;
          id: string;
          journal_id: string | null;
          kind: string;
          line_count: number;
          org_id: string;
          period_month: string;
          posted_at: string | null;
          posted_by: string | null;
          posted_sha256: string | null;
          posted_version: number | null;
          prepared_at: string;
          prepared_by: string | null;
          sha256: string;
          status: string;
          total: number;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          entity_id: string;
          id?: string;
          journal_id?: string | null;
          kind: string;
          line_count?: number;
          org_id: string;
          period_month: string;
          posted_at?: string | null;
          posted_by?: string | null;
          posted_sha256?: string | null;
          posted_version?: number | null;
          prepared_at?: string;
          prepared_by?: string | null;
          sha256: string;
          status?: string;
          total?: number;
          updated_at?: string;
          version?: number;
        };
        Update: {
          created_at?: string;
          entity_id?: string;
          id?: string;
          journal_id?: string | null;
          kind?: string;
          line_count?: number;
          org_id?: string;
          period_month?: string;
          posted_at?: string | null;
          posted_by?: string | null;
          posted_sha256?: string | null;
          posted_version?: number | null;
          prepared_at?: string;
          prepared_by?: string | null;
          sha256?: string;
          status?: string;
          total?: number;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_depreciation_runs_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_depreciation_runs_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_depreciation_runs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_depreciation_runs_posted_by_fkey";
            columns: ["posted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_depreciation_runs_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_entities: {
        Row: {
          active: boolean;
          base_currency: string;
          created_at: string;
          created_by: string | null;
          default_emirate: string;
          fiscal_year_start_month: number;
          id: string;
          is_default: boolean;
          ledger_start_date: string | null;
          name: string;
          org_id: string;
          trn: string | null;
          updated_at: string;
          vat_period_anchor_month: number;
          vat_period_months: number;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          base_currency?: string;
          created_at?: string;
          created_by?: string | null;
          default_emirate?: string;
          fiscal_year_start_month?: number;
          id?: string;
          is_default?: boolean;
          ledger_start_date?: string | null;
          name: string;
          org_id: string;
          trn?: string | null;
          updated_at?: string;
          vat_period_anchor_month?: number;
          vat_period_months?: number;
        };
        Update: {
          active?: boolean;
          base_currency?: string;
          created_at?: string;
          created_by?: string | null;
          default_emirate?: string;
          fiscal_year_start_month?: number;
          id?: string;
          is_default?: boolean;
          ledger_start_date?: string | null;
          name?: string;
          org_id?: string;
          trn?: string | null;
          updated_at?: string;
          vat_period_anchor_month?: number;
          vat_period_months?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_entities_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_entities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_entity_branches: {
        Row: {
          branch_code: string;
          created_at: string;
          emirate: string;
          entity_id: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          branch_code: string;
          created_at?: string;
          emirate?: string;
          entity_id: string;
          org_id: string;
        };
        Update: {
          branch_code?: string;
          created_at?: string;
          emirate?: string;
          entity_id?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_entity_branches_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_entity_branches_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_fiscal_years: {
        Row: {
          closed_at: string | null;
          closed_by: string | null;
          closing_journal_id: string | null;
          created_at: string;
          end_date: string;
          entity_id: string;
          id: string;
          label: string;
          org_id: string;
          start_date: string;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          closed_at?: string | null;
          closed_by?: string | null;
          closing_journal_id?: string | null;
          created_at?: string;
          end_date: string;
          entity_id: string;
          id?: string;
          label: string;
          org_id: string;
          start_date: string;
          status?: string;
        };
        Update: {
          closed_at?: string | null;
          closed_by?: string | null;
          closing_journal_id?: string | null;
          created_at?: string;
          end_date?: string;
          entity_id?: string;
          id?: string;
          label?: string;
          org_id?: string;
          start_date?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_fiscal_years_closed_by_fkey";
            columns: ["closed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_fiscal_years_closing_journal_id_fkey";
            columns: ["closing_journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_fiscal_years_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_fiscal_years_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_journal_lines: {
        Row: {
          account_id: string;
          amount_fx: number | null;
          branch_code: string | null;
          cost_centre_id: string | null;
          created_at: string;
          credit: number;
          currency: string | null;
          debit: number;
          department: string | null;
          description: string | null;
          doctor_id: string | null;
          fx_rate: number | null;
          id: string;
          journal_id: string;
          line_no: number;
          org_id: string;
          party_id: string | null;
          party_kind: string | null;
          payer_id: string | null;
          supplier_id: string | null;
          tax_code_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          amount_fx?: number | null;
          branch_code?: string | null;
          cost_centre_id?: string | null;
          created_at?: string;
          credit?: number;
          currency?: string | null;
          debit?: number;
          department?: string | null;
          description?: string | null;
          doctor_id?: string | null;
          fx_rate?: number | null;
          id?: string;
          journal_id: string;
          line_no: number;
          org_id: string;
          party_id?: string | null;
          party_kind?: string | null;
          payer_id?: string | null;
          supplier_id?: string | null;
          tax_code_id?: string | null;
        };
        Update: {
          account_id?: string;
          amount_fx?: number | null;
          branch_code?: string | null;
          cost_centre_id?: string | null;
          created_at?: string;
          credit?: number;
          currency?: string | null;
          debit?: number;
          department?: string | null;
          description?: string | null;
          doctor_id?: string | null;
          fx_rate?: number | null;
          id?: string;
          journal_id?: string;
          line_no?: number;
          org_id?: string;
          party_id?: string | null;
          party_kind?: string | null;
          payer_id?: string | null;
          supplier_id?: string | null;
          tax_code_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_journal_lines_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journal_lines_cost_centre_id_fkey";
            columns: ["cost_centre_id"];
            isOneToOne: false;
            referencedRelation: "acc_cost_centres";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journal_lines_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journal_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journal_lines_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "fin_suppliers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journal_lines_tax_code_id_fkey";
            columns: ["tax_code_id"];
            isOneToOne: false;
            referencedRelation: "acc_tax_codes";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_journals: {
        Row: {
          approved_by: string | null;
          auto_reverse_on: string | null;
          created_at: string;
          entity_id: string;
          fiscal_year_id: string | null;
          id: string;
          is_adjustment: boolean;
          journal_date: string;
          narration: string;
          number: string | null;
          org_id: string;
          period_id: string | null;
          posted_at: string | null;
          prepared_by: string | null;
          return_remarks: string | null;
          returned_at: string | null;
          returned_by: string | null;
          reversal_of: string | null;
          reversed_by: string | null;
          sha256: string | null;
          source_id: string | null;
          source_kind: string | null;
          source_version: number | null;
          status: string;
          submitted_at: string | null;
          submitted_by: string | null;
          tally_alter_id: number | null;
          tally_guid: string | null;
          total: number;
          updated_at: string;
          voucher_type: string;
        };
        ComputedFields: never;
        Insert: {
          approved_by?: string | null;
          auto_reverse_on?: string | null;
          created_at?: string;
          entity_id: string;
          fiscal_year_id?: string | null;
          id?: string;
          is_adjustment?: boolean;
          journal_date: string;
          narration: string;
          number?: string | null;
          org_id: string;
          period_id?: string | null;
          posted_at?: string | null;
          prepared_by?: string | null;
          return_remarks?: string | null;
          returned_at?: string | null;
          returned_by?: string | null;
          reversal_of?: string | null;
          reversed_by?: string | null;
          sha256?: string | null;
          source_id?: string | null;
          source_kind?: string | null;
          source_version?: number | null;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          tally_alter_id?: number | null;
          tally_guid?: string | null;
          total?: number;
          updated_at?: string;
          voucher_type?: string;
        };
        Update: {
          approved_by?: string | null;
          auto_reverse_on?: string | null;
          created_at?: string;
          entity_id?: string;
          fiscal_year_id?: string | null;
          id?: string;
          is_adjustment?: boolean;
          journal_date?: string;
          narration?: string;
          number?: string | null;
          org_id?: string;
          period_id?: string | null;
          posted_at?: string | null;
          prepared_by?: string | null;
          return_remarks?: string | null;
          returned_at?: string | null;
          returned_by?: string | null;
          reversal_of?: string | null;
          reversed_by?: string | null;
          sha256?: string | null;
          source_id?: string | null;
          source_kind?: string | null;
          source_version?: number | null;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          tally_alter_id?: number | null;
          tally_guid?: string | null;
          total?: number;
          updated_at?: string;
          voucher_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_journals_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_fiscal_year_id_fkey";
            columns: ["fiscal_year_id"];
            isOneToOne: false;
            referencedRelation: "acc_fiscal_years";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_period_id_fkey";
            columns: ["period_id"];
            isOneToOne: false;
            referencedRelation: "acc_periods";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_returned_by_fkey";
            columns: ["returned_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_reversal_of_fkey";
            columns: ["reversal_of"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_reversed_by_fkey";
            columns: ["reversed_by"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_journals_submitted_by_fkey";
            columns: ["submitted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_number_series: {
        Row: {
          created_at: string;
          entity_id: string;
          fiscal_year_id: string;
          id: string;
          next_number: number;
          org_id: string;
          prefix: string;
          updated_at: string;
          voucher_type: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          entity_id: string;
          fiscal_year_id: string;
          id?: string;
          next_number?: number;
          org_id: string;
          prefix: string;
          updated_at?: string;
          voucher_type: string;
        };
        Update: {
          created_at?: string;
          entity_id?: string;
          fiscal_year_id?: string;
          id?: string;
          next_number?: number;
          org_id?: string;
          prefix?: string;
          updated_at?: string;
          voucher_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_number_series_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_number_series_fiscal_year_id_fkey";
            columns: ["fiscal_year_id"];
            isOneToOne: false;
            referencedRelation: "acc_fiscal_years";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_number_series_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_party_flags: {
        Row: {
          cheque_id: string;
          clear_reason: string | null;
          cleared_at: string | null;
          cleared_by: string | null;
          created_at: string;
          id: string;
          org_id: string;
          party_kind: string;
          party_name: string | null;
          party_ref: string | null;
          reason: string;
        };
        ComputedFields: never;
        Insert: {
          cheque_id: string;
          clear_reason?: string | null;
          cleared_at?: string | null;
          cleared_by?: string | null;
          created_at?: string;
          id?: string;
          org_id: string;
          party_kind: string;
          party_name?: string | null;
          party_ref?: string | null;
          reason: string;
        };
        Update: {
          cheque_id?: string;
          clear_reason?: string | null;
          cleared_at?: string | null;
          cleared_by?: string | null;
          created_at?: string;
          id?: string;
          org_id?: string;
          party_kind?: string;
          party_name?: string | null;
          party_ref?: string | null;
          reason?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_party_flags_cheque_id_fkey";
            columns: ["cheque_id"];
            isOneToOne: true;
            referencedRelation: "acc_cheques";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_party_flags_cleared_by_fkey";
            columns: ["cleared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_party_flags_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_periods: {
        Row: {
          closed_at: string | null;
          closed_by: string | null;
          created_at: string;
          end_date: string;
          entity_id: string;
          fiscal_year_id: string;
          id: string;
          is_adjustment: boolean;
          locked_at: string | null;
          locked_by: string | null;
          month: number;
          org_id: string;
          start_date: string;
          status: string;
          updated_at: string;
          year: number;
        };
        ComputedFields: never;
        Insert: {
          closed_at?: string | null;
          closed_by?: string | null;
          created_at?: string;
          end_date: string;
          entity_id: string;
          fiscal_year_id: string;
          id?: string;
          is_adjustment?: boolean;
          locked_at?: string | null;
          locked_by?: string | null;
          month: number;
          org_id: string;
          start_date: string;
          status?: string;
          updated_at?: string;
          year: number;
        };
        Update: {
          closed_at?: string | null;
          closed_by?: string | null;
          created_at?: string;
          end_date?: string;
          entity_id?: string;
          fiscal_year_id?: string;
          id?: string;
          is_adjustment?: boolean;
          locked_at?: string | null;
          locked_by?: string | null;
          month?: number;
          org_id?: string;
          start_date?: string;
          status?: string;
          updated_at?: string;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_periods_closed_by_fkey";
            columns: ["closed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_periods_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_periods_fiscal_year_id_fkey";
            columns: ["fiscal_year_id"];
            isOneToOne: false;
            referencedRelation: "acc_fiscal_years";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_periods_locked_by_fkey";
            columns: ["locked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_periods_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_petty_cash_counts: {
        Row: {
          book_balance: number;
          count_date: string;
          counted_amount: number;
          created_at: string;
          difference: number;
          explanation: string | null;
          float_id: string;
          id: string;
          month: string;
          org_id: string;
          prepared_at: string;
          prepared_by: string | null;
          sha256: string;
          signed_at: string | null;
          signed_by: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          book_balance: number;
          count_date: string;
          counted_amount: number;
          created_at?: string;
          difference: number;
          explanation?: string | null;
          float_id: string;
          id?: string;
          month: string;
          org_id: string;
          prepared_at?: string;
          prepared_by?: string | null;
          sha256: string;
          signed_at?: string | null;
          signed_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          book_balance?: number;
          count_date?: string;
          counted_amount?: number;
          created_at?: string;
          difference?: number;
          explanation?: string | null;
          float_id?: string;
          id?: string;
          month?: string;
          org_id?: string;
          prepared_at?: string;
          prepared_by?: string | null;
          sha256?: string;
          signed_at?: string | null;
          signed_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_petty_cash_counts_float_id_fkey";
            columns: ["float_id"];
            isOneToOne: false;
            referencedRelation: "acc_petty_cash_floats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_counts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_counts_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_counts_signed_by_fkey";
            columns: ["signed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_petty_cash_expenses: {
        Row: {
          account_id: string;
          amount: number;
          branch_code: string | null;
          cancel_reason: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          created_by: string | null;
          document_id: string | null;
          expense_date: string;
          float_id: string;
          id: string;
          journal_id: string | null;
          narration: string;
          org_id: string;
          reference: string | null;
          status: string;
          tax_code_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          amount: number;
          branch_code?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          expense_date: string;
          float_id: string;
          id?: string;
          journal_id?: string | null;
          narration: string;
          org_id: string;
          reference?: string | null;
          status?: string;
          tax_code_id?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          amount?: number;
          branch_code?: string | null;
          cancel_reason?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          expense_date?: string;
          float_id?: string;
          id?: string;
          journal_id?: string | null;
          narration?: string;
          org_id?: string;
          reference?: string | null;
          status?: string;
          tax_code_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_petty_cash_expenses_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "fin_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_float_id_fkey";
            columns: ["float_id"];
            isOneToOne: false;
            referencedRelation: "acc_petty_cash_floats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_expenses_tax_code_id_fkey";
            columns: ["tax_code_id"];
            isOneToOne: false;
            referencedRelation: "acc_tax_codes";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_petty_cash_floats: {
        Row: {
          account_id: string;
          active: boolean;
          branch_code: string | null;
          created_at: string;
          created_by: string | null;
          custodian_id: string | null;
          id: string;
          imprest_amount: number;
          name: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          active?: boolean;
          branch_code?: string | null;
          created_at?: string;
          created_by?: string | null;
          custodian_id?: string | null;
          id?: string;
          imprest_amount?: number;
          name: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          active?: boolean;
          branch_code?: string | null;
          created_at?: string;
          created_by?: string | null;
          custodian_id?: string | null;
          id?: string;
          imprest_amount?: number;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_petty_cash_floats_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_floats_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_floats_custodian_id_fkey";
            columns: ["custodian_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_petty_cash_floats_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_posting_cursors: {
        Row: {
          cursor_at: string | null;
          cursor_id: string | null;
          org_id: string;
          source_kind: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          cursor_at?: string | null;
          cursor_id?: string | null;
          org_id: string;
          source_kind: string;
          updated_at?: string;
        };
        Update: {
          cursor_at?: string | null;
          cursor_id?: string | null;
          org_id?: string;
          source_kind?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_posting_cursors_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_posting_preview: {
        Row: {
          account_id: string;
          credit: number;
          debit: number;
          entity_id: string;
          month: string;
          org_id: string;
          source_id: string;
          source_kind: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          credit?: number;
          debit?: number;
          entity_id: string;
          month: string;
          org_id: string;
          source_id: string;
          source_kind: string;
        };
        Update: {
          account_id?: string;
          credit?: number;
          debit?: number;
          entity_id?: string;
          month?: string;
          org_id?: string;
          source_id?: string;
          source_kind?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_posting_preview_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_preview_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_preview_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_posting_rules: {
        Row: {
          account_id: string | null;
          active: boolean;
          created_at: string;
          id: string;
          key: string;
          kind: string;
          note: string | null;
          org_id: string;
          origin: string;
          qualifier: string;
          tax_code_id: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          account_id?: string | null;
          active?: boolean;
          created_at?: string;
          id?: string;
          key?: string;
          kind: string;
          note?: string | null;
          org_id: string;
          origin?: string;
          qualifier?: string;
          tax_code_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          account_id?: string | null;
          active?: boolean;
          created_at?: string;
          id?: string;
          key?: string;
          kind?: string;
          note?: string | null;
          org_id?: string;
          origin?: string;
          qualifier?: string;
          tax_code_id?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_posting_rules_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_rules_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_rules_tax_code_id_fkey";
            columns: ["tax_code_id"];
            isOneToOne: false;
            referencedRelation: "acc_tax_codes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_rules_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_posting_settings: {
        Row: {
          denial_allowance_enabled: boolean;
          org_id: string;
          package_invoices: string;
          paused_sources: string[];
          rounding_tolerance: number;
          updated_at: string;
          updated_by: string | null;
          vat_tolerance: number;
        };
        ComputedFields: never;
        Insert: {
          denial_allowance_enabled?: boolean;
          org_id: string;
          package_invoices?: string;
          paused_sources?: string[];
          rounding_tolerance?: number;
          updated_at?: string;
          updated_by?: string | null;
          vat_tolerance?: number;
        };
        Update: {
          denial_allowance_enabled?: boolean;
          org_id?: string;
          package_invoices?: string;
          paused_sources?: string[];
          rounding_tolerance?: number;
          updated_at?: string;
          updated_by?: string | null;
          vat_tolerance?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_posting_settings_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_posting_status: {
        Row: {
          amount: number | null;
          attempts: number;
          content_sha256: string | null;
          detail: string | null;
          first_seen_at: string;
          journal_id: string | null;
          last_attempt_at: string;
          org_id: string;
          reason: string | null;
          source_date: string | null;
          source_id: string;
          source_kind: string;
          state: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          amount?: number | null;
          attempts?: number;
          content_sha256?: string | null;
          detail?: string | null;
          first_seen_at?: string;
          journal_id?: string | null;
          last_attempt_at?: string;
          org_id: string;
          reason?: string | null;
          source_date?: string | null;
          source_id: string;
          source_kind: string;
          state: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          amount?: number | null;
          attempts?: number;
          content_sha256?: string | null;
          detail?: string | null;
          first_seen_at?: string;
          journal_id?: string | null;
          last_attempt_at?: string;
          org_id?: string;
          reason?: string | null;
          source_date?: string | null;
          source_id?: string;
          source_kind?: string;
          state?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_posting_status_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_posting_status_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_receipts: {
        Row: {
          account_id: string;
          amount: number;
          amount_allocated: number;
          cheque_id: string | null;
          created_at: string;
          customer_id: string;
          entity_id: string;
          id: string;
          journal_id: string | null;
          mode: string;
          notes: string | null;
          number: string;
          org_id: string;
          posting_status: string;
          prepared_by: string | null;
          receipt_date: string;
          receivable_account_id: string;
          reference: string | null;
          status: string;
          updated_at: string;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          amount: number;
          amount_allocated?: number;
          cheque_id?: string | null;
          created_at?: string;
          customer_id: string;
          entity_id: string;
          id?: string;
          journal_id?: string | null;
          mode: string;
          notes?: string | null;
          number: string;
          org_id: string;
          posting_status?: string;
          prepared_by?: string | null;
          receipt_date: string;
          receivable_account_id: string;
          reference?: string | null;
          status?: string;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Update: {
          account_id?: string;
          amount?: number;
          amount_allocated?: number;
          cheque_id?: string | null;
          created_at?: string;
          customer_id?: string;
          entity_id?: string;
          id?: string;
          journal_id?: string | null;
          mode?: string;
          notes?: string | null;
          number?: string;
          org_id?: string;
          posting_status?: string;
          prepared_by?: string | null;
          receipt_date?: string;
          receivable_account_id?: string;
          reference?: string | null;
          status?: string;
          updated_at?: string;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_receipts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_cheque_id_fkey";
            columns: ["cheque_id"];
            isOneToOne: false;
            referencedRelation: "acc_cheques";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "acc_customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_receivable_account_id_fkey";
            columns: ["receivable_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_receipts_voided_by_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_sales_invoice_lines: {
        Row: {
          branch_code: string | null;
          cost_centre_id: string | null;
          created_at: string;
          department: string | null;
          description: string;
          discount: number;
          gross: number;
          id: string;
          income_account_id: string;
          invoice_id: string;
          line_no: number;
          line_total: number;
          net: number;
          org_id: string;
          quantity: number;
          tax_code_id: string;
          unit_price: number;
          vat_amount: number;
          vat_rate: number;
        };
        ComputedFields: never;
        Insert: {
          branch_code?: string | null;
          cost_centre_id?: string | null;
          created_at?: string;
          department?: string | null;
          description: string;
          discount?: number;
          gross: number;
          id?: string;
          income_account_id: string;
          invoice_id: string;
          line_no: number;
          line_total: number;
          net: number;
          org_id: string;
          quantity: number;
          tax_code_id: string;
          unit_price: number;
          vat_amount: number;
          vat_rate: number;
        };
        Update: {
          branch_code?: string | null;
          cost_centre_id?: string | null;
          created_at?: string;
          department?: string | null;
          description?: string;
          discount?: number;
          gross?: number;
          id?: string;
          income_account_id?: string;
          invoice_id?: string;
          line_no?: number;
          line_total?: number;
          net?: number;
          org_id?: string;
          quantity?: number;
          tax_code_id?: string;
          unit_price?: number;
          vat_amount?: number;
          vat_rate?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_sales_invoice_lines_cost_centre_id_fkey";
            columns: ["cost_centre_id"];
            isOneToOne: false;
            referencedRelation: "acc_cost_centres";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoice_lines_income_account_id_fkey";
            columns: ["income_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "acc_sales_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoice_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoice_lines_tax_code_id_fkey";
            columns: ["tax_code_id"];
            isOneToOne: false;
            referencedRelation: "acc_tax_codes";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_sales_invoices: {
        Row: {
          amount_credited: number;
          amount_paid: number;
          approval_required: boolean;
          approved_by: string | null;
          content_sha256: string | null;
          created_at: string;
          credit_reason: string | null;
          currency: string;
          customer_id: string;
          discount_total: number;
          due_date: string | null;
          einvoice_status: string;
          entity_id: string;
          event_date: string | null;
          id: string;
          invoice_date: string;
          invoice_form: string | null;
          issued_at: string | null;
          issued_by: string | null;
          journal_id: string | null;
          kind: string;
          net_total: number;
          notes: string | null;
          number: string | null;
          org_id: string;
          original_invoice_id: string | null;
          posting_status: string;
          prepared_by: string | null;
          receivable_account_id: string | null;
          reference: string | null;
          status: string;
          subtotal: number;
          supply_date: string | null;
          total: number;
          updated_at: string;
          vat_total: number;
          void_credit_note_id: string | null;
          void_reason: string | null;
          voided_at: string | null;
          voided_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          amount_credited?: number;
          amount_paid?: number;
          approval_required?: boolean;
          approved_by?: string | null;
          content_sha256?: string | null;
          created_at?: string;
          credit_reason?: string | null;
          currency?: string;
          customer_id: string;
          discount_total?: number;
          due_date?: string | null;
          einvoice_status?: string;
          entity_id: string;
          event_date?: string | null;
          id?: string;
          invoice_date: string;
          invoice_form?: string | null;
          issued_at?: string | null;
          issued_by?: string | null;
          journal_id?: string | null;
          kind?: string;
          net_total?: number;
          notes?: string | null;
          number?: string | null;
          org_id: string;
          original_invoice_id?: string | null;
          posting_status?: string;
          prepared_by?: string | null;
          receivable_account_id?: string | null;
          reference?: string | null;
          status?: string;
          subtotal?: number;
          supply_date?: string | null;
          total?: number;
          updated_at?: string;
          vat_total?: number;
          void_credit_note_id?: string | null;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Update: {
          amount_credited?: number;
          amount_paid?: number;
          approval_required?: boolean;
          approved_by?: string | null;
          content_sha256?: string | null;
          created_at?: string;
          credit_reason?: string | null;
          currency?: string;
          customer_id?: string;
          discount_total?: number;
          due_date?: string | null;
          einvoice_status?: string;
          entity_id?: string;
          event_date?: string | null;
          id?: string;
          invoice_date?: string;
          invoice_form?: string | null;
          issued_at?: string | null;
          issued_by?: string | null;
          journal_id?: string | null;
          kind?: string;
          net_total?: number;
          notes?: string | null;
          number?: string | null;
          org_id?: string;
          original_invoice_id?: string | null;
          posting_status?: string;
          prepared_by?: string | null;
          receivable_account_id?: string | null;
          reference?: string | null;
          status?: string;
          subtotal?: number;
          supply_date?: string | null;
          total?: number;
          updated_at?: string;
          vat_total?: number;
          void_credit_note_id?: string | null;
          void_reason?: string | null;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_sales_invoices_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_customer_id_fkey";
            columns: ["customer_id"];
            isOneToOne: false;
            referencedRelation: "acc_customers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_issued_by_fkey";
            columns: ["issued_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_original_invoice_id_fkey";
            columns: ["original_invoice_id"];
            isOneToOne: false;
            referencedRelation: "acc_sales_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_receivable_account_id_fkey";
            columns: ["receivable_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_void_credit_note_id_fkey";
            columns: ["void_credit_note_id"];
            isOneToOne: false;
            referencedRelation: "acc_sales_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_sales_invoices_voided_by_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_schedules: {
        Row: {
          auto_reverse: boolean;
          branch_code: string | null;
          bs_account_id: string;
          created_at: string;
          created_by: string | null;
          department: string | null;
          description: string;
          entity_id: string;
          id: string;
          kind: string;
          months: number;
          org_id: string;
          pl_account_id: string;
          start_month: string;
          status: string;
          supplier_invoice_id: string | null;
          total: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          auto_reverse?: boolean;
          branch_code?: string | null;
          bs_account_id: string;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          description: string;
          entity_id: string;
          id?: string;
          kind: string;
          months: number;
          org_id: string;
          pl_account_id: string;
          start_month: string;
          status?: string;
          supplier_invoice_id?: string | null;
          total: number;
          updated_at?: string;
        };
        Update: {
          auto_reverse?: boolean;
          branch_code?: string | null;
          bs_account_id?: string;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          description?: string;
          entity_id?: string;
          id?: string;
          kind?: string;
          months?: number;
          org_id?: string;
          pl_account_id?: string;
          start_month?: string;
          status?: string;
          supplier_invoice_id?: string | null;
          total?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_schedules_bs_account_id_fkey";
            columns: ["bs_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_schedules_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_schedules_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_schedules_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_schedules_pl_account_id_fkey";
            columns: ["pl_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_schedules_supplier_invoice_id_fkey";
            columns: ["supplier_invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_supplier_invoices";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_bridge_settings: {
        Row: {
          cost_category: string;
          org_id: string;
          pull_enabled: boolean;
          push_enabled: boolean;
          push_from: string | null;
          push_sources: string[];
          revenue_mode: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          cost_category?: string;
          org_id: string;
          pull_enabled?: boolean;
          push_enabled?: boolean;
          push_from?: string | null;
          push_sources?: string[];
          revenue_mode?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          cost_category?: string;
          org_id?: string;
          pull_enabled?: boolean;
          push_enabled?: boolean;
          push_from?: string | null;
          push_sources?: string[];
          revenue_mode?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_bridge_settings_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_bridge_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_cursors: {
        Row: {
          alter_id: number | null;
          cursor: string;
          org_id: string;
          stamp: string | null;
          stamp_key: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          alter_id?: number | null;
          cursor: string;
          org_id: string;
          stamp?: string | null;
          stamp_key?: string | null;
          updated_at?: string;
        };
        Update: {
          alter_id?: number | null;
          cursor?: string;
          org_id?: string;
          stamp?: string | null;
          stamp_key?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_cursors_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_devices: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          label: string;
          last_seen_at: string | null;
          org_id: string;
          paired_at: string | null;
          pairing_expires_at: string | null;
          pairing_sha256: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          status: string;
          tally_state: string | null;
          token_sha256: string | null;
          updated_at: string;
          version: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          label: string;
          last_seen_at?: string | null;
          org_id: string;
          paired_at?: string | null;
          pairing_expires_at?: string | null;
          pairing_sha256?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          status?: string;
          tally_state?: string | null;
          token_sha256?: string | null;
          updated_at?: string;
          version?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          label?: string;
          last_seen_at?: string | null;
          org_id?: string;
          paired_at?: string | null;
          pairing_expires_at?: string | null;
          pairing_sha256?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          status?: string;
          tally_state?: string | null;
          token_sha256?: string | null;
          updated_at?: string;
          version?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_devices_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_devices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_devices_revoked_by_fkey";
            columns: ["revoked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_imports: {
        Row: {
          committed_at: string | null;
          committed_by: string | null;
          company: string | null;
          created_at: string;
          created_by: string | null;
          entity_id: string;
          file_bytes: number;
          file_sha256: string[];
          first_date: string | null;
          forced: boolean;
          id: string;
          last_date: string | null;
          opening_date: string | null;
          org_id: string;
          periods_locked_at: string | null;
          reconciled_at: string | null;
          reconciled_by: string | null;
          report: NonNullable<Json>;
          result: NonNullable<Json>;
          source: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          committed_at?: string | null;
          committed_by?: string | null;
          company?: string | null;
          created_at?: string;
          created_by?: string | null;
          entity_id: string;
          file_bytes?: number;
          file_sha256: string[];
          first_date?: string | null;
          forced?: boolean;
          id?: string;
          last_date?: string | null;
          opening_date?: string | null;
          org_id: string;
          periods_locked_at?: string | null;
          reconciled_at?: string | null;
          reconciled_by?: string | null;
          report?: NonNullable<Json>;
          result?: NonNullable<Json>;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          committed_at?: string | null;
          committed_by?: string | null;
          company?: string | null;
          created_at?: string;
          created_by?: string | null;
          entity_id?: string;
          file_bytes?: number;
          file_sha256?: string[];
          first_date?: string | null;
          forced?: boolean;
          id?: string;
          last_date?: string | null;
          opening_date?: string | null;
          org_id?: string;
          periods_locked_at?: string | null;
          reconciled_at?: string | null;
          reconciled_by?: string | null;
          report?: NonNullable<Json>;
          result?: NonNullable<Json>;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_imports_committed_by_fkey";
            columns: ["committed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_imports_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_imports_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_imports_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_imports_reconciled_by_fkey";
            columns: ["reconciled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_jobs: {
        Row: {
          attempts: number;
          check_first: boolean;
          created_at: string;
          device_id: string | null;
          done_at: string | null;
          error_code: string | null;
          id: string;
          kind: string;
          org_id: string;
          params: NonNullable<Json>;
          push_id: string | null;
          result: Json | null;
          sent_at: string | null;
          seq: number;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          check_first?: boolean;
          created_at?: string;
          device_id?: string | null;
          done_at?: string | null;
          error_code?: string | null;
          id?: string;
          kind: string;
          org_id: string;
          params?: NonNullable<Json>;
          push_id?: string | null;
          result?: Json | null;
          sent_at?: string | null;
          seq?: never;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          check_first?: boolean;
          created_at?: string;
          device_id?: string | null;
          done_at?: string | null;
          error_code?: string | null;
          id?: string;
          kind?: string;
          org_id?: string;
          params?: NonNullable<Json>;
          push_id?: string | null;
          result?: Json | null;
          sent_at?: string | null;
          seq?: never;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_jobs_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "acc_tally_devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_jobs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_jobs_push_id_fkey";
            columns: ["push_id"];
            isOneToOne: false;
            referencedRelation: "acc_tally_push";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_push: {
        Row: {
          amount: number;
          attempts: number;
          content: Json | null;
          created_at: string;
          detail: string | null;
          done_at: string | null;
          id: string;
          journal_sha256: string;
          mirror_journal_id: string | null;
          org_id: string;
          reason: string | null;
          remote_id: string;
          reversed: boolean;
          reverses_id: string | null;
          role: string;
          source_id: string;
          source_kind: string;
          status: string;
          tally_master_id: number | null;
          updated_at: string;
          version: number;
          voucher_date: string;
          voucher_type: string;
        };
        ComputedFields: never;
        Insert: {
          amount?: number;
          attempts?: number;
          content?: Json | null;
          created_at?: string;
          detail?: string | null;
          done_at?: string | null;
          id?: string;
          journal_sha256: string;
          mirror_journal_id?: string | null;
          org_id: string;
          reason?: string | null;
          remote_id: string;
          reversed?: boolean;
          reverses_id?: string | null;
          role?: string;
          source_id: string;
          source_kind: string;
          status: string;
          tally_master_id?: number | null;
          updated_at?: string;
          version: number;
          voucher_date: string;
          voucher_type: string;
        };
        Update: {
          amount?: number;
          attempts?: number;
          content?: Json | null;
          created_at?: string;
          detail?: string | null;
          done_at?: string | null;
          id?: string;
          journal_sha256?: string;
          mirror_journal_id?: string | null;
          org_id?: string;
          reason?: string | null;
          remote_id?: string;
          reversed?: boolean;
          reverses_id?: string | null;
          role?: string;
          source_id?: string;
          source_kind?: string;
          status?: string;
          tally_master_id?: number | null;
          updated_at?: string;
          version?: number;
          voucher_date?: string;
          voucher_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_push_mirror_journal_id_fkey";
            columns: ["mirror_journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_push_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_push_reverses_id_fkey";
            columns: ["reverses_id"];
            isOneToOne: false;
            referencedRelation: "acc_tally_push";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_reconciliations: {
        Row: {
          as_at: string;
          compared: number;
          created_at: string;
          created_by: string | null;
          differences: number;
          entity_id: string;
          file_sha256: string;
          id: string;
          import_id: string | null;
          org_id: string;
          reconciled: boolean;
          rows: NonNullable<Json>;
          source: string;
          total_difference: number;
        };
        ComputedFields: never;
        Insert: {
          as_at: string;
          compared: number;
          created_at?: string;
          created_by?: string | null;
          differences: number;
          entity_id: string;
          file_sha256: string;
          id?: string;
          import_id?: string | null;
          org_id: string;
          reconciled: boolean;
          rows?: NonNullable<Json>;
          source?: string;
          total_difference?: number;
        };
        Update: {
          as_at?: string;
          compared?: number;
          created_at?: string;
          created_by?: string | null;
          differences?: number;
          entity_id?: string;
          file_sha256?: string;
          id?: string;
          import_id?: string | null;
          org_id?: string;
          reconciled?: boolean;
          rows?: NonNullable<Json>;
          source?: string;
          total_difference?: number;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_reconciliations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_reconciliations_entity_id_fkey";
            columns: ["entity_id"];
            isOneToOne: false;
            referencedRelation: "acc_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_reconciliations_import_id_fkey";
            columns: ["import_id"];
            isOneToOne: false;
            referencedRelation: "acc_tally_imports";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_reconciliations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_staged: {
        Row: {
          alter_id: number | null;
          guid: string | null;
          id: number;
          import_id: string;
          journal_id: string | null;
          kind: string;
          org_id: string;
          payload: NonNullable<Json>;
          result_code: string | null;
          seq: number;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          alter_id?: number | null;
          guid?: string | null;
          id?: never;
          import_id: string;
          journal_id?: string | null;
          kind: string;
          org_id: string;
          payload: NonNullable<Json>;
          result_code?: string | null;
          seq: number;
          status?: string;
        };
        Update: {
          alter_id?: number | null;
          guid?: string | null;
          id?: never;
          import_id?: string;
          journal_id?: string | null;
          kind?: string;
          org_id?: string;
          payload?: NonNullable<Json>;
          result_code?: string | null;
          seq?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_staged_import_id_fkey";
            columns: ["import_id"];
            isOneToOne: false;
            referencedRelation: "acc_tally_imports";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_staged_journal_id_fkey";
            columns: ["journal_id"];
            isOneToOne: false;
            referencedRelation: "acc_journals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_staged_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tally_sync_log: {
        Row: {
          at: string;
          code: string | null;
          counts: Json | null;
          direction: string;
          id: number;
          job_id: string | null;
          message: string | null;
          org_id: string;
          outcome: string;
          push_id: string | null;
          remote_id: string | null;
          tally_guid: string | null;
          voucher_date: string | null;
          voucher_number: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          code?: string | null;
          counts?: Json | null;
          direction: string;
          id?: never;
          job_id?: string | null;
          message?: string | null;
          org_id: string;
          outcome: string;
          push_id?: string | null;
          remote_id?: string | null;
          tally_guid?: string | null;
          voucher_date?: string | null;
          voucher_number?: string | null;
        };
        Update: {
          at?: string;
          code?: string | null;
          counts?: Json | null;
          direction?: string;
          id?: never;
          job_id?: string | null;
          message?: string | null;
          org_id?: string;
          outcome?: string;
          push_id?: string | null;
          remote_id?: string | null;
          tally_guid?: string | null;
          voucher_date?: string | null;
          voucher_number?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tally_sync_log_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tally_sync_log_push_id_fkey";
            columns: ["push_id"];
            isOneToOne: false;
            referencedRelation: "acc_tally_push";
            referencedColumns: ["id"];
          },
        ];
      };
      acc_tax_codes: {
        Row: {
          active: boolean;
          code: string;
          created_at: string;
          id: string;
          input_account_id: string | null;
          kind: string;
          name: string;
          org_id: string;
          output_account_id: string | null;
          rate: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          code: string;
          created_at?: string;
          id?: string;
          input_account_id?: string | null;
          kind: string;
          name: string;
          org_id: string;
          output_account_id?: string | null;
          rate?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          code?: string;
          created_at?: string;
          id?: string;
          input_account_id?: string | null;
          kind?: string;
          name?: string;
          org_id?: string;
          output_account_id?: string | null;
          rate?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "acc_tax_codes_input_account_id_fkey";
            columns: ["input_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tax_codes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "acc_tax_codes_output_account_id_fkey";
            columns: ["output_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      access_reviews: {
        Row: {
          attestation_name: string | null;
          attestation_note: string | null;
          attested_at: string | null;
          attested_by: string | null;
          id: string;
          opened_at: string;
          opened_by: string | null;
          org_id: string;
          period: string;
          signature: string | null;
          snapshot: NonNullable<Json>;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          attestation_name?: string | null;
          attestation_note?: string | null;
          attested_at?: string | null;
          attested_by?: string | null;
          id?: string;
          opened_at?: string;
          opened_by?: string | null;
          org_id: string;
          period: string;
          signature?: string | null;
          snapshot: NonNullable<Json>;
          status?: string;
        };
        Update: {
          attestation_name?: string | null;
          attestation_note?: string | null;
          attested_at?: string | null;
          attested_by?: string | null;
          id?: string;
          opened_at?: string;
          opened_by?: string | null;
          org_id?: string;
          period?: string;
          signature?: string | null;
          snapshot?: NonNullable<Json>;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "access_reviews_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_attributions: {
        Row: {
          channel_id: string | null;
          clicked_at: string;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          ctwa_clid: string;
          headline: string | null;
          id: string;
          org_id: string;
          source_id: string | null;
          source_type: string | null;
          waba_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          channel_id?: string | null;
          clicked_at?: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          ctwa_clid: string;
          headline?: string | null;
          id?: string;
          org_id: string;
          source_id?: string | null;
          source_type?: string | null;
          waba_id?: string | null;
        };
        Update: {
          channel_id?: string | null;
          clicked_at?: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          ctwa_clid?: string;
          headline?: string | null;
          id?: string;
          org_id?: string;
          source_id?: string | null;
          source_type?: string | null;
          waba_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ad_attributions_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_attributions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_attributions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "ad_attributions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "ad_attributions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_attributions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ad_attributions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_conversation_engagement";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ad_attributions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ad_attributions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ad_insights_daily: {
        Row: {
          ad_id: string;
          ad_name: string | null;
          campaign_name: string | null;
          clicks: number;
          currency: string;
          day: string;
          impressions: number;
          org_id: string;
          pulled_at: string;
          spend_milli: number;
        };
        ComputedFields: never;
        Insert: {
          ad_id: string;
          ad_name?: string | null;
          campaign_name?: string | null;
          clicks?: number;
          currency: string;
          day: string;
          impressions?: number;
          org_id: string;
          pulled_at?: string;
          spend_milli: number;
        };
        Update: {
          ad_id?: string;
          ad_name?: string | null;
          campaign_name?: string | null;
          clicks?: number;
          currency?: string;
          day?: string;
          impressions?: number;
          org_id?: string;
          pulled_at?: string;
          spend_milli?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ad_insights_daily_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_message_intents: {
        Row: {
          conversation_id: string;
          created_at: string;
          escalated_at: string | null;
          id: string;
          intents: string[];
          message_id: string;
          org_id: string;
          signals: string[];
          source: string;
          topic: string | null;
        };
        ComputedFields: never;
        Insert: {
          conversation_id: string;
          created_at?: string;
          escalated_at?: string | null;
          id?: string;
          intents?: string[];
          message_id: string;
          org_id: string;
          signals?: string[];
          source: string;
          topic?: string | null;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          escalated_at?: string | null;
          id?: string;
          intents?: string[];
          message_id?: string;
          org_id?: string;
          signals?: string[];
          source?: string;
          topic?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_message_intents_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_message_intents_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_message_intents_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_conversation_engagement";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_message_intents_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_message_intents_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_message_intents_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_message_intents_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_quality_reports: {
        Row: {
          created_at: string;
          gaps: NonNullable<Json>;
          id: string;
          org_id: string;
          stats: NonNullable<Json>;
          week_end: string;
          week_start: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          gaps?: NonNullable<Json>;
          id?: string;
          org_id: string;
          stats: NonNullable<Json>;
          week_end: string;
          week_start: string;
        };
        Update: {
          created_at?: string;
          gaps?: NonNullable<Json>;
          id?: string;
          org_id?: string;
          stats?: NonNullable<Json>;
          week_end?: string;
          week_start?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_quality_reports_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_suggestion_outcomes: {
        Row: {
          ai_usage_id: string;
          conversation_id: string | null;
          created_at: string;
          org_id: string;
          outcome: string;
          similarity: number;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          ai_usage_id: string;
          conversation_id?: string | null;
          created_at?: string;
          org_id: string;
          outcome: string;
          similarity: number;
          user_id?: string | null;
        };
        Update: {
          ai_usage_id?: string;
          conversation_id?: string | null;
          created_at?: string;
          org_id?: string;
          outcome?: string;
          similarity?: number;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ai_suggestion_outcomes_ai_usage_id_fkey";
            columns: ["ai_usage_id"];
            isOneToOne: true;
            referencedRelation: "ai_usage";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_suggestion_outcomes_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_suggestion_outcomes_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_suggestion_outcomes_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_conversation_engagement";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_suggestion_outcomes_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "ai_suggestion_outcomes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_suggestion_outcomes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_usage: {
        Row: {
          conversation_id: string | null;
          created_at: string;
          feature: string;
          grounded: boolean | null;
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
          grounded?: boolean | null;
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
          grounded?: boolean | null;
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
            referencedRelation: "v_conversation_engagement";
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
      api_read_log: {
        Row: {
          api_key_id: string;
          bucket: string;
          org_id: string;
          request_count: number;
          resource: string;
          row_count: number;
        };
        ComputedFields: never;
        Insert: {
          api_key_id: string;
          bucket: string;
          org_id: string;
          request_count?: number;
          resource: string;
          row_count?: number;
        };
        Update: {
          api_key_id?: string;
          bucket?: string;
          org_id?: string;
          request_count?: number;
          resource?: string;
          row_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "api_read_log_api_key_id_fkey";
            columns: ["api_key_id"];
            isOneToOne: false;
            referencedRelation: "api_keys";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "api_read_log_org_id_fkey";
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
            foreignKeyName: "appointment_reminders_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
          arrived_at: string | null;
          channel_id: string | null;
          checked_out_at: string | null;
          checkin_status: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          department_id: string | null;
          done_at: string | null;
          ends_at: string;
          external_id: string | null;
          external_status: string | null;
          flow_step_key: string | null;
          id: string;
          is_walk_in: boolean;
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
          visit_mode: string | null;
          with_doctor_at: string | null;
        };
        ComputedFields: never;
        Insert: {
          arrived_at?: string | null;
          channel_id?: string | null;
          checked_out_at?: string | null;
          checkin_status?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          department_id?: string | null;
          done_at?: string | null;
          ends_at: string;
          external_id?: string | null;
          external_status?: string | null;
          flow_step_key?: string | null;
          id?: string;
          is_walk_in?: boolean;
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
          visit_mode?: string | null;
          with_doctor_at?: string | null;
        };
        Update: {
          arrived_at?: string | null;
          channel_id?: string | null;
          checked_out_at?: string | null;
          checkin_status?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          custom?: NonNullable<Json>;
          department_id?: string | null;
          done_at?: string | null;
          ends_at?: string;
          external_id?: string | null;
          external_status?: string | null;
          flow_step_key?: string | null;
          id?: string;
          is_walk_in?: boolean;
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
          visit_mode?: string | null;
          with_doctor_at?: string | null;
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
      auth_events: {
        Row: {
          at: string;
          detail: NonNullable<Json>;
          email_hash: string | null;
          event_type: string;
          id: number;
          ip_address: string | null;
          ip_hash: string | null;
          method: string | null;
          org_id: string | null;
          ua_family: string | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          detail?: NonNullable<Json>;
          email_hash?: string | null;
          event_type: string;
          id?: never;
          ip_address?: string | null;
          ip_hash?: string | null;
          method?: string | null;
          org_id?: string | null;
          ua_family?: string | null;
          user_id?: string | null;
        };
        Update: {
          at?: string;
          detail?: NonNullable<Json>;
          email_hash?: string | null;
          event_type?: string;
          id?: never;
          ip_address?: string | null;
          ip_hash?: string | null;
          method?: string | null;
          org_id?: string | null;
          ua_family?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auth_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_feeds: {
        Row: {
          access_count: number;
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          label: string;
          last_access_at: string | null;
          org_id: string;
          revoked_at: string | null;
          rotated_at: string | null;
          specialist_id: string | null;
          token_hash: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          access_count?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind: string;
          label: string;
          last_access_at?: string | null;
          org_id: string;
          revoked_at?: string | null;
          rotated_at?: string | null;
          specialist_id?: string | null;
          token_hash: string;
          user_id?: string | null;
        };
        Update: {
          access_count?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          label?: string;
          last_access_at?: string | null;
          org_id?: string;
          revoked_at?: string | null;
          rotated_at?: string | null;
          specialist_id?: string | null;
          token_hash?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_feeds_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_feeds_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_feeds_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_feeds_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_ab_variants: {
        Row: {
          campaign_id: string;
          created_at: string;
          fallbacks: NonNullable<Json>;
          id: string;
          org_id: string;
          split_pct: number;
          template_id: string;
          variable_map: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          campaign_id: string;
          created_at?: string;
          fallbacks?: NonNullable<Json>;
          id?: string;
          org_id: string;
          split_pct: number;
          template_id: string;
          variable_map?: NonNullable<Json>;
        };
        Update: {
          campaign_id?: string;
          created_at?: string;
          fallbacks?: NonNullable<Json>;
          id?: string;
          org_id?: string;
          split_pct?: number;
          template_id?: string;
          variable_map?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_ab_variants_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: true;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_ab_variants_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: true;
            referencedRelation: "v_campaign_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_ab_variants_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_ab_variants_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_archive: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          org_id: string;
          sent_at: string | null;
          source: string;
          template_name: string | null;
          totals: NonNullable<Json>;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          org_id: string;
          sent_at?: string | null;
          source?: string;
          template_name?: string | null;
          totals?: NonNullable<Json>;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          org_id?: string;
          sent_at?: string | null;
          source?: string;
          template_name?: string | null;
          totals?: NonNullable<Json>;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_archive_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_archive_recipients: {
        Row: {
          archive_id: string;
          contact_id: string;
          created_at: string;
          delivered_at: string | null;
          error_code: number | null;
          failed_at: string | null;
          id: string;
          org_id: string;
          read_at: string | null;
          replied_at: string | null;
          sent_at: string | null;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          archive_id: string;
          contact_id: string;
          created_at?: string;
          delivered_at?: string | null;
          error_code?: number | null;
          failed_at?: string | null;
          id?: string;
          org_id: string;
          read_at?: string | null;
          replied_at?: string | null;
          sent_at?: string | null;
          status: string;
        };
        Update: {
          archive_id?: string;
          contact_id?: string;
          created_at?: string;
          delivered_at?: string | null;
          error_code?: number | null;
          failed_at?: string | null;
          id?: string;
          org_id?: string;
          read_at?: string | null;
          replied_at?: string | null;
          sent_at?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_archive_recipients_archive_id_fkey";
            columns: ["archive_id"];
            isOneToOne: false;
            referencedRelation: "campaign_archive";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_archive_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_archive_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "campaign_archive_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "campaign_archive_recipients_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_budget_months: {
        Row: {
          month: string;
          org_id: string;
          updated_at: string;
          used: number;
        };
        ComputedFields: never;
        Insert: {
          month: string;
          org_id: string;
          updated_at?: string;
          used?: number;
        };
        Update: {
          month?: string;
          org_id?: string;
          updated_at?: string;
          used?: number;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_budget_months_org_id_fkey";
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
          variant: string | null;
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
          variant?: string | null;
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
          variant?: string | null;
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
            foreignKeyName: "campaign_recipients_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
      campaign_recurrences: {
        Row: {
          channel_id: string;
          created_at: string;
          created_by: string | null;
          cron: string;
          fallbacks: NonNullable<Json>;
          guardrails: NonNullable<Json>;
          id: string;
          last_campaign_id: string | null;
          last_run_at: string | null;
          last_run_outcome: string | null;
          name: string;
          next_run_at: string | null;
          org_id: string;
          retry_delay_minutes: number;
          retry_rounds: number;
          runs: number;
          segment_id: string | null;
          status: string;
          template_id: string;
          timezone: string;
          updated_at: string;
          variable_map: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          channel_id: string;
          created_at?: string;
          created_by?: string | null;
          cron: string;
          fallbacks?: NonNullable<Json>;
          guardrails?: NonNullable<Json>;
          id?: string;
          last_campaign_id?: string | null;
          last_run_at?: string | null;
          last_run_outcome?: string | null;
          name: string;
          next_run_at?: string | null;
          org_id: string;
          retry_delay_minutes?: number;
          retry_rounds?: number;
          runs?: number;
          segment_id?: string | null;
          status?: string;
          template_id: string;
          timezone: string;
          updated_at?: string;
          variable_map?: NonNullable<Json>;
        };
        Update: {
          channel_id?: string;
          created_at?: string;
          created_by?: string | null;
          cron?: string;
          fallbacks?: NonNullable<Json>;
          guardrails?: NonNullable<Json>;
          id?: string;
          last_campaign_id?: string | null;
          last_run_at?: string | null;
          last_run_outcome?: string | null;
          name?: string;
          next_run_at?: string | null;
          org_id?: string;
          retry_delay_minutes?: number;
          retry_rounds?: number;
          runs?: number;
          segment_id?: string | null;
          status?: string;
          template_id?: string;
          timezone?: string;
          updated_at?: string;
          variable_map?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_recurrences_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recurrences_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recurrences_last_campaign_id_fkey";
            columns: ["last_campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recurrences_last_campaign_id_fkey";
            columns: ["last_campaign_id"];
            isOneToOne: false;
            referencedRelation: "v_campaign_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recurrences_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recurrences_segment_id_fkey";
            columns: ["segment_id"];
            isOneToOne: false;
            referencedRelation: "segments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaign_recurrences_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
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
          recurrence_id: string | null;
          retry_delay_minutes: number;
          retry_round: number;
          retry_rounds: number;
          run_key: string | null;
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
          recurrence_id?: string | null;
          retry_delay_minutes?: number;
          retry_round?: number;
          retry_rounds?: number;
          run_key?: string | null;
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
          recurrence_id?: string | null;
          retry_delay_minutes?: number;
          retry_round?: number;
          retry_rounds?: number;
          run_key?: string | null;
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
            foreignKeyName: "campaigns_recurrence_id_fkey";
            columns: ["recurrence_id"];
            isOneToOne: false;
            referencedRelation: "campaign_recurrences";
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
      capi_events: {
        Row: {
          attempts: number;
          attribution_id: string;
          created_at: string;
          event_id: string;
          event_name: string;
          event_time: string;
          id: string;
          is_test: boolean;
          org_id: string;
          reason: string | null;
          sent_at: string | null;
          status: string;
          subject_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          attempts?: number;
          attribution_id: string;
          created_at?: string;
          event_id: string;
          event_name: string;
          event_time: string;
          id?: string;
          is_test?: boolean;
          org_id: string;
          reason?: string | null;
          sent_at?: string | null;
          status?: string;
          subject_id?: string | null;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          attribution_id?: string;
          created_at?: string;
          event_id?: string;
          event_name?: string;
          event_time?: string;
          id?: string;
          is_test?: boolean;
          org_id?: string;
          reason?: string | null;
          sent_at?: string | null;
          status?: string;
          subject_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "capi_events_attribution_id_fkey";
            columns: ["attribution_id"];
            isOneToOne: false;
            referencedRelation: "ad_attributions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "capi_events_org_id_fkey";
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
          default_team_id: string | null;
          display_phone: string | null;
          id: string;
          is_coexistence: boolean;
          last_synced_at: string | null;
          location_id: string | null;
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
          default_team_id?: string | null;
          display_phone?: string | null;
          id?: string;
          is_coexistence?: boolean;
          last_synced_at?: string | null;
          location_id?: string | null;
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
          default_team_id?: string | null;
          display_phone?: string | null;
          id?: string;
          is_coexistence?: boolean;
          last_synced_at?: string | null;
          location_id?: string | null;
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
            foreignKeyName: "channels_default_team_id_fkey";
            columns: ["default_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channels_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
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
            foreignKeyName: "clinical_feedback_source_message_id_fkey";
            columns: ["source_message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
            foreignKeyName: "clinical_message_log_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
            foreignKeyName: "clinical_message_log_reply_message_id_fkey";
            columns: ["reply_message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
      contact_channel_identities: {
        Row: {
          channel_id: string;
          contact_id: string;
          created_at: string;
          external_id: string;
          id: string;
          last_seen_at: string;
          org_id: string;
          platform: string;
        };
        ComputedFields: never;
        Insert: {
          channel_id: string;
          contact_id: string;
          created_at?: string;
          external_id: string;
          id?: string;
          last_seen_at?: string;
          org_id: string;
          platform: string;
        };
        Update: {
          channel_id?: string;
          contact_id?: string;
          created_at?: string;
          external_id?: string;
          id?: string;
          last_seen_at?: string;
          org_id?: string;
          platform?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_channel_identities_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_channel_identities_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_channel_identities_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contact_channel_identities_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "contact_channel_identities_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_chronic_conditions: {
        Row: {
          contact_id: string;
          created_at: string;
          evidence_visits: number | null;
          id: string;
          last_seen_on: string | null;
          noted_at: string | null;
          org_id: string;
          ref_diagnosis_id: string;
          source: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          created_at?: string;
          evidence_visits?: number | null;
          id?: string;
          last_seen_on?: string | null;
          noted_at?: string | null;
          org_id: string;
          ref_diagnosis_id: string;
          source?: string;
          updated_at?: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          evidence_visits?: number | null;
          id?: string;
          last_seen_on?: string | null;
          noted_at?: string | null;
          org_id?: string;
          ref_diagnosis_id?: string;
          source?: string;
          updated_at?: string;
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
          erased_at: string | null;
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
          location_id: string | null;
          merged_into_id: string | null;
          nationality: string | null;
          no_review_requests_at: string | null;
          org_id: string;
          owner_id: string | null;
          phone_e164: string | null;
          promotions_consent: Json | null;
          promotions_opt_in: boolean;
          sms_opt_out_at: string | null;
          source: string;
          stop_marketing: boolean;
          unite_last_visit_date: string | null;
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
          erased_at?: string | null;
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
          location_id?: string | null;
          merged_into_id?: string | null;
          nationality?: string | null;
          no_review_requests_at?: string | null;
          org_id: string;
          owner_id?: string | null;
          phone_e164?: string | null;
          promotions_consent?: Json | null;
          promotions_opt_in?: boolean;
          sms_opt_out_at?: string | null;
          source?: string;
          stop_marketing?: boolean;
          unite_last_visit_date?: string | null;
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
          erased_at?: string | null;
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
          location_id?: string | null;
          merged_into_id?: string | null;
          nationality?: string | null;
          no_review_requests_at?: string | null;
          org_id?: string;
          owner_id?: string | null;
          phone_e164?: string | null;
          promotions_consent?: Json | null;
          promotions_opt_in?: boolean;
          sms_opt_out_at?: string | null;
          source?: string;
          stop_marketing?: boolean;
          unite_last_visit_date?: string | null;
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
            foreignKeyName: "contacts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
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
      conversation_assignment_events: {
        Row: {
          actor_id: string | null;
          at: string;
          conversation_id: string;
          from_team_id: string | null;
          from_user_id: string | null;
          id: number;
          kind: string;
          org_id: string;
          source: string;
          to_team_id: string | null;
          to_user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          at?: string;
          conversation_id: string;
          from_team_id?: string | null;
          from_user_id?: string | null;
          id?: never;
          kind: string;
          org_id: string;
          source: string;
          to_team_id?: string | null;
          to_user_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          at?: string;
          conversation_id?: string;
          from_team_id?: string | null;
          from_user_id?: string | null;
          id?: never;
          kind?: string;
          org_id?: string;
          source?: string;
          to_team_id?: string | null;
          to_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_conversation_engagement";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_org_id_fkey";
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
            referencedRelation: "v_conversation_engagement";
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
          auto_reply_sent_at: string | null;
          bot_active: boolean;
          campaign_only: boolean;
          category_id: string | null;
          channel_id: string;
          closed_at: string | null;
          closed_by: string | null;
          contact_id: string;
          created_at: string;
          escalation_level: number;
          flow_run_id: string | null;
          id: string;
          last_inbound_at: string | null;
          last_message_at: string | null;
          last_message_direction: string | null;
          last_message_preview: string | null;
          last_outbound_at: string | null;
          location_id: string | null;
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
          auto_reply_sent_at?: string | null;
          bot_active?: boolean;
          campaign_only?: boolean;
          category_id?: string | null;
          channel_id: string;
          closed_at?: string | null;
          closed_by?: string | null;
          contact_id: string;
          created_at?: string;
          escalation_level?: number;
          flow_run_id?: string | null;
          id?: string;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_direction?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          location_id?: string | null;
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
          auto_reply_sent_at?: string | null;
          bot_active?: boolean;
          campaign_only?: boolean;
          category_id?: string | null;
          channel_id?: string;
          closed_at?: string | null;
          closed_by?: string | null;
          contact_id?: string;
          created_at?: string;
          escalation_level?: number;
          flow_run_id?: string | null;
          id?: string;
          last_inbound_at?: string | null;
          last_message_at?: string | null;
          last_message_direction?: string | null;
          last_message_preview?: string | null;
          last_outbound_at?: string | null;
          location_id?: string | null;
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
            foreignKeyName: "conversations_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
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
      deleted_items: {
        Row: {
          deleted_at: string;
          deleted_by: string | null;
          entity: string;
          id: string;
          org_id: string;
          record_id: string;
          restore_data: NonNullable<Json>;
        };
        ComputedFields: never;
        Insert: {
          deleted_at?: string;
          deleted_by?: string | null;
          entity: string;
          id?: string;
          org_id: string;
          record_id: string;
          restore_data?: NonNullable<Json>;
        };
        Update: {
          deleted_at?: string;
          deleted_by?: string | null;
          entity?: string;
          id?: string;
          org_id?: string;
          record_id?: string;
          restore_data?: NonNullable<Json>;
        };
        Relationships: [
          {
            foreignKeyName: "deleted_items_deleted_by_fkey";
            columns: ["deleted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deleted_items_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
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
      document_retention_policies: {
        Row: {
          auto_delete: boolean;
          category: string;
          org_id: string;
          retain_days: number | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          auto_delete?: boolean;
          category: string;
          org_id: string;
          retain_days?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          auto_delete?: boolean;
          category?: string;
          org_id?: string;
          retain_days?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "document_retention_policies_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_retention_policies_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      enquiry_tags: {
        Row: {
          added_at: string;
          added_by: string | null;
          enquiry_id: string;
          org_id: string;
          tag_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_at?: string;
          added_by?: string | null;
          enquiry_id: string;
          org_id: string;
          tag_id: string;
        };
        Update: {
          added_at?: string;
          added_by?: string | null;
          enquiry_id?: string;
          org_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "enquiry_tags_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiry_tags_enquiry_id_fkey";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "enquiries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiry_tags_enquiry_id_fkey";
            columns: ["enquiry_id"];
            isOneToOne: false;
            referencedRelation: "v_enquiry_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiry_tags_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "enquiry_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
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
      esign_requests: {
        Row: {
          completed_at: string | null;
          contact_id: string;
          created_at: string;
          error_code: string | null;
          expires_at: string | null;
          id: string;
          org_id: string;
          provider: string;
          provider_request_id: string | null;
          requested_by: string | null;
          sent_at: string | null;
          signed_document_id: string | null;
          signer_hint: string | null;
          source_asset_id: string | null;
          source_document_id: string | null;
          source_kind: string;
          status: string;
          test_mode: boolean;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          completed_at?: string | null;
          contact_id: string;
          created_at?: string;
          error_code?: string | null;
          expires_at?: string | null;
          id?: string;
          org_id: string;
          provider?: string;
          provider_request_id?: string | null;
          requested_by?: string | null;
          sent_at?: string | null;
          signed_document_id?: string | null;
          signer_hint?: string | null;
          source_asset_id?: string | null;
          source_document_id?: string | null;
          source_kind: string;
          status?: string;
          test_mode?: boolean;
          updated_at?: string;
        };
        Update: {
          completed_at?: string | null;
          contact_id?: string;
          created_at?: string;
          error_code?: string | null;
          expires_at?: string | null;
          id?: string;
          org_id?: string;
          provider?: string;
          provider_request_id?: string | null;
          requested_by?: string | null;
          sent_at?: string | null;
          signed_document_id?: string | null;
          signer_hint?: string | null;
          source_asset_id?: string | null;
          source_document_id?: string | null;
          source_kind?: string;
          status?: string;
          test_mode?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "esign_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "esign_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "esign_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "esign_requests_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "esign_requests_requested_by_fkey";
            columns: ["requested_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "esign_requests_signed_document_id_fkey";
            columns: ["signed_document_id"];
            isOneToOne: false;
            referencedRelation: "patient_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "esign_requests_source_asset_id_fkey";
            columns: ["source_asset_id"];
            isOneToOne: false;
            referencedRelation: "media_assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "esign_requests_source_document_id_fkey";
            columns: ["source_document_id"];
            isOneToOne: false;
            referencedRelation: "patient_documents";
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
      fin_accounting_exports: {
        Row: {
          checksum: string;
          created_at: string;
          credit_total: number;
          debit_total: number;
          exported_by: string | null;
          id: string;
          org_id: string;
          period_from: string;
          period_to: string;
          row_count: number;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          checksum: string;
          created_at?: string;
          credit_total: number;
          debit_total: number;
          exported_by?: string | null;
          id?: string;
          org_id: string;
          period_from: string;
          period_to: string;
          row_count: number;
          status: string;
        };
        Update: {
          checksum?: string;
          created_at?: string;
          credit_total?: number;
          debit_total?: number;
          exported_by?: string | null;
          id?: string;
          org_id?: string;
          period_from?: string;
          period_to?: string;
          row_count?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_accounting_exports_exported_by_fkey";
            columns: ["exported_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_accounting_exports_org_id_fkey";
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
      fin_approval_signatures: {
        Row: {
          bound_sha256: string;
          cert_fingerprint: string;
          cert_issuer: string;
          cert_issuer_cn: string | null;
          cert_serial: string;
          cert_subject: string;
          cert_subject_cn: string | null;
          cert_valid_from: string;
          cert_valid_to: string;
          certificate_id: string | null;
          cms: string;
          doc_id: string;
          doc_kind: string;
          id: string;
          org_id: string;
          statement: string;
          statement_sha256: string;
          step: string;
          step_at: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          bound_sha256: string;
          cert_fingerprint: string;
          cert_issuer: string;
          cert_issuer_cn?: string | null;
          cert_serial: string;
          cert_subject: string;
          cert_subject_cn?: string | null;
          cert_valid_from: string;
          cert_valid_to: string;
          certificate_id?: string | null;
          cms: string;
          doc_id: string;
          doc_kind: string;
          id?: string;
          org_id: string;
          statement: string;
          statement_sha256: string;
          step: string;
          step_at?: string;
          user_id?: string | null;
        };
        Update: {
          bound_sha256?: string;
          cert_fingerprint?: string;
          cert_issuer?: string;
          cert_issuer_cn?: string | null;
          cert_serial?: string;
          cert_subject?: string;
          cert_subject_cn?: string | null;
          cert_valid_from?: string;
          cert_valid_to?: string;
          certificate_id?: string | null;
          cms?: string;
          doc_id?: string;
          doc_kind?: string;
          id?: string;
          org_id?: string;
          statement?: string;
          statement_sha256?: string;
          step?: string;
          step_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_approval_signatures_certificate_id_fkey";
            columns: ["certificate_id"];
            isOneToOne: false;
            referencedRelation: "fin_signing_certificates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_approval_signatures_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_approval_signatures_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_accounts: {
        Row: {
          active: boolean;
          bank_name: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          gl_account_id: string | null;
          id: string;
          last4: string;
          ledger_name: string | null;
          name: string;
          org_id: string;
          receives_insurance: boolean;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          bank_name: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          gl_account_id?: string | null;
          id?: string;
          last4: string;
          ledger_name?: string | null;
          name: string;
          org_id: string;
          receives_insurance?: boolean;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          bank_name?: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          gl_account_id?: string | null;
          id?: string;
          last4?: string;
          ledger_name?: string | null;
          name?: string;
          org_id?: string;
          receives_insurance?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_accounts_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_accounts_gl_account_id_fkey";
            columns: ["gl_account_id"];
            isOneToOne: false;
            referencedRelation: "acc_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_accounts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_ai_reviews: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          item_count: number;
          model: string;
          org_id: string;
          rec_id: string;
          reject_reason: string | null;
          repaired: boolean;
          status: string;
          suggestion_count: number;
          summary: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_count?: number;
          model: string;
          org_id: string;
          rec_id: string;
          reject_reason?: string | null;
          repaired?: boolean;
          status: string;
          suggestion_count?: number;
          summary?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_count?: number;
          model?: string;
          org_id?: string;
          rec_id?: string;
          reject_reason?: string | null;
          repaired?: boolean;
          status?: string;
          suggestion_count?: number;
          summary?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_ai_reviews_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_ai_reviews_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_ai_reviews_rec_id_fkey";
            columns: ["rec_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_recs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_ai_suggestions: {
        Row: {
          candidate_line_id: string | null;
          confidence: string;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision: string;
          id: string;
          item_key: string;
          org_id: string;
          reason_code: string;
          rec_id: string;
          review_id: string;
        };
        ComputedFields: never;
        Insert: {
          candidate_line_id?: string | null;
          confidence: string;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision?: string;
          id?: string;
          item_key: string;
          org_id: string;
          reason_code: string;
          rec_id: string;
          review_id: string;
        };
        Update: {
          candidate_line_id?: string | null;
          confidence?: string;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision?: string;
          id?: string;
          item_key?: string;
          org_id?: string;
          reason_code?: string;
          rec_id?: string;
          review_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_ai_suggestions_candidate_line_id_fkey";
            columns: ["candidate_line_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_ai_suggestions_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_ai_suggestions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_ai_suggestions_rec_id_fkey";
            columns: ["rec_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_recs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_ai_suggestions_review_id_fkey";
            columns: ["review_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_ai_reviews";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_imports: {
        Row: {
          account_id: string | null;
          file_name: string | null;
          file_sha256: string;
          first_date: string | null;
          format_id: string | null;
          id: string;
          imported_at: string;
          imported_by: string | null;
          kind: string;
          last_date: string | null;
          org_id: string;
          payment_mode: string | null;
          row_count: number;
          sum_credits: number;
          sum_debits: number;
        };
        ComputedFields: never;
        Insert: {
          account_id?: string | null;
          file_name?: string | null;
          file_sha256: string;
          first_date?: string | null;
          format_id?: string | null;
          id?: string;
          imported_at?: string;
          imported_by?: string | null;
          kind: string;
          last_date?: string | null;
          org_id: string;
          payment_mode?: string | null;
          row_count?: number;
          sum_credits?: number;
          sum_debits?: number;
        };
        Update: {
          account_id?: string | null;
          file_name?: string | null;
          file_sha256?: string;
          first_date?: string | null;
          format_id?: string | null;
          id?: string;
          imported_at?: string;
          imported_by?: string | null;
          kind?: string;
          last_date?: string | null;
          org_id?: string;
          payment_mode?: string | null;
          row_count?: number;
          sum_credits?: number;
          sum_debits?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_imports_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_imports_format_id_fkey";
            columns: ["format_id"];
            isOneToOne: false;
            referencedRelation: "fin_import_formats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_imports_imported_by_fkey";
            columns: ["imported_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_imports_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_lines: {
        Row: {
          account_id: string;
          amount: number;
          created_at: string;
          description: string | null;
          id: string;
          import_id: string;
          match_status: string;
          org_id: string;
          reference: string | null;
          row_no: number;
          value_date: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          amount: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          import_id: string;
          match_status?: string;
          org_id: string;
          reference?: string | null;
          row_no: number;
          value_date: string;
        };
        Update: {
          account_id?: string;
          amount?: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          import_id?: string;
          match_status?: string;
          org_id?: string;
          reference?: string | null;
          row_no?: number;
          value_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_lines_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_lines_import_id_fkey";
            columns: ["import_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_imports";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_matches: {
        Row: {
          auto: boolean;
          bank_amount: number;
          bank_line_id: string;
          decided_at: string;
          decided_by: string | null;
          expected_amount: number;
          expected_date: string;
          expected_key: string;
          expected_kind: string;
          id: string;
          org_id: string;
          reasons: NonNullable<Json>;
          rec_id: string;
          score: number;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          auto?: boolean;
          bank_amount: number;
          bank_line_id: string;
          decided_at?: string;
          decided_by?: string | null;
          expected_amount: number;
          expected_date: string;
          expected_key: string;
          expected_kind: string;
          id?: string;
          org_id: string;
          reasons?: NonNullable<Json>;
          rec_id: string;
          score: number;
          status: string;
        };
        Update: {
          auto?: boolean;
          bank_amount?: number;
          bank_line_id?: string;
          decided_at?: string;
          decided_by?: string | null;
          expected_amount?: number;
          expected_date?: string;
          expected_key?: string;
          expected_kind?: string;
          id?: string;
          org_id?: string;
          reasons?: NonNullable<Json>;
          rec_id?: string;
          score?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_matches_bank_line_id_fkey";
            columns: ["bank_line_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_lines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_matches_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_matches_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_matches_rec_id_fkey";
            columns: ["rec_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_recs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_rec_notes: {
        Row: {
          decided_at: string;
          decided_by: string | null;
          id: string;
          item_key: string;
          note: string | null;
          org_id: string;
          reason_code: string;
          rec_id: string;
        };
        ComputedFields: never;
        Insert: {
          decided_at?: string;
          decided_by?: string | null;
          id?: string;
          item_key: string;
          note?: string | null;
          org_id: string;
          reason_code: string;
          rec_id: string;
        };
        Update: {
          decided_at?: string;
          decided_by?: string | null;
          id?: string;
          item_key?: string;
          note?: string | null;
          org_id?: string;
          reason_code?: string;
          rec_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_rec_notes_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_rec_notes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_rec_notes_rec_id_fkey";
            columns: ["rec_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_recs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_bank_recs: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          figures: Json | null;
          figures_sha256: string | null;
          id: string;
          month: string;
          org_id: string;
          period_end: string;
          period_start: string;
          prepared_at: string | null;
          prepared_by: string | null;
          signed_at: string | null;
          signed_by: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          figures?: Json | null;
          figures_sha256?: string | null;
          id?: string;
          month: string;
          org_id: string;
          period_end: string;
          period_start: string;
          prepared_at?: string | null;
          prepared_by?: string | null;
          signed_at?: string | null;
          signed_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          figures?: Json | null;
          figures_sha256?: string | null;
          id?: string;
          month?: string;
          org_id?: string;
          period_end?: string;
          period_start?: string;
          prepared_at?: string | null;
          prepared_by?: string | null;
          signed_at?: string | null;
          signed_by?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_bank_recs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_recs_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_recs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_recs_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_bank_recs_signed_by_fkey";
            columns: ["signed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      fin_cashup_lines: {
        Row: {
          cashup_id: string;
          counted_amount: number | null;
          created_at: string;
          expected_amount: number;
          id: string;
          org_id: string;
          payment_mode: string;
          reason: string | null;
          updated_at: string;
          variance: number | null;
        };
        ComputedFields: never;
        Insert: {
          cashup_id: string;
          counted_amount?: number | null;
          created_at?: string;
          expected_amount?: number;
          id?: string;
          org_id: string;
          payment_mode: string;
          reason?: string | null;
          updated_at?: string;
          variance?: never;
        };
        Update: {
          cashup_id?: string;
          counted_amount?: number | null;
          created_at?: string;
          expected_amount?: number;
          id?: string;
          org_id?: string;
          payment_mode?: string;
          reason?: string | null;
          updated_at?: string;
          variance?: never;
        };
        Relationships: [
          {
            foreignKeyName: "fin_cashup_lines_cashup_id_fkey";
            columns: ["cashup_id"];
            isOneToOne: false;
            referencedRelation: "fin_cashups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cashup_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_cashups: {
        Row: {
          branch_code: string;
          business_date: string;
          created_at: string;
          id: string;
          note: string | null;
          org_id: string;
          prepared_by: string | null;
          status: string;
          submitted_at: string | null;
          submitted_by: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_code: string;
          business_date: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          org_id: string;
          prepared_by?: string | null;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          updated_at?: string;
        };
        Update: {
          branch_code?: string;
          business_date?: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          org_id?: string;
          prepared_by?: string | null;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_cashups_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cashups_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cashups_submitted_by_fkey";
            columns: ["submitted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_close_steps: {
        Row: {
          active: boolean;
          backup_user_id: string | null;
          code: string;
          created_at: string;
          depends_on: string[];
          due_wd: number;
          evidence_hint: string | null;
          id: string;
          org_id: string;
          owner_role: string | null;
          owner_user_id: string | null;
          sort_order: number;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          backup_user_id?: string | null;
          code: string;
          created_at?: string;
          depends_on?: string[];
          due_wd: number;
          evidence_hint?: string | null;
          id?: string;
          org_id: string;
          owner_role?: string | null;
          owner_user_id?: string | null;
          sort_order?: number;
          title: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          backup_user_id?: string | null;
          code?: string;
          created_at?: string;
          depends_on?: string[];
          due_wd?: number;
          evidence_hint?: string | null;
          id?: string;
          org_id?: string;
          owner_role?: string | null;
          owner_user_id?: string | null;
          sort_order?: number;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_close_steps_backup_user_id_fkey";
            columns: ["backup_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_close_steps_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_close_steps_owner_user_id_fkey";
            columns: ["owner_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_close_tasks: {
        Row: {
          blocked_reason: string | null;
          created_at: string;
          done_at: string | null;
          done_by: string | null;
          due_wd: number;
          id: string;
          month: string;
          note: string | null;
          org_id: string;
          reminded_on: string | null;
          status: string;
          step_code: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          blocked_reason?: string | null;
          created_at?: string;
          done_at?: string | null;
          done_by?: string | null;
          due_wd: number;
          id?: string;
          month: string;
          note?: string | null;
          org_id: string;
          reminded_on?: string | null;
          status?: string;
          step_code: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          blocked_reason?: string | null;
          created_at?: string;
          done_at?: string | null;
          done_by?: string | null;
          due_wd?: number;
          id?: string;
          month?: string;
          note?: string | null;
          org_id?: string;
          reminded_on?: string | null;
          status?: string;
          step_code?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_close_tasks_done_by_fkey";
            columns: ["done_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_close_tasks_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_close_tasks_org_id_step_code_fkey";
            columns: ["org_id", "step_code"];
            isOneToOne: false;
            referencedRelation: "fin_close_steps";
            referencedColumns: ["org_id", "code"];
          },
          {
            foreignKeyName: "fin_close_tasks_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_cost_doctor_comp: {
        Row: {
          amount: number;
          created_at: string;
          created_by: string | null;
          doctor_dha_id: string;
          id: string;
          month: string;
          note: string | null;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          created_at?: string;
          created_by?: string | null;
          doctor_dha_id: string;
          id?: string;
          month: string;
          note?: string | null;
          org_id: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          created_by?: string | null;
          doctor_dha_id?: string;
          id?: string;
          month?: string;
          note?: string | null;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_cost_doctor_comp_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cost_doctor_comp_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_cost_overheads: {
        Row: {
          amount: number;
          basis: string;
          branch_code: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          month: string;
          note: string | null;
          org_id: string;
          pool: string;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          basis?: string;
          branch_code?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          month: string;
          note?: string | null;
          org_id: string;
          pool: string;
        };
        Update: {
          amount?: number;
          basis?: string;
          branch_code?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          month?: string;
          note?: string | null;
          org_id?: string;
          pool?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_cost_overheads_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cost_overheads_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_cost_periods: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          month: string;
          note: string | null;
          org_id: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          month: string;
          note?: string | null;
          org_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          month?: string;
          note?: string | null;
          org_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_cost_periods_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cost_periods_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_cost_services: {
        Row: {
          created_at: string;
          created_by: string | null;
          effective_from: string;
          id: string;
          item_code: string;
          note: string | null;
          org_id: string;
          unit_cost: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          effective_from: string;
          id?: string;
          item_code: string;
          note?: string | null;
          org_id: string;
          unit_cost: number;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          id?: string;
          item_code?: string;
          note?: string | null;
          org_id?: string;
          unit_cost?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_cost_services_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_cost_services_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_doctor_charges: {
        Row: {
          amount: number;
          created_at: string;
          created_by: string | null;
          doctor_dha_id: string;
          id: string;
          kind: string;
          month: string;
          note: string | null;
          org_id: string;
          reference: string | null;
          source: string;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          created_at?: string;
          created_by?: string | null;
          doctor_dha_id: string;
          id?: string;
          kind: string;
          month: string;
          note?: string | null;
          org_id: string;
          reference?: string | null;
          source?: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          created_by?: string | null;
          doctor_dha_id?: string;
          id?: string;
          kind?: string;
          month?: string;
          note?: string | null;
          org_id?: string;
          reference?: string | null;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_doctor_charges_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_doctor_charges_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_documents: {
        Row: {
          created_at: string;
          id: string;
          inbox_at: string | null;
          kind: string;
          mime_type: string;
          org_id: string;
          routed_at: string | null;
          scan_engine: string | null;
          scan_status: string;
          scanned_at: string | null;
          sender_domain: string | null;
          sha256: string | null;
          size_bytes: number;
          source: string;
          status: string;
          storage_path: string;
          updated_at: string;
          uploaded_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          inbox_at?: string | null;
          kind: string;
          mime_type: string;
          org_id: string;
          routed_at?: string | null;
          scan_engine?: string | null;
          scan_status?: string;
          scanned_at?: string | null;
          sender_domain?: string | null;
          sha256?: string | null;
          size_bytes: number;
          source?: string;
          status?: string;
          storage_path: string;
          updated_at?: string;
          uploaded_by?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          inbox_at?: string | null;
          kind?: string;
          mime_type?: string;
          org_id?: string;
          routed_at?: string | null;
          scan_engine?: string | null;
          scan_status?: string;
          scanned_at?: string | null;
          sender_domain?: string | null;
          sha256?: string | null;
          size_bytes?: number;
          source?: string;
          status?: string;
          storage_path?: string;
          updated_at?: string;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_documents_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_documents_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_eligibility_checks: {
        Row: {
          appointment_id: string | null;
          checked_by: string | null;
          checked_on: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          document_id: string | null;
          id: string;
          method: string;
          org_id: string;
          patient_pin: string | null;
          payer_id: string;
          result_note: string | null;
          status: string;
          updated_at: string;
          valid_from: string | null;
          valid_to: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          checked_by?: string | null;
          checked_on?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          id?: string;
          method?: string;
          org_id: string;
          patient_pin?: string | null;
          payer_id: string;
          result_note?: string | null;
          status?: string;
          updated_at?: string;
          valid_from?: string | null;
          valid_to?: string | null;
        };
        Update: {
          appointment_id?: string | null;
          checked_by?: string | null;
          checked_on?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          id?: string;
          method?: string;
          org_id?: string;
          patient_pin?: string | null;
          payer_id?: string;
          result_note?: string | null;
          status?: string;
          updated_at?: string;
          valid_from?: string | null;
          valid_to?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_eligibility_checks_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_checked_by_fkey";
            columns: ["checked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "patient_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_eligibility_checks_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_import_formats: {
        Row: {
          active: boolean;
          amount_style: string;
          created_at: string;
          created_by: string | null;
          date_format: string;
          id: string;
          kind: string;
          mapping: NonNullable<Json>;
          name: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          amount_style?: string;
          created_at?: string;
          created_by?: string | null;
          date_format: string;
          id?: string;
          kind: string;
          mapping: NonNullable<Json>;
          name: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          amount_style?: string;
          created_at?: string;
          created_by?: string | null;
          date_format?: string;
          id?: string;
          kind?: string;
          mapping?: NonNullable<Json>;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_import_formats_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_import_formats_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_invoice_change_reviews: {
        Row: {
          amount: number;
          bulk: boolean;
          change_date: string;
          change_key: string;
          decision: string;
          id: string;
          invoice_id: string;
          kind: string;
          month_locked: boolean;
          org_id: string;
          reason: string;
          reviewed_at: string;
          reviewed_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          bulk?: boolean;
          change_date: string;
          change_key: string;
          decision: string;
          id?: string;
          invoice_id: string;
          kind: string;
          month_locked?: boolean;
          org_id: string;
          reason: string;
          reviewed_at?: string;
          reviewed_by?: string | null;
        };
        Update: {
          amount?: number;
          bulk?: boolean;
          change_date?: string;
          change_key?: string;
          decision?: string;
          id?: string;
          invoice_id?: string;
          kind?: string;
          month_locked?: boolean;
          org_id?: string;
          reason?: string;
          reviewed_at?: string;
          reviewed_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_invoice_change_reviews_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_change_reviews_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_change_reviews_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_invoice_change_reviews_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_invoice_change_reviews_reviewed_by_fkey";
            columns: ["reviewed_by"];
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
          ordering_doctor_dha_id: string | null;
          ordering_doctor_name: string | null;
          org_id: string;
          patient_pin: string | null;
          patient_ref: string | null;
          performing_doctor_dha_id: string | null;
          performing_doctor_name: string | null;
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
          ordering_doctor_dha_id?: string | null;
          ordering_doctor_name?: string | null;
          org_id: string;
          patient_pin?: string | null;
          patient_ref?: string | null;
          performing_doctor_dha_id?: string | null;
          performing_doctor_name?: string | null;
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
          ordering_doctor_dha_id?: string | null;
          ordering_doctor_name?: string | null;
          org_id?: string;
          patient_pin?: string | null;
          patient_ref?: string | null;
          performing_doctor_dha_id?: string | null;
          performing_doctor_name?: string | null;
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
      fin_payment_requests: {
        Row: {
          amount_minor: number;
          amount_paid_minor: number | null;
          contact_id: string | null;
          create_attempted_at: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          expires_at: string | null;
          failure_code: string | null;
          flow_step_key: string | null;
          id: string;
          invoice_id: string;
          invoice_number: string;
          last_event_at: string | null;
          message_id: string | null;
          needs_review: boolean;
          org_id: string;
          paid_at: string | null;
          patient_pin: string | null;
          provider: string;
          provider_ref: string | null;
          review_reason: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_minor: number;
          amount_paid_minor?: number | null;
          contact_id?: string | null;
          create_attempted_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency: string;
          expires_at?: string | null;
          failure_code?: string | null;
          flow_step_key?: string | null;
          id?: string;
          invoice_id: string;
          invoice_number: string;
          last_event_at?: string | null;
          message_id?: string | null;
          needs_review?: boolean;
          org_id: string;
          paid_at?: string | null;
          patient_pin?: string | null;
          provider: string;
          provider_ref?: string | null;
          review_reason?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          amount_minor?: number;
          amount_paid_minor?: number | null;
          contact_id?: string | null;
          create_attempted_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          expires_at?: string | null;
          failure_code?: string | null;
          flow_step_key?: string | null;
          id?: string;
          invoice_id?: string;
          invoice_number?: string;
          last_event_at?: string | null;
          message_id?: string | null;
          needs_review?: boolean;
          org_id?: string;
          paid_at?: string | null;
          patient_pin?: string | null;
          provider?: string;
          provider_ref?: string | null;
          review_reason?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_payment_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_payment_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_payment_requests_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_requests_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_requests_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_requests_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_payment_requests_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_requests_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_requests_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_payment_vouchers: {
        Row: {
          amount: number;
          approved_at: string | null;
          branch_code: string | null;
          bulk_allowed: boolean | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          category: string;
          ceo_approved_at: string | null;
          ceo_approved_by: string | null;
          checked_at: string | null;
          checked_by: string | null;
          content_sha256: string | null;
          cost_centre: string | null;
          created_at: string;
          currency: string;
          dept_approved_at: string | null;
          dept_approved_by: string | null;
          id: string;
          narration: string;
          needs_ceo: boolean | null;
          needs_dept: boolean | null;
          org_id: string;
          paid_at: string | null;
          paid_by: string | null;
          pay_from: string | null;
          payee_name: string;
          payment_date: string | null;
          payment_method: string;
          payment_reference: string | null;
          prepared_by: string | null;
          rejected_at: string | null;
          rejected_by: string | null;
          rejection_remarks: string | null;
          route: string | null;
          special_category: string;
          status: string;
          submitted_at: string | null;
          submitted_by: string | null;
          supplier_id: string | null;
          tally_export_id: string | null;
          tally_exported_at: string | null;
          tier_code: string | null;
          updated_at: string;
          voucher_date: string;
          voucher_no: string;
        };
        ComputedFields: never;
        Insert: {
          amount: number;
          approved_at?: string | null;
          branch_code?: string | null;
          bulk_allowed?: boolean | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          category: string;
          ceo_approved_at?: string | null;
          ceo_approved_by?: string | null;
          checked_at?: string | null;
          checked_by?: string | null;
          content_sha256?: string | null;
          cost_centre?: string | null;
          created_at?: string;
          currency?: string;
          dept_approved_at?: string | null;
          dept_approved_by?: string | null;
          id?: string;
          narration: string;
          needs_ceo?: boolean | null;
          needs_dept?: boolean | null;
          org_id: string;
          paid_at?: string | null;
          paid_by?: string | null;
          pay_from?: string | null;
          payee_name: string;
          payment_date?: string | null;
          payment_method?: string;
          payment_reference?: string | null;
          prepared_by?: string | null;
          rejected_at?: string | null;
          rejected_by?: string | null;
          rejection_remarks?: string | null;
          route?: string | null;
          special_category?: string;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          supplier_id?: string | null;
          tally_export_id?: string | null;
          tally_exported_at?: string | null;
          tier_code?: string | null;
          updated_at?: string;
          voucher_date: string;
          voucher_no: string;
        };
        Update: {
          amount?: number;
          approved_at?: string | null;
          branch_code?: string | null;
          bulk_allowed?: boolean | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          category?: string;
          ceo_approved_at?: string | null;
          ceo_approved_by?: string | null;
          checked_at?: string | null;
          checked_by?: string | null;
          content_sha256?: string | null;
          cost_centre?: string | null;
          created_at?: string;
          currency?: string;
          dept_approved_at?: string | null;
          dept_approved_by?: string | null;
          id?: string;
          narration?: string;
          needs_ceo?: boolean | null;
          needs_dept?: boolean | null;
          org_id?: string;
          paid_at?: string | null;
          paid_by?: string | null;
          pay_from?: string | null;
          payee_name?: string;
          payment_date?: string | null;
          payment_method?: string;
          payment_reference?: string | null;
          prepared_by?: string | null;
          rejected_at?: string | null;
          rejected_by?: string | null;
          rejection_remarks?: string | null;
          route?: string | null;
          special_category?: string;
          status?: string;
          submitted_at?: string | null;
          submitted_by?: string | null;
          supplier_id?: string | null;
          tally_export_id?: string | null;
          tally_exported_at?: string | null;
          tier_code?: string | null;
          updated_at?: string;
          voucher_date?: string;
          voucher_no?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_payment_vouchers_cancelled_by_fkey";
            columns: ["cancelled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_ceo_approved_by_fkey";
            columns: ["ceo_approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_checked_by_fkey";
            columns: ["checked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_dept_approved_by_fkey";
            columns: ["dept_approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_paid_by_fkey";
            columns: ["paid_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_rejected_by_fkey";
            columns: ["rejected_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_submitted_by_fkey";
            columns: ["submitted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "fin_suppliers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_payment_vouchers_tally_export_id_fkey";
            columns: ["tally_export_id"];
            isOneToOne: false;
            referencedRelation: "fin_tally_exports";
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
      fin_period_closes: {
        Row: {
          built_at: string | null;
          built_by: string | null;
          ceo_note: string | null;
          ceo_signed_at: string | null;
          ceo_signed_by: string | null;
          created_at: string;
          finance_note: string | null;
          finance_signed_at: string | null;
          finance_signed_by: string | null;
          id: string;
          locked_at: string | null;
          month: string;
          org_id: string;
          snapshot: Json | null;
          snapshot_hash: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          built_at?: string | null;
          built_by?: string | null;
          ceo_note?: string | null;
          ceo_signed_at?: string | null;
          ceo_signed_by?: string | null;
          created_at?: string;
          finance_note?: string | null;
          finance_signed_at?: string | null;
          finance_signed_by?: string | null;
          id?: string;
          locked_at?: string | null;
          month: string;
          org_id: string;
          snapshot?: Json | null;
          snapshot_hash?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          built_at?: string | null;
          built_by?: string | null;
          ceo_note?: string | null;
          ceo_signed_at?: string | null;
          ceo_signed_by?: string | null;
          created_at?: string;
          finance_note?: string | null;
          finance_signed_at?: string | null;
          finance_signed_by?: string | null;
          id?: string;
          locked_at?: string | null;
          month?: string;
          org_id?: string;
          snapshot?: Json | null;
          snapshot_hash?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_period_closes_built_by_fkey";
            columns: ["built_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_period_closes_ceo_signed_by_fkey";
            columns: ["ceo_signed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_period_closes_finance_signed_by_fkey";
            columns: ["finance_signed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_period_closes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_pre_authorisations: {
        Row: {
          appointment_id: string | null;
          approved_amount: number | null;
          approved_units: number | null;
          auth_number: string | null;
          claim_activity_id: string | null;
          contact_id: string | null;
          cpt_codes: string[];
          created_at: string;
          created_by: string | null;
          decision_on: string | null;
          expires_on: string | null;
          expiry_notified_at: string | null;
          expiry_task_id: string | null;
          id: string;
          org_id: string;
          patient_pin: string | null;
          payer_id: string;
          reference_note: string | null;
          requested_by: string | null;
          requested_on: string | null;
          status: string;
          updated_at: string;
          valid_from: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          approved_amount?: number | null;
          approved_units?: number | null;
          auth_number?: string | null;
          claim_activity_id?: string | null;
          contact_id?: string | null;
          cpt_codes?: string[];
          created_at?: string;
          created_by?: string | null;
          decision_on?: string | null;
          expires_on?: string | null;
          expiry_notified_at?: string | null;
          expiry_task_id?: string | null;
          id?: string;
          org_id: string;
          patient_pin?: string | null;
          payer_id: string;
          reference_note?: string | null;
          requested_by?: string | null;
          requested_on?: string | null;
          status?: string;
          updated_at?: string;
          valid_from?: string | null;
        };
        Update: {
          appointment_id?: string | null;
          approved_amount?: number | null;
          approved_units?: number | null;
          auth_number?: string | null;
          claim_activity_id?: string | null;
          contact_id?: string | null;
          cpt_codes?: string[];
          created_at?: string;
          created_by?: string | null;
          decision_on?: string | null;
          expires_on?: string | null;
          expiry_notified_at?: string | null;
          expiry_task_id?: string | null;
          id?: string;
          org_id?: string;
          patient_pin?: string | null;
          payer_id?: string;
          reference_note?: string | null;
          requested_by?: string | null;
          requested_on?: string | null;
          status?: string;
          updated_at?: string;
          valid_from?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_pre_authorisations_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_claim_activity_id_fkey";
            columns: ["claim_activity_id"];
            isOneToOne: false;
            referencedRelation: "ins_claim_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_expiry_task_id_fkey";
            columns: ["expiry_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_pre_authorisations_requested_by_fkey";
            columns: ["requested_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_provider_files: {
        Row: {
          file_name: string | null;
          file_sha256: string;
          first_date: string | null;
          format_id: string | null;
          id: string;
          imported_at: string;
          imported_by: string | null;
          kind: string;
          last_date: string | null;
          org_id: string;
          row_count: number;
          statement_id: string;
          total_amount: number;
        };
        ComputedFields: never;
        Insert: {
          file_name?: string | null;
          file_sha256: string;
          first_date?: string | null;
          format_id?: string | null;
          id?: string;
          imported_at?: string;
          imported_by?: string | null;
          kind: string;
          last_date?: string | null;
          org_id: string;
          row_count?: number;
          statement_id: string;
          total_amount?: number;
        };
        Update: {
          file_name?: string | null;
          file_sha256?: string;
          first_date?: string | null;
          format_id?: string | null;
          id?: string;
          imported_at?: string;
          imported_by?: string | null;
          kind?: string;
          last_date?: string | null;
          org_id?: string;
          row_count?: number;
          statement_id?: string;
          total_amount?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_provider_files_format_id_fkey";
            columns: ["format_id"];
            isOneToOne: false;
            referencedRelation: "fin_import_formats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_files_imported_by_fkey";
            columns: ["imported_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_files_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_files_statement_id_fkey";
            columns: ["statement_id"];
            isOneToOne: false;
            referencedRelation: "fin_provider_statements";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_provider_lines: {
        Row: {
          amount: number | null;
          branch_code: string | null;
          code: string;
          created_at: string;
          doctor_dha_id: string | null;
          file_id: string;
          id: string;
          invoice_no: string | null;
          org_id: string;
          patient_pin: string | null;
          result_date: string | null;
          row_no: number;
          service_date: string;
          statement_id: string;
        };
        ComputedFields: never;
        Insert: {
          amount?: number | null;
          branch_code?: string | null;
          code: string;
          created_at?: string;
          doctor_dha_id?: string | null;
          file_id: string;
          id?: string;
          invoice_no?: string | null;
          org_id: string;
          patient_pin?: string | null;
          result_date?: string | null;
          row_no: number;
          service_date: string;
          statement_id: string;
        };
        Update: {
          amount?: number | null;
          branch_code?: string | null;
          code?: string;
          created_at?: string;
          doctor_dha_id?: string | null;
          file_id?: string;
          id?: string;
          invoice_no?: string | null;
          org_id?: string;
          patient_pin?: string | null;
          result_date?: string | null;
          row_no?: number;
          service_date?: string;
          statement_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_provider_lines_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "fin_provider_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_lines_statement_id_fkey";
            columns: ["statement_id"];
            isOneToOne: false;
            referencedRelation: "fin_provider_statements";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_provider_notes: {
        Row: {
          decided_at: string;
          decided_by: string | null;
          id: string;
          item_key: string;
          note: string | null;
          org_id: string;
          reason_code: string;
          statement_id: string;
        };
        ComputedFields: never;
        Insert: {
          decided_at?: string;
          decided_by?: string | null;
          id?: string;
          item_key: string;
          note?: string | null;
          org_id: string;
          reason_code: string;
          statement_id: string;
        };
        Update: {
          decided_at?: string;
          decided_by?: string | null;
          id?: string;
          item_key?: string;
          note?: string | null;
          org_id?: string;
          reason_code?: string;
          statement_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_provider_notes_decided_by_fkey";
            columns: ["decided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_notes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_notes_statement_id_fkey";
            columns: ["statement_id"];
            isOneToOne: false;
            referencedRelation: "fin_provider_statements";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_provider_statements: {
        Row: {
          created_at: string;
          created_by: string | null;
          figures: Json | null;
          figures_sha256: string | null;
          id: string;
          month: string;
          org_id: string;
          posted_at: string | null;
          posted_by: string | null;
          prepared_at: string | null;
          prepared_by: string | null;
          provider_id: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          figures?: Json | null;
          figures_sha256?: string | null;
          id?: string;
          month: string;
          org_id: string;
          posted_at?: string | null;
          posted_by?: string | null;
          prepared_at?: string | null;
          prepared_by?: string | null;
          provider_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          figures?: Json | null;
          figures_sha256?: string | null;
          id?: string;
          month?: string;
          org_id?: string;
          posted_at?: string | null;
          posted_by?: string | null;
          prepared_at?: string | null;
          prepared_by?: string | null;
          provider_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_provider_statements_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_statements_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_statements_posted_by_fkey";
            columns: ["posted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_statements_prepared_by_fkey";
            columns: ["prepared_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_provider_statements_provider_id_fkey";
            columns: ["provider_id"];
            isOneToOne: false;
            referencedRelation: "fin_providers";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_providers: {
        Row: {
          active: boolean;
          allocation_basis: string;
          created_at: string;
          created_by: string | null;
          fixed_monthly_fee: number | null;
          id: string;
          kind: string;
          name: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          allocation_basis?: string;
          created_at?: string;
          created_by?: string | null;
          fixed_monthly_fee?: number | null;
          id?: string;
          kind: string;
          name: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          allocation_basis?: string;
          created_at?: string;
          created_by?: string | null;
          fixed_monthly_fee?: number | null;
          id?: string;
          kind?: string;
          name?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_providers_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_providers_org_id_fkey";
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
      fin_raw_remittance_files: {
        Row: {
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
          sum_paid: number | null;
          uploaded_at: string;
          uploaded_by: string | null;
        };
        ComputedFields: never;
        Insert: {
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
          sum_paid?: number | null;
          uploaded_at?: string;
          uploaded_by?: string | null;
        };
        Update: {
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
          sum_paid?: number | null;
          uploaded_at?: string;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_raw_remittance_files_committed_by_fkey";
            columns: ["committed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_raw_remittance_files_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_raw_remittance_files_uploaded_by_fkey";
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
      fin_recovery_reminders: {
        Row: {
          balance: number | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          invoice_id: string;
          message_id: string | null;
          org_id: string;
          patient_pin: string | null;
          sequence_no: number;
          skip_reason: string | null;
          status: string;
          template_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          balance?: number | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          invoice_id: string;
          message_id?: string | null;
          org_id: string;
          patient_pin?: string | null;
          sequence_no: number;
          skip_reason?: string | null;
          status: string;
          template_id?: string | null;
        };
        Update: {
          balance?: number | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          invoice_id?: string;
          message_id?: string | null;
          org_id?: string;
          patient_pin?: string | null;
          sequence_no?: number;
          skip_reason?: string | null;
          status?: string;
          template_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_recovery_reminders_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_fin_invoice_list";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "v_ins_invoice_match";
            referencedColumns: ["invoice_id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_recovery_reminders_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_account_map: {
        Row: {
          account_code: string;
          account_name: string | null;
          key: string;
          kind: string;
          org_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_code: string;
          account_name?: string | null;
          key: string;
          kind: string;
          org_id: string;
          updated_at?: string;
        };
        Update: {
          account_code?: string;
          account_name?: string | null;
          key?: string;
          kind?: string;
          org_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_account_map_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_approval_tiers: {
        Row: {
          active: boolean;
          bulk_allowed: boolean;
          code: string;
          created_at: string;
          description: string | null;
          id: string;
          label: string;
          max_amount: number | null;
          min_amount: number | null;
          needs_ceo: boolean;
          needs_dept_head: boolean;
          org_id: string;
          sort_order: number;
          special_category: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          bulk_allowed?: boolean;
          code: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          label: string;
          max_amount?: number | null;
          min_amount?: number | null;
          needs_ceo?: boolean;
          needs_dept_head?: boolean;
          org_id: string;
          sort_order?: number;
          special_category?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          bulk_allowed?: boolean;
          code?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          label?: string;
          max_amount?: number | null;
          min_amount?: number | null;
          needs_ceo?: boolean;
          needs_dept_head?: boolean;
          org_id?: string;
          sort_order?: number;
          special_category?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_approval_tiers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_approval_tiers_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      fin_ref_denial_codes: {
        Row: {
          active: boolean;
          appealable: boolean;
          category: string;
          code: string;
          created_at: string;
          default_owner_role: string;
          description: string;
          is_family: boolean;
          is_placeholder: boolean;
          org_id: string;
          resubmit_days: number | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          appealable?: boolean;
          category?: string;
          code: string;
          created_at?: string;
          default_owner_role?: string;
          description: string;
          is_family?: boolean;
          is_placeholder?: boolean;
          org_id: string;
          resubmit_days?: number | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          appealable?: boolean;
          category?: string;
          code?: string;
          created_at?: string;
          default_owner_role?: string;
          description?: string;
          is_family?: boolean;
          is_placeholder?: boolean;
          org_id?: string;
          resubmit_days?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_denial_codes_org_id_fkey";
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
      fin_ref_finance_settings: {
        Row: {
          acc_budget_variance_pct: number;
          acc_ct_connected_limit: number;
          acc_ct_entertainment_pct: number;
          acc_ct_rate: number;
          acc_ct_sbr_limit: number;
          acc_ct_threshold: number;
          acc_large_journal_amount: number;
          accepted_claim_statuses: string[];
          ageing_bucket_days: number[];
          approval_mode: string;
          bank_amount_tolerance: number;
          bank_amount_tolerance_pct: number;
          bank_auto_accept_score: number;
          bank_cutoff_day: number;
          bank_date_window_days: number;
          bank_weekend_days: number[];
          cashup_variance_tolerance: number;
          change_bulk_approve_max: number;
          change_review_min_amount: number;
          change_review_start_date: string | null;
          close_deadline_wd: number;
          close_inputs_wd: number;
          close_item_max_age_days: number;
          close_receivables_over90_pct: number;
          close_revshare_wd: number;
          close_timetable_start: string | null;
          close_voucher_unpaid_days: number;
          close_weekend_days: number[];
          denial_cases_start_date: string | null;
          denial_default_resubmit_days: number;
          denial_task_enabled: boolean;
          denial_warn_days: number;
          doctor_basis: string | null;
          escalation_days: number;
          escalation_role: string;
          evidence_grace_days: number;
          evidence_start_date: string | null;
          flash_share_basis: string;
          flash_top_doctors: number;
          followup_stage_days: number[];
          followup_start_date: string | null;
          followup_task_due_days: number;
          followup_task_enabled: boolean;
          followup_task_role: string;
          forecast_default_collection_rate: number;
          forecast_default_lag_days: number;
          forecast_horizon_weeks: number;
          forecast_min_history: number;
          forecast_tail_weeks: number;
          lab_date_window_days: number;
          lab_price_tolerance: number;
          org_id: string;
          preauth_expiry_lead_days: number;
          preauth_task_enabled: boolean;
          ready_grace_days: number;
          ready_start_date: string | null;
          recovery_batch_size: number;
          recovery_enabled: boolean;
          recovery_gap_days: number;
          recovery_max_reminders: number;
          recovery_min_balance: number;
          recovery_min_days_overdue: number;
          recovery_template_id: string | null;
          recovery_tone_approved_at: string | null;
          recovery_tone_approved_by: string | null;
          recovery_tone_approved_hash: string | null;
          recovery_variable_map: NonNullable<Json>;
          scorecard_days_to_pay_alert: number;
          scorecard_days_to_pay_warn: number;
          scorecard_denial_rate_alert: number;
          scorecard_denial_rate_warn: number;
          scorecard_min_claims: number;
          short_pay_tolerance_amount: number;
          short_pay_tolerance_pct: number;
          tally_company_name: string | null;
          tally_cost_category: string;
          updated_at: string;
          voucher_duplicate_window_days: number;
          voucher_large_amount: number;
          voucher_mismatch_tolerance: number;
        };
        ComputedFields: never;
        Insert: {
          acc_budget_variance_pct?: number;
          acc_ct_connected_limit?: number;
          acc_ct_entertainment_pct?: number;
          acc_ct_rate?: number;
          acc_ct_sbr_limit?: number;
          acc_ct_threshold?: number;
          acc_large_journal_amount?: number;
          accepted_claim_statuses?: string[];
          ageing_bucket_days?: number[];
          approval_mode?: string;
          bank_amount_tolerance?: number;
          bank_amount_tolerance_pct?: number;
          bank_auto_accept_score?: number;
          bank_cutoff_day?: number;
          bank_date_window_days?: number;
          bank_weekend_days?: number[];
          cashup_variance_tolerance?: number;
          change_bulk_approve_max?: number;
          change_review_min_amount?: number;
          change_review_start_date?: string | null;
          close_deadline_wd?: number;
          close_inputs_wd?: number;
          close_item_max_age_days?: number;
          close_receivables_over90_pct?: number;
          close_revshare_wd?: number;
          close_timetable_start?: string | null;
          close_voucher_unpaid_days?: number;
          close_weekend_days?: number[];
          denial_cases_start_date?: string | null;
          denial_default_resubmit_days?: number;
          denial_task_enabled?: boolean;
          denial_warn_days?: number;
          doctor_basis?: string | null;
          escalation_days?: number;
          escalation_role?: string;
          evidence_grace_days?: number;
          evidence_start_date?: string | null;
          flash_share_basis?: string;
          flash_top_doctors?: number;
          followup_stage_days?: number[];
          followup_start_date?: string | null;
          followup_task_due_days?: number;
          followup_task_enabled?: boolean;
          followup_task_role?: string;
          forecast_default_collection_rate?: number;
          forecast_default_lag_days?: number;
          forecast_horizon_weeks?: number;
          forecast_min_history?: number;
          forecast_tail_weeks?: number;
          lab_date_window_days?: number;
          lab_price_tolerance?: number;
          org_id: string;
          preauth_expiry_lead_days?: number;
          preauth_task_enabled?: boolean;
          ready_grace_days?: number;
          ready_start_date?: string | null;
          recovery_batch_size?: number;
          recovery_enabled?: boolean;
          recovery_gap_days?: number;
          recovery_max_reminders?: number;
          recovery_min_balance?: number;
          recovery_min_days_overdue?: number;
          recovery_template_id?: string | null;
          recovery_tone_approved_at?: string | null;
          recovery_tone_approved_by?: string | null;
          recovery_tone_approved_hash?: string | null;
          recovery_variable_map?: NonNullable<Json>;
          scorecard_days_to_pay_alert?: number;
          scorecard_days_to_pay_warn?: number;
          scorecard_denial_rate_alert?: number;
          scorecard_denial_rate_warn?: number;
          scorecard_min_claims?: number;
          short_pay_tolerance_amount?: number;
          short_pay_tolerance_pct?: number;
          tally_company_name?: string | null;
          tally_cost_category?: string;
          updated_at?: string;
          voucher_duplicate_window_days?: number;
          voucher_large_amount?: number;
          voucher_mismatch_tolerance?: number;
        };
        Update: {
          acc_budget_variance_pct?: number;
          acc_ct_connected_limit?: number;
          acc_ct_entertainment_pct?: number;
          acc_ct_rate?: number;
          acc_ct_sbr_limit?: number;
          acc_ct_threshold?: number;
          acc_large_journal_amount?: number;
          accepted_claim_statuses?: string[];
          ageing_bucket_days?: number[];
          approval_mode?: string;
          bank_amount_tolerance?: number;
          bank_amount_tolerance_pct?: number;
          bank_auto_accept_score?: number;
          bank_cutoff_day?: number;
          bank_date_window_days?: number;
          bank_weekend_days?: number[];
          cashup_variance_tolerance?: number;
          change_bulk_approve_max?: number;
          change_review_min_amount?: number;
          change_review_start_date?: string | null;
          close_deadline_wd?: number;
          close_inputs_wd?: number;
          close_item_max_age_days?: number;
          close_receivables_over90_pct?: number;
          close_revshare_wd?: number;
          close_timetable_start?: string | null;
          close_voucher_unpaid_days?: number;
          close_weekend_days?: number[];
          denial_cases_start_date?: string | null;
          denial_default_resubmit_days?: number;
          denial_task_enabled?: boolean;
          denial_warn_days?: number;
          doctor_basis?: string | null;
          escalation_days?: number;
          escalation_role?: string;
          evidence_grace_days?: number;
          evidence_start_date?: string | null;
          flash_share_basis?: string;
          flash_top_doctors?: number;
          followup_stage_days?: number[];
          followup_start_date?: string | null;
          followup_task_due_days?: number;
          followup_task_enabled?: boolean;
          followup_task_role?: string;
          forecast_default_collection_rate?: number;
          forecast_default_lag_days?: number;
          forecast_horizon_weeks?: number;
          forecast_min_history?: number;
          forecast_tail_weeks?: number;
          lab_date_window_days?: number;
          lab_price_tolerance?: number;
          org_id?: string;
          preauth_expiry_lead_days?: number;
          preauth_task_enabled?: boolean;
          ready_grace_days?: number;
          ready_start_date?: string | null;
          recovery_batch_size?: number;
          recovery_enabled?: boolean;
          recovery_gap_days?: number;
          recovery_max_reminders?: number;
          recovery_min_balance?: number;
          recovery_min_days_overdue?: number;
          recovery_template_id?: string | null;
          recovery_tone_approved_at?: string | null;
          recovery_tone_approved_by?: string | null;
          recovery_tone_approved_hash?: string | null;
          recovery_variable_map?: NonNullable<Json>;
          scorecard_days_to_pay_alert?: number;
          scorecard_days_to_pay_warn?: number;
          scorecard_denial_rate_alert?: number;
          scorecard_denial_rate_warn?: number;
          scorecard_min_claims?: number;
          short_pay_tolerance_amount?: number;
          short_pay_tolerance_pct?: number;
          tally_company_name?: string | null;
          tally_cost_category?: string;
          updated_at?: string;
          voucher_duplicate_window_days?: number;
          voucher_large_amount?: number;
          voucher_mismatch_tolerance?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_finance_settings_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: true;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_finance_settings_recovery_template_id_fkey";
            columns: ["recovery_template_id"];
            isOneToOne: false;
            referencedRelation: "wa_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_finance_settings_recovery_tone_approved_by_fkey";
            columns: ["recovery_tone_approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_holidays: {
        Row: {
          created_at: string;
          created_by: string | null;
          holiday_on: string;
          id: string;
          name: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          holiday_on: string;
          id?: string;
          name: string;
          org_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          holiday_on?: string;
          id?: string;
          name?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_holidays_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_holidays_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_payer_prices: {
        Row: {
          agreed_price: number;
          cpt_code: string;
          created_at: string;
          effective_from: string;
          effective_to: string | null;
          id: string;
          org_id: string;
          payer_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agreed_price: number;
          cpt_code: string;
          created_at?: string;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          org_id: string;
          payer_id: string;
          updated_at?: string;
        };
        Update: {
          agreed_price?: number;
          cpt_code?: string;
          created_at?: string;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          org_id?: string;
          payer_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_payer_prices_org_id_fkey";
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
      fin_ref_provider_tests: {
        Row: {
          agreed_price: number | null;
          code: string;
          created_at: string;
          expected_days: number | null;
          id: string;
          org_id: string;
          provider_id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          agreed_price?: number | null;
          code: string;
          created_at?: string;
          expected_days?: number | null;
          id?: string;
          org_id: string;
          provider_id: string;
          updated_at?: string;
        };
        Update: {
          agreed_price?: number | null;
          code?: string;
          created_at?: string;
          expected_days?: number | null;
          id?: string;
          org_id?: string;
          provider_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_provider_tests_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_provider_tests_provider_id_fkey";
            columns: ["provider_id"];
            isOneToOne: false;
            referencedRelation: "fin_providers";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_report_lines: {
        Row: {
          active: boolean;
          code: string;
          created_at: string;
          created_by: string | null;
          id: string;
          in_core: boolean;
          label: string;
          match_kind: string;
          match_values: string[];
          org_id: string;
          sort_order: number;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          code: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          in_core?: boolean;
          label: string;
          match_kind: string;
          match_values: string[];
          org_id: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          code?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          in_core?: boolean;
          label?: string;
          match_kind?: string;
          match_values?: string[];
          org_id?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_report_lines_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_report_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_revenue_targets: {
        Row: {
          arpp: number | null;
          created_at: string;
          created_by: string | null;
          daily_patients: number | null;
          daily_revenue: number | null;
          id: string;
          line_code: string | null;
          month: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          arpp?: number | null;
          created_at?: string;
          created_by?: string | null;
          daily_patients?: number | null;
          daily_revenue?: number | null;
          id?: string;
          line_code?: string | null;
          month: string;
          org_id: string;
        };
        Update: {
          arpp?: number | null;
          created_at?: string;
          created_by?: string | null;
          daily_patients?: number | null;
          daily_revenue?: number | null;
          id?: string;
          line_code?: string | null;
          month?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_revenue_targets_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_revenue_targets_org_id_fkey";
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
          requires_preauth: boolean;
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
          requires_preauth?: boolean;
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
          requires_preauth?: boolean;
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
      fin_ref_settlement_rules: {
        Row: {
          account_id: string | null;
          created_at: string;
          created_by: string | null;
          fee_pct: number | null;
          id: string;
          lag_days: number | null;
          org_id: string;
          payment_mode: string;
          settles_to_bank: boolean;
          source: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          fee_pct?: number | null;
          id?: string;
          lag_days?: number | null;
          org_id: string;
          payment_mode: string;
          settles_to_bank?: boolean;
          source?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          fee_pct?: number | null;
          id?: string;
          lag_days?: number | null;
          org_id?: string;
          payment_mode?: string;
          settles_to_bank?: boolean;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_settlement_rules_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_settlement_rules_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_settlement_rules_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_ref_tally_ledgers: {
        Row: {
          key: string;
          kind: string;
          ledger_name: string;
          org_id: string;
          updated_at: string;
          updated_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          key: string;
          kind: string;
          ledger_name: string;
          org_id: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          key?: string;
          kind?: string;
          ledger_name?: string;
          org_id?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_ref_tally_ledgers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_ref_tally_ledgers_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_revshare_lines: {
        Row: {
          created_at: string;
          doctor_dha_id: string;
          id: string;
          org_id: string;
          paid_by: string | null;
          paid_on: string | null;
          paid_recorded_at: string | null;
          payment_ref: string | null;
          payout: number;
          run_id: string;
          scheme_id: string;
          scheme_version: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          doctor_dha_id: string;
          id?: string;
          org_id: string;
          paid_by?: string | null;
          paid_on?: string | null;
          paid_recorded_at?: string | null;
          payment_ref?: string | null;
          payout: number;
          run_id: string;
          scheme_id: string;
          scheme_version: number;
        };
        Update: {
          created_at?: string;
          doctor_dha_id?: string;
          id?: string;
          org_id?: string;
          paid_by?: string | null;
          paid_on?: string | null;
          paid_recorded_at?: string | null;
          payment_ref?: string | null;
          payout?: number;
          run_id?: string;
          scheme_id?: string;
          scheme_version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_revshare_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_lines_paid_by_fkey";
            columns: ["paid_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_lines_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "fin_revshare_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_revshare_runs: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          built_at: string;
          built_by: string | null;
          created_at: string;
          id: string;
          month: string;
          org_id: string;
          paid_at: string | null;
          posted_at: string | null;
          posted_by: string | null;
          posted_ref: string | null;
          snapshot: NonNullable<Json>;
          snapshot_hash: string;
          status: string;
          total_payout: number;
          updated_at: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          built_at?: string;
          built_by?: string | null;
          created_at?: string;
          id?: string;
          month: string;
          org_id: string;
          paid_at?: string | null;
          posted_at?: string | null;
          posted_by?: string | null;
          posted_ref?: string | null;
          snapshot: NonNullable<Json>;
          snapshot_hash: string;
          status?: string;
          total_payout?: number;
          updated_at?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          built_at?: string;
          built_by?: string | null;
          created_at?: string;
          id?: string;
          month?: string;
          org_id?: string;
          paid_at?: string | null;
          posted_at?: string | null;
          posted_by?: string | null;
          posted_ref?: string | null;
          snapshot?: NonNullable<Json>;
          snapshot_hash?: string;
          status?: string;
          total_payout?: number;
          updated_at?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_revshare_runs_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_runs_built_by_fkey";
            columns: ["built_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_runs_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_runs_posted_by_fkey";
            columns: ["posted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_runs_verified_by_fkey";
            columns: ["verified_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_revshare_schemes: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          created_at: string;
          created_by: string | null;
          doctor_dha_id: string;
          effective_from: string;
          id: string;
          note: string | null;
          org_id: string;
          retired_at: string | null;
          retired_by: string | null;
          rule: NonNullable<Json>;
          rule_hash: string;
          status: string;
          updated_at: string;
          verified_at: string | null;
          verified_by: string | null;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          doctor_dha_id: string;
          effective_from: string;
          id?: string;
          note?: string | null;
          org_id: string;
          retired_at?: string | null;
          retired_by?: string | null;
          rule: NonNullable<Json>;
          rule_hash: string;
          status?: string;
          updated_at?: string;
          verified_at?: string | null;
          verified_by?: string | null;
          version: number;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          doctor_dha_id?: string;
          effective_from?: string;
          id?: string;
          note?: string | null;
          org_id?: string;
          retired_at?: string | null;
          retired_by?: string | null;
          rule?: NonNullable<Json>;
          rule_hash?: string;
          status?: string;
          updated_at?: string;
          verified_at?: string | null;
          verified_by?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_revshare_schemes_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_schemes_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_schemes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_schemes_retired_by_fkey";
            columns: ["retired_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_revshare_schemes_verified_by_fkey";
            columns: ["verified_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_sealed_documents: {
        Row: {
          bound_sha256: string;
          doc_id: string;
          doc_kind: string;
          id: string;
          org_id: string;
          pdf: string;
          pdf_sha256: string | null;
          seal_fingerprint: string;
          seal_subject: string;
          sealed_at: string;
          sealed_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          bound_sha256: string;
          doc_id: string;
          doc_kind: string;
          id?: string;
          org_id: string;
          pdf: string;
          pdf_sha256?: never;
          seal_fingerprint: string;
          seal_subject: string;
          sealed_at?: string;
          sealed_by?: string | null;
        };
        Update: {
          bound_sha256?: string;
          doc_id?: string;
          doc_kind?: string;
          id?: string;
          org_id?: string;
          pdf?: string;
          pdf_sha256?: never;
          seal_fingerprint?: string;
          seal_subject?: string;
          sealed_at?: string;
          sealed_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fin_sealed_documents_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_sealed_documents_sealed_by_fkey";
            columns: ["sealed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_settlement_lines: {
        Row: {
          created_at: string;
          fee: number;
          gross: number;
          id: string;
          import_id: string;
          net: number;
          org_id: string;
          payment_mode: string;
          reference: string | null;
          row_no: number;
          settlement_date: string;
          txn_date: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          fee?: number;
          gross: number;
          id?: string;
          import_id: string;
          net: number;
          org_id: string;
          payment_mode: string;
          reference?: string | null;
          row_no: number;
          settlement_date: string;
          txn_date: string;
        };
        Update: {
          created_at?: string;
          fee?: number;
          gross?: number;
          id?: string;
          import_id?: string;
          net?: number;
          org_id?: string;
          payment_mode?: string;
          reference?: string | null;
          row_no?: number;
          settlement_date?: string;
          txn_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_settlement_lines_import_id_fkey";
            columns: ["import_id"];
            isOneToOne: false;
            referencedRelation: "fin_bank_imports";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_settlement_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_signing_certificates: {
        Row: {
          created_at: string;
          fingerprint_sha256: string;
          id: string;
          issuer: string;
          issuer_cn: string | null;
          org_id: string;
          p12_enc: string | null;
          revoked_at: string | null;
          serial_hex: string;
          subject: string;
          subject_cn: string | null;
          user_id: string;
          valid_from: string;
          valid_to: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          fingerprint_sha256: string;
          id?: string;
          issuer: string;
          issuer_cn?: string | null;
          org_id: string;
          p12_enc?: string | null;
          revoked_at?: string | null;
          serial_hex: string;
          subject: string;
          subject_cn?: string | null;
          user_id: string;
          valid_from: string;
          valid_to: string;
        };
        Update: {
          created_at?: string;
          fingerprint_sha256?: string;
          id?: string;
          issuer?: string;
          issuer_cn?: string | null;
          org_id?: string;
          p12_enc?: string | null;
          revoked_at?: string | null;
          serial_hex?: string;
          subject?: string;
          subject_cn?: string | null;
          user_id?: string;
          valid_from?: string;
          valid_to?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_signing_certificates_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_signing_certificates_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_staged_remittance_lines: {
        Row: {
          created_at: string;
          data: NonNullable<Json>;
          file_id: string;
          id: string;
          org_id: string;
          row_no: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          data: NonNullable<Json>;
          file_id: string;
          id?: string;
          org_id: string;
          row_no: number;
        };
        Update: {
          created_at?: string;
          data?: NonNullable<Json>;
          file_id?: string;
          id?: string;
          org_id?: string;
          row_no?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_staged_remittance_lines_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_remittance_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_staged_remittance_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_supplier_invoices: {
        Row: {
          branch_code: string | null;
          category: string;
          cost_centre: string | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          doctor_dha_id: string | null;
          document_id: string | null;
          due_date: string | null;
          id: string;
          invoice_date: string;
          invoice_number: string;
          net: number;
          org_id: string;
          paid_amount: number;
          status: string;
          supplier_id: string;
          tally_export_id: string | null;
          tally_exported_at: string | null;
          total: number | null;
          updated_at: string;
          vat: number;
        };
        ComputedFields: never;
        Insert: {
          branch_code?: string | null;
          category: string;
          cost_centre?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          doctor_dha_id?: string | null;
          document_id?: string | null;
          due_date?: string | null;
          id?: string;
          invoice_date: string;
          invoice_number: string;
          net: number;
          org_id: string;
          paid_amount?: number;
          status?: string;
          supplier_id: string;
          tally_export_id?: string | null;
          tally_exported_at?: string | null;
          total?: never;
          updated_at?: string;
          vat?: number;
        };
        Update: {
          branch_code?: string | null;
          category?: string;
          cost_centre?: string | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          doctor_dha_id?: string | null;
          document_id?: string | null;
          due_date?: string | null;
          id?: string;
          invoice_date?: string;
          invoice_number?: string;
          net?: number;
          org_id?: string;
          paid_amount?: number;
          status?: string;
          supplier_id?: string;
          tally_export_id?: string | null;
          tally_exported_at?: string | null;
          total?: never;
          updated_at?: string;
          vat?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_supplier_invoices_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_supplier_invoices_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "fin_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_supplier_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_supplier_invoices_supplier_id_fkey";
            columns: ["supplier_id"];
            isOneToOne: false;
            referencedRelation: "fin_suppliers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_supplier_invoices_tally_export_id_fkey";
            columns: ["tally_export_id"];
            isOneToOne: false;
            referencedRelation: "fin_tally_exports";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_suppliers: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          default_category: string | null;
          id: string;
          name: string;
          org_id: string;
          payment_terms_days: number | null;
          trn: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          default_category?: string | null;
          id?: string;
          name: string;
          org_id: string;
          payment_terms_days?: number | null;
          trn?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          default_category?: string | null;
          id?: string;
          name?: string;
          org_id?: string;
          payment_terms_days?: number | null;
          trn?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_suppliers_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_suppliers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_tally_exports: {
        Row: {
          checksum: string;
          created_at: string;
          exported_by: string | null;
          id: string;
          invoice_count: number;
          org_id: string;
          total_amount: number;
          voucher_count: number;
          xml: string;
        };
        ComputedFields: never;
        Insert: {
          checksum: string;
          created_at?: string;
          exported_by?: string | null;
          id?: string;
          invoice_count: number;
          org_id: string;
          total_amount?: number;
          voucher_count: number;
          xml: string;
        };
        Update: {
          checksum?: string;
          created_at?: string;
          exported_by?: string | null;
          id?: string;
          invoice_count?: number;
          org_id?: string;
          total_amount?: number;
          voucher_count?: number;
          xml?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_tally_exports_exported_by_fkey";
            columns: ["exported_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_tally_exports_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_voucher_counters: {
        Row: {
          last_no: number;
          org_id: string;
          year: number;
        };
        ComputedFields: never;
        Insert: {
          last_no?: number;
          org_id: string;
          year: number;
        };
        Update: {
          last_no?: number;
          org_id?: string;
          year?: number;
        };
        Relationships: [
          {
            foreignKeyName: "fin_voucher_counters_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_voucher_documents: {
        Row: {
          added_by: string | null;
          created_at: string;
          document_id: string;
          org_id: string;
          voucher_id: string;
        };
        ComputedFields: never;
        Insert: {
          added_by?: string | null;
          created_at?: string;
          document_id: string;
          org_id: string;
          voucher_id: string;
        };
        Update: {
          added_by?: string | null;
          created_at?: string;
          document_id?: string;
          org_id?: string;
          voucher_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_voucher_documents_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_documents_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "fin_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_documents_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_documents_voucher_id_fkey";
            columns: ["voucher_id"];
            isOneToOne: false;
            referencedRelation: "fin_payment_vouchers";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_voucher_events: {
        Row: {
          action: string;
          actor_id: string | null;
          at: string;
          content_sha256: string | null;
          from_status: string | null;
          id: number;
          org_id: string;
          remarks: string | null;
          to_status: string | null;
          voucher_id: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_id?: string | null;
          at?: string;
          content_sha256?: string | null;
          from_status?: string | null;
          id?: never;
          org_id: string;
          remarks?: string | null;
          to_status?: string | null;
          voucher_id: string;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          at?: string;
          content_sha256?: string | null;
          from_status?: string | null;
          id?: never;
          org_id?: string;
          remarks?: string | null;
          to_status?: string | null;
          voucher_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_voucher_events_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_events_voucher_id_fkey";
            columns: ["voucher_id"];
            isOneToOne: false;
            referencedRelation: "fin_payment_vouchers";
            referencedColumns: ["id"];
          },
        ];
      };
      fin_voucher_invoices: {
        Row: {
          created_at: string;
          org_id: string;
          paid_amount: number | null;
          supplier_invoice_id: string;
          voucher_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          org_id: string;
          paid_amount?: number | null;
          supplier_invoice_id: string;
          voucher_id: string;
        };
        Update: {
          created_at?: string;
          org_id?: string;
          paid_amount?: number | null;
          supplier_invoice_id?: string;
          voucher_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fin_voucher_invoices_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_invoices_supplier_invoice_id_fkey";
            columns: ["supplier_invoice_id"];
            isOneToOne: false;
            referencedRelation: "fin_supplier_invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fin_voucher_invoices_voucher_id_fkey";
            columns: ["voucher_id"];
            isOneToOne: false;
            referencedRelation: "fin_payment_vouchers";
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
            referencedRelation: "v_conversation_engagement";
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
          ai_drafted_at: string | null;
          ai_review_required: boolean;
          ai_reviewed_at: string | null;
          ai_reviewed_by: string | null;
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
          ai_drafted_at?: string | null;
          ai_review_required?: boolean;
          ai_reviewed_at?: string | null;
          ai_reviewed_by?: string | null;
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
          ai_drafted_at?: string | null;
          ai_review_required?: boolean;
          ai_reviewed_at?: string | null;
          ai_reviewed_by?: string | null;
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
            foreignKeyName: "flows_ai_reviewed_by_fkey";
            columns: ["ai_reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
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
      gcal_connections: {
        Row: {
          access_enc: string | null;
          access_expires_at: string | null;
          calendar_id: string;
          connected_at: string;
          connected_by: string | null;
          consecutive_failures: number;
          created_at: string;
          id: string;
          last_error: string | null;
          last_pull_at: string | null;
          last_push_at: string | null;
          next_sync_at: string;
          org_id: string;
          refresh_enc: string | null;
          revoked_at: string | null;
          specialist_id: string;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          access_enc?: string | null;
          access_expires_at?: string | null;
          calendar_id?: string;
          connected_at?: string;
          connected_by?: string | null;
          consecutive_failures?: number;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          last_pull_at?: string | null;
          last_push_at?: string | null;
          next_sync_at?: string;
          org_id: string;
          refresh_enc?: string | null;
          revoked_at?: string | null;
          specialist_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          access_enc?: string | null;
          access_expires_at?: string | null;
          calendar_id?: string;
          connected_at?: string;
          connected_by?: string | null;
          consecutive_failures?: number;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          last_pull_at?: string | null;
          last_push_at?: string | null;
          next_sync_at?: string;
          org_id?: string;
          refresh_enc?: string | null;
          revoked_at?: string | null;
          specialist_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "gcal_connections_connected_by_fkey";
            columns: ["connected_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_connections_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_connections_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      gcal_event_links: {
        Row: {
          appointment_id: string | null;
          connection_id: string;
          created_at: string;
          event_id: string;
          id: string;
          last_synced_at: string;
          org_id: string;
          status: string;
          synced_hash: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          connection_id: string;
          created_at?: string;
          event_id: string;
          id?: string;
          last_synced_at?: string;
          org_id: string;
          status?: string;
          synced_hash: string;
        };
        Update: {
          appointment_id?: string | null;
          connection_id?: string;
          created_at?: string;
          event_id?: string;
          id?: string;
          last_synced_at?: string;
          org_id?: string;
          status?: string;
          synced_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "gcal_event_links_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_event_links_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_event_links_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "gcal_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_event_links_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      gcal_oauth_states: {
        Row: {
          created_at: string;
          expires_at: string;
          org_id: string;
          specialist_id: string;
          state_hash: string;
          used_at: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          expires_at: string;
          org_id: string;
          specialist_id: string;
          state_hash: string;
          used_at?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string;
          org_id?: string;
          specialist_id?: string;
          state_hash?: string;
          used_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "gcal_oauth_states_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_oauth_states_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gcal_oauth_states_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      handover_notes: {
        Row: {
          body: string;
          created_at: string;
          created_by: string | null;
          id: string;
          location_id: string | null;
          org_id: string;
          pinned: boolean;
          resolved_at: string | null;
          resolved_by: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string | null;
          org_id: string;
          pinned?: boolean;
          resolved_at?: string | null;
          resolved_by?: string | null;
          updated_at?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string | null;
          org_id?: string;
          pinned?: boolean;
          resolved_at?: string | null;
          resolved_by?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "handover_notes_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "handover_notes_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "handover_notes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "handover_notes_resolved_by_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      help_feedback: {
        Row: {
          created_at: string;
          id: string;
          kind: string;
          message: string;
          org_id: string;
          page: string;
          status: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          kind?: string;
          message: string;
          org_id: string;
          page: string;
          status?: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: string;
          message?: string;
          org_id?: string;
          page?: string;
          status?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "help_feedback_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "help_feedback_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      household_links: {
        Row: {
          created_at: string;
          created_by: string | null;
          dependant_contact_id: string;
          guardian_contact_id: string;
          id: string;
          org_id: string;
          relationship: string;
          reminders_to_guardian: boolean;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          dependant_contact_id: string;
          guardian_contact_id: string;
          id?: string;
          org_id: string;
          relationship?: string;
          reminders_to_guardian?: boolean;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          dependant_contact_id?: string;
          guardian_contact_id?: string;
          id?: string;
          org_id?: string;
          relationship?: string;
          reminders_to_guardian?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "household_links_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "household_links_dependant_contact_id_fkey";
            columns: ["dependant_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "household_links_dependant_contact_id_fkey";
            columns: ["dependant_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "household_links_dependant_contact_id_fkey";
            columns: ["dependant_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "household_links_guardian_contact_id_fkey";
            columns: ["guardian_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "household_links_guardian_contact_id_fkey";
            columns: ["guardian_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "household_links_guardian_contact_id_fkey";
            columns: ["guardian_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "household_links_org_id_fkey";
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
      ins_appeal_drafts: {
        Row: {
          body: string;
          case_id: string;
          created_at: string;
          created_by: string | null;
          flags: string[];
          id: string;
          kind: string;
          language: string;
          marked_sent_at: string | null;
          marked_sent_by: string | null;
          model: string | null;
          org_id: string;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          body: string;
          case_id: string;
          created_at?: string;
          created_by?: string | null;
          flags?: string[];
          id?: string;
          kind: string;
          language?: string;
          marked_sent_at?: string | null;
          marked_sent_by?: string | null;
          model?: string | null;
          org_id: string;
          status?: string;
        };
        Update: {
          body?: string;
          case_id?: string;
          created_at?: string;
          created_by?: string | null;
          flags?: string[];
          id?: string;
          kind?: string;
          language?: string;
          marked_sent_at?: string | null;
          marked_sent_by?: string | null;
          model?: string | null;
          org_id?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ins_appeal_drafts_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "ins_denial_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_appeal_drafts_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_appeal_drafts_marked_sent_by_fkey";
            columns: ["marked_sent_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_appeal_drafts_org_id_fkey";
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
      ins_claim_followup_stages: {
        Row: {
          assignee_id: string | null;
          claim_activity_id: string;
          created_at: string;
          crossed_on: string;
          id: string;
          org_id: string;
          stage: number;
          superseded: boolean;
          task_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          assignee_id?: string | null;
          claim_activity_id: string;
          created_at?: string;
          crossed_on: string;
          id?: string;
          org_id: string;
          stage: number;
          superseded?: boolean;
          task_id?: string | null;
        };
        Update: {
          assignee_id?: string | null;
          claim_activity_id?: string;
          created_at?: string;
          crossed_on?: string;
          id?: string;
          org_id?: string;
          stage?: number;
          superseded?: boolean;
          task_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ins_claim_followup_stages_assignee_id_fkey";
            columns: ["assignee_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_followup_stages_claim_activity_id_fkey";
            columns: ["claim_activity_id"];
            isOneToOne: false;
            referencedRelation: "ins_claim_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_followup_stages_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_followup_stages_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_claim_followups: {
        Row: {
          claim_activity_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          next_action_date: string | null;
          note: string | null;
          org_id: string;
          outcome: string;
          stage: number | null;
        };
        ComputedFields: never;
        Insert: {
          claim_activity_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          next_action_date?: string | null;
          note?: string | null;
          org_id: string;
          outcome: string;
          stage?: number | null;
        };
        Update: {
          claim_activity_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          next_action_date?: string | null;
          note?: string | null;
          org_id?: string;
          outcome?: string;
          stage?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "ins_claim_followups_claim_activity_id_fkey";
            columns: ["claim_activity_id"];
            isOneToOne: false;
            referencedRelation: "ins_claim_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_followups_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_claim_followups_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_denial_cases: {
        Row: {
          appealable: boolean;
          category: string;
          claim_activity_id: string;
          claim_net: number | null;
          claim_number: string;
          clinician_id: string | null;
          cpt_code: string | null;
          created_at: string;
          deadline_notified_at: string | null;
          deadline_on: string;
          denied_on: string;
          id: string;
          invoice_no: string | null;
          opened_by: string | null;
          org_id: string;
          owner_role: string;
          owner_user_id: string | null;
          payer_id: string | null;
          reason_code: string | null;
          rejected_amount: number;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: string;
          task_id: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appealable?: boolean;
          category?: string;
          claim_activity_id: string;
          claim_net?: number | null;
          claim_number: string;
          clinician_id?: string | null;
          cpt_code?: string | null;
          created_at?: string;
          deadline_notified_at?: string | null;
          deadline_on: string;
          denied_on: string;
          id?: string;
          invoice_no?: string | null;
          opened_by?: string | null;
          org_id: string;
          owner_role?: string;
          owner_user_id?: string | null;
          payer_id?: string | null;
          reason_code?: string | null;
          rejected_amount?: number;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          task_id?: string | null;
          updated_at?: string;
        };
        Update: {
          appealable?: boolean;
          category?: string;
          claim_activity_id?: string;
          claim_net?: number | null;
          claim_number?: string;
          clinician_id?: string | null;
          cpt_code?: string | null;
          created_at?: string;
          deadline_notified_at?: string | null;
          deadline_on?: string;
          denied_on?: string;
          id?: string;
          invoice_no?: string | null;
          opened_by?: string | null;
          org_id?: string;
          owner_role?: string;
          owner_user_id?: string | null;
          payer_id?: string | null;
          reason_code?: string | null;
          rejected_amount?: number;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          task_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ins_denial_cases_claim_activity_id_fkey";
            columns: ["claim_activity_id"];
            isOneToOne: false;
            referencedRelation: "ins_claim_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_cases_opened_by_fkey";
            columns: ["opened_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_cases_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_cases_owner_user_id_fkey";
            columns: ["owner_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_cases_resolved_by_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_cases_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_denial_notes: {
        Row: {
          case_id: string;
          created_at: string;
          id: string;
          note: string;
          org_id: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          case_id: string;
          created_at?: string;
          id?: string;
          note: string;
          org_id: string;
          user_id?: string | null;
        };
        Update: {
          case_id?: string;
          created_at?: string;
          id?: string;
          note?: string;
          org_id?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ins_denial_notes_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "ins_denial_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_notes_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_denial_notes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_remittance_batches: {
        Row: {
          created_at: string;
          created_by: string | null;
          file_id: string | null;
          id: string;
          line_count: number;
          matched_count: number;
          org_id: string;
          paid_on: string | null;
          payer_id: string | null;
          remittance_ref: string | null;
          short_count: number;
          sum_expected: number;
          sum_paid: number;
          sum_short: number;
          unmatched_count: number;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          file_id?: string | null;
          id?: string;
          line_count?: number;
          matched_count?: number;
          org_id: string;
          paid_on?: string | null;
          payer_id?: string | null;
          remittance_ref?: string | null;
          short_count?: number;
          sum_expected?: number;
          sum_paid?: number;
          sum_short?: number;
          unmatched_count?: number;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          file_id?: string | null;
          id?: string;
          line_count?: number;
          matched_count?: number;
          org_id?: string;
          paid_on?: string | null;
          payer_id?: string | null;
          remittance_ref?: string | null;
          short_count?: number;
          sum_expected?: number;
          sum_paid?: number;
          sum_short?: number;
          unmatched_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ins_remittance_batches_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_remittance_batches_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "fin_raw_remittance_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_remittance_batches_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      ins_remittance_lines: {
        Row: {
          batch_id: string;
          claim_activity_id: string | null;
          claim_activity_number: string | null;
          claimed_amount: number | null;
          cpt_code: string | null;
          created_at: string;
          denial_code: string | null;
          denied_amount: number;
          expected_amount: number | null;
          expected_basis: string;
          flags: string[];
          id: string;
          invoice_no: string | null;
          line_key: string;
          match_reason: string | null;
          match_status: string;
          org_id: string;
          paid_amount: number;
          paid_on: string | null;
          payer_id: string | null;
          quantity: number | null;
          remittance_ref: string | null;
          review_note: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          row_no: number;
          short_amount: number;
        };
        ComputedFields: never;
        Insert: {
          batch_id: string;
          claim_activity_id?: string | null;
          claim_activity_number?: string | null;
          claimed_amount?: number | null;
          cpt_code?: string | null;
          created_at?: string;
          denial_code?: string | null;
          denied_amount?: number;
          expected_amount?: number | null;
          expected_basis?: string;
          flags?: string[];
          id?: string;
          invoice_no?: string | null;
          line_key: string;
          match_reason?: string | null;
          match_status: string;
          org_id: string;
          paid_amount?: number;
          paid_on?: string | null;
          payer_id?: string | null;
          quantity?: number | null;
          remittance_ref?: string | null;
          review_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          row_no: number;
          short_amount?: number;
        };
        Update: {
          batch_id?: string;
          claim_activity_id?: string | null;
          claim_activity_number?: string | null;
          claimed_amount?: number | null;
          cpt_code?: string | null;
          created_at?: string;
          denial_code?: string | null;
          denied_amount?: number;
          expected_amount?: number | null;
          expected_basis?: string;
          flags?: string[];
          id?: string;
          invoice_no?: string | null;
          line_key?: string;
          match_reason?: string | null;
          match_status?: string;
          org_id?: string;
          paid_amount?: number;
          paid_on?: string | null;
          payer_id?: string | null;
          quantity?: number | null;
          remittance_ref?: string | null;
          review_note?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          row_no?: number;
          short_amount?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ins_remittance_lines_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "ins_remittance_batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_remittance_lines_claim_activity_id_fkey";
            columns: ["claim_activity_id"];
            isOneToOne: false;
            referencedRelation: "ins_claim_activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_remittance_lines_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ins_remittance_lines_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
          credentials_set_at: string | null;
          enabled: boolean;
          enabled_at: string | null;
          enabled_by: string | null;
          id: string;
          kind: string;
          last_error: string | null;
          last_error_at: string | null;
          last_ok_at: string | null;
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
          credentials_set_at?: string | null;
          enabled?: boolean;
          enabled_at?: string | null;
          enabled_by?: string | null;
          id?: string;
          kind: string;
          last_error?: string | null;
          last_error_at?: string | null;
          last_ok_at?: string | null;
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
          credentials_set_at?: string | null;
          enabled?: boolean;
          enabled_at?: string | null;
          enabled_by?: string | null;
          id?: string;
          kind?: string;
          last_error?: string | null;
          last_error_at?: string | null;
          last_ok_at?: string | null;
          org_id?: string;
          status?: string;
          token_expires_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_accounts_enabled_by_fkey";
            columns: ["enabled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integration_accounts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_calls: {
        Row: {
          at: string;
          attempt: number;
          duration_ms: number | null;
          http_status: number | null;
          id: number;
          operation: string;
          org_id: string;
          outcome: string;
          provider: string;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          attempt?: number;
          duration_ms?: number | null;
          http_status?: number | null;
          id?: never;
          operation: string;
          org_id: string;
          outcome: string;
          provider: string;
        };
        Update: {
          at?: string;
          attempt?: number;
          duration_ms?: number | null;
          http_status?: number | null;
          id?: never;
          operation?: string;
          org_id?: string;
          outcome?: string;
          provider?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_calls_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_usage_daily: {
        Row: {
          day: string;
          metric: string;
          org_id: string;
          provider: string;
          value: number;
        };
        ComputedFields: never;
        Insert: {
          day: string;
          metric: string;
          org_id: string;
          provider: string;
          value?: number;
        };
        Update: {
          day?: string;
          metric?: string;
          org_id?: string;
          provider?: string;
          value?: number;
        };
        Relationships: [
          {
            foreignKeyName: "integration_usage_daily_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_webhook_events: {
        Row: {
          event_key: string;
          id: number;
          org_id: string;
          outcome: string | null;
          provider: string;
          received_at: string;
        };
        ComputedFields: never;
        Insert: {
          event_key: string;
          id?: never;
          org_id: string;
          outcome?: string | null;
          provider: string;
          received_at?: string;
        };
        Update: {
          event_key?: string;
          id?: never;
          org_id?: string;
          outcome?: string | null;
          provider?: string;
          received_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_webhook_events_org_id_fkey";
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
            referencedRelation: "v_conversation_engagement";
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
          branch_code: string | null;
          active: boolean;
          address: string | null;
          created_at: string;
          external_id: string | null;
          id: string;
          latitude: number | null;
          longitude: number | null;
          maps_url: string | null;
          name: string;
          org_id: string;
          photo_path: string | null;
          review_url: string | null;
          timezone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          branch_code?: string | null;
          active?: boolean;
          address?: string | null;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          latitude?: number | null;
          longitude?: number | null;
          maps_url?: string | null;
          name: string;
          org_id: string;
          photo_path?: string | null;
          review_url?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          branch_code?: string | null;
          active?: boolean;
          address?: string | null;
          created_at?: string;
          external_id?: string | null;
          id?: string;
          latitude?: number | null;
          longitude?: number | null;
          maps_url?: string | null;
          name?: string;
          org_id?: string;
          photo_path?: string | null;
          review_url?: string | null;
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
      media_assets: {
        Row: {
          created_at: string;
          folder_id: string | null;
          height: number | null;
          id: string;
          kind: string;
          mime_type: string;
          name: string;
          org_id: string;
          original_size_bytes: number | null;
          scan_engine: string | null;
          scan_status: string;
          scanned_at: string | null;
          size_bytes: number;
          status: string;
          storage_path: string;
          tags: string[];
          thumb_path: string | null;
          updated_at: string;
          uploaded_by: string | null;
          width: number | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          folder_id?: string | null;
          height?: number | null;
          id?: string;
          kind: string;
          mime_type: string;
          name: string;
          org_id: string;
          original_size_bytes?: number | null;
          scan_engine?: string | null;
          scan_status?: string;
          scanned_at?: string | null;
          size_bytes: number;
          status?: string;
          storage_path: string;
          tags?: string[];
          thumb_path?: string | null;
          updated_at?: string;
          uploaded_by?: string | null;
          width?: number | null;
        };
        Update: {
          created_at?: string;
          folder_id?: string | null;
          height?: number | null;
          id?: string;
          kind?: string;
          mime_type?: string;
          name?: string;
          org_id?: string;
          original_size_bytes?: number | null;
          scan_engine?: string | null;
          scan_status?: string;
          scanned_at?: string | null;
          size_bytes?: number;
          status?: string;
          storage_path?: string;
          tags?: string[];
          thumb_path?: string | null;
          updated_at?: string;
          uploaded_by?: string | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "media_assets_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "media_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "media_assets_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "media_assets_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      media_folders: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name: string;
          org_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "media_folders_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "media_folders_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      member_presence_events: {
        Row: {
          at: string;
          id: number;
          org_id: string;
          presence: string;
          previous: string | null;
          source: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          at?: string;
          id?: never;
          org_id: string;
          presence: string;
          previous?: string | null;
          source: string;
          user_id: string;
        };
        Update: {
          at?: string;
          id?: never;
          org_id?: string;
          presence?: string;
          previous?: string | null;
          source?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "member_presence_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      membership_locations: {
        Row: {
          created_at: string;
          location_id: string;
          membership_id: string;
          org_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          location_id: string;
          membership_id: string;
          org_id: string;
        };
        Update: {
          created_at?: string;
          location_id?: string;
          membership_id?: string;
          org_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "membership_locations_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "membership_locations_membership_id_fkey";
            columns: ["membership_id"];
            isOneToOne: false;
            referencedRelation: "memberships";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "membership_locations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      memberships: {
        Row: {
          branch_scope: string;
          created_at: string;
          enquiry_scope: string;
          home_location_id: string | null;
          id: string;
          last_seen_at: string | null;
          max_open_conversations: number | null;
          org_id: string;
          presence: string;
          presence_at: string | null;
          presence_auto: boolean;
          role_id: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          branch_scope?: string;
          created_at?: string;
          enquiry_scope?: string;
          home_location_id?: string | null;
          id?: string;
          last_seen_at?: string | null;
          max_open_conversations?: number | null;
          org_id: string;
          presence?: string;
          presence_at?: string | null;
          presence_auto?: boolean;
          role_id: string;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          branch_scope?: string;
          created_at?: string;
          enquiry_scope?: string;
          home_location_id?: string | null;
          id?: string;
          last_seen_at?: string | null;
          max_open_conversations?: number | null;
          org_id?: string;
          presence?: string;
          presence_at?: string | null;
          presence_auto?: boolean;
          role_id?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "memberships_home_location_id_fkey";
            columns: ["home_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
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
            referencedRelation: "v_conversation_engagement";
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
            foreignKeyName: "mentions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
          flow_step_key: string | null;
          id: string;
          kind: string;
          media_filename: string | null;
          media_meta_id: string | null;
          media_mime: string | null;
          media_path: string | null;
          org_id: string;
          payload: NonNullable<Json>;
          reply_to_wa_message_id: string | null;
          retry_of_message_id: string | null;
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
          flow_step_key?: string | null;
          id?: string;
          kind: string;
          media_filename?: string | null;
          media_meta_id?: string | null;
          media_mime?: string | null;
          media_path?: string | null;
          org_id: string;
          payload?: NonNullable<Json>;
          reply_to_wa_message_id?: string | null;
          retry_of_message_id?: string | null;
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
          flow_step_key?: string | null;
          id?: string;
          kind?: string;
          media_filename?: string | null;
          media_meta_id?: string | null;
          media_mime?: string | null;
          media_path?: string | null;
          org_id?: string;
          payload?: NonNullable<Json>;
          reply_to_wa_message_id?: string | null;
          retry_of_message_id?: string | null;
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
            referencedRelation: "v_conversation_engagement";
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
            foreignKeyName: "messages_retry_of_message_id_fkey";
            columns: ["retry_of_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_retry_of_message_id_fkey";
            columns: ["retry_of_message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
      notification_digest_log: {
        Row: {
          id: string;
          kind: string;
          org_id: string;
          period_key: string;
          sent_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          id?: string;
          kind: string;
          org_id: string;
          period_key: string;
          sent_at?: string;
          user_id: string;
        };
        Update: {
          id?: string;
          kind?: string;
          org_id?: string;
          period_key?: string;
          sent_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notification_digest_log_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notification_digest_log_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notification_preferences: {
        Row: {
          channel: string;
          created_at: string;
          enabled: boolean;
          event: string;
          id: string;
          org_id: string;
          quiet_end: string | null;
          quiet_start: string | null;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          channel: string;
          created_at?: string;
          enabled?: boolean;
          event: string;
          id?: string;
          org_id: string;
          quiet_end?: string | null;
          quiet_start?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          channel?: string;
          created_at?: string;
          enabled?: boolean;
          event?: string;
          id?: string;
          org_id?: string;
          quiet_end?: string | null;
          quiet_start?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notification_preferences_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "notification_preferences_user_id_fkey";
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
          snoozed_until: string | null;
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
          snoozed_until?: string | null;
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
          snoozed_until?: string | null;
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
          escalated_at: string | null;
          escalated_from_role: string | null;
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
          escalated_at?: string | null;
          escalated_from_role?: string | null;
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
          escalated_at?: string | null;
          escalated_from_role?: string | null;
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
          is_training: boolean;
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
          is_training?: boolean;
          name: string;
          settings?: NonNullable<Json>;
          slug: string;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_training?: boolean;
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
      patient_documents: {
        Row: {
          category: string;
          contact_id: string;
          created_at: string;
          expires_on: string | null;
          expiry_notified_at: string | null;
          id: string;
          mime_type: string;
          org_id: string;
          scan_engine: string | null;
          scan_status: string;
          scanned_at: string | null;
          size_bytes: number;
          status: string;
          storage_path: string;
          title: string;
          updated_at: string;
          uploaded_by: string | null;
        };
        ComputedFields: never;
        Insert: {
          category: string;
          contact_id: string;
          created_at?: string;
          expires_on?: string | null;
          expiry_notified_at?: string | null;
          id?: string;
          mime_type: string;
          org_id: string;
          scan_engine?: string | null;
          scan_status?: string;
          scanned_at?: string | null;
          size_bytes: number;
          status?: string;
          storage_path: string;
          title: string;
          updated_at?: string;
          uploaded_by?: string | null;
        };
        Update: {
          category?: string;
          contact_id?: string;
          created_at?: string;
          expires_on?: string | null;
          expiry_notified_at?: string | null;
          id?: string;
          mime_type?: string;
          org_id?: string;
          scan_engine?: string | null;
          scan_status?: string;
          scanned_at?: string | null;
          size_bytes?: number;
          status?: string;
          storage_path?: string;
          title?: string;
          updated_at?: string;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "patient_documents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "patient_documents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "patient_documents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "patient_documents_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "patient_documents_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
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
      portal_record_tags: {
        Row: {
          created_at: string;
          created_by: string | null;
          object_key: string;
          org_id: string;
          record_id: string;
          tag_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          object_key: string;
          org_id: string;
          record_id: string;
          tag_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          object_key?: string;
          org_id?: string;
          record_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "portal_record_tags_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_record_tags_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_record_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
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
          step_outcomes: NonNullable<Json>;
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
          step_outcomes?: NonNullable<Json>;
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
          step_outcomes?: NonNullable<Json>;
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
      privacy_requests: {
        Row: {
          completed_at: string | null;
          contact_id: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_note: string | null;
          id: string;
          kind: string;
          org_id: string;
          reason: string;
          requested_at: string;
          requested_by: string | null;
          result: NonNullable<Json>;
          status: string;
        };
        ComputedFields: never;
        Insert: {
          completed_at?: string | null;
          contact_id: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          kind: string;
          org_id: string;
          reason: string;
          requested_at?: string;
          requested_by?: string | null;
          result?: NonNullable<Json>;
          status?: string;
        };
        Update: {
          completed_at?: string | null;
          contact_id?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          kind?: string;
          org_id?: string;
          reason?: string;
          requested_at?: string;
          requested_by?: string | null;
          result?: NonNullable<Json>;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "privacy_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "privacy_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "privacy_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "privacy_requests_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
      push_subscriptions: {
        Row: {
          created_at: string;
          endpoint_hash: string;
          failure_count: number;
          id: string;
          last_used_at: string | null;
          org_id: string;
          subscription_enc: string;
          ua_family: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          endpoint_hash: string;
          failure_count?: number;
          id?: string;
          last_used_at?: string | null;
          org_id: string;
          subscription_enc: string;
          ua_family?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          endpoint_hash?: string;
          failure_count?: number;
          id?: string;
          last_used_at?: string | null;
          org_id?: string;
          subscription_enc?: string;
          ua_family?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "push_subscriptions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      quick_replies: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          label: string | null;
          media_asset_id: string | null;
          org_id: string;
          shortcut: string;
          text: string;
          text_ar: string | null;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          label?: string | null;
          media_asset_id?: string | null;
          org_id: string;
          shortcut: string;
          text: string;
          text_ar?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          label?: string | null;
          media_asset_id?: string | null;
          org_id?: string;
          shortcut?: string;
          text?: string;
          text_ar?: string | null;
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
            foreignKeyName: "quick_replies_media_asset_id_fkey";
            columns: ["media_asset_id"];
            isOneToOne: false;
            referencedRelation: "media_assets";
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
            foreignKeyName: "recall_sends_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
            foreignKeyName: "recall_sends_reply_message_id_fkey";
            columns: ["reply_message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
      record_access_log: {
        Row: {
          action: string;
          at: string;
          detail: NonNullable<Json>;
          entity: string;
          entity_id: string | null;
          id: number;
          org_id: string;
          sampled: boolean;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          at?: string;
          detail?: NonNullable<Json>;
          entity: string;
          entity_id?: string | null;
          id?: never;
          org_id: string;
          sampled?: boolean;
          user_id?: string | null;
        };
        Update: {
          action?: string;
          at?: string;
          detail?: NonNullable<Json>;
          entity?: string;
          entity_id?: string | null;
          id?: never;
          org_id?: string;
          sampled?: boolean;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "record_access_log_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      record_history: {
        Row: {
          actor_id: string | null;
          at: string;
          changes: NonNullable<Json>;
          id: number;
          op: string;
          org_id: string;
          record_id: string;
          table_name: string;
        };
        ComputedFields: never;
        Insert: {
          actor_id?: string | null;
          at?: string;
          changes?: NonNullable<Json>;
          id?: never;
          op: string;
          org_id: string;
          record_id: string;
          table_name: string;
        };
        Update: {
          actor_id?: string | null;
          at?: string;
          changes?: NonNullable<Json>;
          id?: never;
          op?: string;
          org_id?: string;
          record_id?: string;
          table_name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "record_history_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
      review_requests: {
        Row: {
          appointment_id: string;
          claimed_at: string | null;
          contact_id: string | null;
          created_at: string;
          decided_at: string | null;
          id: string;
          location_id: string | null;
          message_id: string | null;
          org_id: string;
          reason: string | null;
          recipient_contact_id: string | null;
          run_at: string;
          status: string;
          updated_at: string;
          visit_ended_at: string | null;
        };
        ComputedFields: never;
        Insert: {
          appointment_id: string;
          claimed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          decided_at?: string | null;
          id?: string;
          location_id?: string | null;
          message_id?: string | null;
          org_id: string;
          reason?: string | null;
          recipient_contact_id?: string | null;
          run_at: string;
          status?: string;
          updated_at?: string;
          visit_ended_at?: string | null;
        };
        Update: {
          appointment_id?: string;
          claimed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          decided_at?: string | null;
          id?: string;
          location_id?: string | null;
          message_id?: string | null;
          org_id?: string;
          reason?: string | null;
          recipient_contact_id?: string | null;
          run_at?: string;
          status?: string;
          updated_at?: string;
          visit_ended_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "review_requests_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "review_requests_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "review_requests_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_recipient_contact_id_fkey";
            columns: ["recipient_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "review_requests_recipient_contact_id_fkey";
            columns: ["recipient_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "review_requests_recipient_contact_id_fkey";
            columns: ["recipient_contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
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
          require_mfa: boolean;
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
          require_mfa?: boolean;
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
          require_mfa?: boolean;
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
      rota_shifts: {
        Row: {
          created_at: string;
          created_by: string | null;
          ends_at: string;
          id: string;
          location_id: string;
          notes: string | null;
          org_id: string;
          role_label: string;
          room: string | null;
          staff_member_id: string;
          starts_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          ends_at: string;
          id?: string;
          location_id: string;
          notes?: string | null;
          org_id: string;
          role_label?: string;
          room?: string | null;
          staff_member_id: string;
          starts_at: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          ends_at?: string;
          id?: string;
          location_id?: string;
          notes?: string | null;
          org_id?: string;
          role_label?: string;
          room?: string | null;
          staff_member_id?: string;
          starts_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rota_shifts_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rota_shifts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rota_shifts_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rota_shifts_staff_member_id_fkey";
            columns: ["staff_member_id"];
            isOneToOne: false;
            referencedRelation: "staff_members";
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
      security_alerts: {
        Row: {
          acknowledged_at: string | null;
          acknowledged_by: string | null;
          created_at: string;
          dedupe_key: string;
          detail: NonNullable<Json>;
          id: string;
          kind: string;
          org_id: string;
          summary: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          created_at?: string;
          dedupe_key: string;
          detail?: NonNullable<Json>;
          id?: string;
          kind: string;
          org_id: string;
          summary: string;
          user_id?: string | null;
        };
        Update: {
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          created_at?: string;
          dedupe_key?: string;
          detail?: NonNullable<Json>;
          id?: string;
          kind?: string;
          org_id?: string;
          summary?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "security_alerts_org_id_fkey";
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
          buffer_after_min: number;
          buffer_before_min: number;
          capacity: number;
          created_at: string;
          default_visit_mode: string;
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
          buffer_after_min?: number;
          buffer_before_min?: number;
          capacity?: number;
          created_at?: string;
          default_visit_mode?: string;
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
          buffer_after_min?: number;
          buffer_before_min?: number;
          capacity?: number;
          created_at?: string;
          default_visit_mode?: string;
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
      slot_offers: {
        Row: {
          appointment_id: string | null;
          created_at: string;
          ends_at: string;
          expires_at: string;
          failure_reason: string | null;
          id: string;
          location_id: string;
          message_id: string | null;
          org_id: string;
          responded_at: string | null;
          sent_as: string | null;
          service_id: string;
          source_appointment_id: string | null;
          specialist_id: string;
          starts_at: string;
          status: string;
          updated_at: string;
          waitlist_entry_id: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          created_at?: string;
          ends_at: string;
          expires_at: string;
          failure_reason?: string | null;
          id?: string;
          location_id: string;
          message_id?: string | null;
          org_id: string;
          responded_at?: string | null;
          sent_as?: string | null;
          service_id: string;
          source_appointment_id?: string | null;
          specialist_id: string;
          starts_at: string;
          status?: string;
          updated_at?: string;
          waitlist_entry_id: string;
        };
        Update: {
          appointment_id?: string | null;
          created_at?: string;
          ends_at?: string;
          expires_at?: string;
          failure_reason?: string | null;
          id?: string;
          location_id?: string;
          message_id?: string | null;
          org_id?: string;
          responded_at?: string | null;
          sent_as?: string | null;
          service_id?: string;
          source_appointment_id?: string | null;
          specialist_id?: string;
          starts_at?: string;
          status?: string;
          updated_at?: string;
          waitlist_entry_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "slot_offers_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_source_appointment_id_fkey";
            columns: ["source_appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_source_appointment_id_fkey";
            columns: ["source_appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "slot_offers_waitlist_entry_id_fkey";
            columns: ["waitlist_entry_id"];
            isOneToOne: false;
            referencedRelation: "waitlist_entries";
            referencedColumns: ["id"];
          },
        ];
      };
      sms_messages: {
        Row: {
          appointment_id: string | null;
          contact_id: string | null;
          created_at: string;
          dedupe_key: string;
          delivered_at: string | null;
          error_code: string | null;
          id: string;
          kind: string;
          org_id: string;
          provider: string;
          provider_message_id: string | null;
          segments: number | null;
          sent_at: string | null;
          source_message_id: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          dedupe_key: string;
          delivered_at?: string | null;
          error_code?: string | null;
          id?: string;
          kind?: string;
          org_id: string;
          provider: string;
          provider_message_id?: string | null;
          segments?: number | null;
          sent_at?: string | null;
          source_message_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          appointment_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          dedupe_key?: string;
          delivered_at?: string | null;
          error_code?: string | null;
          id?: string;
          kind?: string;
          org_id?: string;
          provider?: string;
          provider_message_id?: string | null;
          segments?: number | null;
          sent_at?: string | null;
          source_message_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sms_messages_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_messages_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "sms_messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "sms_messages_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_messages_source_message_id_fkey";
            columns: ["source_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sms_messages_source_message_id_fkey";
            columns: ["source_message_id"];
            isOneToOne: false;
            referencedRelation: "v_template_message_facts";
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
      specialist_recurring_blocks: {
        Row: {
          created_at: string;
          end_min: number;
          id: string;
          location_id: string | null;
          org_id: string;
          reason: string | null;
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
          location_id?: string | null;
          org_id: string;
          reason?: string | null;
          specialist_id: string;
          start_min: number;
          updated_at?: string;
          weekday: number;
        };
        Update: {
          created_at?: string;
          end_min?: number;
          id?: string;
          location_id?: string | null;
          org_id?: string;
          reason?: string | null;
          specialist_id?: string;
          start_min?: number;
          updated_at?: string;
          weekday?: number;
        };
        Relationships: [
          {
            foreignKeyName: "specialist_recurring_blocks_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialist_recurring_blocks_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "specialist_recurring_blocks_specialist_id_fkey";
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
          bio: string | null;
          created_at: string;
          department_id: string | null;
          external_id: string | null;
          id: string;
          licence_authority: string;
          licence_expires_on: string | null;
          licence_expiry_notified_at: string | null;
          licence_number: string | null;
          max_per_slot: number;
          name: string;
          org_id: string;
          phone_ext: string | null;
          photo_path: string | null;
          slot_length_min: number | null;
          specialty: string | null;
          title: string | null;
          updated_at: string;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          bio?: string | null;
          created_at?: string;
          department_id?: string | null;
          external_id?: string | null;
          id?: string;
          licence_authority?: string;
          licence_expires_on?: string | null;
          licence_expiry_notified_at?: string | null;
          licence_number?: string | null;
          max_per_slot?: number;
          name: string;
          org_id: string;
          phone_ext?: string | null;
          photo_path?: string | null;
          slot_length_min?: number | null;
          specialty?: string | null;
          title?: string | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          active?: boolean;
          bio?: string | null;
          created_at?: string;
          department_id?: string | null;
          external_id?: string | null;
          id?: string;
          licence_authority?: string;
          licence_expires_on?: string | null;
          licence_expiry_notified_at?: string | null;
          licence_number?: string | null;
          max_per_slot?: number;
          name?: string;
          org_id?: string;
          phone_ext?: string | null;
          photo_path?: string | null;
          slot_length_min?: number | null;
          specialty?: string | null;
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
      staff_duties: {
        Row: {
          active: boolean;
          created_at: string;
          frequency: string;
          id: string;
          location_id: string | null;
          org_id: string;
          sort_order: number;
          staff_member_id: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          created_at?: string;
          frequency?: string;
          id?: string;
          location_id?: string | null;
          org_id: string;
          sort_order?: number;
          staff_member_id: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          frequency?: string;
          id?: string;
          location_id?: string | null;
          org_id?: string;
          sort_order?: number;
          staff_member_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "staff_duties_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_duties_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_duties_staff_member_id_fkey";
            columns: ["staff_member_id"];
            isOneToOne: false;
            referencedRelation: "staff_members";
            referencedColumns: ["id"];
          },
        ];
      };
      staff_members: {
        Row: {
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          department_id: string | null;
          employment_type: string;
          end_date: string | null;
          full_name: string;
          home_location_id: string | null;
          id: string;
          job_title: string | null;
          licence_expires_on: string | null;
          licence_expiry_notified_at: string | null;
          licence_number: string | null;
          manager_staff_id: string | null;
          notes: string | null;
          org_id: string;
          profile_id: string | null;
          specialist_id: string | null;
          start_date: string | null;
          updated_at: string;
          visa_expires_on: string | null;
          visa_expiry_notified_at: string | null;
          work_email: string | null;
          work_phone: string | null;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          department_id?: string | null;
          employment_type?: string;
          end_date?: string | null;
          full_name: string;
          home_location_id?: string | null;
          id?: string;
          job_title?: string | null;
          licence_expires_on?: string | null;
          licence_expiry_notified_at?: string | null;
          licence_number?: string | null;
          manager_staff_id?: string | null;
          notes?: string | null;
          org_id: string;
          profile_id?: string | null;
          specialist_id?: string | null;
          start_date?: string | null;
          updated_at?: string;
          visa_expires_on?: string | null;
          visa_expiry_notified_at?: string | null;
          work_email?: string | null;
          work_phone?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          department_id?: string | null;
          employment_type?: string;
          end_date?: string | null;
          full_name?: string;
          home_location_id?: string | null;
          id?: string;
          job_title?: string | null;
          licence_expires_on?: string | null;
          licence_expiry_notified_at?: string | null;
          licence_number?: string | null;
          manager_staff_id?: string | null;
          notes?: string | null;
          org_id?: string;
          profile_id?: string | null;
          specialist_id?: string | null;
          start_date?: string | null;
          updated_at?: string;
          visa_expires_on?: string | null;
          visa_expiry_notified_at?: string | null;
          work_email?: string | null;
          work_phone?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "staff_members_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_members_department_id_fkey";
            columns: ["department_id"];
            isOneToOne: false;
            referencedRelation: "departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_members_home_location_id_fkey";
            columns: ["home_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_members_manager_staff_id_fkey";
            columns: ["manager_staff_id"];
            isOneToOne: false;
            referencedRelation: "staff_members";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_members_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_members_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "staff_members_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
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
          deleted_at: string | null;
          done: boolean;
          done_at: string | null;
          due_at: string;
          due_notified_for: string | null;
          enquiry_id: string | null;
          id: string;
          location_id: string | null;
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
          deleted_at?: string | null;
          done?: boolean;
          done_at?: string | null;
          due_at: string;
          due_notified_for?: string | null;
          enquiry_id?: string | null;
          id?: string;
          location_id?: string | null;
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
          deleted_at?: string | null;
          done?: boolean;
          done_at?: string | null;
          due_at?: string;
          due_notified_for?: string | null;
          enquiry_id?: string | null;
          id?: string;
          location_id?: string | null;
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
            foreignKeyName: "tasks_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
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
          auto_reply_text: string | null;
          created_at: string;
          description: string | null;
          fallback_team_id: string | null;
          id: string;
          lead_user_id: string | null;
          location_id: string | null;
          name: string;
          office_hours: Json | null;
          org_id: string;
          round_robin: boolean;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          auto_reply_text?: string | null;
          created_at?: string;
          description?: string | null;
          fallback_team_id?: string | null;
          id?: string;
          lead_user_id?: string | null;
          location_id?: string | null;
          name: string;
          office_hours?: Json | null;
          org_id: string;
          round_robin?: boolean;
          updated_at?: string;
        };
        Update: {
          auto_reply_text?: string | null;
          created_at?: string;
          description?: string | null;
          fallback_team_id?: string | null;
          id?: string;
          lead_user_id?: string | null;
          location_id?: string | null;
          name?: string;
          office_hours?: Json | null;
          org_id?: string;
          round_robin?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "teams_fallback_team_id_fkey";
            columns: ["fallback_team_id"];
            isOneToOne: false;
            referencedRelation: "teams";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "teams_lead_user_id_fkey";
            columns: ["lead_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "teams_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "teams_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      telehealth_rooms: {
        Row: {
          appointment_id: string;
          created_at: string;
          created_by: string | null;
          expires_at: string;
          for_ends_at: string;
          for_starts_at: string;
          id: string;
          org_id: string;
          provider: string;
          provider_deleted_at: string | null;
          revoked_at: string | null;
          revoked_reason: string | null;
          room_ref: string | null;
          status: string;
          token_enc: string;
          token_hash: string;
        };
        ComputedFields: never;
        Insert: {
          appointment_id: string;
          created_at?: string;
          created_by?: string | null;
          expires_at: string;
          for_ends_at: string;
          for_starts_at: string;
          id?: string;
          org_id: string;
          provider: string;
          provider_deleted_at?: string | null;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          room_ref?: string | null;
          status?: string;
          token_enc: string;
          token_hash: string;
        };
        Update: {
          appointment_id?: string;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          for_ends_at?: string;
          for_starts_at?: string;
          id?: string;
          org_id?: string;
          provider?: string;
          provider_deleted_at?: string | null;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          room_ref?: string | null;
          status?: string;
          token_enc?: string;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "telehealth_rooms_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "telehealth_rooms_appointment_id_fkey";
            columns: ["appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "telehealth_rooms_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "telehealth_rooms_org_id_fkey";
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
          external_key: string | null;
          id: string;
          location_id: string | null;
          org_id: string;
          reason: string | null;
          source: string;
          specialist_id: string;
          starts_at: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          ends_at: string;
          external_key?: string | null;
          id?: string;
          location_id?: string | null;
          org_id: string;
          reason?: string | null;
          source?: string;
          specialist_id: string;
          starts_at: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          ends_at?: string;
          external_key?: string | null;
          id?: string;
          location_id?: string | null;
          org_id?: string;
          reason?: string | null;
          source?: string;
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
      user_sessions: {
        Row: {
          created_at: string;
          id: string;
          ip_hash: string | null;
          last_seen_at: string;
          org_id: string;
          revoked_at: string | null;
          revoked_reason: string | null;
          session_id: string;
          ua_family: string | null;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          ip_hash?: string | null;
          last_seen_at?: string;
          org_id: string;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          session_id: string;
          ua_family?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          ip_hash?: string | null;
          last_seen_at?: string;
          org_id?: string;
          revoked_at?: string | null;
          revoked_reason?: string | null;
          session_id?: string;
          ua_family?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_sessions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
      visit_diagnoses: {
        Row: {
          contact_id: string | null;
          created_at: string;
          diagnosis_code: string;
          id: string;
          is_primary: boolean;
          org_id: string;
          ref_diagnosis_id: string | null;
          source: string;
          updated_at: string;
          visit_date: string;
          visit_id: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          created_at?: string;
          diagnosis_code: string;
          id?: string;
          is_primary?: boolean;
          org_id: string;
          ref_diagnosis_id?: string | null;
          source?: string;
          updated_at?: string;
          visit_date: string;
          visit_id: string;
        };
        Update: {
          contact_id?: string | null;
          created_at?: string;
          diagnosis_code?: string;
          id?: string;
          is_primary?: boolean;
          org_id?: string;
          ref_diagnosis_id?: string | null;
          source?: string;
          updated_at?: string;
          visit_date?: string;
          visit_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "visit_diagnoses_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visit_diagnoses_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "visit_diagnoses_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "visit_diagnoses_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visit_diagnoses_ref_diagnosis_id_fkey";
            columns: ["ref_diagnosis_id"];
            isOneToOne: false;
            referencedRelation: "ref_diagnoses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "visit_diagnoses_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "v_visit_data_quality";
            referencedColumns: ["visit_id"];
          },
          {
            foreignKeyName: "visit_diagnoses_visit_id_fkey";
            columns: ["visit_id"];
            isOneToOne: false;
            referencedRelation: "visits";
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
      wa_pricing_daily: {
        Row: {
          category: string;
          cost: number;
          country: string;
          currency: string;
          day: string;
          org_id: string;
          pricing_type: string;
          synced_at: string;
          volume: number;
          waba_id: string;
        };
        ComputedFields: never;
        Insert: {
          category: string;
          cost: number;
          country: string;
          currency: string;
          day: string;
          org_id: string;
          pricing_type: string;
          synced_at?: string;
          volume: number;
          waba_id: string;
        };
        Update: {
          category?: string;
          cost?: number;
          country?: string;
          currency?: string;
          day?: string;
          org_id?: string;
          pricing_type?: string;
          synced_at?: string;
          volume?: number;
          waba_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "wa_pricing_daily_org_id_fkey";
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
          sms_fallback: boolean;
          status: string;
          submitted_at: string | null;
          ttl_seconds: number | null;
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
          sms_fallback?: boolean;
          status?: string;
          submitted_at?: string | null;
          ttl_seconds?: number | null;
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
          sms_fallback?: boolean;
          status?: string;
          submitted_at?: string | null;
          ttl_seconds?: number | null;
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
      waitlist_entries: {
        Row: {
          booked_appointment_id: string | null;
          contact_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          location_id: string | null;
          not_after: string | null;
          notes: string | null;
          org_id: string;
          service_id: string | null;
          specialist_id: string | null;
          status: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          booked_appointment_id?: string | null;
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string | null;
          not_after?: string | null;
          notes?: string | null;
          org_id: string;
          service_id?: string | null;
          specialist_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          booked_appointment_id?: string | null;
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string | null;
          not_after?: string | null;
          notes?: string | null;
          org_id?: string;
          service_id?: string | null;
          specialist_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "waitlist_entries_booked_appointment_id_fkey";
            columns: ["booked_appointment_id"];
            isOneToOne: false;
            referencedRelation: "appointments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_booked_appointment_id_fkey";
            columns: ["booked_appointment_id"];
            isOneToOne: false;
            referencedRelation: "v_appointment_facts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "waitlist_entries_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "waitlist_entries_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_specialist_id_fkey";
            columns: ["specialist_id"];
            isOneToOne: false;
            referencedRelation: "specialists";
            referencedColumns: ["id"];
          },
        ];
      };
      web_chat_sessions: {
        Row: {
          channel_id: string;
          contact_id: string;
          conversation_id: string | null;
          created_at: string;
          id: string;
          last_seen_at: string;
          org_id: string;
          token_hash: string;
        };
        ComputedFields: never;
        Insert: {
          channel_id: string;
          contact_id: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          last_seen_at?: string;
          org_id: string;
          token_hash: string;
        };
        Update: {
          channel_id?: string;
          contact_id?: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: string;
          last_seen_at?: string;
          org_id?: string;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "web_chat_sessions_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "web_chat_sessions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "web_chat_sessions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_birthday_today";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "web_chat_sessions_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "v_chronic_recall_eligibility";
            referencedColumns: ["contact_id"];
          },
          {
            foreignKeyName: "web_chat_sessions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "web_chat_sessions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "web_chat_sessions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_conversation_engagement";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "web_chat_sessions_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "web_chat_sessions_org_id_fkey";
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
          deleted_at: string | null;
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
          deleted_at?: string | null;
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
          deleted_at?: string | null;
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
          reminders_delivered: number | null;
          reminders_excluded: number | null;
          reminders_failed: number | null;
          reminders_read: number | null;
          reminders_replied: number | null;
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
      v_assignment_events: {
        Row: {
          at: string | null;
          conversation_id: string | null;
          day: string | null;
          from_team_id: string | null;
          from_user_id: string | null;
          id: number | null;
          kind: string | null;
          org_id: string | null;
          source: string | null;
          to_team_id: string | null;
          to_user_id: string | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "mv_conversation_facts";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_conversation_engagement";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "v_sla_breaches_now";
            referencedColumns: ["conversation_id"];
          },
          {
            foreignKeyName: "conversation_assignment_events_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
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
          pulse_last_visit_date: string | null;
          unite_last_visit_date: string | null;
          visit_count: number | null;
        };
        ComputedFields: never;
        Relationships: [];
      };
      v_conversation_engagement: {
        Row: {
          ai_assisted: boolean | null;
          assignee_team_id: string | null;
          assignee_user_id: string | null;
          automated_reply: boolean | null;
          bot_engaged: boolean | null;
          channel_id: string | null;
          closed_at: string | null;
          closed_day: string | null;
          conversation_id: string | null;
          human_replied: boolean | null;
          org_id: string | null;
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
            foreignKeyName: "conversations_org_id_fkey";
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
      v_fin_billing_readiness: {
        Row: {
          branch_code: string | null;
          doctor_dha_id: string | null;
          inv_display_number: string | null;
          invoice_id: string | null;
          net: number | null;
          org_id: string | null;
          patient_pin: string | null;
          reasons: string[] | null;
          total: number | null;
          transaction_date: string | null;
        };
        ComputedFields: never;
        Relationships: [];
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
        Relationships: [];
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
      v_fin_data_freshness: {
        Row: {
          active_rules: number | null;
          batch_count: number | null;
          branches_mapped: number | null;
          capture_enabled: boolean | null;
          claim_count: number | null;
          credentials_configured: boolean | null;
          escalated_exceptions: number | null;
          first_claim_date: string | null;
          first_invoice_date: string | null;
          invoice_count: number | null;
          last_capture_at: string | null;
          last_claim_date: string | null;
          last_import_at: string | null;
          last_invoice_date: string | null;
          last_remittance_at: string | null;
          open_exceptions: number | null;
          org_id: string | null;
        };
        ComputedFields: never;
        Relationships: [];
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
        Relationships: [];
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
        Insert: {
          appointment_id?: string | null;
          branch_code?: string | null;
          claim_count?: never;
          claimed?: never;
          department?: string | null;
          doctor_dha_id?: string | null;
          doctor_name?: string | null;
          id?: string | null;
          inv_display_number?: string | null;
          inv_type?: string | null;
          is_deleted?: boolean | null;
          net?: number | null;
          org_id?: string | null;
          paid?: never;
          patient_pin?: string | null;
          rejected?: never;
          remitted?: never;
          total?: number | null;
          transaction_date?: string | null;
          version?: number | null;
        };
        Update: {
          appointment_id?: string | null;
          branch_code?: string | null;
          claim_count?: never;
          claimed?: never;
          department?: string | null;
          doctor_dha_id?: string | null;
          doctor_name?: string | null;
          id?: string | null;
          inv_display_number?: string | null;
          inv_type?: string | null;
          is_deleted?: boolean | null;
          net?: number | null;
          org_id?: string | null;
          paid?: never;
          patient_pin?: string | null;
          rejected?: never;
          remitted?: never;
          total?: number | null;
          transaction_date?: string | null;
          version?: number | null;
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
      v_fin_monthly_measures: {
        Row: {
          accepted: number | null;
          branch_code: string | null;
          claimed: number | null;
          generated: number | null;
          month: string | null;
          org_id: string | null;
          outstanding: number | null;
          paid_allocated: number | null;
          rejected: number | null;
          remitted: number | null;
          self_pay_collected: number | null;
          status_unknown_claims: number | null;
        };
        ComputedFields: never;
        Relationships: [];
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
        Relationships: [];
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
        Relationships: [];
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
      v_presence_events: {
        Row: {
          at: string | null;
          id: number | null;
          org_id: string | null;
          presence: string | null;
          previous: string | null;
          source: string | null;
          user_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          at?: string | null;
          id?: number | null;
          org_id?: string | null;
          presence?: string | null;
          previous?: string | null;
          source?: string | null;
          user_id?: string | null;
        };
        Update: {
          at?: string | null;
          id?: number | null;
          org_id?: string | null;
          presence?: string | null;
          previous?: string | null;
          source?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "member_presence_events_org_id_fkey";
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
      v_template_message_facts: {
        Row: {
          at: string | null;
          channel_id: string | null;
          conversation_id: string | null;
          day: string | null;
          error_code: number | null;
          from_campaign: boolean | null;
          id: string | null;
          is_retry: boolean | null;
          org_id: string | null;
          status: string | null;
          template_key: string | null;
          wa_message_id: string | null;
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
            referencedRelation: "v_conversation_engagement";
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
            foreignKeyName: "messages_org_id_fkey";
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
      v_unknown_diagnosis_codes: {
        Row: {
          diagnosis_code: string | null;
          first_seen: string | null;
          last_seen: string | null;
          org_id: string | null;
          visit_count: number | null;
        };
        ComputedFields: never;
        Relationships: [
          {
            foreignKeyName: "visit_diagnoses_org_id_fkey";
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
          doctor_name: string | null;
          external_id: string | null;
          is_test_record: boolean | null;
          missing_bp: boolean | null;
          missing_pulse: boolean | null;
          missing_spo2: boolean | null;
          missing_temp: boolean | null;
          org_id: string | null;
          source: string | null;
          unmatched_patient: boolean | null;
          visit_date: string | null;
          visit_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          contact_id?: string | null;
          doctor_name?: string | null;
          external_id?: string | null;
          is_test_record?: boolean | null;
          missing_bp?: never;
          missing_pulse?: never;
          missing_spo2?: never;
          missing_temp?: never;
          org_id?: string | null;
          source?: string | null;
          unmatched_patient?: never;
          visit_date?: string | null;
          visit_id?: string | null;
        };
        Update: {
          contact_id?: string | null;
          doctor_name?: string | null;
          external_id?: string | null;
          is_test_record?: boolean | null;
          missing_bp?: never;
          missing_pulse?: never;
          missing_spo2?: never;
          missing_temp?: never;
          org_id?: string | null;
          source?: string | null;
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
      v_wa_cost_daily: {
        Row: {
          category: string | null;
          cost: number | null;
          country: string | null;
          currency: string | null;
          day: string | null;
          org_id: string | null;
          pricing_type: string | null;
          volume: number | null;
          waba_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          category?: string | null;
          cost?: number | null;
          country?: string | null;
          currency?: string | null;
          day?: string | null;
          org_id?: string | null;
          pricing_type?: string | null;
          volume?: number | null;
          waba_id?: string | null;
        };
        Update: {
          category?: string | null;
          cost?: number | null;
          country?: string | null;
          currency?: string | null;
          day?: string | null;
          org_id?: string | null;
          pricing_type?: string | null;
          volume?: number | null;
          waba_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "wa_pricing_daily_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "orgs";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      acc_account_balances: {
        Args: { p_account_ids: string[]; p_as_of: string; p_org_id: string };
        Returns: Json;
      };
      acc_ar_open_items: {
        Args: { p_as_of: string; p_customer_id: string; p_org_id: string };
        Returns: Json;
      };
      acc_ar_retry_postings: { Args: { p_org_id: string }; Returns: Json };
      acc_ar_statement: {
        Args: { p_customer_id: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      acc_asset_disposal_cancel: {
        Args: { p_asset_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_asset_disposal_post: {
        Args: { p_asset_id: string; p_hash: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_asset_disposal_prepare: {
        Args: { p_asset_id: string; p_data: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_asset_run_post: {
        Args: { p_hash: string; p_org_id: string; p_run_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_asset_run_prepare: {
        Args: {
          p_entity_id: string;
          p_kind: string;
          p_lines: Json;
          p_month: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_assets_seed: { Args: { p_org_id: string }; Returns: Json };
      acc_balance_sheet: {
        Args: {
          p_as_at: string;
          p_branch_code?: string;
          p_entity_id: string;
          p_include_adjustment: boolean;
          p_org_id: string;
        };
        Returns: Json;
      };
      acc_bank_create_ledger: {
        Args: {
          p_bank_account_id: string;
          p_code: string;
          p_group: string;
          p_name: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_bank_entry_create: {
        Args: { p: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_bank_link_gl: {
        Args: {
          p_account_id: string;
          p_bank_account_id: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_bank_position: { Args: { p_as_of: string; p_org_id: string }; Returns: Json };
      acc_bank_statement_balance_save: {
        Args: {
          p_as_of: string;
          p_balance: number;
          p_bank_account_id: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_bank_transfer_create: {
        Args: { p: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_banking_cancel: {
        Args: {
          p_date: string;
          p_id: string;
          p_kind: string;
          p_org_id: string;
          p_reason: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_banking_sweep: { Args: { p_org_id: string; p_today: string }; Returns: Json };
      acc_budget_act: {
        Args: {
          p_action: string;
          p_budget_id: string;
          p_hash: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_budget_hash: { Args: { p_budget_id: string }; Returns: string };
      acc_budget_save: {
        Args: {
          p_budget_id: string;
          p_header: Json;
          p_lines: Json;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_budget_vs_actual: {
        Args: {
          p_branch: string;
          p_budget_id: string;
          p_department: string;
          p_from: string;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      acc_cash_flow: {
        Args: {
          p_branch_code?: string;
          p_entity_id: string;
          p_from: string;
          p_include_adjustment: boolean;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      acc_cheque_act: {
        Args: {
          p_action: string;
          p_charge?: Json;
          p_cheque_id: string;
          p_date: string;
          p_org_id: string;
          p_reason: string;
          p_today?: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_cheque_book_save: {
        Args: { p: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_cheque_register: {
        Args: { p: Json; p_org_id: string; p_today?: string; p_user_id: string };
        Returns: Json;
      };
      acc_ct_bridge: {
        Args: { p_entity_id: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      acc_day_book: {
        Args: { p_entity_id: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      acc_ensure_period: {
        Args: { p_date: string; p_entity_id: string; p_org_id: string };
        Returns: string;
      };
      acc_journal_act: {
        Args: {
          p_action: string;
          p_journal_id: string;
          p_org_id: string;
          p_remarks: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_journal_canonical: { Args: { p_journal_id: string }; Returns: string };
      acc_journal_compute_hash: { Args: { p_journal_id: string }; Returns: string };
      acc_journal_save: {
        Args: {
          p_header: Json;
          p_journal_id: string;
          p_lines: Json;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_ledger: {
        Args: {
          p_account_id: string;
          p_branch_code?: string;
          p_from: string;
          p_limit: number;
          p_offset: number;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      acc_party_flag_clear: {
        Args: { p_flag_id: string; p_org_id: string; p_reason: string; p_user_id: string };
        Returns: Json;
      };
      acc_petty_cash_count_prepare: {
        Args: {
          p_count_date: string;
          p_counted: number;
          p_explanation: string;
          p_float_id: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_petty_cash_count_sign: {
        Args: { p_count_id: string; p_org_id: string; p_sha256: string; p_user_id: string };
        Returns: Json;
      };
      acc_petty_cash_expense_create: {
        Args: { p: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_petty_cash_float_save: {
        Args: { p: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_post_from_source: {
        Args: {
          p_date: string;
          p_entity_id: string;
          p_lines: Json;
          p_narration: string;
          p_org_id: string;
          p_source_id: string;
          p_source_kind: string;
          p_source_version: number;
          p_voucher_type: string;
        };
        Returns: Json;
      };
      acc_post_journal: {
        Args: { p_hash?: string; p_journal_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_posting_apply: {
        Args: { p_items: Json; p_kind: string; p_org_id: string; p_today: string };
        Returns: Json;
      };
      acc_posting_candidates: {
        Args: {
          p_after: string;
          p_after_id: string;
          p_kind: string;
          p_limit: number;
          p_org_id: string;
          p_settle_seconds?: number;
        };
        Returns: Json;
      };
      acc_posting_context: { Args: { p_org_id: string }; Returns: Json };
      acc_posting_load: {
        Args: { p_ids: string[]; p_kind: string; p_org_id: string };
        Returns: Json;
      };
      acc_posting_needed_keys: { Args: { p_org_id: string }; Returns: Json };
      acc_posting_preview_report: {
        Args: { p_entity_id: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      acc_posting_set_cursor: {
        Args: { p_at: string; p_id: string; p_kind: string; p_org_id: string };
        Returns: undefined;
      };
      acc_profit_and_loss: {
        Args: {
          p_dimension: string;
          p_entity_id: string;
          p_from: string;
          p_include_adjustment: boolean;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      acc_receipt_allocate: {
        Args: { p_allocations: Json; p_org_id: string; p_receipt_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_receipt_save: {
        Args: { p_allocations: Json; p_org_id: string; p_receipt: Json; p_user_id: string };
        Returns: Json;
      };
      acc_receipt_void: {
        Args: {
          p_date: string;
          p_org_id: string;
          p_reason: string;
          p_receipt_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_reverse_journal: {
        Args: {
          p_date: string;
          p_journal_id: string;
          p_org_id: string;
          p_reason: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_run_auto_reversals: { Args: { p_org_id: string; p_today: string }; Returns: Json };
      acc_sales_doc_discard: {
        Args: { p_doc_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_sales_doc_issue: {
        Args: { p_doc_id: string; p_hash: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_sales_doc_save: {
        Args: {
          p_doc_id: string;
          p_header: Json;
          p_lines: Json;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_sales_invoice_void: {
        Args: {
          p_date: string;
          p_invoice_id: string;
          p_org_id: string;
          p_reason: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_seed_chart: { Args: { p_org_id: string }; Returns: Json };
      acc_seed_posting_rules: { Args: { p_org_id: string }; Returns: Json };
      acc_seed_receivables: { Args: { p_org_id: string }; Returns: number };
      acc_set_ledger_start: {
        Args: { p_date: string; p_entity_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_set_period_status: {
        Args: { p_org_id: string; p_period_id: string; p_status: string; p_user_id: string };
        Returns: Json;
      };
      acc_statement_exceptions: {
        Args: { p_entity_id: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      acc_tally_apply_masters: {
        Args: { p_import_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_bridge_candidates: {
        Args: { p_after: string; p_after_key: string; p_limit: number; p_org_id: string };
        Returns: Json;
      };
      acc_tally_bridge_capture: {
        Args: { p_id: string; p_kind: string; p_org_id: string };
        Returns: Json;
      };
      acc_tally_bridge_claim: {
        Args: { p_device_id: string; p_limit: number; p_org_id: string; p_today: string };
        Returns: Json;
      };
      acc_tally_bridge_device: {
        Args: { p_tally_state: string; p_token_sha256: string; p_version: string };
        Returns: Json;
      };
      acc_tally_bridge_export_result: {
        Args: {
          p_code: string;
          p_counts: Json;
          p_device_id: string;
          p_job_id: string;
          p_ok: boolean;
          p_org_id: string;
        };
        Returns: Json;
      };
      acc_tally_bridge_import_result: {
        Args: {
          p_code: string;
          p_device_id: string;
          p_job_id: string;
          p_master_id: number;
          p_message: string;
          p_org_id: string;
          p_outcome: string;
        };
        Returns: Json;
      };
      acc_tally_bridge_job: {
        Args: { p_device_id: string; p_job_id: string; p_org_id: string };
        Returns: Json;
      };
      acc_tally_bridge_pair_create: {
        Args: { p_code_sha256: string; p_label: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_bridge_pair_exchange: {
        Args: { p_code_sha256: string; p_token_sha256: string; p_version: string };
        Returns: Json;
      };
      acc_tally_bridge_pull_cancelled: {
        Args: { p_items: Json; p_job_id: string; p_org_id: string };
        Returns: Json;
      };
      acc_tally_bridge_pull_finish: {
        Args: {
          p_alter_id: number;
          p_cursor: string;
          p_import_id: string;
          p_job_id: string;
          p_names: Json;
          p_org_id: string;
          p_refusals: Json;
        };
        Returns: Json;
      };
      acc_tally_bridge_push_apply: {
        Args: { p_cursor: Json; p_items: Json; p_org_id: string; p_today: string };
        Returns: Json;
      };
      acc_tally_bridge_record_tb: {
        Args: {
          p_as_at: string;
          p_job_id: string;
          p_org_id: string;
          p_rows: Json;
          p_sha256: string;
        };
        Returns: Json;
      };
      acc_tally_bridge_retry: {
        Args: { p_org_id: string; p_push_id: string; p_today: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_bridge_revoke: {
        Args: { p_device_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_bridge_save_settings: {
        Args: { p: Json; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_bridge_tick: { Args: { p_org_id: string; p_today: string }; Returns: Json };
      acc_tally_finish: {
        Args: { p_import_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_lock_periods: {
        Args: { p_import_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_post_opening: {
        Args: { p_date: string; p_import_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_post_vouchers: {
        Args: { p_import_id: string; p_limit: number; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_tally_reconcile: {
        Args: {
          p_as_at: string;
          p_entity_id: string;
          p_file_sha256: string;
          p_import_id: string;
          p_org_id: string;
          p_rows: Json;
          p_user_id: string;
        };
        Returns: Json;
      };
      acc_trial_balance: {
        Args: {
          p_branch_code?: string;
          p_entity_id: string;
          p_from: string;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      acc_vat_return: {
        Args: { p_entity_id: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      acc_year_end_close: {
        Args: { p_fiscal_year_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_year_end_close_months: {
        Args: { p_fiscal_year_id: string; p_org_id: string; p_user_id: string };
        Returns: Json;
      };
      acc_year_end_preview: { Args: { p_fiscal_year_id: string; p_org_id: string }; Returns: Json };
      acc_year_end_reopen: {
        Args: { p_fiscal_year_id: string; p_org_id: string; p_reason: string; p_user_id: string };
        Returns: Json;
      };
      accept_slot_offer: {
        Args: { p_now?: string; p_offer_id: string; p_org_id: string };
        Returns: Json;
      };
      ad_attribution_report: {
        Args: { p_org: string; p_since: string; p_window_days?: number };
        Returns: Json;
      };
      ad_insights_replace: {
        Args: { p_org: string; p_rows: Json; p_since: string; p_until: string };
        Returns: Json;
      };
      ad_spend_report: { Args: { p_org: string; p_since: string }; Returns: Json };
      ai_add_conversation_tags: {
        Args: { p_conversation: string; p_org: string; p_tags: string[] };
        Returns: string[];
      };
      api_read_log_hit: {
        Args: { p_key: string; p_org: string; p_resource: string; p_rows: number };
        Returns: number;
      };
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
      appointment_capacity_conflicts: {
        Args: { p_ids: string[]; p_org_id: string };
        Returns: {
          appointment_id: string;
          reason: string;
        }[];
      };
      book_appointment: {
        Args: {
          p_contact_id: string;
          p_created_by: string;
          p_department_id: string;
          p_ends_at: string;
          p_enforce: boolean;
          p_location_id: string;
          p_notes: string;
          p_notify_early: boolean;
          p_org_id: string;
          p_service_id: string;
          p_source: string;
          p_specialist_id: string;
          p_starts_at: string;
          p_status: string;
        };
        Returns: {
          arrived_at: string | null;
          channel_id: string | null;
          checked_out_at: string | null;
          checkin_status: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          department_id: string | null;
          done_at: string | null;
          ends_at: string;
          external_id: string | null;
          external_status: string | null;
          flow_step_key: string | null;
          id: string;
          is_walk_in: boolean;
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
          visit_mode: string | null;
          with_doctor_at: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      book_appointment_for_flow_step: {
        Args: {
          p_contact_id: string;
          p_created_by: string;
          p_department_id: string;
          p_ends_at: string;
          p_enforce: boolean;
          p_flow_step_key: string;
          p_location_id: string;
          p_notes: string;
          p_notify_early: boolean;
          p_org_id: string;
          p_service_id: string;
          p_source: string;
          p_specialist_id: string;
          p_starts_at: string;
          p_status: string;
        };
        Returns: {
          arrived_at: string | null;
          channel_id: string | null;
          checked_out_at: string | null;
          checkin_status: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          department_id: string | null;
          done_at: string | null;
          ends_at: string;
          external_id: string | null;
          external_status: string | null;
          flow_step_key: string | null;
          id: string;
          is_walk_in: boolean;
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
          visit_mode: string | null;
          with_doctor_at: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      calendar_feed_touch: { Args: { p_id: string }; Returns: undefined };
      campaign_ab_funnel: { Args: { p_campaign_id: string }; Returns: Json };
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
      campaign_budget_claim: { Args: { p_org: string; p_requested: number }; Returns: number };
      campaign_budget_refund: { Args: { p_count: number; p_org: string }; Returns: undefined };
      campaign_budget_status: {
        Args: { p_org: string };
        Returns: {
          month: string;
          monthly_limit: number;
          used: number;
        }[];
      };
      campaign_dispatch: {
        Args: { p_campaign_id: string; p_items: Json };
        Returns: {
          message_id: string;
          recipient_id: string;
        }[];
      };
      campaign_funnel: { Args: { p_campaign_id: string }; Returns: Json };
      campaign_recurrence_claim: {
        Args: {
          p_next_run_at: string;
          p_recurrence_id: string;
          p_run_at: string;
          p_skip_reason?: string;
        };
        Returns: string;
      };
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
      channel_receive_social: {
        Args: {
          p_at?: string;
          p_body: string;
          p_channel: string;
          p_external_id: string;
          p_kind: string;
          p_message_id: string;
          p_org: string;
          p_platform: string;
        };
        Returns: Json;
      };
      claim_flow_lock: {
        Args: { p_key: string; p_owner: string; p_ttl_seconds?: number };
        Returns: boolean;
      };
      claim_review_request: {
        Args: { p_cap_days: number; p_org: string; p_request: string };
        Returns: string;
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
      clinical_apply_chronic_conditions: {
        Args: { p_contacts?: string[]; p_org: string; p_rows: Json };
        Returns: Json;
      };
      clinical_chronic_facts: {
        Args: { p_contacts?: string[]; p_org: string };
        Returns: {
          chronic: boolean;
          contact_id: string;
          first_visit_date: string;
          last_visit_date: string;
          ref_diagnosis_id: string;
          visit_count: number;
        }[];
      };
      clinical_create_sequence: {
        Args: { p_org: string; p_prescription: string; p_sequence: Json; p_steps: Json };
        Returns: Json;
      };
      clinical_prescriptions_needing_sequence: {
        Args: { p_limit?: number; p_org: string };
        Returns: {
          duration_days: number;
          external_key: string;
          prescription_id: string;
          requires_probiotics: boolean;
          start_date: string;
        }[];
      };
      clinical_resolve_visit_diagnoses: { Args: { p_org: string }; Returns: number };
      clinical_setting: { Args: { p_key: string; p_org: string }; Returns: string };
      clinical_setting_bool: { Args: { p_key: string; p_org: string }; Returns: boolean };
      clinical_setting_num: { Args: { p_key: string; p_org: string }; Returns: number };
      clinical_store_visit_diagnoses: {
        Args: { p_codes: Json; p_org: string; p_source?: string; p_visit: string };
        Returns: Json;
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
      dashboard_overview: {
        Args: {
          p_include_enquiries?: boolean;
          p_include_tasks?: boolean;
          p_org: string;
          p_today_start: string;
          p_user: string;
        };
        Returns: Json;
      };
      demo_wipe_org: { Args: { p_org_id: string }; Returns: Json };
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
      enquiry_ids_visible_to: {
        Args: { p_ids: string[]; p_org_id: string; p_user_id: string };
        Returns: string[];
      };
      erase_contact: {
        Args: { p_actor?: string; p_contact: string; p_org: string };
        Returns: Json;
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
      fin_backfill_patient_refs: { Args: { p_limit?: number; p_org_id: string }; Returns: number };
      fin_bank_collections: {
        Args: { p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_bank_import: {
        Args: {
          p_account_id: string;
          p_file_name: string;
          p_format_id: string;
          p_kind: string;
          p_org_id: string;
          p_payment_mode: string;
          p_rows: Json;
          p_sha256: string;
          p_user: string;
        };
        Returns: string;
      };
      fin_batch_mark_failed: { Args: { p_batch_id: string; p_error: string }; Returns: undefined };
      fin_billing_mix: {
        Args: { p_branch?: string; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_capture_enqueue_ticks: { Args: Record<PropertyKey, never>; Returns: number };
      fin_capture_release_lease: {
        Args: { p_holder: string; p_org_id: string };
        Returns: undefined;
      };
      fin_capture_try_lease: {
        Args: { p_holder: string; p_org_id: string; p_ttl_seconds?: number };
        Returns: boolean;
      };
      fin_cashup_expected: {
        Args: { p_branch: string; p_date: string; p_org_id: string };
        Returns: Json;
      };
      fin_cashup_refresh: { Args: { p_cashup_id: string; p_org_id: string }; Returns: undefined };
      fin_cashup_submit: {
        Args: { p_cashup_id: string; p_org_id: string; p_user_id: string };
        Returns: undefined;
      };
      fin_close_claim_reminders: {
        Args: { p_org_id: string; p_task_ids: string[]; p_today: string };
        Returns: {
          owner_user_id: string;
          task_id: string;
        }[];
      };
      fin_close_controls: {
        Args: { p_month: string; p_org_id: string; p_today?: string };
        Returns: Json;
      };
      fin_close_generate_tasks: { Args: { p_month: string; p_org_id: string }; Returns: number };
      fin_close_month_figures: { Args: { p_month: string; p_org_id: string }; Returns: Json };
      fin_close_seed_steps: { Args: { p_org_id: string }; Returns: number };
      fin_close_set_task_status: {
        Args: {
          p_any_step: boolean;
          p_note: string;
          p_org_id: string;
          p_reason: string;
          p_status: string;
          p_task_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      fin_close_sign_ceo: {
        Args: {
          p_close_id: string;
          p_hash: string;
          p_note: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      fin_close_sign_finance: {
        Args: {
          p_close_id: string;
          p_hash: string;
          p_note: string;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      fin_close_sign_signed: {
        Args: {
          p_close_id: string;
          p_hash: string;
          p_note: string;
          p_org_id: string;
          p_signature: Json;
          p_step: string;
          p_user_id: string;
        };
        Returns: string;
      };
      fin_close_store_snapshot: {
        Args: { p_month: string; p_org_id: string; p_snapshot: Json; p_user_id: string };
        Returns: string;
      };
      fin_close_withdraw: { Args: { p_close_id: string; p_org_id: string }; Returns: undefined };
      fin_cost_set_period: {
        Args: {
          p_month: string;
          p_note: string;
          p_org_id: string;
          p_status: string;
          p_user: string;
        };
        Returns: undefined;
      };
      fin_cost_upsert: {
        Args: { p_kind: string; p_org_id: string; p_rows: Json; p_user: string };
        Returns: number;
      };
      fin_denial_reasons: {
        Args: {
          p_from: string;
          p_limit?: number;
          p_org_id: string;
          p_payer?: string;
          p_to: string;
        };
        Returns: Json;
      };
      fin_doctor_charges_replace_upload: {
        Args: { p_org_id: string; p_rows: Json; p_user_id: string };
        Returns: Json;
      };
      fin_doctor_measures: {
        Args: { p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_escalate_exceptions: { Args: { p_org_id: string }; Returns: number };
      fin_flash_inputs: { Args: { p_from: string; p_org_id: string; p_to: string }; Returns: Json };
      fin_flash_set_targets: {
        Args: { p_month: string; p_org_id: string; p_rows: Json; p_user: string };
        Returns: number;
      };
      fin_followup_create_tasks: {
        Args: { p_limit?: number; p_now?: string; p_org_id: string; p_today: string };
        Returns: Json;
      };
      fin_followup_open_claims: {
        Args: { p_org_id: string; p_today: string };
        Returns: {
          age_days: number;
          branch_code: string;
          claim_activity_number: string;
          claim_status: string;
          evidenced: boolean;
          id: string;
          invoice_no: string;
          last_resubmission_date: string;
          net: number;
          outstanding: number;
          payer_id: string;
          rejected: number;
          remitted: number;
          resubmission_count: number;
          transaction_date: string;
        }[];
      };
      fin_followup_worklist: {
        Args: {
          p_branch?: string;
          p_limit?: number;
          p_org_id: string;
          p_payer?: string;
          p_stage?: number;
          p_today: string;
        };
        Returns: Json;
      };
      fin_forecast_history: { Args: { p_mature_days?: number; p_org_id: string }; Returns: Json };
      fin_forecast_outstanding: { Args: { p_org_id: string }; Returns: Json };
      fin_insurance_overview: {
        Args: { p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_invoice_changes: {
        Args: { p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
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
      fin_journal_source: {
        Args: { p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_lab_post: {
        Args: { p_hash: string; p_org_id: string; p_statement_id: string; p_user: string };
        Returns: Json;
      };
      fin_lab_reopen: { Args: { p_org_id: string; p_statement_id: string }; Returns: undefined };
      fin_lab_unite_lines: {
        Args: { p_codes: string[]; p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_link_preauth_claims: { Args: { p_org_id: string }; Returns: number };
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
      fin_payer_scorecard: {
        Args: { p_from: string; p_group: string; p_org_id: string; p_payer?: string; p_to: string };
        Returns: Json;
      };
      fin_profit_inputs: {
        Args: { p_from: string; p_org_id: string; p_to: string };
        Returns: Json;
      };
      fin_provider_import: {
        Args: {
          p_file_name: string;
          p_format_id: string;
          p_month: string;
          p_org_id: string;
          p_provider_id: string;
          p_rows: Json;
          p_sha256: string;
          p_user: string;
        };
        Returns: string;
      };
      fin_receivables_by_payer_age: {
        Args: { p_branch?: string; p_org_id: string; p_today: string };
        Returns: Json;
      };
      fin_rederive_branches: { Args: { p_org_id: string }; Returns: number };
      fin_revenue_breakdown: {
        Args: {
          p_branch?: string;
          p_dimension: string;
          p_from: string;
          p_limit?: number;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      fin_revenue_trend: {
        Args: {
          p_branch?: string;
          p_from: string;
          p_grain?: string;
          p_org_id: string;
          p_to: string;
        };
        Returns: Json;
      };
      fin_revshare_inputs: { Args: { p_month: string; p_org_id: string }; Returns: Json };
      fin_revshare_liability: { Args: { p_org_id: string }; Returns: Json };
      fin_revshare_post: {
        Args: { p_org_id: string; p_ref: string; p_run_id: string; p_user_id: string };
        Returns: undefined;
      };
      fin_revshare_record_payment: {
        Args: {
          p_line_id: string;
          p_org_id: string;
          p_paid_on: string;
          p_ref: string;
          p_user_id: string;
        };
        Returns: string;
      };
      fin_revshare_run_step: {
        Args: {
          p_hash: string;
          p_org_id: string;
          p_run_id: string;
          p_step: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      fin_revshare_scheme_save: {
        Args: {
          p_doctor: string;
          p_effective_from: string;
          p_note: string;
          p_org_id: string;
          p_rule: Json;
          p_scheme_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      fin_revshare_scheme_step: {
        Args: {
          p_hash: string;
          p_org_id: string;
          p_scheme_id: string;
          p_step: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      fin_revshare_store_draft: {
        Args: { p_month: string; p_org_id: string; p_snapshot: Json; p_user_id: string };
        Returns: string;
      };
      fin_rules_context: {
        Args: { p_org_id: string };
        Returns: {
          appointments_from: string;
          capture_drained: boolean;
          claims_fresh: boolean;
        }[];
      };
      fin_run_exception_rules: { Args: { p_org_id: string }; Returns: Json };
      fin_seed_settlement_rules: { Args: { p_org_id: string }; Returns: undefined };
      fin_selfpay_balances: {
        Args: { p_limit?: number; p_min_balance?: number; p_min_days?: number; p_org_id: string };
        Returns: Json;
      };
      fin_set_invoice_doctor_roles: { Args: { p_org_id: string; p_rows: Json }; Returns: number };
      fin_sync_denial_cases: { Args: { p_limit?: number; p_org_id: string }; Returns: Json };
      fin_tally_record_export: {
        Args: {
          p_checksum: string;
          p_invoice_ids: string[];
          p_org_id: string;
          p_total: number;
          p_user_id: string;
          p_voucher_ids: string[];
          p_xml: string;
        };
        Returns: string;
      };
      fin_voucher_act: {
        Args: {
          p_action: string;
          p_hash: string;
          p_org_id: string;
          p_payment: Json;
          p_remarks: string;
          p_user_id: string;
          p_voucher_id: string;
        };
        Returns: Json;
      };
      fin_voucher_act_signed: {
        Args: {
          p_action: string;
          p_hash: string;
          p_org_id: string;
          p_remarks: string;
          p_signature: Json;
          p_user_id: string;
          p_voucher_id: string;
        };
        Returns: Json;
      };
      fin_voucher_bulk_check: {
        Args: { p_items: Json; p_org_id: string; p_remarks: string; p_user_id: string };
        Returns: Json;
      };
      fin_voucher_canonical: { Args: { p_voucher_id: string }; Returns: string };
      fin_voucher_compute_hash: { Args: { p_voucher_id: string }; Returns: string };
      fin_voucher_save: {
        Args: {
          p_document_ids: string[];
          p_fields: Json;
          p_invoice_ids: string[];
          p_org_id: string;
          p_user_id: string;
          p_voucher_id: string;
        };
        Returns: Json;
      };
      gcal_apply_busy_blocks: {
        Args: { p_blocks: Json; p_from: string; p_org: string; p_specialist: string; p_to: string };
        Returns: Json;
      };
      gcal_clear_busy_blocks: { Args: { p_org: string; p_specialist: string }; Returns: number };
      ins_apply_matches: { Args: { p_matches: Json; p_org_id: string }; Returns: number };
      ins_claims_for_remittance: {
        Args: { p_invoice_keys: string[]; p_numbers: string[]; p_org_id: string };
        Returns: Json;
      };
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
      ins_commit_remittance: {
        Args: {
          p_batch: Json;
          p_file_id: string;
          p_lines: Json;
          p_org_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      ins_discard_import: {
        Args: { p_file_id: string; p_org_id: string; p_reason?: string };
        Returns: undefined;
      };
      ins_purge_stale_staging: { Args: Record<PropertyKey, never>; Returns: number };
      integration_call_stats: {
        Args: { p_org: string; p_since: string };
        Returns: {
          avg_ms: number;
          calls: number;
          last_at: string;
          outcome: string;
          provider: string;
        }[];
      };
      integration_usage_bump: {
        Args: { p_metric: string; p_n?: number; p_org: string; p_provider: string };
        Returns: undefined;
      };
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
      list_deleted_items: {
        Args: {
          p_kinds: string[];
          p_limit?: number;
          p_offset?: number;
          p_org: string;
          p_user: string;
        };
        Returns: {
          deleted_at: string;
          deleted_by: string;
          entity: string;
          record_id: string;
          title: string;
        }[];
      };
      mark_all_notifications_read: { Args: { p_org_id: string }; Returns: number };
      media_asset_usage: {
        Args: { p_asset: string; p_org: string };
        Returns: {
          blocking: boolean;
          kind: string;
          ref_id: string;
          ref_name: string;
          ref_status: string;
        }[];
      };
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
      move_appointment: {
        Args: {
          p_appointment_id: string;
          p_ends_at: string;
          p_enforce: boolean;
          p_location_id: string;
          p_org_id: string;
          p_specialist_id: string;
          p_starts_at: string;
          p_status: string;
        };
        Returns: {
          arrived_at: string | null;
          channel_id: string | null;
          checked_out_at: string | null;
          checkin_status: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          custom: NonNullable<Json>;
          department_id: string | null;
          done_at: string | null;
          ends_at: string;
          external_id: string | null;
          external_status: string | null;
          flow_step_key: string | null;
          id: string;
          is_walk_in: boolean;
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
          visit_mode: string | null;
          with_doctor_at: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "appointments";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      offboard_member: {
        Args: { p_actor: string; p_membership: string; p_org: string; p_reassign_to?: string };
        Returns: Json;
      };
      pick_round_robin_assignee: { Args: { p_org_id: string; p_team_id: string }; Returns: string };
      pick_round_robin_assignee_capped: {
        Args: { p_org_id: string; p_team_id: string };
        Returns: string;
      };
      portal_bulk_update: {
        Args: {
          p_column: string;
          p_ids: string[];
          p_object_key: string;
          p_org_id: string;
          p_value: Json;
        };
        Returns: {
          new_value: Json;
          old_value: Json;
          record_id: string;
        }[];
      };
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
      presence_auto_away_sweep: { Args: Record<PropertyKey, never>; Returns: number };
      presence_heartbeat: { Args: { p_org_id: string }; Returns: string };
      purge_deleted_records: { Args: { p_batch?: number; p_now?: string }; Returns: Json };
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
      report_ai_engagement: {
        Args: {
          p_channels?: string[];
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
        };
        Returns: {
          ai_assisted: number;
          bot_engaged: number;
          closed: number;
          closed_without_human: number;
          closed_without_reply: number;
          engaged: number;
          handled_by_automation: number;
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
      report_assignment_close: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          closed: number;
          first_avg_seconds: number;
          first_median_seconds: number;
          is_total: boolean;
          last_avg_seconds: number;
          last_median_seconds: number;
          user_id: string;
          with_assignment: number;
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
      report_clinical_data_quality: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          incomplete_vitals: number;
          unclassified_medication_codes: number;
          unknown_diagnosis_codes: number;
          unmatched_patients: number;
          visits: number;
        }[];
      };
      report_clinical_followup_load: {
        Args: { p_org: string; p_today: string };
        Returns: {
          doctor_alerts_pending: number;
          high_priority: number;
          open_items: number;
          overdue: number;
          trigger_category: string;
        }[];
      };
      report_clinical_red_flags: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          needs_review: number;
          red_flags: number;
          replies: number;
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
      report_enquiry_cohorts: {
        Args: { p_from: string; p_org: string; p_to: string; p_users?: string[] };
        Returns: {
          created: number;
          disqualified: number;
          lost: number;
          median_days_to_close: number;
          month: string;
          open: number;
          won: number;
          won_value: number;
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
      report_owner_removed: {
        Args: {
          p_from: string;
          p_org: string;
          p_teams?: string[];
          p_to: string;
          p_users?: string[];
        };
        Returns: {
          by_routing_or_system: number;
          by_staff: number;
          is_total: boolean;
          reassigned: number;
          removed: number;
          unassigned: number;
          user_id: string;
        }[];
      };
      report_presence_events: {
        Args: { p_from: string; p_org: string; p_to: string; p_users?: string[] };
        Returns: Json;
      };
      report_recall_week: {
        Args: { p_org: string; p_week_start: string };
        Returns: {
          booked: number;
          failed: number;
          programme_key: string;
          programme_name: string;
          replied: number;
          send_mode: string;
          sent: number;
          unique_contacts: number;
        }[];
      };
      report_reminder_stats_by_day: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          day: string;
          reminders_delivered: number;
          reminders_failed: number;
          reminders_read: number;
          reminders_replied: number;
          reminders_sent: number;
        }[];
      };
      report_reminder_stats_by_specialist: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          appointments: number;
          contacted: number;
          reminders_delivered: number;
          reminders_excluded: number;
          reminders_failed: number;
          reminders_read: number;
          reminders_replied: number;
          reminders_sent: number;
          specialist_id: string;
          specialist_name: string;
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
      report_template_performance: {
        Args: {
          p_channels?: string[];
          p_from: string;
          p_org: string;
          p_template?: string;
          p_to: string;
        };
        Returns: {
          category: string;
          clicked: number;
          delivered: number;
          failed: number;
          from_campaigns: number;
          language: string;
          messages: number;
          name: string;
          pending: number;
          read_count: number;
          replied: number;
          retries: number;
          sent: number;
          template_id: string;
        }[];
      };
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
      report_wa_cost_by_day: {
        Args: { p_from: string; p_org: string; p_to: string };
        Returns: {
          category: string;
          cost: number;
          currency: string;
          day: string;
          volume: number;
        }[];
      };
      requeue_lost_flow_message: {
        Args: { p_message_id: string; p_queue: string };
        Returns: boolean;
      };
      reserve_send_slot: { Args: { p_cap: number; p_channel_id: string }; Returns: number };
      restore_deleted_record: {
        Args: { p_actor?: string; p_entity: string; p_id: string; p_org: string };
        Returns: string;
      };
      review_request_stats: { Args: { p_org: string; p_since: string }; Returns: Json };
      route_conversation: {
        Args: {
          p_conversation_id: string;
          p_org_id: string;
          p_round_robin: boolean;
          p_team_id: string;
        };
        Returns: Json;
      };
      security_maintenance: { Args: { p_now?: string }; Returns: Json };
      seed_clinical_settings: { Args: { p_org: string }; Returns: undefined };
      seed_clinical_settings_phase21: { Args: { p_org: string }; Returns: undefined };
      seed_clinical_settings_phase6: { Args: { p_org: string }; Returns: undefined };
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
      soft_delete_records: {
        Args: { p_actor?: string; p_entity: string; p_ids: string[]; p_org: string };
        Returns: string[];
      };
      storage_usage_summary: { Args: { p_org: string }; Returns: Json };
      unlink_conversation_contact: {
        Args: {
          p_conversation_id: string;
          p_first_name: string;
          p_keep_household: boolean;
          p_last_name: string;
          p_org_id: string;
          p_relationship: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      web_chat_receive: {
        Args: {
          p_at?: string;
          p_body: string;
          p_channel: string;
          p_client_id: string;
          p_create: boolean;
          p_name: string;
          p_org: string;
          p_token_hash: string;
        };
        Returns: Json;
      };
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
