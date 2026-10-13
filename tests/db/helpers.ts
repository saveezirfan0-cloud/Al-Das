/**
 * Helpers for tests that run against a real Postgres prepared by scripts/test-db.sh.
 * Skipped entirely when TEST_DATABASE_URL is not set.
 */
import { createHmac } from "node:crypto";

import { Client } from "pg";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  return client;
}

/** Wipe tenant + job data between test files. */
export async function resetDb(c: Client) {
  await c.query("reset role");
  await c.query("truncate public.orgs cascade");
  await c.query("truncate public.scheduled_jobs, public.job_runs, public.dead_letters, public.flow_locks");
  await c.query("delete from auth.users");
  for (const q of ["outbound", "outbound_priority", "flow_steps", "notifications", "meta_events", "webhooks_out", "kb_ingest", "ai_insights", "sms_outbound", "capi_events", "clinical"]) {
    await c.query(`delete from pgmq.q_${q}`);
    await c.query(`delete from pgmq.a_${q}`);
  }
}

export async function createAuthUser(c: Client, email: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  return rows[0].id;
}

export const ROLES = [
  { name: "Admin", description: "all", permissions: ["*"] },
  { name: "Agent", description: "agent", permissions: ["inbox.send", "contacts.view"] },
];

/** Create an org via the create_org RPC as the service role. */
export async function createOrg(
  c: Client,
  name: string,
  slug: string,
  ownerId: string,
): Promise<string> {
  await c.query("set role service_role");
  const { rows } = await c.query<{ id: string }>(
    "select public.create_org($1, $2, $3::jsonb, $4) as id",
    [name, slug, JSON.stringify(ROLES), ownerId],
  );
  await c.query("reset role");
  return rows[0].id;
}

/** Run the callback as an authenticated user (RLS enforced). */
export async function asUser<T>(c: Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await c.query("set role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', false)");
  }
}

export async function asServiceRole<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query("set role service_role");
  try {
    return await fn();
  } finally {
    await c.query("reset role");
  }
}

export async function count(c: Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    `select count(*)::text as n from (${sql}) t`,
    params,
  );
  return Number(rows[0].n);
}

/**
 * One row in every Phase 15 table for an org, so cross-org sweeps are not vacuous. Returns the ids needed
 * by the dedicated tests. Service role only (these tables have no write policies).
 */
export async function seedSecurityRows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) => (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.authEvent = await one(
      "insert into public.auth_events (org_id, user_id, event_type, ip_address, ip_hash, ua_family) values ($1, $2, 'sign_in', '203.0.113.7', 'hash', 'Chrome on Windows')",
      [orgId, userId],
    );
    ids.session = await one("insert into public.user_sessions (org_id, user_id, session_id) values ($1, $2, 'sess-' || gen_random_uuid()::text)", [orgId, userId]);
    ids.access = await one("insert into public.record_access_log (org_id, user_id, entity, entity_id, action) values ($1, $2, 'contact', 'c-1', 'view')", [orgId, userId]);
    ids.alert = await one("insert into public.security_alerts (org_id, kind, user_id, dedupe_key, summary) values ($1, 'bulk_export', $2, 'seed-' || gen_random_uuid()::text, 'Large export')", [orgId, userId]);
    ids.apiKey = await one("insert into public.api_keys (org_id, name, key_prefix, key_hash, created_by) values ($1, 'seed key', 'pk_seed', 'hash-' || gen_random_uuid()::text, $2)", [orgId, userId]);
    await c.query("insert into public.api_read_log (org_id, api_key_id, resource, bucket, request_count, row_count) values ($1, $2, 'contacts', date_trunc('hour', now()), 1, 5)", [orgId, ids.apiKey]);
    ids.review = await one("insert into public.access_reviews (org_id, period, snapshot, opened_by) values ($1, '2026-Q4', '[]'::jsonb, $2)", [orgId, userId]);
    ids.contact = await one("insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Sample', 'Patient', '+971500000001')", [orgId]);
    ids.privacy = await one(
      "insert into public.privacy_requests (org_id, kind, contact_id, reason, requested_by) values ($1, 'export', $2, 'seed request for tests', $3)",
      [orgId, ids.contact, userId],
    );
    ids.history = await one("insert into public.record_history (org_id, table_name, record_id, op, changes) values ($1, 'tasks', gen_random_uuid(), 'update', '{\"subject\": {\"from\": \"a\", \"to\": \"b\"}}'::jsonb)", [orgId]);
  });
  return ids;
}

/** The tables Phase 15 added, for catalogue assertions. */
export const PHASE15_TABLES = [
  "access_reviews",
  "api_read_log",
  "auth_events",
  "privacy_requests",
  "record_access_log",
  "record_history",
  "security_alerts",
  "user_sessions",
] as const;

/**
 * One row in every Phase 13 table (notification preferences, push subscriptions, digest log) for an org, so
 * the cross-org sweeps are not vacuous for them. Service role only: push_subscriptions and the digest log have
 * no write policy, and notification_preferences is written here directly to keep the seed uniform.
 */
export async function seedPhase13Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) => (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.pref = await one("insert into public.notification_preferences (org_id, user_id, event, channel, enabled) values ($1, $2, 'inbox.message', 'push', false)", [orgId, userId]);
    ids.push = await one(
      "insert into public.push_subscriptions (org_id, user_id, endpoint_hash, subscription_enc, ua_family) values ($1, $2, repeat('a', 64), 'v1:seed:seed:seed', 'Chrome on Android')",
      [orgId, userId],
    );
    ids.digest = await one("insert into public.notification_digest_log (org_id, user_id, kind, period_key) values ($1, $2, 'daily', '2026-10-12')", [orgId, userId]);
  });
  return ids;
}

