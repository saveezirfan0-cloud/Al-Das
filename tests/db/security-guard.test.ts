/**
 * Phase 11 security pass, database side. Introspects the catalog so that a future
 * migration cannot add a table, policy or function that quietly breaks tenant
 * isolation (CLAUDE.md rule 1), and sweeps every org-scoped table with real
 * cross-org reads and writes. Runs only with TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  M4A_TABLES,
  M3_TABLES,
  PHASE13_TABLES,
  PHASE14_TABLES,
  PHASE15_TABLES,
  PHASE16_TABLES,
  PHASE17_TABLES,
  PHASE18_SERVICE_ONLY_TABLES,
  PHASE18_TABLES,
  PHASE19_SERVICE_ONLY_TABLES,
  PHASE19_TABLES,
  PHASE20_TABLES,
  PHASE20A_TABLES,
  PHASE20D_SERVICE_ONLY_TABLES,
  PHASE20D_TABLES,
  PHASE21_TABLES,
  PHASE22_SERVICE_ONLY_TABLES,
  PHASE22_TABLES,
  PHASE22C_SERVICE_ONLY_TABLES,
  PHASE22C_TABLES,
  PHASE22E_TABLES,
  PHASE22F_TABLES,
  PHASE22G_TABLES,
  PHASE22I_SERVICE_ONLY_TABLES,
  PHASE22I_TABLES,
  PHASE22H_TABLES,
  PHASE22J_SERVICE_ONLY_TABLES,
  PHASE22J_TABLES,
  PHASE23_SERVICE_ONLY_TABLES,
  SF20C_BOOKING_TABLES,
  SF20C_TABLES,
  SF20D_TABLES,
  SF20E_SERVICE_ONLY_TABLES,
  SF20E_TABLES,
  SF20G_TABLES,
  SF20I_TABLES,
  PORTAL_TAGS_TABLES,
  ORGANISATION_TABLES,
  PHASE_F_TABLES,
  PHASE_G_TABLES,
  resetDb,
  seedM3Rows,
  seedPhase13Rows,
  seedPhase14Rows,
  seedPhase16Rows,
  seedPhase17Rows,
  seedPhase18Rows,
  seedPhase19Rows,
  seedPhase20Rows,
  seedPhase20aRows,
  seedPhase20DRows,
  seedPhase21Rows,
  seedPhase22GRows,
  seedPhase22IRows,
  seedPhase22Rows,
  seedPhase22CRows,
  seedPhase22ERows,
  seedPhase22FRows,
  seedPhase22HRows,
  seedPhase22JRows,
  seedSf20cBookingRows,
  seedSf20cRows,
  seedSf20dRows,
  seedSf20eRows,
  seedSf20gRows,
  seedSf20iRows,
  seedPortalTagRows,
  seedM4aRows,
  seedOrganisationRows,
  seedPhaseFRows,
  seedPhaseGRows,
  seedSecurityRows,
  seedSoftDeleteRows,
  SOFT_DELETE_SERVICE_ONLY_TABLES,
  TEST_DATABASE_URL,
} from "./helpers";

/** Tables with no API policy on purpose: only the service role (server code after can()) touches them. */
const SERVICE_ONLY = new Set([
  // Track P0: counts of each importer run (no ids, no values); written by the import scripts, read by the migration page
  "import_runs",
  // Phase 10: API key hashes and idempotent-response cache; only the public API (server code) touches them
  "api_idempotency",
  "api_keys",
  // Phase 6: per-org appointment number counter, only touched by a security-definer trigger
  "appointment_counters",
  "channel_secrets",
  "channel_send_slots",
  "dead_letters",
  // Phase 5: per-org enquiry number counter, only touched by a security-definer trigger
  "enquiry_counters",
  // Finance module: infrastructure and raw-payload tables, documented as service-only in their migrations
  "fin_alert_state",
  "fin_capture_lease",
  "fin_capture_settings",
  "fin_raw_diligence_files",
  "fin_raw_unite_batches",
  "ins_staged_activities",
  // Phase 20D: the per-org, per-year payment voucher number counter; only fin_voucher_save (security definer) touches it
  "fin_voucher_counters",
  // Phase 22C: a person's own signing certificate (.p12, AES-256-GCM, PIN never stored), read and written only by
  // server actions for that person; the sealed PDFs, served only by the download routes after the document read check
  "fin_sealed_documents",
  "fin_signing_certificates",
  // Phase 18: an uploaded payment advice (name, sha256, validation result) and its sanitised staged lines. They wait for
  // the confirm step and are deleted at commit; only server code (service role, after can('finance.remittance.manage')) reads them
  "fin_raw_remittance_files",
  "fin_staged_remittance_lines",
  // Phase 22I: the sanitised Tally rows staged between the dry run and the commit (deleted when the commit finishes);
  // only server code (service role, after can('accounting.import')) and the acc_tally_* functions touch them
  "acc_tally_staged",
  // Phase 22J: the Tally connectors (pairing-code and device-token hashes); only server code (service role, after the
  // device-token check or can('accounting.settings.manage')) and the acc_tally_bridge_* functions touch them
  "acc_tally_devices",
  // Phase 23A: the sanitised Unite collection report (uploads and visit rows, PIN-level); only server code (service role,
  // after can('finance.revenue.import') or can('finance.revenue.view')) and the fin_report_* functions touch them
  "fin_report_uploads",
  "fin_report_visits",
  // M1 management alerts: which (rule, scope, period) was announced; only the daily job (fin_mgmt_alert_claim) touches it
  "fin_mgmt_alert_state",
  // Finance F2 / Phase 19: provider credentials (config_enc, AES-256-GCM) and token cache; only server code after can('integrations.manage') reads or writes them
  "integration_accounts",
  // Phase 19: idempotency keys of inbound provider webhooks (provider event ids and a short outcome word); claimed by the webhook route, never read by a browser
  "integration_webhook_events",
  // Phase 19b: the encrypted token of each video room (the link itself); staff get the link through a server action that checks appointments.view
  "telehealth_rooms",
  // Phase 20e: website chat visitor token hashes (the widget routes run as the service role after the origin and rate checks)
  "web_chat_sessions",
  // Phase 20e: Google Calendar refresh/access tokens (AES-256-GCM) and one-time OAuth states; server code after can('integrations.calendar')
  "gcal_connections",
  "gcal_oauth_states",
  "unite_api_calls",
  "job_runs",
  // Phase 8: salted hashes of Make's daily output for the parallel run, written by the importer script only
  "parallel_run_make_outputs",
  "rate_limit_hits",
  "scheduled_jobs",
  "webhook_events_in",
  // Phase 22D: where the posting runner got to per org and source kind; only the runner (service role) reads or moves it
  "acc_posting_cursors",
  // Soft delete (docs/35): the bin, with the cleared phone numbers of deleted contacts; server code after can() only
  "deleted_items",
]);

