/**
 * Wipe and re-seed the DEMO workspace with synthetic data: patients, doctors, appointments for today and
 * tomorrow, 30 conversations in different states, 3 enquiry pipelines, a campaign with results, a recall programme
 * in Test mode, and finance rows from tests/unit/finance/fixtures.
 *
 *   DEMO_RESET_OK=1 pnpm demo:reset --owner-email=you@example.com
 *   DEMO_RESET_OK=1 pnpm demo:reset --users            # also creates demo logins and prints their passwords once
 *   DEMO_RESET_OK=1 pnpm demo:reset --owner-id=<auth user uuid> [--receptionist-id=<uuid>] [--finance-id=<uuid>]
 *   pnpm demo:reset --check                            # only report whether the guard would allow it
 *
 * It refuses to run unless DEMO_RESET_OK=1 and the Supabase URL is on this machine or names a demo project
 * (see lib/demo/guard.ts). It only ever empties a workspace marked as a training workspace AND created by this
 * script (public.demo_wipe_org). It never calls Meta, Unite or any other service; with training mode on, the app
 * itself cannot send WhatsApp messages from this workspace.
 */
import "dotenv/config";

import { randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SYSTEM_ROLES } from "../lib/auth/permissions";
import { assertDemoAllowed, DemoGuardError } from "../lib/demo/guard";
import { seedDemoWorkspace } from "../lib/demo/seed";
import type { Database, Json } from "../lib/supabase/types";

type Admin = SupabaseClient<Database>;

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findUserByEmail(admin: Admin, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`could not list users (${error.message}); pass --owner-id instead`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** A demo login on a reserved .invalid address. The password is shown once and never stored by this script. */
async function ensureDemoUser(
  admin: Admin,
  email: string,
  shown: Array<[string, string]>,
): Promise<string> {
  const password = randomBytes(12).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (!error && data.user) {
    shown.push([email, password]);
    return data.user.id;
  }
  const existing = await findUserByEmail(admin, email);
  if (existing) {
    shown.push([email, "(already existed: password unchanged)"]);
    return existing;
  }
  throw new Error(`could not create ${email}: ${error?.message ?? "unknown error"}`);
}

async function main() {
  const target = assertDemoAllowed({
    DEMO_RESET_OK: flag("check") ? "1" : process.env.DEMO_RESET_OK,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_PROJECT_NAME: process.env.SUPABASE_PROJECT_NAME,
    DEMO_PROJECT_NAME: process.env.DEMO_PROJECT_NAME,
  });
  console.log(`Target: ${target.host} (${target.why})`);
  if (flag("check")) {
    console.log("The guard would allow a reset here (DEMO_RESET_OK is still required to run it).");
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new DemoGuardError("SUPABASE_SERVICE_ROLE_KEY is required.");
  const admin = createClient<Database>(url, key, { auth: { persistSession: false } });

  const slug = arg("slug") ?? "demo-clinic";
  const name = arg("name") ?? "Pulse Demo Clinic";
  if (!/^[a-z0-9-]{3,40}$/.test(slug))
    throw new DemoGuardError("--slug must be 3 to 40 letters, digits or dashes.");

  // Who works in the demo workspace.
  const shown: Array<[string, string]> = [];
  let adminId = arg("owner-id") ?? process.env.DEMO_OWNER_ID ?? null;
  let receptionistId = arg("receptionist-id") ?? null;
  let financeId = arg("finance-id") ?? null;
  const ownerEmail = arg("owner-email");
  if (!adminId && ownerEmail) adminId = await findUserByEmail(admin, ownerEmail);
  if (flag("users")) {
    adminId ??= await ensureDemoUser(admin, "admin@demo.invalid", shown);
    receptionistId ??= await ensureDemoUser(admin, "receptionist@demo.invalid", shown);
    financeId ??= await ensureDemoUser(admin, "finance@demo.invalid", shown);
  }
  if (!adminId || !UUID.test(adminId))
    throw new DemoGuardError(
      "Say who owns the demo workspace: --owner-email=…, --owner-id=<uuid>, or --users.",
    );
  for (const id of [receptionistId, financeId])
    if (id && !UUID.test(id))
      throw new DemoGuardError("--receptionist-id and --finance-id must be user ids (uuid).");

  // Create the workspace, or empty the existing demo one.
  const { data: existing } = await admin
    .from("orgs")
    .select("id, is_training, settings")
    .eq("slug", slug)
    .maybeSingle();
  let orgId: string;
  if (existing) {
    const isDemo =
      existing.is_training &&
      (existing.settings as Record<string, unknown> | null)?.demo_seed === true;
    if (!isDemo)
      throw new DemoGuardError(
        `A workspace with slug "${slug}" exists but is not a demo workspace. Nothing was changed. Pick another --slug.`,
      );
    orgId = existing.id;
    const { data: wiped, error } = await admin.rpc("demo_wipe_org", { p_org_id: orgId });
    if (error) throw new Error(`could not empty the demo workspace: ${error.message}`);
    const result = wiped as {
      deleted: number;
      left_behind: string[];
      errors: Record<string, string>;
    };
    console.log(`Emptied the demo workspace (${result.deleted} rows).`);
    if (result.left_behind.length)
      throw new Error(
        `these tables could not be emptied: ${result.left_behind.join(", ")} (${JSON.stringify(result.errors)})`,
      );
  } else {
    const { data: created, error } = await admin.rpc("create_org", {
      p_name: name,
      p_slug: slug,
      p_roles: SYSTEM_ROLES.map((r) => ({
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      })) as unknown as Json,
      p_owner_id: adminId,
    });
    if (error || !created)
      throw new Error(`could not create the demo workspace: ${error?.message ?? "no id"}`);
    orgId = created;
    await admin.rpc("seed_finance_reference", { p_org_id: orgId });
    console.log(`Created the demo workspace "${name}".`);
  }

  // Mark it: training mode on, and created by this script (the two locks demo_wipe_org checks).
  const { data: row } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  await admin
    .from("orgs")
    .update({
      name,
      timezone: "Asia/Dubai",
      is_training: true,
      settings: {
        ...((row?.settings as Record<string, unknown>) ?? {}),
        demo_seed: true,
      } as unknown as NonNullable<Json>,
    })
    .eq("id", orgId);

  // Staff logins (roles are the system presets).
  const roleByName = new Map<string, string>();
  const { data: roles } = await admin.from("roles").select("id, name").eq("org_id", orgId);
  for (const r of roles ?? []) roleByName.set(r.name, r.id);
  for (const [userId, roleName] of [
    [receptionistId, "Receptionist"],
    [financeId, "Finance"],
  ] as const) {
    const roleId = roleByName.get(roleName);
    if (userId && roleId)
      await admin
        .from("memberships")
        .upsert(
          { org_id: orgId, user_id: userId, role_id: roleId, status: "active" },
          { onConflict: "org_id,user_id" },
        );
  }

  const summary = await seedDemoWorkspace(admin, {
    orgId,
    slug,
    staff: { adminId, receptionistId, financeId },
  });
  console.log(
    "Seeded:",
    Object.entries(summary)
      .map(([k, v]) => `${k} ${v}`)
      .join(", "),
  );
  if (shown.length) {
    console.log("\nDemo logins (shown once; this script does not store them):");
    for (const [email, password] of shown) console.log(`  ${email}  ${password}`);
  }
  console.log(
    `\nDone. Sign in and open the "${name}" workspace. Training mode is on: nothing is sent to WhatsApp.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(e instanceof DemoGuardError ? 2 : 1);
});