/** The tables Phase 13 added, for catalogue assertions. */
export const PHASE13_TABLES = ["notification_digest_log", "notification_preferences", "push_subscriptions"] as const;

/** An HS256 JWT for an authenticated user, signed with the test PostgREST secret (see supabase/test/README.md). */
export function userJwt(userId: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" });
  const body = b({ sub: userId, role: "authenticated", exp: 4102444800 });
  const sig = createHmac("sha256", "pulse-test-jwt-secret-pulse-test-jwt-secret").update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/**
 * One row in every Phase 14 table (handover notes, feedback, household links, waiting list, slot offers) for an
 * org, so the cross-org sweeps are not vacuous for them. Synthetic names and reserved test numbers only.
 */
export async function seedPhase14Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) => (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.location = await one("insert into public.locations (org_id, name) values ($1, 'Seed clinic 14')", [orgId]);
    ids.specialist = await one("insert into public.specialists (org_id, name) values ($1, 'Dr Seed 14')", [orgId]);
    ids.service = await one("insert into public.services (org_id, name, duration_min) values ($1, 'Seed consult 14', 30)", [orgId]);
    ids.guardian = await one("insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Guardian', 'Seed', '+971500000141')", [orgId]);
    ids.dependant = await one("insert into public.contacts (org_id, first_name, last_name) values ($1, 'Dependant', 'Seed')", [orgId]);
    ids.link = await one("insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id, created_by) values ($1, $2, $3, $4)", [orgId, ids.guardian, ids.dependant, userId]);
    ids.entry = await one("insert into public.waitlist_entries (org_id, contact_id, specialist_id, service_id, created_by) values ($1, $2, $3, $4, $5)", [orgId, ids.guardian, ids.specialist, ids.service, userId]);
    ids.offer = await one(
      "insert into public.slot_offers (org_id, waitlist_entry_id, specialist_id, location_id, service_id, starts_at, ends_at, expires_at) values ($1, $2, $3, $4, $5, now() + interval '2 days', now() + interval '2 days 30 minutes', now() + interval '1 day')",
      [orgId, ids.entry, ids.specialist, ids.location, ids.service],
    );
    ids.note = await one("insert into public.handover_notes (org_id, body, created_by) values ($1, 'Seed handover note', $2)", [orgId, userId]);
    ids.feedback = await one("insert into public.help_feedback (org_id, user_id, page, kind, message) values ($1, $2, '/front-desk', 'idea', 'Seed feedback')", [orgId, userId]);
  });
  return ids;
}

/** The tables Phase 14 added, for catalogue assertions. */
export const PHASE14_TABLES = ["handover_notes", "help_feedback", "household_links", "slot_offers", "waitlist_entries"] as const;

/**
 * One row in every Phase 16 table (media folders and assets, patient documents, retention policies) for an org, so
 * the cross-org sweeps are not vacuous for them. Synthetic names; the "files" are never uploaded anywhere.
 */
export async function seedPhase16Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) => (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.folder = await one("insert into public.media_folders (org_id, name, created_by) values ($1, 'Seed folder 16', $2)", [orgId, userId]);
    ids.assetId = (await c.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0].id;
    ids.asset = await one(
      "insert into public.media_assets (id, org_id, folder_id, name, kind, mime_type, size_bytes, storage_path, status, uploaded_by) values ($2::uuid, $1::uuid, $3, 'Seed image 16', 'image', 'image/jpeg', 1234, $1::uuid::text || '/' || $2::uuid::text || '/original.jpg', 'ready', $4)",
      [orgId, ids.assetId, ids.folder, userId],
    );
    ids.contact16 = await one("insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Docs', 'Seed', '+971500000161')", [orgId]);
    ids.docId = (await c.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0].id;
    ids.document = await one(
      "insert into public.patient_documents (id, org_id, contact_id, category, title, mime_type, size_bytes, storage_path, status, uploaded_by) values ($3::uuid, $1::uuid, $2::uuid, 'insurance_card', 'Seed card 16', 'image/jpeg', 2345, $1::uuid::text || '/' || $2::uuid::text || '/' || $3::uuid::text || '.jpg', 'ready', $4)",
      [orgId, ids.contact16, ids.docId, userId],
    );
    await c.query("insert into public.document_retention_policies (org_id, category, retain_days, auto_delete, updated_by) values ($1, 'referral', 365, false, $2)", [orgId, userId]);
  });
  return ids;
}

/** The tables Phase 16 added, for catalogue assertions. */
export const PHASE16_TABLES = ["document_retention_policies", "media_assets", "media_folders", "patient_documents"] as const;

/**
 * One row in every Phase 18 table that has a browser policy, for an org, so the cross-org sweeps are not vacuous for
 * them (synthetic ids and amounts only). The two raw/uploaded-payload tables (service-role only) get a row as well.
 * Service role only: none of these tables has a write policy.
 */
