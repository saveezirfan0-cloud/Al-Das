/**
 * Seeds a small synthetic workspace for the signed-in end-to-end suite and writes tests/e2e/.auth/seed.json.
 *
 *   pnpm e2e:seed        (needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY of a LOCAL Supabase)
 *
 * Every run makes NEW users and a NEW workspace (slug e2e-<run id>), so it never empties or edits anything that
 * already exists and a re-run is always clean. It refuses any Supabase URL that is not on this machine
 * (lib/demo/guard.ts `isLocalHost`), never calls Meta, Unite or any other service, and turns training mode on so the
 * app itself cannot send WhatsApp messages from the workspace.
 *
 * What it creates (all made up, CLAUDE.md rule 10 and the demo conventions in lib/demo/data.ts):
 *  - three logins on the reserved .invalid domain, with random passwords kept only in the git-ignored seed file:
 *    Admin (owner), Receptionist and Agent, each on the system role presets (lib/auth/permissions.ts);
 *  - ONE branch (so the branch switcher stays hidden), a department, a 30-minute service and one doctor who works
 *    08:00 to 20:00 every day, the clinic open all week;
 *  - four patients (`Layla Demo-91` …) with numbers in +44 7700 900091 … 900094;
 *  - today's appointment for the front desk board, a WhatsApp channel with one open conversation (an inbound message
 *    ten minutes old, so the reply window is open), a team and a task.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { SYSTEM_ROLES } from "../../../lib/auth/permissions";
import { isLocalHost } from "../../../lib/demo/guard";
import type { Database, Json } from "../../../lib/supabase/types";
import { ROLES, SEED_FILE, writeSeed, type E2ESeed, type Role } from "./e2e";

type Admin = SupabaseClient<Database>;

const TIMEZONE = "Asia/Dubai";
const DAY_MS = 24 * 3_600_000;

/** Fail with the table and Postgres code only: never print row contents. */
function check(what: string, error: { code?: string; message: string } | null): void {
  if (error)
    throw new Error(
      `e2e seed: ${what} failed (${error.code ?? "?"}): ${error.message.slice(0, 160)}`,
    );
}

