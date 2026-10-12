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
  for (const q of ["outbound", "outbound_priority", "flow_steps", "notifications", "meta_events", "webhooks_out", "kb_ingest"]) {
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