export async function seedPhase18Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    await c.query(
      "insert into public.fin_ref_payer_prices (org_id, payer_id, cpt_code, agreed_price) values ($1, 'PAYER-SEED', '99213', 150)",
      [orgId],
    );
    await c.query(
      "insert into public.fin_ref_account_map (org_id, kind, key, account_code, account_name) values ($1, 'receivable', 'insurance', '1200', 'Seed receivable')",
      [orgId],
    );
    ids.preauth = await one(
      "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, auth_number, status, expires_on, created_by) values ($1, 'PIN-SEED-18', 'PAYER-SEED', 'AUTH-SEED-1', 'approved', '2027-01-31', $2)",
      [orgId, userId],
    );
    ids.eligibility = await one(
      "insert into public.fin_eligibility_checks (org_id, patient_pin, payer_id, status, valid_to, checked_on, created_by) values ($1, 'PIN-SEED-18', 'PAYER-SEED', 'verified', '2027-01-31', '2026-10-01', $2)",
      [orgId, userId],
    );
    ids.claim = await one(
      "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, net, remitted, rejected, last_denial_code, first_remittance_date) values ($1, 'CA-SEED-18', 'ADMC/C/18001', '99213', 'PAYER-SEED', '2026-09-01', 100, 60, 40, 'AUTH-001', '2026-09-20')",
      [orgId],
    );
    ids.denialCase = await one(
      "insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, payer_id, rejected_amount, reason_code, category, denied_on, deadline_on) values ($1, $2, 'CA-SEED-18', 'PAYER-SEED', 40, 'AUTH-001', 'authorization', '2026-09-20', '2026-10-20')",
      [orgId, ids.claim],
    );
    ids.denialNote = await one(
      "insert into public.ins_denial_notes (org_id, case_id, user_id, note) values ($1, $2, $3, 'Seed note')",
      [orgId, ids.denialCase, userId],
    );
    ids.appeal = await one(
      "insert into public.ins_appeal_drafts (org_id, case_id, kind, body, created_by) values ($1, $2, 'template', 'DRAFT seed letter', $3)",
      [orgId, ids.denialCase, userId],
    );
    ids.remitFile = await one(
      "insert into public.fin_raw_remittance_files (org_id, file_sha256, status, uploaded_by) values ($1, 'seed-sha-' || gen_random_uuid()::text, 'validated', $2)",
      [orgId, userId],
    );
    await c.query(
      "insert into public.fin_staged_remittance_lines (org_id, file_id, row_no, data) values ($1, $2, 2, '{}'::jsonb)",
      [orgId, ids.remitFile],
    );
    ids.remitBatch = await one(
      "insert into public.ins_remittance_batches (org_id, file_id, remittance_ref, payer_id, created_by) values ($1, $2, 'RM-SEED', 'PAYER-SEED', $3)",
      [orgId, ids.remitFile, userId],
    );
    ids.remitLine = await one(
      "insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, claim_activity_number, paid_amount, claim_activity_id, match_status) values ($1, $2, 2, 'seed|' || gen_random_uuid()::text, 'CA-SEED-18', 60, $3, 'matched')",
      [orgId, ids.remitBatch, ids.claim],
    );
    ids.close = await one(
      "insert into public.fin_period_closes (org_id, month) values ($1, '2026-01-01')",
      [orgId],
    );
    ids.cashup = await one(
      "insert into public.fin_cashups (org_id, branch_code, business_date, prepared_by) values ($1, 'P', '2026-10-01', $2)",
      [orgId, userId],
    );
    await c.query(
      "insert into public.fin_cashup_lines (org_id, cashup_id, payment_mode, expected_amount, counted_amount) values ($1, $2, 'CASH', 100, 100)",
      [orgId, ids.cashup],
    );
    ids.invoice = await one(
      "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, inv_type, gross, net, total, record_hash) values ($1, 'ADMC/C/18001', '2026-09-01', 'PIN-SEED-18', 'P', 'SELF PAID', 100, 100, 100, 'h')",
      [orgId],
    );
    ids.reminder = await one(
      "insert into public.fin_recovery_reminders (org_id, invoice_id, patient_pin, sequence_no, status) values ($1, $2, 'PIN-SEED-18', 1, 'queued')",
      [orgId, ids.invoice],
    );
    ids.export = await one(
      "insert into public.fin_accounting_exports (org_id, period_from, period_to, status, row_count, debit_total, credit_total, checksum, exported_by) values ($1, '2026-09-01', '2026-09-30', 'provisional', 4, 10, 10, 'abc', $2)",
      [orgId, userId],
    );
  });
  return ids;
}

/** Phase 18 tables with a browser (select) policy. fin_ref_finance_settings and fin_ref_denial_codes are seeded for every org. */
export const PHASE18_TABLES = [
  "fin_accounting_exports",
  "fin_cashup_lines",
  "fin_cashups",
  "fin_eligibility_checks",
  "fin_period_closes",
  "fin_pre_authorisations",
  "fin_recovery_reminders",
  "fin_ref_account_map",
  "fin_ref_denial_codes",
  "fin_ref_finance_settings",
  "fin_ref_payer_prices",
  "ins_appeal_drafts",
  "ins_denial_cases",
  "ins_denial_notes",
  "ins_remittance_batches",
  "ins_remittance_lines",
] as const;

/** Phase 18 tables that hold uploaded payloads: RLS on, no policy, service role only. */
export const PHASE18_SERVICE_ONLY_TABLES = [
  "fin_raw_remittance_files",
  "fin_staged_remittance_lines",
] as const;

/**
 * One row in every Phase 17 table, for an org, so the cross-org sweeps are not vacuous for them (synthetic ids only; no
 * message text anywhere in these tables). Service role only: none of them has a write policy.
 */
