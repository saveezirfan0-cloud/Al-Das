/**
 * Shared bits of the signed-in end-to-end suite (tests/e2e/signed-in). No Playwright import here: the seed script
 * (tests/e2e/fixtures/seed.ts, run with tsx) uses it too.
 *
 * Everything the suite touches is synthetic (CLAUDE.md rule 10): the seed writes `Layla Demo-91`-style names and
 * numbers in the reserved +44 7700 900000 to 900999 range into a fresh training workspace on a LOCAL Supabase.
 */
import fs from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../../lib/supabase/types";

/** The signed-in suite runs only when asked: it needs a local Supabase stack and `pnpm e2e:seed`. */
export const signedIn = process.env.E2E_SIGNED_IN === "1";
export const SIGNED_IN_SKIP_REASON =
  "Signed-in suite: set E2E_SIGNED_IN=1 with a local Supabase and run `pnpm e2e:seed` first (tests/e2e/README.md).";

/** The job secret the test server runs with (playwright.config.ts passes the same default). */
export const E2E_JOB_SECRET = process.env.JOB_SECRET ?? "e2e-job-secret-0123456789abcdef";

export const ROLES = ["admin", "receptionist", "agent"] as const;
export type Role = (typeof ROLES)[number];

/** Git-ignored: storage states and the seed file (it holds the throwaway passwords of the local test users). */
export const AUTH_DIR = path.resolve(process.cwd(), "tests/e2e/.auth");
export const SEED_FILE = path.join(AUTH_DIR, "seed.json");

export function authFile(role: Role): string {
  return path.join(AUTH_DIR, `${role}.json`);
}

type Named = { id: string; name: string };

export type E2ESeed = {
  runId: string;
  orgId: string;
  orgSlug: string;
  timezone: string;
  /** Clinic-local dates (YYYY-MM-DD). */
  today: string;
  bookingDate: string;
  users: Record<Role, { id: string; email: string; password: string }>;
  location: Named;
  specialist: Named;
  service: Named;
  patients: {
    /** Has today's appointment on the front desk board. */
    frontDesk: Named;
    /** Booked and moved through the appointment drawers. */
    booking: Named;
    /** Owns the seeded WhatsApp conversation. */
    inbox: Named;
    /** Shown in the Patients list. */
    listed: Named;
  };
  frontDeskAppointmentId: string;
  conversationId: string;
  inboundText: string;
};

export function loadSeed(): E2ESeed {
  if (!fs.existsSync(SEED_FILE))
    throw new Error(
      `No seed file at ${SEED_FILE}. Run \`pnpm e2e:seed\` against the local stack first.`,
    );
  return JSON.parse(fs.readFileSync(SEED_FILE, "utf8")) as E2ESeed;
}

export function writeSeed(seed: E2ESeed): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2), { mode: 0o600 });
}

/** Service-role client for test set-up and checks only (resetting a row, reading a status). Local stack only. */
export function adminDb(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see tests/e2e/README.md).",
    );
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

/** Escapes text for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