/** SECURITY DEFINER functions in `public` that signed-in users may call directly (each uses auth.uid() inside). */
// presence_heartbeat (Phase 20c): the browser shell's own heartbeat; it only touches the caller's own membership.
const AUTHENTICATED_RPCS = new Set([
  "mark_all_notifications_read",
  "presence_heartbeat",
  "set_presence",
]);

/**
 * Phase 15 SECURITY DEFINER functions that are service-role only (they act across a whole org after the
 * app has run can()). The generic RPC test above already fails if any of them is callable by a signed-in
 * user; this list makes the intent explicit and fails if one disappears.
 */
const PHASE15_SERVICE_FUNCTIONS = [
  "api_read_log_hit",
  "erase_contact",
  "offboard_member",
  "security_maintenance",
];

/** Phase 16 SECURITY DEFINER functions that only server code (service role) may run. */
const PHASE16_SERVICE_FUNCTIONS = ["erase_contact", "media_asset_usage", "storage_usage_summary"];

/**
 * Phase 18 SECURITY DEFINER functions that only server code (service role) may run: the analytics (they take the org
 * explicitly, so the server runs can() first), the commit functions, the close / cash-up state machines.
 */
const PHASE18_SERVICE_FUNCTIONS = [
  "fin_cashup_expected",
  "fin_cashup_refresh",
  "fin_cashup_submit",
  "fin_close_month_figures",
  "fin_close_sign_ceo",
  "fin_close_sign_finance",
  "fin_close_store_snapshot",
  "fin_close_withdraw",
  "fin_denial_reasons",
  "fin_forecast_history",
  "fin_forecast_outstanding",
  "fin_journal_source",
  "fin_link_preauth_claims",
  "fin_payer_scorecard",
  "fin_revenue_breakdown",
  "fin_selfpay_balances",
  "fin_sync_denial_cases",
  "ins_claims_for_remittance",
  "ins_commit_remittance",
];

/** Phase 19 SECURITY DEFINER functions that only server code (service role) may run. */
const PHASE19_SERVICE_FUNCTIONS = [
  "calendar_feed_touch",
  "integration_call_stats",
  "integration_usage_bump",
];

/** Phase 20e SECURITY DEFINER functions that only server code (service role) may run. */
const SF20E_SERVICE_FUNCTIONS = [
  "channel_receive_social",
  "gcal_apply_busy_blocks",
  "gcal_clear_busy_blocks",
  "web_chat_receive",
];

/**
 * Phase 20 SECURITY DEFINER functions that only server code (service role) may run: the flash report (20A), payables
 * and vouchers (20D), bank reconciliation (20C), insurance follow-up (20I), the invoice-change register (20J), the
 * doctor revenue share (20F), the billing mix and trend (20K) and the Board pack controls (20G). The pages, routes,
 * actions and jobs run can() first.
 */