export async function seedPhase17Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.channel17 = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Seed 17', 'waba-17-' || gen_random_uuid()::text, 'pn-17-' || gen_random_uuid()::text)",
      [orgId],
    );
    ids.contact17 = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Intent', 'Seed', '+971500000171')",
      [orgId],
    );
    ids.conversation17 = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id, last_inbound_at) values ($1, $2, $3, $4, now())",
      [orgId, ids.channel17, ids.contact17, userId],
    );
    ids.message17 = await one(
      "insert into public.messages (org_id, conversation_id, direction, kind, body, wa_message_id, status) values ($1, $2, 'in', 'text', 'synthetic message', 'wamid.seed17.' || gen_random_uuid()::text, 'received')",
      [orgId, ids.conversation17],
    );
    ids.intent = await one(
      "insert into public.ai_message_intents (org_id, conversation_id, message_id, source, intents, topic) values ($1, $2, $3, 'model', array['booking'], 'booking')",
      [orgId, ids.conversation17, ids.message17],
    );
    ids.usage17 = await one(
      "insert into public.ai_usage (org_id, user_id, conversation_id, feature, model, status, grounded) values ($1, $2, $3, 'suggest_reply', 'test-model', 'ok', false)",
      [orgId, userId, ids.conversation17],
    );
    await c.query(
      "insert into public.ai_suggestion_outcomes (ai_usage_id, org_id, user_id, conversation_id, outcome, similarity) values ($1, $2, $3, $4, 'edited', 61)",
      [ids.usage17, orgId, userId, ids.conversation17],
    );
    ids.report = await one(
      "insert into public.ai_quality_reports (org_id, week_start, week_end, stats, gaps) values ($1, '2026-10-05', '2026-10-12', '{\"suggestions\":{\"total\":1}}'::jsonb, '[]'::jsonb)",
      [orgId],
    );
  });
  return ids;
}

/** Phase 17 tables with a browser (select) policy. */
export const PHASE17_TABLES = ["ai_message_intents", "ai_quality_reports", "ai_suggestion_outcomes"] as const;

/**
 * One row in every Phase 19 table, for an org, so the cross-org sweeps are not vacuous for them (synthetic ids only; no phone,
 * name, message text, link or token anywhere). Service role only: none of them has a write policy.
 */
export async function seedPhase19Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.account = await one(
      "insert into public.integration_accounts (org_id, kind, config_enc, status, enabled) values ($1, 'sms', 'v1:seed:seed:seed', 'disabled', false) on conflict (org_id, kind) do update set kind = excluded.kind",
      [orgId],
    );
    await c.query(
      "insert into public.integration_calls (org_id, provider, operation, outcome, http_status, duration_ms) values ($1, 'twilio', 'sms.send', 'ok', 201, 120)",
      [orgId],
    );
    await c.query(
      "insert into public.integration_webhook_events (org_id, provider, event_key, outcome) values ($1, 'twilio', 'SMseed:delivered', 'applied_delivered')",
      [orgId],
    );
    await c.query(
      "insert into public.integration_usage_daily (org_id, provider, day, metric, value) values ($1, 'sms', current_date, 'sent', 1)",
      [orgId],
    );
    ids.specialist = await one(
      "insert into public.specialists (org_id, name) values ($1, 'Dr Seed 19')",
      [orgId],
    );
    ids.feed = await one(
      "insert into public.calendar_feeds (org_id, kind, specialist_id, label, token_hash, created_by) values ($1, 'specialist', $2, 'Seed feed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $3)",
      [orgId, ids.specialist, userId],
    );
    ids.contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Sms', 'Seed', '+971500000191')",
      [orgId],
    );
    ids.sms = await one(
      "insert into public.sms_messages (org_id, contact_id, provider, dedupe_key, status) values ($1, $2, 'twilio', 'seed:' || gen_random_uuid()::text, 'sent')",
      [orgId, ids.contact],
    );
    ids.invoice = await one(
      "insert into public.fin_invoices (org_id, inv_display_number, patient_pin, total, record_hash) values ($1, 'INV-SEED-19', 'PIN-SEED-19', 150, 'seed-hash-19')",
      [orgId],
    );
    ids.payment = await one(
      "insert into public.fin_payment_requests (org_id, invoice_id, invoice_number, patient_pin, provider, amount_minor, currency, status, created_by) values ($1, $2, 'INV-SEED-19', 'PIN-SEED-19', 'stripe', 15000, 'AED', 'sent', $3)",
      [orgId, ids.invoice, userId],
    );
    // Phase 19b: Google review requests (ids only).
    ids.appointment19b = await one(
      "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now() - interval '1 day', now() - interval '23 hours', 'completed')",
      [orgId, ids.contact],
    );
    // Phase 19b: ad attribution (a synthetic click id, no ad body or link) and one event row.
    ids.attribution = await one(
      "insert into public.ad_attributions (org_id, contact_id, waba_id, ctwa_clid, source_id, source_type, headline) values ($1, $2, '102290129340398', 'seed-click-' || gen_random_uuid()::text, '1202', 'ad', 'Seed headline')",
      [orgId, ids.contact],
    );
    ids.capiEvent = await one(
      "insert into public.capi_events (org_id, attribution_id, event_name, event_id, event_time, status) values ($1, $2, 'Contact', 'seed-event-' || gen_random_uuid()::text, now(), 'skipped')",
      [orgId, ids.attribution],
    );
    // Phase 19b: an e-signature request (masked signer hint only).
    ids.esign = await one(
      "insert into public.esign_requests (org_id, contact_id, source_kind, status, signer_hint) values ($1, $2, 'patient_document', 'failed', 's***@example.com')",
      [orgId, ids.contact],
    );
    // Phase 19b: a video room (token hash and a placeholder ciphertext; no real token).
    ids.room = await one(
      "insert into public.telehealth_rooms (org_id, appointment_id, provider, token_hash, token_enc, status, for_starts_at, for_ends_at, expires_at) values ($1, $2, 'static', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'v1:seed:seed:seed', 'revoked', now(), now() + interval '30 minutes', now() + interval '1 hour')",
      [orgId, ids.appointment19b],
    );
    ids.reviewRequest = await one(
      "insert into public.review_requests (org_id, appointment_id, contact_id, recipient_contact_id, status, reason, run_at) values ($1, $2, $3, $3, 'skipped', 'no_opt_in', now())",
      [orgId, ids.appointment19b, ids.contact],
    );
  });
  return ids;
}

