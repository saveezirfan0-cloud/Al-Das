/**
 * Helpers for tests that run against a real Postgres prepared by scripts/test-db.sh.
 * Skipped entirely when TEST_DATABASE_URL is not set.
 */
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
  for (const q of ["outbound", "outbound_priority", "flow_steps", "notifications", "meta_events"]) {
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