const PHASE20_SERVICE_FUNCTIONS = [
  "fin_bank_collections",
  "fin_bank_import",
  "fin_close_controls",
  "fin_billing_mix",
  "fin_doctor_charges_replace_upload",
  "fin_flash_inputs",
  "fin_flash_set_targets",
  "fin_lab_post",
  "fin_lab_reopen",
  "fin_lab_unite_lines",
  "fin_provider_import",
  "fin_followup_create_tasks",
  "fin_followup_open_claims",
  "fin_followup_worklist",
  "fin_invoice_changes",
  "fin_receivables_by_payer_age",
  "fin_revenue_trend",
  "fin_seed_settlement_rules",
  "fin_tally_record_export",
  "fin_voucher_act",
  "fin_voucher_bulk_check",
  "fin_voucher_canonical",
  "fin_voucher_compute_hash",
  "fin_voucher_save",
  "fin_revshare_inputs",
  "fin_revshare_liability",
  "fin_revshare_post",
  "fin_revshare_record_payment",
  "fin_revshare_run_step",
  "fin_revshare_scheme_save",
  "fin_revshare_scheme_step",
  "fin_revshare_store_draft",
];

/**
 * Phase 22A SECURITY DEFINER functions (accounting ledger core) that only server code (service role) may run: the chart
 * seed, periods, manual journals, posting and reversal, the posting API for later slices, the content hash and reports.
 */
const PHASE22_SERVICE_FUNCTIONS = [
  "acc_day_book",
  "acc_ensure_period",
  "acc_journal_act",
  "acc_journal_canonical",
  "acc_journal_compute_hash",
  "acc_journal_save",
  "acc_ledger",
  "acc_post_from_source",
  "acc_post_journal",
  "acc_reverse_journal",
  "acc_run_auto_reversals",
  "acc_seed_chart",
  "acc_set_period_status",
  "acc_trial_balance",
  // Phase 22D: the ledger start, the default rules and the posting runner
  "acc_posting_apply",
  "acc_posting_candidates",
  "acc_posting_context",
  "acc_posting_load",
  "acc_posting_needed_keys",
  "acc_posting_preview_report",
  "acc_posting_set_cursor",
  "acc_seed_posting_rules",
  "acc_set_ledger_start",
];
/** Phase 22C: an approval step and its personal signature in one transaction (server actions after can()). */
const PHASE22C_SERVICE_FUNCTIONS = ["fin_close_sign_signed", "fin_voucher_act_signed"];

/**
 * Phase 22E SECURITY DEFINER functions (receivables): seeding, sales documents, receipts and allocations, retrying postings
 * that waited for the ledger start, and the report data. Server code (service role) only.
 */
const PHASE22E_SERVICE_FUNCTIONS = [
  "acc_ar_open_items",
  "acc_ar_retry_postings",
  "acc_ar_statement",
  "acc_receipt_allocate",
  "acc_receipt_save",
  "acc_receipt_void",
  "acc_sales_doc_discard",
  "acc_sales_doc_issue",
  "acc_sales_doc_save",
  "acc_sales_invoice_void",
  "acc_seed_receivables",
];

/** Phase 22F SECURITY DEFINER functions (banking and cash) that only server code (service role) may run. */
const PHASE22F_SERVICE_FUNCTIONS = [
  "acc_account_balances",
  "acc_bank_create_ledger",
  "acc_bank_entry_create",
  "acc_bank_link_gl",
  "acc_bank_position",
  "acc_bank_statement_balance_save",
  "acc_bank_transfer_create",
  "acc_banking_cancel",
  "acc_banking_sweep",
  "acc_cheque_act",
  "acc_cheque_book_save",
  "acc_cheque_register",
  "acc_party_flag_clear",
  "acc_petty_cash_count_prepare",
  "acc_petty_cash_count_sign",
  "acc_petty_cash_expense_create",
  "acc_petty_cash_float_save",
];

/**
 * Phase 22G SECURITY DEFINER functions (statements, budgets, VAT return): reports and the budget workflow, service role
 * only (the server runs can() first).
 */
const PHASE22G_SERVICE_FUNCTIONS = [
  "acc_balance_sheet",
  "acc_budget_act",
  "acc_budget_hash",
  "acc_budget_save",
  "acc_budget_vs_actual",
  "acc_cash_flow",
  "acc_ct_bridge",
  "acc_profit_and_loss",
  "acc_statement_exceptions",
  "acc_vat_return",
];

/**
 * Phase 22I SECURITY DEFINER functions (Tally import, reconciliation, year-end close) that only server code (service
 * role) may run; each checks the person's permission again.
 */
const PHASE22I_SERVICE_FUNCTIONS = [
  "acc_tally_apply_masters",
  "acc_tally_finish",
  "acc_tally_lock_periods",
  "acc_tally_post_opening",
  "acc_tally_post_vouchers",
  "acc_tally_reconcile",
  "acc_year_end_close",
  "acc_year_end_close_months",
  "acc_year_end_preview",
  "acc_year_end_reopen",
];

/**
 * Phase 22J SECURITY DEFINER functions (the Tally bridge) that only server code (service role) may run: the person's
 * permission is checked again for pairing, revoking, settings and retries; the connector's ones run after the route
 * checked the device token and the integration switch.
 */