/** Phase 19 tables with a browser (select) policy. */
export const PHASE19_TABLES = [
  "ad_attributions",
  "calendar_feeds",
  "capi_events",
  "esign_requests",
  "fin_payment_requests",
  "integration_calls",
  "integration_usage_daily",
  "review_requests",
  "sms_messages",
] as const;

/** Phase 19 tables that hold secrets or idempotency keys: RLS on, no policy, service role only. */
export const PHASE19_SERVICE_ONLY_TABLES = [
  "integration_accounts",
  "integration_webhook_events",
  "telehealth_rooms",
] as const;

/**
 * One row in every Phase 20 table (20A flash report, 20I insurance follow-up, 20J invoice-change reviews, 20F revenue share, 20E labs), for an org, so the cross-org sweeps are not
 * vacuous for them. Synthetic ids and amounts only. Service role only: none of them has a write policy.
 */
export async function seedPhase20Rows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.line = await one(
      "insert into public.fin_ref_report_lines (org_id, code, label, match_kind, match_values) values ($1, 'SEED20', 'Seed line', 'branch', '{P}')",
      [orgId],
    );
    ids.target = await one(
      "insert into public.fin_ref_revenue_targets (org_id, month, line_code, daily_revenue) values ($1, '2026-10-01', 'SEED20', 1000)",
      [orgId],
    );
    ids.claim20 = await one(
      "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, net) values ($1, 'CA-SEED-20', 'ADMC/C/20001', '99213', 'PAYER-SEED', '2026-07-01', 100)",
      [orgId],
    );
    ids.followup = await one(
      "insert into public.ins_claim_followups (org_id, claim_activity_id, stage, outcome, note, created_by) values ($1, $2, 90, 'contacted', 'Seed note', $3)",
      [orgId, ids.claim20, userId],
    );
    ids.followupStage = await one(
      "insert into public.ins_claim_followup_stages (org_id, claim_activity_id, stage, crossed_on) values ($1, $2, 90, '2026-09-29')",
      [orgId, ids.claim20],
    );
    ids.invoice20 = await one(
      "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, net, total, record_hash) values ($1, 'SYN-SEED-20J', '2026-10-01', 100, 100, 'h')",
      [orgId],
    );
    ids.changeReview = await one(
      "insert into public.fin_invoice_change_reviews (org_id, change_key, invoice_id, kind, amount, change_date, decision, reason, reviewed_by) values ($1, md5('seed-20j'), $2, 'discount', 10, '2026-10-01', 'approved', 'Seed reason', $3)",
      [orgId, ids.invoice20, userId],
    );
    // 20F: a doctor charge, a draft scheme version, a draft run and its line
    ids.charge20 = await one(
      "insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount, created_by) values ($1, '2026-09-01', 'SYN-SEED', 'lab', 10, $2)",
      [orgId, userId],
    );
    ids.scheme20 = await one(
      `insert into public.fin_revshare_schemes (org_id, doctor_dha_id, version, effective_from, rule, rule_hash, created_by)
       values ($1, 'SYN-SEED', 1, '2026-01-01', '{"basis":"net_revenue","default_rate":0.3,"deductions":{"lab":1}}'::jsonb, '', $2)`,
      [orgId, userId],
    );
    ids.run20 = await one(
      "insert into public.fin_revshare_runs (org_id, month, snapshot, snapshot_hash, built_by) values ($1, '2026-09-01', '{}'::jsonb, '', $2)",
      [orgId, userId],
    );
    ids.line20 = await one(
      "insert into public.fin_revshare_lines (org_id, run_id, doctor_dha_id, scheme_id, scheme_version, payout) values ($1, $2, 'SYN-SEED', $3, 1, 100)",
      [orgId, ids.run20, ids.scheme20],
    );
    // 20E: a provider, one of its tests, an open statement with one file, one line and one reason
    ids.provider20 = await one(
      "insert into public.fin_providers (org_id, name, kind) values ($1, 'Synthetic Lab', 'send_out_lab')",
      [orgId],
    );
    ids.providerTest20 = await one(
      "insert into public.fin_ref_provider_tests (org_id, provider_id, code, expected_days) values ($1, $2, '85025', 2)",
      [orgId, ids.provider20],
    );
    ids.statement20 = await one(
      "insert into public.fin_provider_statements (org_id, provider_id, month, created_by) values ($1, $2, '2026-09-01', $3)",
      [orgId, ids.provider20, userId],
    );
    ids.providerFile20 = await one(
      "insert into public.fin_provider_files (org_id, statement_id, kind, file_sha256) values ($1, $2, 'provider_invoice', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))",
      [orgId, ids.statement20],
    );
    ids.providerLine20 = await one(
      "insert into public.fin_provider_lines (org_id, statement_id, file_id, row_no, service_date, code, amount) values ($1, $2, $3, 1, '2026-09-02', '85025', 10)",
      [orgId, ids.statement20, ids.providerFile20],
    );
    ids.providerNote20 = await one(
      "insert into public.fin_provider_notes (org_id, statement_id, item_key, reason_code) values ($1, $2, 'line|' || $3, 'provider_error')",
      [orgId, ids.statement20, ids.providerLine20],
    );
    // 20C bank reconciliation, 20H AI review, 20G close timetable (the close steps and settlement rules are seeded for
    // every new org by the orgs_seed_finance_phase20 trigger)
    const sha = "encode(sha256(gen_random_uuid()::text::bytea), 'hex')";
    ids.bankAccount = await one(
      "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Seed account', 'Seed Bank', '0001')",
      [orgId],
    );
    ids.importFormat = await one(
      "insert into public.fin_import_formats (org_id, kind, name, mapping, date_format) values ($1, 'bank_statement', 'Seed layout', '{}'::jsonb, 'YYYY-MM-DD')",
      [orgId],
    );
    ids.bankImport = await one(
      `insert into public.fin_bank_imports (org_id, kind, account_id, file_sha256) values ($1, 'bank_statement', $2, ${sha})`,
      [orgId, ids.bankAccount],
    );
    ids.bankLine = await one(
      "insert into public.fin_bank_lines (org_id, account_id, import_id, row_no, value_date, amount) values ($1, $2, $3, 1, '2026-09-02', 100)",
      [orgId, ids.bankAccount, ids.bankImport],
    );
    ids.settlementImport = await one(
      `insert into public.fin_bank_imports (org_id, kind, payment_mode, file_sha256) values ($1, 'settlement', 'Card', ${sha})`,
      [orgId],
    );
    ids.settlementLine = await one(
      "insert into public.fin_settlement_lines (org_id, import_id, row_no, payment_mode, txn_date, settlement_date, gross, net) values ($1, $2, 1, 'Card', '2026-09-01', '2026-09-03', 100, 98)",
      [orgId, ids.settlementImport],
    );
    ids.bankRec = await one(
      "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end) values ($1, $2, '2026-09-01', '2026-09-01', '2026-09-30')",
      [orgId, ids.bankAccount],
    );
    ids.bankMatch = await one(
      "insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status) values ($1, $2, $3, 'SEED', 'collection', '2026-09-01', 100, 100, 90, 'matched')",
      [orgId, ids.bankRec, ids.bankLine],
    );
    ids.bankNote = await one(
      "insert into public.fin_bank_rec_notes (org_id, rec_id, item_key, reason_code) values ($1, $2, 'SEED2', 'in_transit')",
      [orgId, ids.bankRec],
    );
    ids.aiReview = await one(
      "insert into public.fin_bank_ai_reviews (org_id, rec_id, status, model, summary, item_count, suggestion_count) values ($1, $2, 'ok', 'test-model', 'Seed summary', 1, 1)",
      [orgId, ids.bankRec],
    );
    ids.aiSuggestion = await one(
      "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, reason_code, confidence) values ($1, $2, $3, 'SEED', 'needs_person', 'low')",
      [orgId, ids.bankRec, ids.aiReview],
    );
    ids.closeTask = await one(
      "insert into public.fin_close_tasks (org_id, month, step_code, due_wd) select $1, '2026-09-01', code, 5 from public.fin_close_steps where org_id = $1 order by code limit 1",
      [orgId],
    );
    ids.holiday = await one(
      "insert into public.fin_ref_holidays (org_id, holiday_on, name) values ($1, '2026-12-02', 'Seed holiday')",
      [orgId],
    );
  });
  return ids;
}