async function createLogin(
  admin: Admin,
  runId: string,
  role: Role,
): Promise<{ id: string; email: string; password: string }> {
  const email = `${role}-${runId}@e2e.invalid`;
  const password = randomBytes(18).toString("base64url");
  const label = role[0].toUpperCase() + role.slice(1);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: label, last_name: "E2E" },
  });
  if (error || !data.user)
    throw new Error(
      `e2e seed: could not create the ${role} login (${error?.message ?? "no user"})`,
    );
  return { id: data.user.id, email, password };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key)
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (tests/e2e/README.md).",
    );
  const host = new URL(url).hostname;
  if (!isLocalHost(host))
    throw new Error(
      `Refusing to seed ${host}: the end-to-end seed only runs against a local Supabase stack.`,
    );

  const admin = createClient<Database>(url, key, { auth: { persistSession: false } });
  const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const now = new Date();
  const today = formatInTimeZone(now, TIMEZONE, "yyyy-MM-dd");
  const bookingDate = formatInTimeZone(
    new Date(now.getTime() + 2 * DAY_MS),
    TIMEZONE,
    "yyyy-MM-dd",
  );

  // ------------------------------------------------------------------------------------------ logins and workspace
  const users = {} as E2ESeed["users"];
  for (const role of ROLES) users[role] = await createLogin(admin, runId, role);

  const orgSlug = `e2e-${runId}`;
  const { data: orgId, error: orgError } = await admin.rpc("create_org", {
    p_name: "E2E Demo Clinic",
    p_slug: orgSlug,
    p_roles: SYSTEM_ROLES.map((r) => ({
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })) as unknown as Json,
    p_owner_id: users.admin.id,
  });
  check("create_org", orgError);
  if (!orgId) throw new Error("e2e seed: create_org returned no id");

  const { data: orgRow } = await admin.from("orgs").select("settings").eq("id", orgId).single();
  const { error: trainingError } = await admin
    .from("orgs")
    .update({
      timezone: TIMEZONE,
      // Training mode: the outbound job marks messages sent on screen and never builds a Meta client.
      is_training: true,
      settings: {
        ...((orgRow?.settings as Record<string, unknown> | null) ?? {}),
        e2e_seed: true,
        appointments: { working_weekdays: [1, 2, 3, 4, 5, 6, 7] },
      } as unknown as NonNullable<Json>,
    })
    .eq("id", orgId);
  check("orgs update", trainingError);

  const { data: roles, error: rolesError } = await admin
    .from("roles")
    .select("id, name")
    .eq("org_id", orgId);
  check("roles", rolesError);
  const roleId = (name: string) => {
    const id = roles?.find((r) => r.name === name)?.id;
    if (!id) throw new Error(`e2e seed: role ${name} missing`);
    return id;
  };
  const { error: memberError } = await admin.from("memberships").insert([
    {
      org_id: orgId,
      user_id: users.receptionist.id,
      role_id: roleId("Receptionist"),
      status: "active",
    },
    { org_id: orgId, user_id: users.agent.id, role_id: roleId("Agent"), status: "active" },
  ]);
  check("memberships", memberError);

  const teamId = randomUUID();
  check(
    "teams",
    (
      await admin
        .from("teams")
        .insert({ id: teamId, org_id: orgId, name: "Front desk", round_robin: false })
    ).error,
  );
  check(
    "team_members",
    (
      await admin.from("team_members").insert([
        { org_id: orgId, team_id: teamId, user_id: users.admin.id },
        { org_id: orgId, team_id: teamId, user_id: users.receptionist.id },
      ])
    ).error,
  );

  // ------------------------------------------------------------------------------------------ clinic set-up
  const location = { id: randomUUID(), name: "E2E Demo Clinic Main" };
  const departmentId = randomUUID();
  const service = { id: randomUUID(), name: "GP consultation" };
  const specialist = { id: randomUUID(), name: "Dr Alpha Demo" };
  check(
    "locations",
    (
      await admin.from("locations").insert({
        id: location.id,
        org_id: orgId,
        name: location.name,
        timezone: TIMEZONE,
        address: "1 Example Street, Demo City",
      })
    ).error,
  );
  check(
    "departments",
    (
      await admin
        .from("departments")
        .insert({ id: departmentId, org_id: orgId, name: "General practice" })
    ).error,
  );
  check(
    "services",
    (
      await admin.from("services").insert({
        id: service.id,
        org_id: orgId,
        department_id: departmentId,
        name: service.name,
        duration_min: 30,
        price: 250,
      })
    ).error,
  );
  check(
    "specialists",
    (
      await admin.from("specialists").insert({
        id: specialist.id,
        org_id: orgId,
        name: specialist.name,
        title: "Doctor",
        department_id: departmentId,
      })
    ).error,
  );
  check(
    "specialist_locations",
    (
      await admin
        .from("specialist_locations")
        .insert({ org_id: orgId, specialist_id: specialist.id, location_id: location.id })
    ).error,
  );
  check(
    "specialist_services",
    (
      await admin
        .from("specialist_services")
        .insert({ org_id: orgId, specialist_id: specialist.id, service_id: service.id })
    ).error,
  );
  check(
    "working_hours",
    (
      await admin.from("working_hours").insert(
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          org_id: orgId,
          specialist_id: specialist.id,
          location_id: location.id,
          weekday,
          start_min: 8 * 60,
          end_min: 20 * 60,
        })),
      )
    ).error,
  );

  // ------------------------------------------------------------------------------------------ patients
  const people = [
    { key: "frontDesk", first: "Layla", n: 91 },
    { key: "booking", first: "Omar", n: 92 },
    { key: "inbox", first: "Sara", n: 93 },
    { key: "listed", first: "Yusuf", n: 94 },
  ] as const;
  const patients = {} as E2ESeed["patients"];
  for (const p of people) patients[p.key] = { id: randomUUID(), name: `${p.first} Demo-${p.n}` };
  check(
    "contacts",
    (
      await admin.from("contacts").insert(
        people.map((p) => ({
          id: patients[p.key].id,
          org_id: orgId,
          first_name: p.first,
          last_name: `Demo-${p.n}`,
          phone_e164: `+447700900${String(p.n).padStart(3, "0")}`,
          language: "en",
          source: "manual",
          last_interaction_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
          created_by: users.admin.id,
        })),
      )
    ).error,
  );

  // Today's appointment: the next quarter hour, kept on today's date (no later than 23:00 clinic time).
  const localMinutes =
    Number(formatInTimeZone(now, TIMEZONE, "H")) * 60 +
    Number(formatInTimeZone(now, TIMEZONE, "m"));
  const startMin = Math.min(Math.ceil(localMinutes / 15) * 15, 23 * 60);
  const hhmm = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
  const startsAt = fromZonedTime(`${today}T${hhmm}:00`, TIMEZONE);
  const frontDeskAppointmentId = randomUUID();
  check(
    "appointments",
    (
      await admin.from("appointments").insert({
        id: frontDeskAppointmentId,
        org_id: orgId,
        contact_id: patients.frontDesk.id,
        location_id: location.id,
        specialist_id: specialist.id,
        service_id: service.id,
        department_id: departmentId,
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        status: "confirmed",
        source: "portal",
        created_by: users.receptionist.id,
      })
    ).error,
  );

  // ------------------------------------------------------------------------------------------ inbox
  const channelId = randomUUID();
  check(
    "channels",
    (
      await admin.from("channels").insert({
        id: channelId,
        org_id: orgId,
        name: "E2E WhatsApp",
        waba_id: `e2e-waba-${runId}`,
        phone_number_id: `e2e-phone-number-${runId}`,
        display_phone: "+44 7700 900000",
        verified_name: "E2E Demo Clinic",
        quality_rating: "GREEN",
        messaging_limit_tier: "TIER_1K",
      })
    ).error,
  );
  const inboundText = "Hello, do you have any appointments this week?";
  const inboundAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  const conversationId = randomUUID();
  check(
    "conversations",
    (
      await admin.from("conversations").insert({
        id: conversationId,
        org_id: orgId,
        channel_id: channelId,
        contact_id: patients.inbox.id,
        status: "open",
        assignee_team_id: teamId,
        assignee_user_id: users.admin.id,
        last_inbound_at: inboundAt,
        last_message_at: inboundAt,
        last_message_preview: inboundText,
        last_message_direction: "in",
        unread_count: 1,
      })
    ).error,
  );
  check(
    "messages",
    (
      await admin.from("messages").insert({
        org_id: orgId,
        conversation_id: conversationId,
        direction: "in",
        kind: "text",
        body: inboundText,
        wa_message_id: `wamid.E2E.${runId}.1`,
        status: "received",
        at: inboundAt,
      })
    ).error,
  );

  check(
    "tasks",
    (
      await admin.from("tasks").insert({
        org_id: orgId,
        subject: "Call the patient back",
        contact_id: patients.inbox.id,
        assignee_id: users.admin.id,
        created_by: users.admin.id,
        due_at: new Date(now.getTime() + 3_600_000).toISOString(),
      })
    ).error,
  );

  writeSeed({
    runId,
    orgId,
    orgSlug,
    timezone: TIMEZONE,
    today,
    bookingDate,
    users,
    location,
    specialist,
    service,
    patients,
    frontDeskAppointmentId,
    conversationId,
    inboundText,
  });
  // Ids and counts only; the passwords stay in the git-ignored seed file.
  console.log(
    `E2E workspace ${orgSlug} seeded (3 logins, 1 branch, 4 patients). Wrote ${SEED_FILE}.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