const PHASE22J_SERVICE_FUNCTIONS = [
  "acc_tally_bridge_candidates",
  "acc_tally_bridge_capture",
  "acc_tally_bridge_claim",
  "acc_tally_bridge_device",
  "acc_tally_bridge_export_result",
  "acc_tally_bridge_import_result",
  "acc_tally_bridge_job",
  "acc_tally_bridge_pair_create",
  "acc_tally_bridge_pair_exchange",
  "acc_tally_bridge_pull_cancelled",
  "acc_tally_bridge_pull_finish",
  "acc_tally_bridge_push_apply",
  "acc_tally_bridge_record_tb",
  "acc_tally_bridge_retry",
  "acc_tally_bridge_revoke",
  "acc_tally_bridge_save_settings",
  "acc_tally_bridge_tick",
];

/** Phase 22H SECURITY DEFINER functions (fixed assets and schedules) that only server code (service role) may run. */
const PHASE22H_SERVICE_FUNCTIONS = [
  "acc_asset_disposal_cancel",
  "acc_asset_disposal_post",
  "acc_asset_disposal_prepare",
  "acc_asset_run_post",
  "acc_asset_run_prepare",
  "acc_assets_seed",
];

/** Phase 17 SECURITY DEFINER functions that only server code (service role) may run. */
const PHASE17_SERVICE_FUNCTIONS = ["ai_add_conversation_tags"];

/** Phase 14 SECURITY DEFINER functions that only server code (service role) may run. */
const PHASE14_SERVICE_FUNCTIONS = ["accept_slot_offer", "demo_wipe_org"];

/** Phase 20g (campaign A/B tests) SECURITY DEFINER functions that only server code (service role) may run. */
const SF20G_SERVICE_FUNCTIONS = ["campaign_ab_funnel"];

/** Phase 20c (routing) SECURITY DEFINER functions that only server code (service role) or pg_cron may run. */
const SF20C_SERVICE_FUNCTIONS = [
  "enquiry_ids_visible_to",
  "pick_round_robin_assignee_capped",
  "presence_auto_away_sweep",
  "route_conversation",
];

/**
 * Tables whose BEFORE-INSERT triggers (cross-org consistency checks, system-role protection)
 * raise before RLS is evaluated, so the generic insert probe sees 23514 instead of 42501.
 * Their policies are proven by the dedicated per-table suites, which this file checks by name.
 */
const TRIGGER_GUARDED = new Set([
  "conversation_labels",
  "conversations",
  "enquiries",
  "invites",
  "memberships",
  "team_members",
]);

/** Helpers a policy must call to be considered org-scoped. */
const ORG_SCOPE_MARKERS = [
  "org_id",
  "app.is_org_member",
  "app.has_perm",
  "app.user_org_ids",
  "app.can_view_conversation",
  "app.shares_org_with",
];

type Rel = { name: string; rls: boolean; has_org: boolean; policies: number };