/** Phase 20 tables with a browser (select) policy. */
export const PHASE20_TABLES = [
  "fin_bank_accounts",
  "fin_bank_ai_reviews",
  "fin_bank_ai_suggestions",
  "fin_bank_imports",
  "fin_bank_lines",
  "fin_bank_matches",
  "fin_bank_rec_notes",
  "fin_bank_recs",
  "fin_close_steps",
  "fin_close_tasks",
  "fin_import_formats",
  "fin_invoice_change_reviews",
  "fin_ref_holidays",
  "fin_ref_settlement_rules",
  "fin_settlement_lines",
  "fin_ref_report_lines",
  "fin_ref_revenue_targets",
  "fin_doctor_charges",
  "fin_provider_files",
  "fin_provider_lines",
  "fin_provider_notes",
  "fin_provider_statements",
  "fin_providers",
  "fin_ref_provider_tests",
  "fin_revshare_lines",
  "fin_revshare_runs",
  "fin_revshare_schemes",
  "ins_claim_followup_stages",
  "ins_claim_followups",
] as const;

/**
 * One row in every Phase 21 table for an org (visit diagnoses and the derived chronic conditions), so the cross-org
 * sweeps are not vacuous for them. Service role only: neither table has a write policy. Synthetic data only.
 */
export async function seedPhase21Rows(c: Client, orgId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, phone_e164) values ($1, 'Layla Demo-21', 'Synthetic', '+447700900021')",
      [orgId],
    );
    ids.visit = await one(
      "insert into public.visits (org_id, contact_id, external_id, visit_date) values ($1, $2, 'SYN-P21-V1', current_date - 30)",
      [orgId, ids.contact],
    );
    ids.diagnosis = await one(
      "insert into public.ref_diagnoses (org_id, code, chronic) values ($1, 'I10', true) on conflict (org_id, code) do update set chronic = true",
      [orgId],
    );
    ids.visitDiagnosis = await one(
      "insert into public.visit_diagnoses (org_id, visit_id, contact_id, ref_diagnosis_id, diagnosis_code, visit_date, source) values ($1, $2, $3, $4, 'I10', current_date - 30, 'unite')",
      [orgId, ids.visit, ids.contact, ids.diagnosis],
    );
    ids.chronic = await one(
      "insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id, source, noted_at, last_seen_on, evidence_visits) values ($1, $2, $3, 'visit_diagnoses', current_date - 30, current_date - 30, 1)",
      [orgId, ids.contact, ids.diagnosis],
    );
  });
  return ids;
}

/** Phase 21 tables with a (PHI-gated) select policy and no write policy. */
export const PHASE21_TABLES = ["contact_chronic_conditions", "visit_diagnoses"] as const;

