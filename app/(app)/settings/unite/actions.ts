"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { APPOINTMENT_STATUSES } from "@/lib/appointments/status";
import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { enqueue } from "@/lib/jobs/enqueue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { uniteConfigSchema } from "@/lib/unite/config";
import { buildUniteClient, loadUniteAccount } from "@/lib/unite/store";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function refresh() {
  revalidatePath("/settings/unite");
}

const settingsSchema = z.object({
  status: z.enum(["active", "paused"]),
  config: uniteConfigSchema,
});

export async function saveUniteSettings(input: unknown): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings." };
  const { config, status } = parsed.data;
  if (config.enabled.patients && !config.paths.patients)
    return { ok: false, error: "Set the patients endpoint before enabling the patients sync." };
  if (config.enabled.doctors && !config.paths.doctors)
    return { ok: false, error: "Set the doctors endpoint before enabling the doctors sync." };
  if (/finance/i.test(JSON.stringify(config.paths)))
    return {
      ok: false,
      error: "The Finance API is not used: each call permanently dequeues records.",
    };

  const admin = createAdminClient();
  // The row is created together with the shared credentials (Finance → Capture health).
  if (!(await loadUniteAccount(admin, member.orgId)))
    return {
      ok: false,
      error: "Store the Unite credentials first (Finance → Capture health).",
    };
  const { error } = await admin
    .from("integration_accounts")
    .update({
      status: status === "active" ? "active" : "disabled",
      config: config as unknown as NonNullable<Json>,
    })
    .eq("org_id", member.orgId)
    .eq("kind", "unite");
  if (error) return { ok: false, error: "Could not save." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "unite.settings_updated",
    entity: "integration",
    diff: { status, enabled: config.enabled } as Json,
  });
  refresh();
  return { ok: true, message: "Unite settings saved." };
}

/** Logs in only (authorize); no patient data is requested. */
export async function testUniteConnection(): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const built = await buildUniteClient(admin, member.orgId);
  if (!built.ok) {
    const why = {
      no_account: "Store the Unite credentials first (Finance → Capture health).",
      paused: "The integration is paused.",
      no_credentials: "No readable credentials: store them under Finance → Capture health.",
    }[built.reason];
    return { ok: false, error: why };
  }
  try {
    await built.auth.getToken({ force: true });
    return { ok: true, message: "Connected: Unite accepted the credentials." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not connect." };
  }
}

export async function resetUniteBreaker(): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  await admin
    .from("integration_accounts")
    .update({ consecutive_failures: 0, breaker_open_until: null })
    .eq("org_id", member.orgId)
    .eq("kind", "unite");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "unite.breaker_reset",
    entity: "integration",
  });
  refresh();
  return { ok: true, message: "Calls resumed." };
}

/** Queues the same jobs the schedule would (never calls Unite from the request itself). */
export async function syncUniteNow(
  entity: "appointments" | "doctors" | "patients",
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const account = await loadUniteAccount(admin, member.orgId);
  if (!account || account.row.status !== "active")
    return { ok: false, error: "Unite is not active." };
  if (!account.config.enabled[entity])
    return { ok: false, error: `The ${entity} sync is switched off.` };
  let queued = 0;
  if (entity === "appointments") {
    const { data: locations } = await admin
      .from("locations")
      .select("external_id")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .not("external_id", "is", null);
    for (const l of locations ?? []) {
      await enqueue("unite_sync", {
        org_id: member.orgId,
        entity,
        clinic_id: l.external_id,
        mode: "nightly",
      });
      queued++;
    }
    if (!queued)
      return {
        ok: false,
        error: "No location has a Unite clinic id yet (Settings → Appointments).",
      };
  } else {
    await enqueue("unite_sync", { org_id: member.orgId, entity });
    queued = 1;
  }
  return { ok: true, message: `Queued ${queued} sync job${queued === 1 ? "" : "s"}.` };
}

const mapSchema = z.array(
  z.object({
    code: z.string().trim().min(1).max(20),
    status: z.enum(APPOINTMENT_STATUSES).nullable(),
    label: z.string().trim().max(120).nullable(),
    counts_as_no_show: z.boolean(),
  }),
);

/** Unite status codes → Pulse statuses (OQ-23). Unmapped codes never change a status. */
export async function saveStatusMap(input: z.input<typeof mapSchema>): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = mapSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid mapping." };
  const admin = createAdminClient();
  const { error } = await admin.from("unite_appointment_status_map").upsert(
    parsed.data.map((r) => ({ ...r, code: r.code.toUpperCase(), org_id: member.orgId })),
    { onConflict: "org_id,code" },
  );
  if (error) return { ok: false, error: "Could not save the mapping." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "unite.status_map_updated",
    entity: "integration",
  });
  refresh();
  return { ok: true, message: "Status mapping saved. It applies on the next sync." };
}