describe.skipIf(!TEST_DATABASE_URL)("security guard (catalog)", () => {
  let c: Client;
  let rels: Rel[];

  beforeAll(async () => {
    c = await connect();
    const { rows } = await c.query<Rel>(`
      select c.relname as name, c.relrowsecurity as rls,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`);
    rels = rows;
  });
  afterAll(async () => {
    await c.end();
  });

  it("sees the schema (guards against an empty catalog making every test vacuous)", () => {
    expect(rels.length).toBeGreaterThanOrEqual(35);
  });

  it("has row level security enabled on every public table", () => {
    expect(rels.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
  });

  it("gives every org-scoped table at least one policy unless it is explicitly service-only", () => {
    const missing = rels.filter((r) => r.has_org && r.policies === 0 && !SERVICE_ONLY.has(r.name));
    expect(missing.map((r) => r.name)).toEqual([]);
  });

  it("keeps the service-only allowlist honest: listed tables have no API policy and exist", () => {
    const byName = new Map(rels.map((r) => [r.name, r]));
    for (const t of SERVICE_ONLY) {
      expect(byName.has(t), `${t} is in SERVICE_ONLY but does not exist`).toBe(true);
      expect(byName.get(t)!.policies, `${t} has policies; remove it from SERVICE_ONLY`).toBe(0);
    }
  });

  it("scopes every policy on an org table to the org (no using(true), no unscoped policy)", async () => {
    const { rows } = await c.query<{
      tablename: string;
      policyname: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public'`,
    );
    const orgTables = new Set(rels.filter((r) => r.has_org).map((r) => r.name));
    const bad: string[] = [];
    for (const p of rows) {
      if (/anon|public/.test(p.roles) && !/authenticated/.test(p.roles))
        bad.push(`${p.tablename}.${p.policyname}: applies to anon/public`);
      const exprs = [p.qual, p.with_check].filter((e): e is string => !!e);
      if (exprs.some((e) => e.trim() === "true"))
        bad.push(`${p.tablename}.${p.policyname}: always true`);
      if (orgTables.has(p.tablename) && exprs.length > 0) {
        const joined = exprs.join(" ");
        if (!ORG_SCOPE_MARKERS.some((m) => joined.includes(m)))
          bad.push(`${p.tablename}.${p.policyname}: not org-scoped`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("pins search_path on every SECURITY DEFINER function in public and app", async () => {
    const { rows } = await c.query<{ name: string }>(`
      select n.nspname || '.' || p.proname as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app') and p.prokind = 'f' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("exposes no SECURITY DEFINER RPC in public to anon, and only the allowlisted ones to signed-in users", async () => {
    const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean }>(`
      select p.proname as name,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef`);
    expect(rows.filter((r) => r.anon).map((r) => r.name)).toEqual([]);
    expect(
      rows.filter((r) => r.auth && !AUTHENTICATED_RPCS.has(r.name)).map((r) => r.name),
    ).toEqual([]);
    expect(rows.some((r) => AUTHENTICATED_RPCS.has(r.name) && r.auth)).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 15 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE15_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE15_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 16 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE16_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE16_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 18 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE18_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE18_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 20e service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [SF20E_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...SF20E_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 19 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE19_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE19_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 22C service-role functions", () => {
  it("exist and are executable by the service role only; the signature store is internal", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE22C_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE22C_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
      const inner = await c.query<{ auth: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'fin_store_approval_signature'`,
      );
      expect(inner.rows).toEqual([{ auth: false }]);
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 20 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE20_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE20_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 22I service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE22I_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE22I_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 22 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [
          [
            ...PHASE22_SERVICE_FUNCTIONS,
            ...PHASE22E_SERVICE_FUNCTIONS,
            ...PHASE22F_SERVICE_FUNCTIONS,
          ],
        ],
      );
      expect(rows.map((r) => r.name).sort()).toEqual(
        [
          ...PHASE22_SERVICE_FUNCTIONS,
          ...PHASE22E_SERVICE_FUNCTIONS,
          ...PHASE22F_SERVICE_FUNCTIONS,
        ].sort(),
      );
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 22G service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE22G_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE22G_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 20g (campaign A/B) service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [SF20G_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...SF20G_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 20c (Sanoflow parity) service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [SF20C_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...SF20C_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 22J service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE22J_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE22J_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 22H service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE22H_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE22H_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 17 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE17_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE17_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("phase 14 service-role functions", () => {
  it("exist and are executable by the service role only", async () => {
    const c = await connect();
    try {
      const { rows } = await c.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1)`,
        [PHASE14_SERVICE_FUNCTIONS],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...PHASE14_SERVICE_FUNCTIONS].sort());
      for (const r of rows)
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({
          name: r.name,
          anon: false,
          auth: false,
          svc: true,
        });
    } finally {
      await c.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("cross-org sweep over every org-scoped table", () => {
  let c: Client;
  let alice: string; // admin of org A
  let bob: string; // admin of org B
  let nobody: string; // signed up, no membership
  let orgA: string;
  let orgB: string;
  let orgTables: string[];
  let allTables: string[];

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    nobody = await createAuthUser(c, "nobody@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);

    const { rows } = await c.query<{ name: string; has_org: boolean; policies: number }>(`
      select c.relname as name,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`);
    allTables = rows.map((r) => r.name);
    orgTables = rows.filter((r) => r.has_org && r.policies > 0).map((r) => r.name);

    // Give org A some rows in tables that are service-only or otherwise easy to seed.
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.rate_limit_hits (key, window_start, hits) values ('sweep', now(), 1)",
      );
      await c.query(
        "insert into public.webhook_events_in (source, payload) values ('meta', '{}'::jsonb)",
      );
      await c
        .query(
          "insert into public.job_runs (queue, handler, started_at) values ('sweep', 'sweep', now())",
        )
        .catch(() => {});
      await c.query("insert into public.teams (org_id, name) values ($1, 'Front desk')", [orgA]);
      await c.query(
        "insert into public.notifications (org_id, user_id, type, title) values ($1, $2, 'system', 'hello')",
        [orgA, alice],
      );
      await c.query(
        "insert into public.audit_log (org_id, user_id, action, entity) values ($1, $2, 'sweep.test', 'org')",
        [orgA, alice],
      );
    });
    // Phase 15 tables: one row each in org A, so the cross-org sweeps below are not vacuous for them.
    await seedSecurityRows(c, orgA, alice);
    // Phase 13 tables likewise.
    await seedPhase13Rows(c, orgA, alice);
    // Phase 14 tables likewise.
    await seedPhase14Rows(c, orgA, alice);
    // Phase 16 tables likewise.
    await seedPhase16Rows(c, orgA, alice);
    // Phase 18 tables likewise.
    await seedPhase18Rows(c, orgA, alice);
    // Phase 17 tables likewise.
    await seedPhase17Rows(c, orgA, alice);
    // Phase 19 tables likewise.
    await seedPhase19Rows(c, orgA, alice);
    // Phase 20 tables likewise.
    await seedPhase20Rows(c, orgA, alice);
    // Phase 20D tables likewise.
    await seedPhase20DRows(c, orgA, alice);
    // Phase 21 tables likewise.
    await seedPhase21Rows(c, orgA);
    // Phase 20a (Sanoflow) tables likewise.
    await seedPhase20aRows(c, orgA);
    // Phase 22A (accounting) tables likewise.
    await seedPhase22Rows(c, orgA);
    // Phase 22C (digital signatures) tables likewise.
    await seedPhase22CRows(c, orgA, alice);
    // Phase 22E (receivables) tables likewise.
    await seedPhase22ERows(c, orgA, alice);
    // Phase 22F (banking and cash) tables likewise.
    await seedPhase22FRows(c, orgA, alice);
    // Phase 22G (statements: budgets) likewise.
    await seedPhase22GRows(c, orgA, alice);
    // Phase 22I (Tally import) tables likewise.
    await seedPhase22IRows(c, orgA);
    // Phase 22H (fixed assets and schedules) tables likewise.
    await seedPhase22HRows(c, orgA);
    // Phase 22J (Tally bridge) tables likewise.
    await seedPhase22JRows(c, orgA);
    // Phase 20c booking-capacity tables likewise.
    await seedSf20cBookingRows(c, orgA);
    // Phase 20c tables likewise.
    await seedSf20cRows(c, orgA, alice);
    // Phase 20d tables likewise.
    await seedSf20dRows(c, orgA);
    // Phase 20e tables likewise.
    await seedSf20eRows(c, orgA, alice);
    // Phase 20g (campaign A/B tests) tables likewise.
    await seedSf20gRows(c, orgA);
    // Phase 20i (Meta ads spend) tables likewise.
    await seedSf20iRows(c, orgA);
    // Portal tags (docs/33) likewise.
    await seedPortalTagRows(c, orgA);
    // Soft delete (docs/35): one item in the bin, so the service-only read check is not vacuous.
    await seedSoftDeleteRows(c, orgA, alice);
    // M4 (recruitment calculator): a saved scenario and the seeded calendar.
    await seedM4aRows(c, orgA);
    // M3 rooms and capacity likewise.
    await seedM3Rows(c, orgA);
    // Phase C (organisation): a staff member, a duty and a shift.
    await seedOrganisationRows(c, orgA);
    // Phase F (tasks v2): a task with a checklist line, a comment and a file, and a daily checklist template.
    await seedPhaseFRows(c, orgA, alice);
    // Phase G (scheduled report e-mails): a schedule and one run.
    await seedPhaseGRows(c, orgA, alice);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("covers a meaningful number of tables", () => {
    expect(orgTables.length).toBeGreaterThanOrEqual(25);
  });

  it("sweeps every Phase 13 to 22 table (a new table must be added to PHASE13_TABLES ... PHASE22_TABLES and seeded)", () => {
    for (const t of [
      ...M4A_TABLES,
      ...M3_TABLES,
      ...SF20G_TABLES,
      ...SF20E_TABLES,
      ...SF20I_TABLES,
      ...PORTAL_TAGS_TABLES,
      ...ORGANISATION_TABLES,
      ...PHASE_F_TABLES,
      ...PHASE_G_TABLES,
      ...SF20D_TABLES,
      ...SF20C_BOOKING_TABLES,
      ...SF20C_TABLES,
      ...PHASE22G_TABLES,
      ...PHASE22I_TABLES,
      ...PHASE22_TABLES,
      ...PHASE22C_TABLES,
      ...PHASE22E_TABLES,
      ...PHASE22F_TABLES,
      ...PHASE22H_TABLES,
      ...PHASE22J_TABLES,
      ...PHASE21_TABLES,
      ...PHASE20_TABLES,
      ...PHASE20A_TABLES,
      ...PHASE20D_TABLES,
      ...PHASE19_TABLES,
      ...PHASE18_TABLES,
      ...PHASE17_TABLES,
      ...PHASE16_TABLES,
      ...PHASE15_TABLES,
      ...PHASE14_TABLES,
      ...PHASE13_TABLES,
    ])
      expect(orgTables, `${t} is not in the org sweep`).toContain(t);
  });

  it("really holds org A rows in the Phase 13 to 21 tables, visible to org A's admin (control for the leak sweep)", async () => {
    await asUser(c, alice, async () => {
      for (const t of [
        ...M4A_TABLES,
        ...M3_TABLES,
        ...SF20G_TABLES,
        ...SF20E_TABLES,
        ...SF20I_TABLES,
        ...PORTAL_TAGS_TABLES,
        ...ORGANISATION_TABLES,
        ...PHASE_F_TABLES,
        ...PHASE_G_TABLES,
        ...SF20D_TABLES,
        ...SF20C_BOOKING_TABLES,
        ...SF20C_TABLES,
        ...PHASE22G_TABLES,
        ...PHASE22I_TABLES,
        ...PHASE22_TABLES,
        ...PHASE22C_TABLES,
        ...PHASE22E_TABLES,
        ...PHASE22F_TABLES,
        ...PHASE22H_TABLES,
        ...PHASE22J_TABLES,
        ...PHASE21_TABLES,
        ...PHASE20_TABLES,
        ...PHASE20A_TABLES,
        ...PHASE20D_TABLES,
        ...PHASE19_TABLES,
        ...PHASE18_TABLES,
        ...PHASE17_TABLES,
        ...PHASE16_TABLES,
        ...PHASE15_TABLES,
        ...PHASE14_TABLES,
        ...PHASE13_TABLES,
      ]) {
        const { rows } = await c.query<{ n: string }>(
          `select count(*)::text as n from public.${t} where org_id = $1`,
          [orgA],
        );
        expect(Number(rows[0].n), t).toBeGreaterThan(0);
      }
    });
  });

  it("hides org A rows from org B's admin in every org-scoped table", async () => {
    const leaks: string[] = [];
    await asUser(c, bob, async () => {
      for (const t of orgTables) {
        const { rows } = await c.query<{ n: string }>(
          `select count(*)::text as n from public.${t} where org_id = $1`,
          [orgA],
        );
        if (Number(rows[0].n) !== 0) leaks.push(t);
      }
    });
    expect(leaks).toEqual([]);
  });

  it("shows a signed-in user without a membership nothing at all, and anon nothing either", async () => {
    const seen: string[] = [];
    await asUser(c, nobody, async () => {
      for (const t of orgTables) {
        const { rows } = await c.query<{ n: string }>(
          `select count(*)::text as n from public.${t}`,
        );
        if (Number(rows[0].n) !== 0) seen.push(`authenticated:${t}`);
      }
    });
    await c.query("set role anon");
    try {
      for (const t of allTables) {
        const { rows } = await c
          .query<{ n: string }>(`select count(*)::text as n from public.${t}`)
          .catch(() => ({ rows: [{ n: "0" }] }));
        if (Number(rows[0].n) !== 0) seen.push(`anon:${t}`);
      }
    } finally {
      await c.query("reset role");
    }
    expect(seen).toEqual([]);
  });

  it("denies signed-in users every read of the service-only tables", async () => {
    const seen: string[] = [];
    await asUser(c, alice, async () => {
      for (const t of [
        "rate_limit_hits",
        "webhook_events_in",
        "dead_letters",
        "job_runs",
        "channel_secrets",
        "channel_send_slots",
        "scheduled_jobs",
        "import_runs",
        ...PHASE18_SERVICE_ONLY_TABLES,
        ...PHASE19_SERVICE_ONLY_TABLES,
        ...SF20E_SERVICE_ONLY_TABLES,
        ...PHASE20D_SERVICE_ONLY_TABLES,
        ...PHASE22C_SERVICE_ONLY_TABLES,
        ...PHASE22_SERVICE_ONLY_TABLES,
        ...PHASE22I_SERVICE_ONLY_TABLES,
        ...PHASE22J_SERVICE_ONLY_TABLES,
        ...SOFT_DELETE_SERVICE_ONLY_TABLES,
        ...PHASE23_SERVICE_ONLY_TABLES,
      ]) {
        const { rows } = await c
          .query<{ n: string }>(`select count(*)::text as n from public.${t}`)
          .catch(() => ({ rows: [{ n: "0" }] }));
        if (Number(rows[0].n) !== 0) seen.push(t);
      }
    });
    expect(seen).toEqual([]);
  });

  it("rejects an insert into org A by org B's admin on every org-scoped table (RLS fires before NOT NULL)", async () => {
    const notBlocked: string[] = [];
    await asUser(c, bob, async () => {
      for (const t of orgTables) {
        await c.query("begin");
        try {
          await c.query(`insert into public.${t} (org_id) values ($1)`, [orgA]);
          notBlocked.push(`${t}: insert succeeded`);
        } catch (err) {
          const code = (err as { code?: string }).code;
          const ok = code === "42501" || (code === "23514" && TRIGGER_GUARDED.has(t));
          if (!ok) notBlocked.push(`${t}: ${code}`);
        }
        await c.query("rollback");
      }
    });
    expect(notBlocked).toEqual([]);
  });

  it("has a dedicated cross-org suite for every trigger-guarded table", () => {
    const suites = ["rls.test.ts", "crm-rls.test.ts", "inbox-rls.test.ts", "enquiries-rls.test.ts"]
      .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"))
      .join("\n");
    for (const t of TRIGGER_GUARDED)
      expect(suites, `${t} is not covered by a per-table RLS suite`).toMatch(
        new RegExp(`\\b${t}\\b`),
      );
  });

  it("the insert probe can tell RLS from other failures (control: org A's admin reaches the constraint check)", async () => {
    await asUser(c, alice, async () => {
      await c.query("begin");
      const err = await c.query("insert into public.teams (org_id) values ($1)", [orgA]).then(
        () => null,
        (e: { code?: string }) => e,
      );
      await c.query("rollback");
      expect(err?.code).toBe("23502"); // not-null on name, i.e. RLS let it through
    });
  });

  it("lets org B's admin neither update nor delete org A rows", async () => {
    await asUser(c, bob, async () => {
      for (const t of orgTables) {
        await c.query("begin");
        const u = await c
          .query(`update public.${t} set org_id = org_id where org_id = $1`, [orgA])
          .catch(() => ({ rowCount: 0 }));
        const d = await c
          .query(`delete from public.${t} where org_id = $1`, [orgA])
          .catch(() => ({ rowCount: 0 }));
        await c.query("rollback");
        expect(u.rowCount ?? 0, `${t} update`).toBe(0);
        expect(d.rowCount ?? 0, `${t} delete`).toBe(0);
      }
    });
  });

  it("does not let org B's admin move org B data into org A by changing org_id", async () => {
    await asServiceRole(c, async () => {
      await c.query("insert into public.teams (org_id, name) values ($1, 'B team')", [orgB]);
    });
    await asUser(c, bob, async () => {
      await c.query("begin");
      const err = await c
        .query("update public.teams set org_id = $1 where org_id = $2", [orgA, orgB])
        .then(
          () => null,
          (e: { code?: string }) => e,
        );
      await c.query("rollback");
      expect(err?.code).toBe("42501");
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("audit_log is append-only", () => {
  let c: Client;
  let alice: string;
  let orgA: string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.audit_log (org_id, user_id, action, entity) values ($1, $2, 'x.created', 'x')",
        [orgA, alice],
      );
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("blocks UPDATE and DELETE even for the service role", async () => {
    await asServiceRole(c, async () => {
      for (const sql of [
        "update public.audit_log set action = 'tampered'",
        "update public.audit_log set diff = '{}'::jsonb",
        "delete from public.audit_log",
      ]) {
        await c.query("begin");
        const err = await c.query(sql).then(
          () => null,
          (e: { message?: string }) => e,
        );
        await c.query("rollback");
        expect(err?.message, sql).toMatch(/append-only/);
      }
    });
  });

  it("still allows inserts, the user_id null-out when a user is removed, and the org cascade", async () => {
    await asServiceRole(c, async () => {
      await c.query(
        "insert into public.audit_log (org_id, user_id, action, entity) values ($1, $2, 'y.created', 'y')",
        [orgA, alice],
      );
    });
    await c.query("delete from auth.users where id = $1", [alice]);
    const { rows } = await c.query<{ n: string; nulls: string }>(
      "select count(*)::text as n, count(*) filter (where user_id is null)::text as nulls from public.audit_log where org_id = $1",
      [orgA],
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(2);
    expect(rows[0].nulls).toBe(rows[0].n);
    // Orgs are never deleted in normal operation (system roles are protected); lift that guard
    // inside a transaction to prove the cascade is the one path that may remove audit rows.
    await c.query("begin");
    try {
      await c.query("alter table public.roles disable trigger user");
      await c.query("delete from public.orgs where id = $1", [orgA]);
      const after = await c.query("select 1 from public.audit_log where org_id = $1", [orgA]);
      expect(after.rowCount).toBe(0);
    } finally {
      await c.query("rollback");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("rate_limit_hit()", () => {
  let c: Client;

  beforeAll(async () => {
    c = await connect();
    await c.query("truncate public.rate_limit_hits");
  });
  afterAll(async () => {
    await c.query("truncate public.rate_limit_hits");
    await c.end();
  });

  const hit = async (key: string, limit: number, window = 60) => {
    const { rows } = await c.query<{ allowed: boolean; hits: number; retry_after: number }>(
      "select * from public.rate_limit_hit($1, $2, $3)",
      [key, limit, window],
    );
    return rows[0];
  };

  it("allows up to the limit then blocks with a retry_after inside the window", async () => {
    expect((await hit("k1", 3)).allowed).toBe(true);
    expect((await hit("k1", 3)).allowed).toBe(true);
    const third = await hit("k1", 3);
    expect(third).toMatchObject({ allowed: true, hits: 3, retry_after: 0 });
    const fourth = await hit("k1", 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retry_after).toBeGreaterThanOrEqual(1);
    expect(fourth.retry_after).toBeLessThanOrEqual(60);
  });

  it("keeps keys independent", async () => {
    await hit("a", 1);
    expect((await hit("a", 1)).allowed).toBe(false);
    expect((await hit("b", 1)).allowed).toBe(true);
  });

  it("is atomic under parallel callers: exactly `limit` are allowed", async () => {
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect()));
    try {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          clients[i % clients.length].query<{ allowed: boolean }>(
            "select allowed from public.rate_limit_hit('parallel', 10, 60)",
          ),
        ),
      );
      expect(results.filter((r) => r.rows[0].allowed)).toHaveLength(10);
    } finally {
      await Promise.all(clients.map((x) => x.end()));
    }
  });

  it("rejects empty and oversized keys", async () => {
    await expect(hit("", 1)).rejects.toThrow(/invalid rate limit key/);
    await expect(hit("x".repeat(201), 1)).rejects.toThrow(/invalid rate limit key/);
  });

  it("is callable by the service role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await c.query(`set role ${role}`);
      await c.query("begin");
      const err = await c.query("select * from public.rate_limit_hit('nope', 1, 60)").then(
        () => null,
        (e: { code?: string }) => e,
      );
      await c.query("rollback");
      await c.query("reset role");
      expect(err?.code, role).toBe("42501");
    }
    await asServiceRole(c, async () => {
      expect((await hit("svc", 1)).allowed).toBe(true);
    });
  });
});