/**
 * One row in every Phase 20D (payables and vouchers) table for an org, so the cross-org sweeps are not vacuous for them.
 * Synthetic names and amounts; the document row is a placeholder (no file). Service role only: none of these tables has a
 * write policy. The voucher is made by fin_voucher_save, so the counter (service-only) and the trail get rows as well.
 * `userId` must hold finance.vouchers.prepare (the org owner's Admin role does).
 */
export async function seedPhase20DRows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.document = await one(
      "insert into public.fin_documents (org_id, kind, storage_path, mime_type, size_bytes, sha256, status, uploaded_by) values ($1::uuid, 'voucher_backup', $1::text || '/' || gen_random_uuid() || '.pdf', 'application/pdf', 100, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'ready', $2)",
      [orgId, userId],
    );
    ids.supplier = await one(
      "insert into public.fin_suppliers (org_id, name, created_by) values ($1, 'Supplier Test Seed', $2)",
      [orgId, userId],
    );
    ids.invoice = await one(
      "insert into public.fin_supplier_invoices (org_id, supplier_id, invoice_number, invoice_date, category, net, vat, document_id) values ($1, $2, 'INV-SEED-1', '2026-10-01', 'Consumables', 100, 5, $3)",
      [orgId, ids.supplier, ids.document],
    );
    const { rows } = await c.query<{ r: { id: string } }>(
      "select public.fin_voucher_save($1, $2, null, $3::jsonb, $4::uuid[], $5::uuid[]) as r",
      [
        orgId,
        userId,
        JSON.stringify({
          voucher_date: "2026-10-02",
          payee_name: "Supplier Test Seed",
          amount: 105,
          category: "Consumables",
          narration: "Seed voucher",
        }),
        [ids.invoice],
        [ids.document],
      ],
    );
    ids.voucher = rows[0].r.id;
    await c.query(
      "insert into public.fin_ref_tally_ledgers (org_id, kind, key, ledger_name) values ($1, 'category', 'Consumables', 'Seed Consumables')",
      [orgId],
    );
    ids.export = await one(
      "insert into public.fin_tally_exports (org_id, voucher_count, invoice_count, checksum, xml, exported_by) values ($1, 0, 1, encode(sha256('seed'::bytea), 'hex'), '<ENVELOPE/>', $2)",
      [orgId, userId],
    );
  });
  return ids;
}

/** Phase 20D tables with a browser (select) policy. fin_ref_approval_tiers is seeded for every org. */
export const PHASE20D_TABLES = [
  "fin_documents",
  "fin_payment_vouchers",
  "fin_ref_approval_tiers",
  "fin_ref_tally_ledgers",
  "fin_supplier_invoices",
  "fin_suppliers",
  "fin_tally_exports",
  "fin_voucher_documents",
  "fin_voucher_events",
  "fin_voucher_invoices",
] as const;

/** Phase 20D service-only tables: RLS on, no policy (the per-org voucher number counter). */
export const PHASE20D_SERVICE_ONLY_TABLES = ["fin_voucher_counters"] as const;

/**
 * Phase 20a tables (enquiry tags, Sanoflow campaign archive): one synthetic row each, so the cross-org
 * sweeps are not vacuous for them. Service role, like the import that writes them.
 */
export async function seedPhase20aRows(c: Client, orgId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    const contact = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-20', '+447700900420')",
      [orgId],
    );
    const pipeline = await one(
      "insert into public.pipelines (org_id, name) values ($1, 'Sweep 20')",
      [orgId],
    );
    const stage = await one(
      "insert into public.stages (org_id, pipeline_id, name) values ($1, $2, 'New')",
      [orgId, pipeline],
    );
    ids.enquiry = await one(
      "insert into public.enquiries (org_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, 'Sweep', $4)",
      [orgId, pipeline, stage, contact],
    );
    ids.tag = await one(
      "insert into public.tags (org_id, name, scope) values ($1, 'Sweep 20', 'enquiry')",
      [orgId],
    );
    await c.query(
      "insert into public.enquiry_tags (org_id, enquiry_id, tag_id) values ($1, $2, $3)",
      [orgId, ids.enquiry, ids.tag],
    );
    ids.archive = await one(
      `insert into public.campaign_archive (org_id, name, totals) values ($1, 'Sweep campaign', '{"recipients":1,"read":1}')`,
      [orgId],
    );
    ids.recipient = await one(
      "insert into public.campaign_archive_recipients (org_id, archive_id, contact_id, status) values ($1, $2, $3, 'read')",
      [orgId, ids.archive, contact],
    );
    ids.contact = contact;
  });
  return ids;
}

/** Phase 20a tables with a browser (select) policy. */
export const PHASE20A_TABLES = [
  "campaign_archive",
  "campaign_archive_recipients",
  "enquiry_tags",
] as const;

/**
 * Phase 20c booking capacity (weekly blocks): one synthetic row, so the cross-org sweeps are not vacuous for it.
 * Service role, like the settings action that writes it.
 */
export async function seedSf20cBookingRows(c: Client, orgId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.specialist = await one(
      "insert into public.specialists (org_id, name) values ($1, 'Dr Seed 20cb')",
      [orgId],
    );
    ids.block = await one(
      "insert into public.specialist_recurring_blocks (org_id, specialist_id, weekday, start_min, end_min, reason) values ($1, $2, 1, 780, 840, 'Lunch')",
      [orgId, ids.specialist],
    );
  });
  return ids;
}

/** Phase 20c booking-capacity tables with a browser (select) policy. */
export const SF20C_BOOKING_TABLES = ["specialist_recurring_blocks"] as const;

/**
 * Phase 20c (routing): one row in each new log table for an org, written the way production writes them (the triggers
 * on conversations.assignee_* and memberships.presence), so the cross-org sweeps are not vacuous for them.
 */
export async function seedSf20cRows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    const contact = await one(
      "insert into public.contacts (org_id, first_name, phone_e164) values ($1, 'Layla Demo-21', '+447700900421')",
      [orgId],
    );
    const channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Sweep 20c', 'waba-20c-' || gen_random_uuid(), 'pn-20c-' || gen_random_uuid())",
      [orgId],
    );
    ids.conversation = await one(
      "insert into public.conversations (org_id, channel_id, contact_id, assignee_user_id) values ($1, $2, $3, $4)",
      [orgId, channel, contact, userId],
    );
    await c.query("update public.memberships set presence = 'away' where org_id = $1 and user_id = $2", [orgId, userId]);
  });
  return ids;
}

/** Phase 20c tables with a browser (select) policy. */
export const SF20C_TABLES = ["conversation_assignment_events", "member_presence_events"] as const;

/**
 * Phase 20d tables (recurring campaigns, monthly campaign budget): one synthetic row each, so the cross-org sweeps are
 * not vacuous for them. Service role, like the server actions and jobs that write them. `suffix` keeps the channel's
 * globally unique phone_number_id distinct when several orgs are seeded.
 */
export async function seedSf20dRows(c: Client, orgId: string, suffix = "a") {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    ids.channel = await one(
      "insert into public.channels (org_id, name, waba_id, phone_number_id) values ($1, 'Sweep 20d', $2, $3)",
      [orgId, `waba-20d-${suffix}`, `pn-20d-${suffix}`],
    );
    ids.template = await one(
      "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, status, category) values ($1, $2, $3, 'sweep_20d', 'en', 'APPROVED', 'UTILITY')",
      [orgId, ids.channel, `waba-20d-${suffix}`],
    );
    ids.segment = await one(
      "insert into public.segments (org_id, name, kind) values ($1, 'Sweep 20d', 'static')",
      [orgId],
    );
    ids.recurrence = await one(
      `insert into public.campaign_recurrences (org_id, name, channel_id, template_id, segment_id, cron, timezone, next_run_at)
       values ($1, 'Sweep recurring', $2, $3, $4, '0 10 * * 1', 'Asia/Dubai', now() + interval '1 day')`,
      [orgId, ids.channel, ids.template, ids.segment],
    );
    await c.query(
      "insert into public.campaign_budget_months (org_id, month, used) values ($1, date_trunc('month', now())::date, 3) on conflict do nothing",
      [orgId],
    );
  });
  return ids;
}

/** Phase 20d (Sanoflow parity) tables with a browser (select) policy. */
export const SF20D_TABLES = ["campaign_budget_months", "campaign_recurrences"] as const;

/** Phase 20e tables with a browser (select) policy. */
export const SF20E_TABLES = ["contact_channel_identities", "gcal_event_links"] as const;

/** Phase 20e tables that only the service role may touch (visitor token hashes, Google tokens, OAuth states). */
export const SF20E_SERVICE_ONLY_TABLES = [
  "gcal_connections",
  "gcal_oauth_states",
  "web_chat_sessions",
] as const;

/** One synthetic row in each Phase 20e table of `orgId` (no real people, ids and hashes only). */
export async function seedSf20eRows(c: Client, orgId: string, userId: string) {
  const ids: Record<string, string> = {};
  await asServiceRole(c, async () => {
    const one = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: string }>(sql + " returning id::text", params)).rows[0].id;
    const contact = await one(
      "insert into public.contacts (org_id, first_name, last_name, source) values ($1, 'Instagram', 'user', 'instagram')",
      [orgId],
    );
    const ig = await one(
      "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, 'instagram', 'Instagram', '', 'instagram:' || replace(gen_random_uuid()::text, '-', ''))",
      [orgId],
    );
    ids.identity = await one(
      "insert into public.contact_channel_identities (org_id, channel_id, contact_id, platform, external_id) values ($1, $2, $3, 'instagram', '1780000000000001')",
      [orgId, ig, contact],
    );
    const web = await one(
      "insert into public.channels (org_id, type, name, waba_id, phone_number_id) values ($1, 'web', 'Website chat', '', $2)",
      [orgId, `web:seed:${orgId}`],
    );
    await c.query(
      "insert into public.web_chat_sessions (org_id, channel_id, contact_id, token_hash) values ($1, $2, $3, encode(sha256(gen_random_uuid()::text::bytea), 'hex'))",
      [orgId, web, contact],
    );
    const specialist = await one(
      "insert into public.specialists (org_id, name) values ($1, 'Dr Seed 20e')",
      [orgId],
    );
    const conn = await one(
      "insert into public.gcal_connections (org_id, specialist_id, refresh_enc, connected_by) values ($1, $2, 'v1:seed:seed:seed', $3)",
      [orgId, specialist, userId],
    );
    await c.query(
      "insert into public.gcal_oauth_states (state_hash, org_id, specialist_id, user_id, expires_at) values (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, $2, $3, now() + interval '10 minutes')",
      [orgId, specialist, userId],
    );
    const appt = await one(
      "insert into public.appointments (org_id, contact_id, specialist_id, starts_at, ends_at, status) values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed')",
      [orgId, contact, specialist],
    );
    ids.link = await one(
      "insert into public.gcal_event_links (org_id, connection_id, appointment_id, event_id, synced_hash) values ($1, $2, $3, $4, encode(sha256('seed'::bytea), 'hex'))",
      [orgId, conn, appt, `pulse${"0a1b2c3d".repeat(6)}`],
    );
    ids.contact = contact;
    ids.specialist = specialist;
    ids.connection = conn;
  });
  return ids;
}
